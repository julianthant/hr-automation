import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  parseDisambiguationResponse,
  buildDisambiguationPrompt,
  disambiguateMatch,
  __setDisambiguateCallForTests,
  __setDisambiguateCacheDirForTests,
} from "../../../../src/services/ocr/disambiguate.js";
import { __resetKeyRotationCacheForTests } from "../../../../src/services/ocr/rotation.js";

test("buildDisambiguationPrompt includes query and candidate names", () => {
  const prompt = buildDisambiguationPrompt({
    query: "Renee Coleman",
    candidates: [
      { eid: "10706431", name: "Coleman, Renee R", score: 0.82 },
      { eid: "10812990", name: "Cohlman, Renee", score: 0.74 },
    ],
  });
  assert.match(prompt, /Renee Coleman/);
  assert.match(prompt, /Coleman, Renee R/);
  assert.match(prompt, /10706431/);
  assert.match(prompt, /Cohlman, Renee/);
});

test("parseDisambiguationResponse extracts EID from JSON-style response", () => {
  const result = parseDisambiguationResponse(
    '{"eid": "10706431", "confidence": 0.95}',
  );
  assert.deepEqual(result, { eid: "10706431", confidence: 0.95 });
});

test("parseDisambiguationResponse returns none for `none` answer", () => {
  const result = parseDisambiguationResponse(
    '{"eid": null, "confidence": 0.0}',
  );
  assert.deepEqual(result, { eid: null, confidence: 0.0 });
});

test("parseDisambiguationResponse handles loose JSON (no surrounding ticks)", () => {
  const result = parseDisambiguationResponse(
    'Sure! {"eid": "10706431", "confidence": 0.9}',
  );
  assert.equal(result.eid, "10706431");
});

test("parseDisambiguationResponse returns null EID on unparseable response", () => {
  const result = parseDisambiguationResponse(
    "I'm not sure who this person is.",
  );
  assert.equal(result.eid, null);
});

test("disambiguateMatch rotates to the next Gemini key after a rate limit", async () => {
  const oldKey1 = process.env.GEMINI_API_KEY;
  const oldKey2 = process.env.GEMINI_API_KEY2;
  const dir = mkdtempSync(join(tmpdir(), "disambiguate-rot-"));
  process.env.GEMINI_API_KEY = "k1";
  process.env.GEMINI_API_KEY2 = "k2";
  __setDisambiguateCacheDirForTests(dir);
  const seen: string[] = [];
  __setDisambiguateCallForTests(async (key) => {
    seen.push(key.value);
    if (key.value === "k1") {
      const err = new Error("429 Too Many Requests");
      throw err;
    }
    return '{"eid":"10800001","confidence":0.91}';
  });
  try {
    const result = await disambiguateMatch({
      query: "Doe Jane",
      candidates: [{ eid: "10800001", name: "Doe, Jane", score: 0.8 }],
    });
    assert.deepEqual(seen, ["k1", "k2"]);
    assert.deepEqual(result, { eid: "10800001", confidence: 0.91 });
  } finally {
    __setDisambiguateCallForTests(undefined);
    __setDisambiguateCacheDirForTests(undefined);
    rmSync(dir, { recursive: true, force: true });
    if (oldKey1 === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = oldKey1;
    if (oldKey2 === undefined) delete process.env.GEMINI_API_KEY2;
    else process.env.GEMINI_API_KEY2 = oldKey2;
  }
});

test("concurrent disambiguation calls share in-memory key throttle state", async () => {
  const oldKey1 = process.env.GEMINI_API_KEY;
  const oldKey2 = process.env.GEMINI_API_KEY2;
  const dir = mkdtempSync(join(tmpdir(), "disambiguate-concurrent-"));
  const firstCallRateLimited = Promise.withResolvers<void>();
  const releaseFirstCall = Promise.withResolvers<void>();
  process.env.GEMINI_API_KEY = "k1";
  process.env.GEMINI_API_KEY2 = "k2";
  __resetKeyRotationCacheForTests();
  __setDisambiguateCacheDirForTests(dir);
  const seenByQuery = new Map<string, string[]>();
  __setDisambiguateCallForTests(async (key, prompt) => {
    const query = prompt.includes('OCR\'d name: "Call A"') ? "A" : "B";
    const seen = seenByQuery.get(query) ?? [];
    seen.push(key.value);
    seenByQuery.set(query, seen);
    if (query === "A" && key.value === "k1") {
      firstCallRateLimited.resolve();
      throw new Error("429 Too Many Requests");
    }
    if (query === "A" && key.value === "k2") {
      await releaseFirstCall.promise;
    }
    return `{"eid":"${query === "A" ? "10800001" : "10800002"}","confidence":0.91}`;
  });
  try {
    const callA = disambiguateMatch({
      query: "Call A",
      candidates: [{ eid: "10800001", name: "Doe, Jane", score: 0.8 }],
    });
    await firstCallRateLimited.promise;
    const callB = disambiguateMatch({
      query: "Call B",
      candidates: [{ eid: "10800002", name: "Roe, Janet", score: 0.8 }],
    });
    const resultB = await callB;
    releaseFirstCall.resolve();
    const resultA = await callA;

    assert.deepEqual(seenByQuery.get("B"), ["k2"]);
    assert.deepEqual(resultA, { eid: "10800001", confidence: 0.91 });
    assert.deepEqual(resultB, { eid: "10800002", confidence: 0.91 });
  } finally {
    releaseFirstCall.resolve();
    __setDisambiguateCallForTests(undefined);
    __setDisambiguateCacheDirForTests(undefined);
    __resetKeyRotationCacheForTests();
    rmSync(dir, { recursive: true, force: true });
    if (oldKey1 === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = oldKey1;
    if (oldKey2 === undefined) delete process.env.GEMINI_API_KEY2;
    else process.env.GEMINI_API_KEY2 = oldKey2;
  }
});
