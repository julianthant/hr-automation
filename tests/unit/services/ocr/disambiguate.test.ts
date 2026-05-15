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
