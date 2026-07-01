import { test } from "vitest";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod/v4";
import { completeText, completeJson } from "../../../../src/services/llm/complete.js";
import type { TextPoolKey } from "../../../../src/services/llm/text-pool.js";
import { OcrHttpError } from "../../../../src/services/ocr/rate-limit-headers.js";
import { __resetUsageTrackerForTests } from "../../../../src/services/ocr/usage-tracker.js";

const LIMIT = { rpm: 10, tpm: 250_000, rpd: 250, imgTokens: 1000 };

/** A fake pool key whose callText is fully controlled by the test. */
function fakeKey(
  id: string,
  providerId: TextPoolKey["providerId"],
  keyIndex: number,
  models: string[],
  call: TextPoolKey["callText"],
): TextPoolKey {
  return {
    id,
    providerId,
    keyIndex,
    rotationKey: `key-${id}`,
    priority: keyIndex,
    models: models.map((m) => ({ id: m, limit: LIMIT })),
    callText: call,
  };
}

function isolatedDir(): string {
  return mkdtempSync(join(tmpdir(), "llm-complete-"));
}

test("completeText returns the first successful cell's text", async () => {
  __resetUsageTrackerForTests();
  const dir = isolatedDir();
  try {
    const pool = [
      fakeKey("gemini-1", "gemini", 1, ["gemini-2.5-flash"], async (prompt) => ({
        text: `echo:${prompt}`,
        promptTokens: 42,
      })),
    ];
    const out = await completeText({ prompt: "hello", pool, cacheDir: dir });
    assert.ok(out, "expected a result");
    assert.equal(out.text, "echo:hello");
    assert.equal(out.provider, "gemini");
    assert.equal(out.attempts, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("completeText falls through to the next provider when the first is rate-limited", async () => {
  __resetUsageTrackerForTests();
  const dir = isolatedDir();
  const calls: string[] = [];
  try {
    const pool = [
      fakeKey("gemini-1", "gemini", 1, ["gemini-2.5-flash"], async () => {
        calls.push("gemini");
        // 429 with no daily marker → a transient per-minute rate-limit.
        throw new OcrHttpError("gemini", 429, {}, "rate limit exceeded");
      }),
      fakeKey("groq-1", "groq", 1, ["llama"], async (prompt) => {
        calls.push("groq");
        return { text: `groq:${prompt}`, promptTokens: 10 };
      }),
    ];
    const out = await completeText({ prompt: "hi", pool, cacheDir: dir, logTag: "test" });
    assert.ok(out, "expected fall-through to succeed");
    assert.equal(out.text, "groq:hi");
    assert.equal(out.provider, "groq");
    assert.deepEqual(calls, ["gemini", "groq"], "gemini tried first, then groq");
    assert.equal(out.attempts, 2);
    assert.ok(out.attemptedKeys.length >= 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("completeText falls through the model chain on one key before the next key", async () => {
  __resetUsageTrackerForTests();
  const dir = isolatedDir();
  const models: string[] = [];
  try {
    const pool = [
      fakeKey("gemini-1", "gemini", 1, ["primary", "backup"], async (prompt, model) => {
        models.push(model);
        if (model === "primary") throw new OcrHttpError("gemini", 429, {}, "rate limit");
        return { text: `ok:${model}`, promptTokens: 5 };
      }),
    ];
    const out = await completeText({ prompt: "x", pool, cacheDir: dir });
    assert.ok(out);
    assert.equal(out.model, "backup");
    assert.deepEqual(models, ["primary", "backup"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("completeText returns null when every cell is exhausted", async () => {
  __resetUsageTrackerForTests();
  const dir = isolatedDir();
  try {
    const pool = [
      fakeKey("gemini-1", "gemini", 1, ["m"], async () => {
        throw new OcrHttpError("gemini", 429, {}, "rate limit");
      }),
      fakeKey("groq-1", "groq", 1, ["m"], async () => {
        throw new OcrHttpError("groq", 429, {}, "rate limit");
      }),
    ];
    const out = await completeText({ prompt: "x", pool, cacheDir: dir, maxWaitMs: 0 });
    assert.equal(out, null, "no cell could serve → null");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("completeText returns null with an empty pool (no keys configured)", async () => {
  __resetUsageTrackerForTests();
  const out = await completeText({ prompt: "x", pool: [] });
  assert.equal(out, null);
});

test("completeJson validates the reply against the schema", async () => {
  __resetUsageTrackerForTests();
  const dir = isolatedDir();
  try {
    const schema = z.object({ ok: z.boolean(), reason: z.string() });
    const pool = [
      fakeKey("gemini-1", "gemini", 1, ["m"], async () => ({
        text: '```json\n{"ok": true, "reason": "looks fine"}\n```',
      })),
    ];
    const out = await completeJson({ prompt: "check", pool, cacheDir: dir, schema });
    assert.ok(out);
    assert.equal(out.ok, true);
    assert.equal(out.reason, "looks fine");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("completeJson returns null when the reply fails schema validation", async () => {
  __resetUsageTrackerForTests();
  const dir = isolatedDir();
  try {
    const schema = z.object({ ok: z.boolean() });
    const pool = [
      fakeKey("gemini-1", "gemini", 1, ["m"], async () => ({
        text: '{"ok": "not-a-boolean"}',
      })),
    ];
    const out = await completeJson({ prompt: "check", pool, cacheDir: dir, schema });
    assert.equal(out, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
