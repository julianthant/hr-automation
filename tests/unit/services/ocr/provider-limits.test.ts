import { describe, it, afterEach } from "vitest";
import assert from "node:assert/strict";
import {
  providerConfig,
  resolveModelChain,
  visionProviderConfigs,
} from "../../../../src/services/ocr/provider-limits.js";

describe("visionProviderConfigs", () => {
  it("orders providers by priority with Gemini first", () => {
    const cfgs = visionProviderConfigs();
    assert.equal(cfgs[0].id, "gemini");
    assert.equal(cfgs[0].priority, 1);
    const ids = cfgs.map((c) => c.id);
    assert.deepEqual(ids, ["gemini", "groq", "mistral", "openrouter", "sambanova"]);
    // Gemini uses the native SDK path (no OpenAI-compat endpoint); others have one.
    assert.equal(providerConfig("gemini")!.endpoint, undefined);
    assert.ok(providerConfig("groq")!.endpoint?.includes("groq.com"));
  });
});

describe("resolveModelChain", () => {
  const ENV_KEYS = ["OCR_GEMINI_MODELS", "OCR_GEMINI_MODEL"];
  afterEach(() => {
    for (const k of ENV_KEYS) delete process.env[k];
  });

  it("returns the built-in chain by default (primary first)", () => {
    const chain = resolveModelChain(providerConfig("gemini")!);
    assert.equal(chain[0].id, "gemini-2.5-flash");
    assert.ok(chain.length >= 3, "Gemini ships a multi-model fallback chain");
  });

  it("honors a comma-separated OCR_<PROVIDER>_MODELS override in order", () => {
    process.env.OCR_GEMINI_MODELS = "gemini-2.5-flash-lite, gemini-3.5-flash";
    const chain = resolveModelChain(providerConfig("gemini")!);
    assert.deepEqual(chain.map((m) => m.id), ["gemini-2.5-flash-lite", "gemini-3.5-flash"]);
    // Limits come from the table for known ids.
    assert.equal(chain[0].limit.rpd, 1000);
  });

  it("honors the legacy single OCR_<PROVIDER>_MODEL var", () => {
    process.env.OCR_GEMINI_MODEL = "gemini-3.5-flash";
    const chain = resolveModelChain(providerConfig("gemini")!);
    assert.deepEqual(chain.map((m) => m.id), ["gemini-3.5-flash"]);
  });

  it("falls back to the primary's limit for an unknown model id", () => {
    process.env.OCR_GEMINI_MODELS = "some-future-model";
    const chain = resolveModelChain(providerConfig("gemini")!);
    assert.equal(chain.length, 1);
    assert.equal(chain[0].id, "some-future-model");
    assert.ok(chain[0].limit.imgTokens > 0, "synthesized a usable fallback limit");
  });
});
