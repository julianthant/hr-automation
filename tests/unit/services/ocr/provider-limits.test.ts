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

  it("rejects an unknown model id instead of trusting synthesized limits", () => {
    process.env.OCR_GEMINI_MODELS = "some-future-model";
    assert.throws(
      () => resolveModelChain(providerConfig("gemini")!),
      /unknown.*some-future-model.*gemini/i,
    );
  });

  it("requires every tier-1 registry model to be explicitly benchmarked", () => {
    for (const provider of visionProviderConfigs()) {
      for (const model of provider.models) {
        assert.ok(model.tier === 1 || model.tier === 2);
        if (model.tier === 1) assert.equal(model.trust, "benchmarked");
      }
    }
  });
});
