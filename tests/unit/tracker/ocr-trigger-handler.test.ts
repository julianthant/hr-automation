import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { buildOcrTriggerHandler } from "../../../src/tracker/dashboard/ocr/trigger-handler.js";

// BM-6: the shared OCR operator-trigger HTTP handler factory. These pin the
// validate → (override ?? run) → onSuccess/mapError → lock contract that
// force-research / verify-relookup / retry-page now share.

interface Body {
  ok: boolean;
  error?: string;
  value?: number;
}

describe("buildOcrTriggerHandler", () => {
  it("rejects with 400 + onError when validation fails (run is never called)", async () => {
    let ran = false;
    const handler = buildOcrTriggerHandler<{ x: number }, number, Body>({
      validate: (i) => (i.x < 0 ? "bad x" : null),
      run: async () => { ran = true; return 1; },
      onSuccess: (v) => ({ ok: true, value: v }),
      onError: (error) => ({ ok: false, error }),
    });
    const r = await handler({ x: -1 });
    assert.equal(r.status, 400);
    assert.deepEqual(r.body, { ok: false, error: "bad x" });
    assert.equal(ran, false);
  });

  it("runs the real target when no override is configured", async () => {
    const handler = buildOcrTriggerHandler<{ x: number }, number, Body>({
      validate: () => null,
      run: async (i) => i.x * 2,
      onSuccess: (v) => ({ ok: true, value: v }),
      onError: (error) => ({ ok: false, error }),
    });
    const r = await handler({ x: 21 });
    assert.deepEqual(r, { status: 200, body: { ok: true, value: 42 } });
  });

  it("uses the override instead of run when configured", async () => {
    let ranReal = false;
    const handler = buildOcrTriggerHandler<{ x: number }, number, Body>({
      validate: () => null,
      override: (i) => Promise.resolve(i.x + 100),
      run: async () => { ranReal = true; return -1; },
      onSuccess: (v) => ({ ok: true, value: v }),
      onError: (error) => ({ ok: false, error }),
    });
    const r = await handler({ x: 5 });
    assert.deepEqual(r.body, { ok: true, value: 105 });
    assert.equal(ranReal, false);
  });

  it("maps a thrown error via mapError, falling through to 400 on null", async () => {
    class CodedError extends Error {
      constructor(public code: string) { super(code); }
    }
    const handler = buildOcrTriggerHandler<{ which: string }, number, Body>({
      validate: () => null,
      run: async (i) => { throw i.which === "coded" ? new CodedError("nope") : new Error("plain boom"); },
      onSuccess: (v) => ({ ok: true, value: v }),
      onError: (error) => ({ ok: false, error }),
      mapError: (err) => (err instanceof CodedError ? { status: 410, body: { ok: false, error: err.code } } : null),
    });
    const coded = await handler({ which: "coded" });
    assert.equal(coded.status, 410);
    assert.deepEqual(coded.body, { ok: false, error: "nope" });
    const plain = await handler({ which: "plain" });
    assert.equal(plain.status, 400);
    assert.deepEqual(plain.body, { ok: false, error: "plain boom" });
  });

  it("short-circuits with onLocked when the row lock is held, and releases after running", async () => {
    const held = new Set<string>();
    const handler = buildOcrTriggerHandler<{ id: string }, number, Body>({
      validate: () => null,
      run: async () => 1,
      onSuccess: (v) => ({ ok: true, value: v }),
      onError: (error) => ({ ok: false, error }),
      lock: {
        key: (i) => i.id,
        isHeld: (k) => held.has(k),
        acquire: (k) => held.add(k),
        release: (k) => held.delete(k),
        onLocked: () => ({ status: 409, body: { ok: false, error: "locked" } }),
      },
    });
    const r1 = await handler({ id: "row-1" });
    assert.equal(r1.status, 200);
    assert.equal(held.size, 0, "lock released after a successful run");

    held.add("row-2");
    const r2 = await handler({ id: "row-2" });
    assert.equal(r2.status, 409);
    assert.deepEqual(r2.body, { ok: false, error: "locked" });
  });

  it("releases the lock even when the run throws", async () => {
    const held = new Set<string>();
    const handler = buildOcrTriggerHandler<{ id: string }, number, Body>({
      validate: () => null,
      run: async () => { throw new Error("boom"); },
      onSuccess: (v) => ({ ok: true, value: v }),
      onError: (error) => ({ ok: false, error }),
      lock: {
        key: (i) => i.id,
        isHeld: (k) => held.has(k),
        acquire: (k) => held.add(k),
        release: (k) => held.delete(k),
        onLocked: () => ({ status: 409, body: { ok: false, error: "locked" } }),
      },
    });
    const r = await handler({ id: "row-3" });
    assert.equal(r.status, 400);
    assert.equal(held.size, 0, "lock released after a thrown run");
  });
});
