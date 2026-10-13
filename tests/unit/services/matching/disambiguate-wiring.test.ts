import { privateValue } from "../../../../src/private-data.js";
import { test } from "vitest";
import assert from "node:assert/strict";
import { matchAgainstRosterAsync } from "../../../../src/services/matching/match.js";

const fakeRoster = [
  { eid: privateValue("id:dfa73f9264a72c07"), name: privateValue("name:952c7413af9733c9") + " R" },
  { eid: "10000002", name: "Cohlman, Renee" },
  { eid: "10000003", name: "Smith, Bob" },
];

test("matchAgainstRosterAsync auto-accepts high-confidence matches without calling LLM", async () => {
  let called = false;
  const result = await matchAgainstRosterAsync(privateValue("name:952c7413af9733c9") + " R", fakeRoster, {
    disambiguator: async () => {
      called = true;
      return { eid: "x", confidence: 1 };
    },
  });
  assert.equal(called, false, "LLM should not be called for >=0.85 matches");
  assert.equal(result.eid, privateValue("id:dfa73f9264a72c07"));
  assert.equal(result.source, "roster");
});

test("matchAgainstRosterAsync sends borderline matches to disambiguator", async () => {
  let called = false;
  // "name:90e2a9a138da09ef" → "name:952c7413af9733c9 R" hits the swap tier (~0.85) which
  // is below the 0.99 acceptThreshold, so the LLM gate fires.
  const result = await matchAgainstRosterAsync(privateValue("name:90e2a9a138da09ef"), fakeRoster, {
    acceptThreshold: 0.99,
    disambiguator: async (input) => {
      called = true;
      assert.equal(input.query, privateValue("name:90e2a9a138da09ef"));
      assert.ok(input.candidates.length > 0);
      return { eid: privateValue("id:dfa73f9264a72c07"), confidence: 0.91 };
    },
  });
  assert.equal(called, true);
  assert.equal(result.eid, privateValue("id:dfa73f9264a72c07"));
  assert.equal(result.source, "llm");
  assert.equal(result.confidence, 0.91);
});

test("matchAgainstRosterAsync returns null for very-low scores without LLM call", async () => {
  let called = false;
  const result = await matchAgainstRosterAsync("Xyzzy Plugh", fakeRoster, {
    disambiguator: async () => {
      called = true;
      return { eid: null, confidence: 0 };
    },
  });
  assert.equal(called, false);
  assert.equal(result.eid, null);
  assert.equal(result.source, "roster");
});

test("matchAgainstRosterAsync respects disambiguateThreshold for the LLM gate", async () => {
  let called = false;
  // "Smyth, Bob" → "Smith, Bob" hits the fuzzy tier (Levenshtein 1, ~0.7)
  // which is below the 0.95 acceptThreshold but above the 0.5 LLM gate.
  await matchAgainstRosterAsync("Smyth, Bob", fakeRoster, {
    acceptThreshold: 0.95,
    disambiguateThreshold: 0.5,
    disambiguator: async () => {
      called = true;
      return { eid: "10000003", confidence: 0.9 };
    },
  });
  assert.equal(called, true);
});

test("matchAgainstRosterAsync returns null EID + source: 'roster' when LLM declines", async () => {
  // Force borderline via fuzzy tier ("Smyth, Bob" → ~0.7 against "Smith, Bob")
  const result = await matchAgainstRosterAsync("Smyth, Bob", fakeRoster, {
    acceptThreshold: 0.95,
    disambiguator: async () => ({ eid: null, confidence: 0 }),
  });
  assert.equal(result.eid, null);
  assert.equal(result.source, "roster");
});
