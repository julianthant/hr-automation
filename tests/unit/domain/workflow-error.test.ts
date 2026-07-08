import { describe, it } from "vitest";
import assert from "node:assert/strict";

import { WorkflowError } from "../../../src/domain/workflow-error.js";
import { RetryPageError } from "../../../src/workflows/ocr/retry-page.js";
import { EmplIdNotRecognizedError } from "../../../src/workflows/separations/steps/ucpath-transaction.js";

describe("WorkflowError", () => {
  it("is a real Error subclass carrying an optional code", () => {
    const err = new WorkflowError("boom", "some-code");
    assert.ok(err instanceof Error);
    assert.ok(err instanceof WorkflowError);
    assert.equal(err.message, "boom");
    assert.equal(err.code, "some-code");
    assert.equal(err.name, "WorkflowError");
  });

  it("allows an undefined code for instanceof-only discrimination", () => {
    const err = new WorkflowError("boom");
    assert.equal(err.code, undefined);
  });
});

describe("RetryPageError (migrated to WorkflowError)", () => {
  it("is both a WorkflowError and an Error, and preserves its code + name", () => {
    const err = new RetryPageError("row-not-found", "No OCR row for sessionId=abc runId=def");
    assert.ok(err instanceof Error);
    assert.ok(err instanceof WorkflowError);
    assert.ok(err instanceof RetryPageError);
    assert.equal(err.code, "row-not-found");
    assert.equal(err.name, "RetryPageError");
    assert.equal(err.message, "No OCR row for sessionId=abc runId=def");
  });
});

describe("EmplIdNotRecognizedError (migrated to WorkflowError)", () => {
  it("is both a WorkflowError and an Error, and builds its own message", () => {
    const err = new EmplIdNotRecognizedError("10526678", "Sanchez, Raquel");
    assert.ok(err instanceof Error);
    assert.ok(err instanceof WorkflowError);
    assert.ok(err instanceof EmplIdNotRecognizedError);
    assert.equal(err.name, "EmplIdNotRecognizedError");
    assert.equal(err.code, undefined);
    assert.match(err.message, /10526678/);
    assert.match(err.message, /Sanchez, Raquel/);
  });
});
