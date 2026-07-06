import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { withTimeout, TimeoutError } from "../../../src/utils/with-timeout.js";

describe("withTimeout", () => {
  it("resolves with the inner value when it settles before the deadline", async () => {
    const result = await withTimeout(Promise.resolve("done"), 50, "test-op");
    assert.equal(result, "done");
  });

  it("rejects with the inner rejection reason when it rejects before the deadline", async () => {
    const boom = new Error("inner failure");
    await assert.rejects(
      withTimeout(Promise.reject(boom), 50, "test-op"),
      (err) => err === boom,
    );
  });

  it("rejects with TimeoutError naming the label + ms when the inner promise never settles", async () => {
    const never = new Promise<void>(() => {
      /* deliberately never resolves/rejects */
    });
    await assert.rejects(
      withTimeout(never, 10, "hung-op"),
      (err) => {
        assert.ok(err instanceof TimeoutError, `expected TimeoutError, got ${err}`);
        assert.match((err as Error).message, /hung-op/);
        assert.match((err as Error).message, /10ms/);
        return true;
      },
    );
  });

  it("does not fire the timeout after the inner promise already resolved (no dangling rejection)", async () => {
    const result = await withTimeout(Promise.resolve(42), 20, "fast-op");
    assert.equal(result, 42);
    // Give the (cleared) timer a chance to fire if clearTimeout didn't work —
    // if it did, no unhandled rejection / process crash occurs.
    await new Promise((r) => setTimeout(r, 40));
  });
});
