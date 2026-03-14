import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { TransactionError } from "../../src/ucpath/types.js";

describe("TransactionError", () => {
  it("has name 'TransactionError'", () => {
    const err = new TransactionError("something failed");
    assert.equal(err.name, "TransactionError");
  });

  it("carries the message", () => {
    const err = new TransactionError("step failed");
    assert.equal(err.message, "step failed");
  });

  it("is an instance of Error", () => {
    const err = new TransactionError("test");
    assert.ok(err instanceof Error);
  });

  it("step is undefined when not provided", () => {
    const err = new TransactionError("no step");
    assert.equal(err.step, undefined);
  });

  it("step carries the step name where failure occurred", () => {
    const err = new TransactionError("failed at nav", "Navigate to Smart HR");
    assert.equal(err.step, "Navigate to Smart HR");
  });
});
