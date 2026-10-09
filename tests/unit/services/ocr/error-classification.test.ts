import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { classifyOcrError } from "../../../../src/services/ocr/error-classification.js";
import { OcrProviderError } from "../../../../src/services/ocr/types.js";

describe("classifyOcrError", () => {
  it("maps provider error kinds to shared classes", () => {
    assert.equal(
      classifyOcrError(new OcrProviderError("429", "rate-limit", 429)),
      "rate-limit",
    );
    assert.equal(
      classifyOcrError(new OcrProviderError("quota", "quota-exhausted")),
      "quota-exhausted",
    );
    assert.equal(
      classifyOcrError(new OcrProviderError("invalid api key", "auth", 401)),
      "auth",
    );
    assert.equal(
      classifyOcrError(new OcrProviderError("network", "transient")),
      "transient",
    );
    assert.equal(
      classifyOcrError(new OcrProviderError("mystery", "unknown")),
      "permanent",
    );
  });

  it("classifies raw provider messages", () => {
    assert.equal(classifyOcrError(new Error("429 Too Many Requests")), "rate-limit");
    assert.equal(classifyOcrError(new Error("quota exhausted")), "quota-exhausted");
    assert.equal(classifyOcrError(new Error("401 invalid api key")), "auth");
    assert.equal(classifyOcrError(new Error("ECONNRESET")), "transient");
    assert.equal(classifyOcrError(new Error("schema was weird")), "permanent");
  });
});
