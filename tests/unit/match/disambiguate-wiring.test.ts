import { test } from "node:test";
import assert from "node:assert/strict";
import { matchAgainstRosterAsync } from "../../../src/match/match.js";

const fakeRoster = [
  { eid: "10000001", name: "Coleman, Renee R" },
  { eid: "10000002", name: "Cohlman, Renee" },
  { eid: "10000003", name: "Smith, Bob" },
];

test("matchAgainstRosterAsync auto-accepts high-confidence matches without calling LLM", async () => {
  let called = false;
  const result = await matchAgainstRosterAsync("Coleman, Renee R", fakeRoster, {
    disambiguator: async () => {
      called = true;
      return { eid: "x", confidence: 1 };
    },
  });
  assert.equal(called, false, "LLM should not be called for >=0.85 matches");
  assert.equal(result.eid, "10000001");
  assert.equal(result.source, "roster");
});

test("matchAgainstRosterAsync sends borderline matches to disambiguator", async () => {
  let called = false;
  // "Renee Coleman" → "Coleman, Renee R" hits the swap tier (~0.85) which
  // is below the 0.99 acceptThreshold, so the LLM gate fires.
  const result = await matchAgainstRosterAsync("Renee Coleman", fakeRoster, {
    acceptThreshold: 0.99,
    disambiguator: async (input) => {
      called = true;
      assert.equal(input.query, "Renee Coleman");
      assert.ok(input.candidates.length > 0);
      return { eid: "10000001", confidence: 0.91 };
    },
  });
  assert.equal(called, true);
  assert.equal(result.eid, "10000001");
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
