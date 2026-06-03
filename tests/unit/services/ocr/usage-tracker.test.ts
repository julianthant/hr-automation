import { describe, it, afterEach } from "vitest";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
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
});
