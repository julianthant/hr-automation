import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseDisambiguationResponse,
  buildDisambiguationPrompt,
} from "../../../src/ocr/disambiguate.js";

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
