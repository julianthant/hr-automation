import { describe, it, afterEach } from "vitest";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UsageTracker, type Candidate } from "../../../../src/services/ocr/usage-tracker.js";
import type { ModelLimit } from "../../../../src/services/ocr/provider-limits.js";

const LIM = (over: Partial<ModelLimit> = {}): ModelLimit => ({
  rpm: 10,
  tpm: 100_000,
  rpd: 100,
  imgTokens: 100,
  ...over,
});

const cand = (key: string, model: string, limit: ModelLimit, keyIndex = 1): Candidate => ({
  provider: "gemini",
  keyValue: key,
  keyIndex,
  model,
  limit,
  priority: 1,
});

describe("UsageTracker", () => {
  let tmp: string;
  const dirs: string[] = [];
  const fresh = (): UsageTracker => {
    tmp = mkdtempSync(join(tmpdir(), "ocr-usage-"));
    dirs.push(tmp);
    return new UsageTracker(tmp);
  };
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it("reserves an available cell and charges it", () => {
    const t = fresh();
    const r = t.reserve([cand("k1", "m", LIM())]);
    assert.equal(r.kind, "ok");
    if (r.kind === "ok") {
      assert.equal(r.token.model, "m");
      assert.equal(r.token.keyIndex, 1);
    }
  });

  it("returns exhausted for an empty candidate list", () => {
    assert.equal(fresh().reserve([]).kind, "exhausted");
  });

  it("spreads load: picks the cell with the lowest daily count", () => {
    const t = fresh();
    const cands = [cand("k1", "m", LIM(), 1), cand("k2", "m", LIM(), 2)];
    const a = t.reserve(cands);
    const b = t.reserve(cands);
    assert.equal(a.kind === "ok" && a.token.keyIndex, 1);
    assert.equal(b.kind === "ok" && b.token.keyIndex, 2, "second pick rotates to the unused key");
  });

  it("waits when the only cell's RPM window is full", () => {
    const t = fresh();
    const cands = [cand("k1", "m", LIM({ rpm: 1 }))];
    const now = 1_000_000;
    assert.equal(t.reserve(cands, now).kind, "ok");
    const r = t.reserve(cands, now + 100);
    assert.equal(r.kind, "wait");
    if (r.kind === "wait") assert.ok(r.waitMs > 0 && r.waitMs <= 60_000);
  });

  it("waits until the RPM window slides open, then reserves again", () => {
    const t = fresh();
    const cands = [cand("k1", "m", LIM({ rpm: 1 }))];
    const now = 2_000_000;
    t.reserve(cands, now);
    assert.equal(t.reserve(cands, now + 61_000).kind, "ok", "window cleared after 60s");
  });

  it("treats a hit daily cap as a wait until ~next UTC midnight", () => {
    const t = fresh();
    const cands = [cand("k1", "m", LIM({ rpd: 1 }))];
    const now = 3_000_000;
    t.reserve(cands, now);
    const r = t.reserve(cands, now + 100);
    assert.equal(r.kind, "wait");
    if (r.kind === "wait") assert.ok(r.waitMs > 60_000, "daily wall waits far longer than a minute");
  });

  it("reconciles the token estimate via commit() so TPM frees up", () => {
    const t = fresh();
    const cands = [cand("k1", "m", LIM({ tpm: 200, imgTokens: 150 }))];
    const now = 4_000_000;
    const a = t.reserve(cands, now);
    assert.equal(a.kind, "ok");
    // 150 (est) + 150 would exceed tpm 200 → second reserve waits.
    assert.equal(t.reserve(cands, now + 1).kind, "wait");
    // The real call only cost 10 tokens; commit reconciles → headroom returns.
    if (a.kind === "ok") t.commit(a.token, 10, now + 2);
    assert.equal(t.reserve(cands, now + 3).kind, "ok");
  });

  it("penalize(auth) marks the cell dead; a sole dead cell is exhausted", () => {
    const t = fresh();
    const cands = [cand("k1", "m", LIM())];
    const a = t.reserve(cands);
    if (a.kind === "ok") t.penalize(a.token, { kind: "auth" });
    assert.equal(t.reserve(cands).kind, "exhausted");
  });

  it("penalize(rate-limit) honors retryAfterMs and frees after it passes", () => {
    const t = fresh();
    const cands = [cand("k1", "m", LIM())];
    const now = 5_000_000;
    const a = t.reserve(cands, now);
    if (a.kind === "ok") t.penalize(a.token, { kind: "rate-limit", retryAfterMs: 5_000 }, now);
    assert.equal(t.reserve(cands, now + 1_000).kind, "wait");
    assert.equal(t.reserve(cands, now + 6_000).kind, "ok");
  });

  it("flush() no-ops when clean and does not create a state file", () => {
    const t = fresh();
    const statePath = join(tmp, "ocr-usage-state.json");
    t.flush();
    assert.equal(existsSync(statePath), false);
  });

  it("flush() writes compact JSON when dirty", () => {
    const t = fresh();
    t.reserve([cand("k1", "m", LIM())]);
    t.flush();
    const raw = readFileSync(join(tmp, "ocr-usage-state.json"), "utf-8");
    assert.ok(!raw.includes("\n  "), "persisted state should be compact JSON");
    assert.ok(raw.startsWith("{"));
  });

  it("persists cooldown + dead state across instances", () => {
    const t1 = fresh();
    const cands = [cand("k1", "m1", LIM()), cand("k1", "m2", LIM())];
    const a = t1.reserve(cands);
    if (a.kind === "ok") t1.penalize(a.token, { kind: "auth" });
    t1.flush();

    const t2 = new UsageTracker(tmp);
    // m1 is dead from the persisted state → t2 must pick m2.
    const r = t2.reserve(cands);
    assert.equal(r.kind === "ok" && r.token.model, "m2");
  });

  it("flush merges cells created by another instance after this instance loaded", () => {
    tmp = mkdtempSync(join(tmpdir(), "ocr-usage-merge-"));
    dirs.push(tmp);
    const first = new UsageTracker(tmp);
    const staleSecond = new UsageTracker(tmp);
    const now = 1_000_000;

    assert.equal(first.reserve([cand("k1", "m", LIM(), 1)], now).kind, "ok");
    first.flush();

    assert.equal(staleSecond.reserve([cand("k2", "m", LIM(), 2)], now + 1).kind, "ok");
    staleSecond.flush();

    const latest = new UsageTracker(tmp);
    const cells = latest.inspect(now + 2);
    assert.equal(cells.length, 2, "stale flush must preserve the other process's cell");
    assert.deepEqual(cells.map((c) => c.rpdCount).sort((a, b) => a - b), [1, 1]);
  });

  it("flush merges same-cell counters, cooldowns, and dead flags conservatively", () => {
    tmp = mkdtempSync(join(tmpdir(), "ocr-usage-merge-cell-"));
    dirs.push(tmp);
    const first = new UsageTracker(tmp);
    const staleSecond = new UsageTracker(tmp);
    const cands = [cand("k1", "m", LIM(), 1)];
    const now = 2_000_000;

    assert.equal(first.reserve(cands, now).kind, "ok");
    assert.equal(first.reserve(cands, now + 1).kind, "ok");
    first.flush();

    const staleReserve = staleSecond.reserve(cands, now + 2);
    assert.equal(staleReserve.kind, "ok");
    if (staleReserve.kind === "ok") {
      staleSecond.penalize(staleReserve.token, { kind: "auth" }, now + 3);
    }
    staleSecond.flush();

    const latest = new UsageTracker(tmp);
    const [cell] = latest.inspect(now + 4);
    assert.equal(cell.rpdCount, 2, "daily count should keep the highest observed value");
    assert.equal(cell.dead, true, "dead flag should survive from either process");
  });
});

describe("UsageTracker — accuracy tiers", () => {
  let tmp: string;
  const dirs: string[] = [];
  const fresh = (): UsageTracker => {
    tmp = mkdtempSync(join(tmpdir(), "ocr-usage-tier-"));
    dirs.push(tmp);
    return new UsageTracker(tmp);
  };
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it("prefers a tier-1 cell over tier-2 even when tier-2 has the lower daily count", () => {
    const t = fresh();
    const strong: Candidate = { ...cand("k1", "strong-model", LIM()), tier: 1 };
    const weak: Candidate = { ...cand("k2", "weak-model", LIM(), 2), tier: 2 };
    // Charge the strong cell twice so naive load-spreading would pick weak.
    assert.equal(t.reserve([strong]).kind, "ok");
    assert.equal(t.reserve([strong]).kind, "ok");
    const r = t.reserve([weak, strong]); // weak listed first AND lower rpdCount
    assert.equal(r.kind, "ok");
    if (r.kind === "ok") assert.equal(r.token.model, "strong-model");
  });

  it("falls back to a tier-2 cell only when every tier-1 cell is busy", () => {
    const t = fresh();
    const strong: Candidate = { ...cand("k1", "strong-model", LIM({ rpm: 1 })), tier: 1 };
    const weak: Candidate = { ...cand("k2", "weak-model", LIM(), 2), tier: 2 };
    const first = t.reserve([strong, weak]);
    if (first.kind === "ok") assert.equal(first.token.model, "strong-model");
    const second = t.reserve([strong, weak]); // strong now rpm-exhausted
    assert.equal(second.kind, "ok");
    if (second.kind === "ok") assert.equal(second.token.model, "weak-model");
  });

  it("treats an absent tier as tier 1 (back-compat with untiered candidates)", () => {
    const t = fresh();
    const untiered = cand("k1", "untiered-model", LIM());
    const weak: Candidate = { ...cand("k2", "weak-model", LIM(), 2), tier: 2 };
    const r = t.reserve([weak, untiered]);
    assert.equal(r.kind, "ok");
    if (r.kind === "ok") assert.equal(r.token.model, "untiered-model");
  });
});

describe("UsageTracker — tier-1 patience (preferTier1WaitMs)", () => {
  // The batch-drift fix: without patience, the instant every tier-1 cell's RPM
  // window fills (~15-20 pages into a batch), reserve() hands the next page a
  // tier-2 (handwriting-mangling) cell. With patience, the page WAITS for a
  // tier-1 cell that frees soon instead.
  let tmp: string;
  const dirs: string[] = [];
  const fresh = (): UsageTracker => {
    tmp = mkdtempSync(join(tmpdir(), "ocr-usage-patience-"));
    dirs.push(tmp);
    return new UsageTracker(tmp);
  };
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  const T0 = 1_750_000_000_000; // fixed clock — mid-day UTC, no midnight rollover

  it("waits for a tier-1 cell that frees within patience instead of granting a free tier-2 cell", () => {
    const t = fresh();
    const strong: Candidate = { ...cand("k1", "strong-model", LIM({ rpm: 1 })), tier: 1 };
    const weak: Candidate = { ...cand("k2", "weak-model", LIM(), 2), tier: 2 };
    assert.equal(t.reserve([strong, weak], T0).kind, "ok"); // strong now rpm-busy for 60s
    const r = t.reserve([strong, weak], T0 + 10_000, { preferTier1WaitMs: 60_000 });
    assert.equal(r.kind, "wait", "tier-2 is free but a tier-1 cell frees within patience — wait");
    if (r.kind === "wait") assert.equal(r.waitMs, 50_000, "waits exactly until the tier-1 RPM window frees");
  });

  it("grants the tier-2 cell when patience is smaller than the tier-1 wait", () => {
    const t = fresh();
    const strong: Candidate = { ...cand("k1", "strong-model", LIM({ rpm: 1 })), tier: 1 };
    const weak: Candidate = { ...cand("k2", "weak-model", LIM(), 2), tier: 2 };
    assert.equal(t.reserve([strong, weak], T0).kind, "ok");
    const r = t.reserve([strong, weak], T0 + 10_000, { preferTier1WaitMs: 30_000 });
    assert.equal(r.kind, "ok", "tier-1 frees in 50s > 30s patience — take the overflow cell");
    if (r.kind === "ok") assert.equal(r.token.model, "weak-model");
  });

  it("grants the tier-2 cell immediately when tier-1 is daily-walled (wait far exceeds patience)", () => {
    const t = fresh();
    const strong: Candidate = { ...cand("k1", "strong-model", LIM({ rpd: 1 })), tier: 1 };
    const weak: Candidate = { ...cand("k2", "weak-model", LIM(), 2), tier: 2 };
    assert.equal(t.reserve([strong, weak], T0).kind, "ok"); // strong hits its daily wall
    const r = t.reserve([strong, weak], T0 + 61_000, { preferTier1WaitMs: 90_000 });
    assert.equal(r.kind, "ok", "tier-1 frees at UTC midnight — hours away, never wait that out");
    if (r.kind === "ok") assert.equal(r.token.model, "weak-model");
  });

  it("without the option (or with 0) keeps today's behavior: best free cell wins immediately", () => {
    const t = fresh();
    const strong: Candidate = { ...cand("k1", "strong-model", LIM({ rpm: 1 })), tier: 1 };
    const weak: Candidate = { ...cand("k2", "weak-model", LIM(), 2), tier: 2 };
    assert.equal(t.reserve([strong, weak], T0).kind, "ok");
    const noOpt = t.reserve([strong, weak], T0 + 10_000);
    assert.equal(noOpt.kind, "ok");
    if (noOpt.kind === "ok") assert.equal(noOpt.token.model, "weak-model");
    const zero = t.reserve([strong, weak], T0 + 11_000, { preferTier1WaitMs: 0 });
    assert.equal(zero.kind, "ok");
    if (zero.kind === "ok") assert.equal(zero.token.model, "weak-model");
  });

  it("patience never blocks a tier-1 grant (free tier-1 cell still wins instantly)", () => {
    const t = fresh();
    const strong: Candidate = { ...cand("k1", "strong-model", LIM()), tier: 1 };
    const weak: Candidate = { ...cand("k2", "weak-model", LIM(), 2), tier: 2 };
    const r = t.reserve([weak, strong], T0, { preferTier1WaitMs: 60_000 });
    assert.equal(r.kind, "ok");
    if (r.kind === "ok") assert.equal(r.token.model, "strong-model");
  });
});

it("UsageTracker reservations are immediately additive across process-like instances", () => {
  const dir = mkdtempSync(join(tmpdir(), "ocr-usage-multiprocess-"));
  try {
    const a = new UsageTracker(dir);
    const b = new UsageTracker(dir);
    const candidate = cand("shared-key", "shared-model", LIM({ rpm: 1, rpd: 2 }));
    assert.equal(a.reserve([candidate], 1_750_000_000_000).kind, "ok");
    const blocked = b.reserve([candidate], 1_750_000_000_001);
    assert.equal(blocked.kind, "wait", "second process sees the first process minute reservation without flush");
    const nextMinute = b.reserve([candidate], 1_750_000_061_000);
    assert.equal(nextMinute.kind, "ok");
    const dailyWall = a.reserve([candidate], 1_750_000_122_000);
    assert.equal(dailyWall.kind, "wait", "two process reservations add to the shared daily limit");
    a.close();
    b.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it("UsageTracker shares token-per-minute reservations across process-like instances", () => {
  const dir = mkdtempSync(join(tmpdir(), "ocr-usage-multiprocess-tpm-"));
  const a = new UsageTracker(dir);
  const b = new UsageTracker(dir);
  try {
    const candidate = cand("shared-key", "shared-model", LIM({ rpm: 10, tpm: 150, imgTokens: 100 }));
    assert.equal(a.reserve([candidate], 1_750_000_000_000).kind, "ok");
    const blocked = b.reserve([candidate], 1_750_000_000_001);
    assert.equal(blocked.kind, "wait", "second process includes the first process estimated tokens");
    assert.equal(b.reserve([candidate], 1_750_000_061_000).kind, "ok");
  } finally {
    a.close();
    b.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
