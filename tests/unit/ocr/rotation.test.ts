import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KeyRotation } from "../../../src/ocr/rotation.js";

describe("KeyRotation", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "ocr-rot-"));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("returns the first key when none have been used", () => {
    const r = new KeyRotation("gemini", ["k1", "k2", "k3"], tmp);
    const k = r.pickNext();
    assert.equal(k.value, "k1");
  });

  it("rotates past a 429-throttled key", () => {
    const r = new KeyRotation("gemini", ["k1", "k2"], tmp);
    const k1 = r.pickNext();
    r.markRateLimited(k1, Date.now() + 60_000);
    const k = r.pickNext();
    assert.equal(k.value, "k2");
  });

  it("rotates past a quota-exhausted key", () => {
    const r = new KeyRotation("gemini", ["k1", "k2"], tmp);
    const k1 = r.pickNext();
    r.markQuotaExhausted(k1, Date.now() + 24 * 3600_000);
    const k = r.pickNext();
    assert.equal(k.value, "k2");
  });

  it("rotates past a dead key", () => {
    const r = new KeyRotation("gemini", ["k1", "k2"], tmp);
    const k1 = r.pickNext();
    r.markDead(k1);
    const k = r.pickNext();
    assert.equal(k.value, "k2");
  });

  it("throws when all keys are exhausted", () => {
    const r = new KeyRotation("gemini", ["k1"], tmp);
    const k1 = r.pickNext();
    r.markDead(k1);
    assert.throws(() => r.pickNext(), /exhausted/i);
  });

  it("re-enables a throttled key after its until time passes", () => {
    const r = new KeyRotation("gemini", ["k1"], tmp);
    const k1 = r.pickNext();
    r.markRateLimited(k1, Date.now() - 1_000);
    const k = r.pickNext();
    assert.equal(k.value, "k1");
  });

  it("persists state to file on flush(), restores on next instance", () => {
    const r1 = new KeyRotation("gemini", ["k1", "k2"], tmp);
    const k1 = r1.pickNext();
    r1.markRateLimited(k1, Date.now() + 60_000);
    r1.flush();
    const r2 = new KeyRotation("gemini", ["k1", "k2"], tmp);
    // r2 reads persisted state and should rotate past k1.
    const k = r2.pickNext();
    assert.equal(k.value, "k2");
  });

  it("picks key with smallest dailyCount when multiple are available", () => {
    const r = new KeyRotation("gemini", ["k1", "k2", "k3"], tmp);
    // k1 used 3x, k2 used 1x, k3 used 0x.
    const a = r.pickNext();
    const b = r.pickNext();
    const c = r.pickNext();
    assert.equal(a.value, "k1");
    assert.equal(b.value, "k2");
    assert.equal(c.value, "k3");
    // After three picks counts are k1=1, k2=1, k3=1; pick should return any.
    // Use again — counts now 1/1/1 → tie-break picks first matching ("k1").
    const d = r.pickNext();
    assert.equal(d.value, "k1");
  });
});
