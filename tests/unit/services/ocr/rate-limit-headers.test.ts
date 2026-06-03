import { describe, it } from "vitest";
import assert from "node:assert/strict";
import {
  OcrHttpError,
  classifyResponse,
  errorToRateLimitInfo,
  parseGoDuration,
  parseRetryAfter,
} from "../../../../src/services/ocr/rate-limit-headers.js";

describe("parseRetryAfter", () => {
  const now = 1_700_000_000_000;
  it("parses integer seconds", () => {
    assert.equal(parseRetryAfter("5", now), 5_000);
    assert.equal(parseRetryAfter("0", now), 0);
  });
  it("parses an HTTP date relative to now", () => {
    const future = new Date(now + 30_000).toUTCString();
    const ms = parseRetryAfter(future, now);
    assert.ok(ms != null && Math.abs(ms - 30_000) < 1_500);
  });
  it("returns undefined for missing/garbage", () => {
    assert.equal(parseRetryAfter(undefined, now), undefined);
    assert.equal(parseRetryAfter("soon", now), undefined);
  });
});

describe("parseGoDuration", () => {
  it("parses bare seconds and unit strings", () => {
    assert.equal(parseGoDuration("30s"), 30_000);
    assert.equal(parseGoDuration("0.5s"), 500);
    assert.equal(parseGoDuration("500ms"), 500);
    assert.equal(parseGoDuration("1m30s"), 90_000);
    assert.equal(parseGoDuration("49m30s"), 49 * 60_000 + 30_000);
    assert.equal(parseGoDuration("12"), 12_000); // bare number = seconds
  });
  it("returns undefined for empty/garbage", () => {
    assert.equal(parseGoDuration(undefined), undefined);
    assert.equal(parseGoDuration("nope"), undefined);
  });
});

describe("classifyResponse — gemini", () => {
  const now = 1_700_000_000_000;
  it("parses RetryInfo.retryDelay on a short rate-limit 429", () => {
    const body = JSON.stringify({
      error: {
        code: 429,
        status: "RESOURCE_EXHAUSTED",
        details: [
          { "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "RATE_LIMIT_EXCEEDED", metadata: { quota_metric: "generate_content_requests" } },
          { "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "30s" },
        ],
      },
    });
    const r = classifyResponse("gemini", { status: 429, body }, now);
    assert.equal(r.kind, "rate-limit");
    assert.equal(r.retryAfterMs, 30_000);
  });
  it("classifies a long retry / daily metric as quota-exhausted", () => {
    const body = JSON.stringify({
      error: {
        code: 429,
        status: "RESOURCE_EXHAUSTED",
        details: [
          { "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "QUOTA_EXHAUSTED", metadata: { quota_metric: "generate_content_free_tier_requests_per_day" } },
          { "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "2970s" },
        ],
      },
    });
    const r = classifyResponse("gemini", { status: 429, body }, now);
    assert.equal(r.kind, "quota-exhausted");
    assert.equal(r.retryAfterMs, 2_970_000);
  });
  it("maps 503 to transient and 401 to auth", () => {
    assert.equal(classifyResponse("gemini", { status: 503, body: "overloaded" }, now).kind, "transient");
    assert.equal(classifyResponse("gemini", { status: 401, body: "bad key" }, now).kind, "auth");
  });
});

describe("classifyResponse — OpenAI-compatible", () => {
  const now = 1_700_000_000_000;
  it("reads the retry-after header on a 429", () => {
    const r = classifyResponse("groq", { status: 429, headers: { "retry-after": "12" }, body: "{}" }, now);
    assert.equal(r.kind, "rate-limit");
    assert.equal(r.retryAfterMs, 12_000);
  });
  it("treats a limit_rpd body as a daily wall", () => {
    const r = classifyResponse("openrouter", { status: 429, headers: {}, body: '{"error":{"message":"limit_rpd/free"}}' }, now);
    assert.equal(r.kind, "quota-exhausted");
  });
  it("maps 402 to quota-exhausted, 401 to auth, 503 to transient", () => {
    assert.equal(classifyResponse("openrouter", { status: 402, body: "no credits" }, now).kind, "quota-exhausted");
    assert.equal(classifyResponse("mistral", { status: 401, body: "bad" }, now).kind, "auth");
    assert.equal(classifyResponse("sambanova", { status: 503, body: "down" }, now).kind, "transient");
  });
});

describe("errorToRateLimitInfo", () => {
  it("delegates to classifyResponse for an OcrHttpError", () => {
    const err = new OcrHttpError("groq", 429, { "retry-after": "7" }, "{}");
    const r = errorToRateLimitInfo("groq", err, 1_700_000_000_000);
    assert.equal(r.kind, "rate-limit");
    assert.equal(r.retryAfterMs, 7_000);
  });
  it("classifies a plain Error by message", () => {
    assert.equal(errorToRateLimitInfo("gemini", new Error("429 Too Many Requests")).kind, "rate-limit");
    assert.equal(errorToRateLimitInfo("gemini", new Error("invalid api key")).kind, "auth");
    assert.equal(errorToRateLimitInfo("gemini", new Error("ECONNRESET")).kind, "transient");
  });
});
