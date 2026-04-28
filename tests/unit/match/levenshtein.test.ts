import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { levenshteinDistance } from "../../../src/match/levenshtein.js";

describe("levenshteinDistance", () => {
  it("returns 0 for identical strings", () => {
    assert.equal(levenshteinDistance("hello", "hello"), 0);
  });
  it("returns 1 for single substitution", () => {
    assert.equal(levenshteinDistance("tomako", "tomoko"), 1);
  });
  it("returns 2 for two substitutions across full name", () => {
    assert.equal(levenshteinDistance("tomako langley", "tomoko longley"), 2);
  });
  it("returns >= 3 for three character changes", () => {
    assert.ok(levenshteinDistance("alice", "bobce") >= 3);
  });
  it("handles different lengths (insertion)", () => {
    assert.equal(levenshteinDistance("foo", "fooo"), 1);
  });
  it("handles empty input", () => {
    assert.equal(levenshteinDistance("", "abc"), 3);
    assert.equal(levenshteinDistance("abc", ""), 3);
    assert.equal(levenshteinDistance("", ""), 0);
  });
});
