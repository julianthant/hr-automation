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
import { dirname, join } from "node:path";
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

  constructor(cacheDir: string) {
    this.statePath = join(cacheDir, "ocr-usage-state.json");
    this.load();
  }

  private load(): void {
    const persisted = this.readPersisted();
    for (const [id, c] of Object.entries(persisted.cells ?? {})) {
      this.cells.set(id, {
        reqTimes: [],
        tokTimes: [],
        rpdCount: c.rpdCount ?? 0,
        rpdEpochDay: c.rpdEpochDay ?? 0,
        cooldownUntilMs: c.cooldownUntilMs ?? 0,
        consecFails: 0,
        dead: c.dead ?? false,
      });
    }
  }

  private readPersisted(): PersistedState {
    if (!existsSync(this.statePath)) return { cells: {} };
    try {
      const parsed = JSON.parse(readFileSync(this.statePath, "utf-8")) as PersistedState;
      return { cells: parsed.cells ?? {} };
    } catch {
      // Corrupt state — start fresh.
      return { cells: {} };
    }
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
  private msUntilFree(c: CellState, limit: ModelLimit, estTokens: number, nowMs: number): number {
    if (c.dead) return Number.POSITIVE_INFINITY;
    let wait = Math.max(0, c.cooldownUntilMs - nowMs);
    if (limit.rpd > 0 && c.rpdCount >= limit.rpd) {
      wait = Math.max(wait, nextUtcMidnight(nowMs) - nowMs);
    }
    if (c.reqTimes.length >= limit.rpm) {
      const oldest = c.reqTimes[c.reqTimes.length - limit.rpm];
      wait = Math.max(wait, oldest + WINDOW_MS - nowMs);
    }
    if (this.tpmUsed(c) + estTokens > limit.tpm && c.tokTimes.length) {
      wait = Math.max(wait, c.tokTimes[0].t + WINDOW_MS - nowMs);
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
   * minimal wait; if every cell is dead, returns "exhausted".
   */
  reserve(candidates: Candidate[], nowMs = Date.now()): ReserveResult {
    if (candidates.length === 0) return { kind: "exhausted" };
    let best: { idx: number; cell: CellState; c: Candidate } | null = null;
    let minWait = Number.POSITIVE_INFINITY;
    let anyAlive = false;

    for (let i = 0; i < candidates.length; i++) {
      const cand = candidates[i];
      const id = cellId(cand.provider, hashKeyValue(cand.keyValue), cand.model);
      const cell = this.cell(id, nowMs);
      if (!cell.dead) anyAlive = true;
      const wait = this.msUntilFree(cell, cand.limit, cand.limit.imgTokens, nowMs);
      if (wait === 0) {
        const tier = cand.tier ?? 1;
        const bestTier = best ? (best.c.tier ?? 1) : Number.POSITIVE_INFINITY;
        if (!best || tier < bestTier || (tier === bestTier && cell.rpdCount < best.cell.rpdCount)) {
          best = { idx: i, cell, c: cand };
        }
      } else if (Number.isFinite(wait)) {
        minWait = Math.min(minWait, wait);
      }
    }

    if (best) {
      const estTokens = best.c.limit.imgTokens;
      best.cell.reqTimes.push(nowMs);
      best.cell.tokTimes.push({ t: nowMs, tok: estTokens });
      best.cell.rpdCount += 1;
      this.markDirty();
      return {
        kind: "ok",
        token: {
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
  trackerCache.clear();
}
