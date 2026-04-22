import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { normalizeName } from "../../../../src/workflows/eid-lookup/schema.js";

describe("normalizeName", () => {
  it("title-cases all-lowercase input", () => {
    assert.equal(normalizeName("zaw, hein thant"), "Zaw, Hein Thant");
  });

  it("title-cases all-uppercase input", () => {
    assert.equal(normalizeName("SMITH, JOHN MICHAEL"), "Smith, John Michael");
  });

  it("title-cases mixed-case input", () => {
    assert.equal(normalizeName("mCdOnAlD, BoB"), "Mcdonald, Bob");
  });

  it("preserves hyphenated last names", () => {
    assert.equal(normalizeName("o'brien-smith, jane"), "O'brien-smith, Jane");
  });

  it("trims surrounding whitespace and collapses internal spaces", () => {
    assert.equal(normalizeName("  smith  ,   john   michael  "), "Smith, John Michael");
  });

  it("normalizes separator to ', ' (comma + single space)", () => {
    assert.equal(normalizeName("smith ,john"), "Smith, John");
    assert.equal(normalizeName("smith,john"), "Smith, John");
  });

  it("handles single-word first name (no middle)", () => {
    assert.equal(normalizeName("smith, john"), "Smith, John");
  });

  it("is idempotent", () => {
    const once = normalizeName("zaw, hein thant");
    const twice = normalizeName(once);
    assert.equal(once, twice);
  });

  it("returns input unchanged if format is invalid (no comma)", () => {
    assert.equal(normalizeName("plain string"), "plain string");
  });

  it("returns input unchanged if only last name given", () => {
    assert.equal(normalizeName("smith,"), "smith,");
    assert.equal(normalizeName(",john"), ",john");
  });
});
