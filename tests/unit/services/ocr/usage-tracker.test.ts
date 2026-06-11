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
