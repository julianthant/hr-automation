import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeName,
  EidLookupItemSchema,
  EidLookupNameInputSchema,
  EidLookupEidInputSchema,
  isEidInput,
} from "../../../../src/workflows/eid-lookup/schema.js";

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

describe("EidLookupItemSchema (discriminated union)", () => {
  it("EidLookupNameInputSchema accepts a name string", () => {
    const parsed = EidLookupNameInputSchema.parse({ name: "Coleman, Renee" });
    assert.equal(parsed.name, "Coleman, Renee");
  });

  it("EidLookupNameInputSchema rejects empty name", () => {
    assert.throws(() => EidLookupNameInputSchema.parse({ name: "" }));
  });

  it("EidLookupEidInputSchema accepts a 5+ digit Empl ID", () => {
    const parsed = EidLookupEidInputSchema.parse({ emplId: "10706431" });
    assert.equal(parsed.emplId, "10706431");
  });

  it("EidLookupEidInputSchema rejects non-numeric Empl ID", () => {
    assert.throws(() => EidLookupEidInputSchema.parse({ emplId: "abc" }));
  });

  it("EidLookupEidInputSchema rejects too-short Empl ID", () => {
    assert.throws(() => EidLookupEidInputSchema.parse({ emplId: "1234" }));
  });

  it("EidLookupItemSchema accepts both shapes via union", () => {
    EidLookupItemSchema.parse({ name: "Smith, Bob" });
    EidLookupItemSchema.parse({ emplId: "10812990" });
  });

  it("isEidInput discriminates the union", () => {
    assert.equal(isEidInput({ name: "Smith, Bob" }), false);
    assert.equal(isEidInput({ emplId: "10706431" }), true);
  });

  it("keepNonHdh flag carries through both shapes", () => {
    const n = EidLookupNameInputSchema.parse({
      name: "Coleman, Renee",
      keepNonHdh: true,
    });
    const e = EidLookupEidInputSchema.parse({
      emplId: "10706431",
      keepNonHdh: true,
    });
    assert.equal(n.keepNonHdh, true);
    assert.equal(e.keepNonHdh, true);
  });
});
