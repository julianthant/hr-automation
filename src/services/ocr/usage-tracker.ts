/**
 * Accurate, proactive usage tracker for the vision-OCR pool.
 *
 * Replaces the old "fire at full concurrency, wait a flat 60s after a 429"
 * scheme. Tracks live windows per (provider, key, model):
 *   - RPM  (requests in the last 60s)
 *   - TPM  (prompt tokens in the last 60s)
 *   - RPD  (requests today, UTC) — the free-tier daily wall
 * plus a cooldown set from the server's own retry signal (see
 * rate-limit-headers.ts) and a dead flag for auth failures.
 *
 * `reserve()` does *admission control*: it only hands out a (key, model) cell
 * that has headroom on all three windows right now, optimistically charging the
 * cell so concurrent callers see the spend immediately. `commit()` reconciles the
 * estimate against the real token count; `penalize()` applies the parsed retry
 * delay (or an exponential-backoff-with-jitter fallback). State persists so a
 * restart still respects a daily wall, and a single in-memory instance per
 * cacheDir lets concurrent runs share throttle state.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { openDatabase, transaction, type Database } from "../../infra/sqlite/index.js";
import { numEnv } from "../../utils/env.js";
import type { ModelLimit, VisionProviderId } from "./provider-limits.js";
import { hashKeyValue } from "./rotation.js";
import type { RateLimitInfo } from "./rate-limit-headers.js";

const WINDOW_MS = 60_000;
// Operator-tunable via Settings → "OCR" (env populated only for an explicitly-set
// field; unset = the literal default, so an unconfigured install is unchanged).
const BACKOFF_BASE_MS = numEnv("OCR_BACKOFF_BASE_MS", 2_000, { min: 0 });
const BACKOFF_CAP_MS = numEnv("OCR_BACKOFF_CAP_MS", 60_000, { min: 0 });
const FLUSH_DEBOUNCE_MS = 250;

export interface Candidate {
  provider: VisionProviderId;
  /** Raw key value — hashed for the state map, never persisted in the clear. */
  keyValue: string;
  keyIndex: number;
  model: string;
  limit: ModelLimit;
  /** Provider priority (lower preferred); used only for stable ordering. */
  priority: number;
  /**
   * Model accuracy tier (1 = name-trusted, 2 = throughput overflow; see
   * `ModelSpec.tier`). Absent = 1. `reserve()` prefers tier-1 cells among
   * those free now, so weak models only run when the strong ones are busy.
   */
  tier?: number;
}

/** Handle returned by reserve(); pass back to commit()/penalize(). */
export interface ReservedToken {
  reservationId?: string;
  provider: VisionProviderId;
  keyHash: string;
  keyIndex: number;
  model: string;
  estTokens: number;
}

export type ReserveResult =
  | { kind: "ok"; token: ReservedToken }
  | { kind: "wait"; waitMs: number }
  | { kind: "exhausted" };

export interface ReserveOpts {
  /**
   * Tier-1 patience: when the only cells with headroom RIGHT NOW are tier ≥ 2
   * (throughput-overflow models observed mangling handwriting) but some tier-1
   * cell frees within this many ms, return `wait` for that tier-1 cell instead
   * of granting the tier-2 one. This is what stops a batch from drifting onto
   * weak models as the tier-1 RPM windows saturate mid-run — the caller pays a
   * short pause for a trusted read. 0 / absent = today's behavior (take the
   * best free cell immediately). A tier-1 cell walled for longer than this
   * (e.g. daily quota — hours) still falls through to tier-2.
   */
  preferTier1WaitMs?: number;
}

interface CellState {
  // Ephemeral (not persisted) — only meaningful within the current minute.
  reqTimes: number[];
  tokTimes: Array<{ t: number; tok: number }>;
  // Persisted.
  rpdCount: number;
  rpdEpochDay: number;
  cooldownUntilMs: number;
  consecFails: number;
  dead: boolean;
}

interface PersistedCell {
  rpdCount: number;
  rpdEpochDay: number;
  cooldownUntilMs: number;
  dead: boolean;
}
interface PersistedState {
  cells: Record<string, PersistedCell>;
}

function dayUtc(ms: number): number {
  return Math.floor(ms / (24 * 3_600_000));
}
function nextUtcMidnight(nowMs: number): number {
  return (dayUtc(nowMs) + 1) * 24 * 3_600_000;
}
function cellId(provider: string, keyHash: string, model: string): string {
  return `${provider}::${keyHash}::${model}`;
}

export class UsageTracker {
  private cells = new Map<string, CellState>();
  private readonly statePath: string;
  private dirty = false;
  private flushTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly quotaDb: Database;
  private closed = false;

  constructor(cacheDir: string) {
    if (!existsSync(cacheDir)) mkdirSync(cacheDir, { recursive: true });
    this.statePath = join(cacheDir, "ocr-usage-state.json");
    this.quotaDb = openDatabase(join(cacheDir, "ocr-usage.sqlite"));
    this.quotaDb.exec(`
      CREATE TABLE IF NOT EXISTS reservations (
        reservation_id TEXT PRIMARY KEY,
        cell_id TEXT NOT NULL,
        reserved_at_ms INTEGER NOT NULL,
        epoch_day INTEGER NOT NULL,
        estimated_tokens INTEGER NOT NULL,
        actual_tokens INTEGER
      );
      CREATE INDEX IF NOT EXISTS reservations_cell_time_idx ON reservations(cell_id, reserved_at_ms);
      CREATE INDEX IF NOT EXISTS reservations_cell_day_idx ON reservations(cell_id, epoch_day);
    `);
    this.load();
  }

  private load(): void {
    const persisted = this.readPersisted();
    for (const [id, c] of Object.entries(persisted.cells)) {
      this.cells.set(id, {
        reqTimes: [],
        tokTimes: [],
        rpdCount: c.rpdCount,
        rpdEpochDay: c.rpdEpochDay,
        cooldownUntilMs: c.cooldownUntilMs,
        consecFails: 0,
        dead: c.dead,
      });
    }
  }

  private readPersisted(): PersistedState {
    if (!existsSync(this.statePath)) return { cells: {} };
    const parsed = JSON.parse(readFileSync(this.statePath, "utf-8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`OCR usage state ${this.statePath} is corrupt: expected an object`);
    }
    const cells = (parsed as { cells?: unknown }).cells;
    if (!cells || typeof cells !== "object" || Array.isArray(cells)) {
      throw new Error(`OCR usage state ${this.statePath} is corrupt: expected a cells object`);
    }
    for (const [id, value] of Object.entries(cells)) {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error(`OCR usage state ${this.statePath} is corrupt at cell ${id}`);
      }
      const cell = value as Record<string, unknown>;
      if (
        !Number.isFinite(cell.rpdCount) || !Number.isFinite(cell.rpdEpochDay) ||
        !Number.isFinite(cell.cooldownUntilMs) || typeof cell.dead !== "boolean"
      ) {
        throw new Error(`OCR usage state ${this.statePath} has invalid quota metadata at cell ${id}`);
      }
    }
    return parsed as PersistedState;
  }

  flush(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
    if (!this.dirty) return;
    const dir = dirname(this.statePath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const persisted = this.mergePersisted(this.readPersisted());
    this.applyPersisted(persisted);
    const tmpPath = `${this.statePath}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmpPath, JSON.stringify(persisted));
    renameSync(tmpPath, this.statePath);
    this.dirty = false;
  }

  private snapshot(): PersistedState {
    const snapshot: PersistedState = { cells: {} };
    for (const [id, c] of this.cells) {
      snapshot.cells[id] = {
        rpdCount: c.rpdCount,
        rpdEpochDay: c.rpdEpochDay,
        cooldownUntilMs: c.cooldownUntilMs,
        dead: c.dead,
      };
    }
    return snapshot;
  }

  private mergePersisted(onDisk: PersistedState): PersistedState {
    const local = this.snapshot();
    const merged: PersistedState = { cells: { ...onDisk.cells } };
    for (const [id, localCell] of Object.entries(local.cells)) {
      const diskCell = merged.cells[id];
      merged.cells[id] = diskCell ? mergeCell(diskCell, localCell) : localCell;
    }
    return merged;
  }

  private applyPersisted(persisted: PersistedState): void {
    const nowMs = Date.now();
    for (const [id, c] of Object.entries(persisted.cells ?? {})) {
      const cell = this.cells.get(id) ?? {
        reqTimes: [],
        tokTimes: [],
        rpdCount: 0,
        rpdEpochDay: dayUtc(nowMs),
        cooldownUntilMs: 0,
        consecFails: 0,
        dead: false,
      };
      cell.rpdCount = c.rpdCount ?? 0;
      cell.rpdEpochDay = c.rpdEpochDay ?? 0;
      cell.cooldownUntilMs = c.cooldownUntilMs ?? 0;
      cell.dead = c.dead ?? false;
      this.cells.set(id, cell);
    }
  }

  private markDirty(): void {
    this.dirty = true;
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      try {
        if (this.dirty) this.flush();
      } catch {
        // Admission control keeps working in-memory; the next explicit flush
        // or process run can retry persistence.
      }
    }, FLUSH_DEBOUNCE_MS);
    this.flushTimer.unref?.();
  }

  private cell(id: string, nowMs: number): CellState {
    let c = this.cells.get(id);
    if (!c) {
      c = {
        reqTimes: [],
        tokTimes: [],
        rpdCount: 0,
        rpdEpochDay: dayUtc(nowMs),
        cooldownUntilMs: 0,
        consecFails: 0,
        dead: false,
      };
      this.cells.set(id, c);
    }
    // Roll the daily counter at the UTC boundary.
    const today = dayUtc(nowMs);
    if (c.rpdEpochDay !== today) {
      c.rpdCount = 0;
      c.rpdEpochDay = today;
      // A new day clears a daily-quota cooldown (reset is at midnight anyway).
      if (c.cooldownUntilMs > nowMs && c.cooldownUntilMs - nowMs > WINDOW_MS) c.cooldownUntilMs = 0;
      this.markDirty();
    }
    // Prune minute windows.
    const cutoff = nowMs - WINDOW_MS;
    if (c.reqTimes.length) c.reqTimes = c.reqTimes.filter((t) => t > cutoff);
    if (c.tokTimes.length) c.tokTimes = c.tokTimes.filter((e) => e.t > cutoff);
    return c;
  }

  private tpmUsed(c: CellState): number {
    let sum = 0;
    for (const e of c.tokTimes) sum += e.tok;
    return sum;
  }

  /** ms until this cell can next accept a request of `estTokens` (0 = now). */
  private sharedUsage(id: string, nowMs: number): {
    minute: Array<{ reserved_at_ms: number; tokens: number }>;
    rpdCount: number;
  } {
    const minute = this.quotaDb.prepare(`
      SELECT reserved_at_ms, COALESCE(actual_tokens, estimated_tokens) AS tokens
      FROM reservations WHERE cell_id = @id AND reserved_at_ms > @cutoff
      ORDER BY reserved_at_ms ASC
    `).all({ id, cutoff: nowMs - WINDOW_MS }) as Array<{ reserved_at_ms: number; tokens: number }>;
    const daily = this.quotaDb.prepare(`
      SELECT COUNT(*) AS count FROM reservations WHERE cell_id = @id AND epoch_day = @day
    `).get({ id, day: dayUtc(nowMs) }) as { count: number };
    return { minute, rpdCount: daily.count };
  }

  private msUntilFree(
    c: CellState,
    limit: ModelLimit,
    estTokens: number,
    nowMs: number,
    shared: { minute: Array<{ reserved_at_ms: number; tokens: number }>; rpdCount: number },
  ): number {
    if (c.dead) return Number.POSITIVE_INFINITY;
    let wait = Math.max(0, c.cooldownUntilMs - nowMs);
    if (limit.rpd > 0 && Math.max(c.rpdCount, shared.rpdCount) >= limit.rpd) {
      wait = Math.max(wait, nextUtcMidnight(nowMs) - nowMs);
    }
    if (shared.minute.length >= limit.rpm) {
      const oldest = shared.minute[shared.minute.length - limit.rpm].reserved_at_ms;
      wait = Math.max(wait, oldest + WINDOW_MS - nowMs);
    }
    const sharedTokens = shared.minute.reduce((sum, row) => sum + row.tokens, 0);
    if (sharedTokens + estTokens > limit.tpm && shared.minute.length) {
      wait = Math.max(wait, shared.minute[0].reserved_at_ms + WINDOW_MS - nowMs);
    }
    return wait;
  }

  /**
   * Pick the best available (key, model) cell for the next page. Candidates
   * should be supplied in preference order (provider priority → model chain →
   * key index). Among those with headroom *now*, picks the best accuracy tier
   * first (tier 1 before tier 2 — load-spreading must not drift pages onto
   * name-mangling overflow models while trusted ones are free), then the
   * lowest daily count to spread load within the tier, tie-broken by supplied
   * order. Charges the cell optimistically. If nothing is free, returns the
   * minimal wait; if every cell is dead, returns "exhausted". With
   * `opts.preferTier1WaitMs`, a tier-2-only "free now" set additionally waits
   * for a tier-1 cell that frees within that window (see `ReserveOpts`).
   */
  reserve(candidates: Candidate[], nowMs = Date.now(), opts: ReserveOpts = {}): ReserveResult {
    return transaction(this.quotaDb, () => this.reserveLocked(candidates, nowMs, opts));
  }

  private reserveLocked(candidates: Candidate[], nowMs: number, opts: ReserveOpts): ReserveResult {
    this.quotaDb.prepare("DELETE FROM reservations WHERE epoch_day < @day").run({ day: dayUtc(nowMs) });
    if (candidates.length === 0) return { kind: "exhausted" };
    let best: { idx: number; cell: CellState; c: Candidate; id: string; sharedRpdCount: number } | null = null;
    let minWait = Number.POSITIVE_INFINITY;
    let minWaitTier1 = Number.POSITIVE_INFINITY;
    let anyAlive = false;

    for (let i = 0; i < candidates.length; i++) {
      const cand = candidates[i];
      const id = cellId(cand.provider, hashKeyValue(cand.keyValue), cand.model);
      const cell = this.cell(id, nowMs);
      const shared = this.sharedUsage(id, nowMs);
      if (!cell.dead) anyAlive = true;
      const wait = this.msUntilFree(cell, cand.limit, cand.limit.imgTokens, nowMs, shared);
      if (wait === 0) {
        const tier = cand.tier ?? 1;
        const bestTier = best ? (best.c.tier ?? 1) : Number.POSITIVE_INFINITY;
        const rpdCount = Math.max(cell.rpdCount, shared.rpdCount);
        if (!best || tier < bestTier || (tier === bestTier && rpdCount < best.sharedRpdCount)) {
          best = { idx: i, cell, c: cand, id, sharedRpdCount: rpdCount };
        }
      } else if (Number.isFinite(wait)) {
        minWait = Math.min(minWait, wait);
        if ((cand.tier ?? 1) === 1) minWaitTier1 = Math.min(minWaitTier1, wait);
      }
    }

    // Tier-1 patience: only tier-2 cells are free now, but a tier-1 cell
    // frees soon — wait for it rather than feeding the page to a weak model.
    const { preferTier1WaitMs: patience = 0 } = opts;
    if (best && (best.c.tier ?? 1) >= 2 && patience > 0 && minWaitTier1 <= patience) {
      return { kind: "wait", waitMs: minWaitTier1 };
    }

    if (best) {
      const estTokens = best.c.limit.imgTokens;
      const reservationId = randomUUID();
      this.quotaDb.prepare(`
        INSERT INTO reservations (
          reservation_id, cell_id, reserved_at_ms, epoch_day, estimated_tokens, actual_tokens
        ) VALUES (@reservationId, @cellId, @nowMs, @epochDay, @estTokens, NULL)
      `).run({ reservationId, cellId: best.id, nowMs, epochDay: dayUtc(nowMs), estTokens });
      best.cell.reqTimes.push(nowMs);
      best.cell.tokTimes.push({ t: nowMs, tok: estTokens });
      best.cell.rpdCount += 1;
      this.markDirty();
      return {
        kind: "ok",
        token: {
          reservationId,
          provider: best.c.provider,
          keyHash: hashKeyValue(best.c.keyValue),
          keyIndex: best.c.keyIndex,
          model: best.c.model,
          estTokens,
        },
      };
    }
    if (!anyAlive) return { kind: "exhausted" };
    return { kind: "wait", waitMs: Number.isFinite(minWait) ? minWait : WINDOW_MS };
  }

  /** Reconcile the optimistic token estimate with the real prompt-token count. */
  commit(token: ReservedToken, actualTokens: number | undefined, nowMs = Date.now()): void {
    if (token.reservationId && actualTokens != null) {
      this.quotaDb.prepare(`
        UPDATE reservations SET actual_tokens = @actualTokens WHERE reservation_id = @reservationId
      `).run({ actualTokens, reservationId: token.reservationId });
    }
    const c = this.cells.get(cellId(token.provider, token.keyHash, token.model));
    if (!c) return;
    c.consecFails = 0;
    if (actualTokens != null && c.tokTimes.length) {
      // Replace the most recent (estimate) entry with the measured value.
      c.tokTimes[c.tokTimes.length - 1] = { t: nowMs, tok: actualTokens };
    }
  }

  /** Apply a parsed rate-limit/auth result (or fall back to exponential backoff). */
  penalize(token: ReservedToken, info: RateLimitInfo, nowMs = Date.now()): void {
    const c = this.cells.get(cellId(token.provider, token.keyHash, token.model));
    if (!c) return;
    c.consecFails += 1;
    switch (info.kind) {
      case "auth":
        c.dead = true;
        this.markDirty();
        return;
      case "quota-exhausted":
        c.cooldownUntilMs = nowMs + (info.retryAfterMs ?? nextUtcMidnight(nowMs) - nowMs);
        // Treat the daily wall as hit so the proactive gate stops picking it.
        c.rpdCount = Math.max(c.rpdCount, Number.MAX_SAFE_INTEGER / 2);
        this.markDirty();
        return;
      case "rate-limit":
        c.cooldownUntilMs = nowMs + (info.retryAfterMs ?? this.backoff(c.consecFails));
        this.markDirty();
        return;
      case "transient":
        c.cooldownUntilMs = nowMs + (info.retryAfterMs ?? this.backoff(c.consecFails, 1_000));
        this.markDirty();
        return;
      case "permanent":
        // Don't cool down — let the page try a different key/model immediately.
        return;
    }
  }

  private backoff(fails: number, base = BACKOFF_BASE_MS): number {
    const exp = Math.min(base * 2 ** (fails - 1), BACKOFF_CAP_MS);
    return exp + Math.floor(Math.random() * Math.min(exp, 1_000)); // full-ish jitter
  }

  /** For the key-status endpoint / debugging. Never exposes key material. */
  inspect(nowMs = Date.now()): Array<{
    cell: string;
    rpdCount: number;
    rpmNow: number;
    tpmNow: number;
    cooldownMs: number;
    dead: boolean;
  }> {
    const out = [];
    for (const [id, c] of this.cells) {
      this.cell(id, nowMs); // prune
      out.push({
        cell: id,
        rpdCount: c.rpdCount,
        rpmNow: c.reqTimes.length,
        tpmNow: this.tpmUsed(c),
        cooldownMs: Math.max(0, c.cooldownUntilMs - nowMs),
        dead: c.dead,
      });
    }
    return out;
  }

  /** Flush legacy cooldown/dead metadata and release the shared quota handle. */
  close(): void {
    if (this.closed) return;
    this.flush();
    this.quotaDb.close();
    this.closed = true;
  }
}

function mergeCell(a: PersistedCell, b: PersistedCell): PersistedCell {
  const newerDay = Math.max(a.rpdEpochDay ?? 0, b.rpdEpochDay ?? 0);
  const sameDay = (a.rpdEpochDay ?? 0) === (b.rpdEpochDay ?? 0);
  return {
    rpdEpochDay: newerDay,
    rpdCount: sameDay
      ? Math.max(a.rpdCount ?? 0, b.rpdCount ?? 0)
      : (a.rpdEpochDay ?? 0) > (b.rpdEpochDay ?? 0)
        ? a.rpdCount ?? 0
        : b.rpdCount ?? 0,
    cooldownUntilMs: Math.max(a.cooldownUntilMs ?? 0, b.cooldownUntilMs ?? 0),
    dead: Boolean(a.dead || b.dead),
  };
}

const trackerCache = new Map<string, UsageTracker>();

export function getUsageTracker(cacheDir: string): UsageTracker {
  let t = trackerCache.get(cacheDir);
  if (!t) {
    t = new UsageTracker(cacheDir);
    trackerCache.set(cacheDir, t);
  }
  return t;
}

export function __resetUsageTrackerForTests(): void {
  for (const tracker of trackerCache.values()) tracker.close();
  trackerCache.clear();
}
