import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  OcrAllKeysExhaustedError,
  OcrValidationError,
  OcrProviderError,
} from "../../../src/ocr/types.js";

describe("OCR error classes", () => {
  it("OcrAllKeysExhaustedError carries provider + count", () => {
    const err = new OcrAllKeysExhaustedError("gemini", 6);
    assert.equal(err.name, "OcrAllKeysExhaustedError");
    assert.match(err.message, /6.*gemini.*exhausted/i);
    assert.equal(err.providerId, "gemini");
    assert.equal(err.keyCount, 6);
  });

  it("OcrValidationError carries the zod issues", () => {
    const err = new OcrValidationError("schema mismatch", {
      issues: [{ path: ["a", 0], message: "Required" }],
    });
    assert.equal(err.name, "OcrValidationError");
    assert.equal(err.zodResult.issues.length, 1);
  });

  it("OcrProviderError carries the kind + optional status", () => {
    const e1 = new OcrProviderError("hot key", "rate-limit", 429);
    assert.equal(e1.kind, "rate-limit");
    assert.equal(e1.httpStatus, 429);
    const e2 = new OcrProviderError("network blip", "transient");
    assert.equal(e2.kind, "transient");
    assert.equal(e2.httpStatus, undefined);
  });
});
