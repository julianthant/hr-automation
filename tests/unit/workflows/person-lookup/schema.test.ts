import { describe, it } from "vitest";
import assert from "node:assert/strict";
import {
  buildPersonLookupCliInput,
  derivePersonLookupItemId,
  normalizeName,
  PersonLookupItemSchema,
  PersonLookupNameInputSchema,
  PersonLookupEidInputSchema,
  isEidInput,
} from "../../../../src/workflows/person-lookup/schema.js";

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
    assert.equal(normalizeName("o'brien-smith, jane"), "O'Brien-Smith, Jane");
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

  it("display-normalizes names without a comma", () => {
    assert.equal(normalizeName("plain string"), "Plain String");
  });

  it("returns input unchanged if only last name given", () => {
    assert.equal(normalizeName("smith,"), "smith,");
    assert.equal(normalizeName(",john"), ",john");
  });
});

describe("PersonLookupItemSchema", () => {
  it("PersonLookupNameInputSchema accepts a name string", () => {
    const parsed = PersonLookupNameInputSchema.parse({ name: "Coleman, Renee" });
    assert.equal(parsed.name, "Coleman, Renee");
  });

  it("PersonLookupNameInputSchema rejects empty name", () => {
    assert.throws(() => PersonLookupNameInputSchema.parse({ name: "" }));
  });

  it("PersonLookupEidInputSchema accepts a UCPath EID", () => {
    const parsed = PersonLookupEidInputSchema.parse({ emplId: "10706431" });
    assert.equal(parsed.emplId, "10706431");
  });

  it("PersonLookupEidInputSchema rejects non-numeric Empl ID", () => {
    assert.throws(() => PersonLookupEidInputSchema.parse({ emplId: "abc" }));
  });

  it("PersonLookupEidInputSchema rejects too-short Empl ID", () => {
    assert.throws(() => PersonLookupEidInputSchema.parse({ emplId: "1234" }));
  });

  it("PersonLookupItemSchema accepts both shapes via union", () => {
    PersonLookupItemSchema.parse({ name: "Smith, Bob" });
    PersonLookupItemSchema.parse({ emplId: "10812990" });
  });

  it("isEidInput discriminates the union", () => {
    assert.equal(isEidInput(PersonLookupItemSchema.parse({ name: "Smith, Bob" })), false);
    assert.equal(isEidInput(PersonLookupItemSchema.parse({ emplId: "10706431" })), true);
  });

  it("keepNonHdh flag carries through both shapes", () => {
    const n = PersonLookupNameInputSchema.parse({
      name: "Coleman, Renee",
      keepNonHdh: true,
    });
    const e = PersonLookupEidInputSchema.parse({
      emplId: "10706431",
      keepNonHdh: true,
    });
    assert.equal(n.keepNonHdh, true);
    assert.equal(e.keepNonHdh, true);
  });

  it("includeCrmDates is optional — omitting it still parses both shapes", () => {
    const n = PersonLookupNameInputSchema.parse({ name: "Coleman, Renee" });
    const e = PersonLookupEidInputSchema.parse({ emplId: "10706431" });
    assert.equal(n.includeCrmDates, undefined);
    assert.equal(e.includeCrmDates, undefined);
  });

  it("includeCrmDates: true is accepted on name input", () => {
    const n = PersonLookupNameInputSchema.parse({
      name: "Coleman, Renee",
      includeCrmDates: true,
    });
    assert.equal(n.includeCrmDates, true);
  });

  it("includeCrmDates: true is accepted on EID input", () => {
    const e = PersonLookupEidInputSchema.parse({
      emplId: "10706431",
      includeCrmDates: true,
    });
    assert.equal(e.includeCrmDates, true);
  });

  it("includeCrmDates: false is accepted on both shapes", () => {
    const n = PersonLookupNameInputSchema.parse({
      name: "Coleman, Renee",
      includeCrmDates: false,
    });
    const e = PersonLookupEidInputSchema.parse({
      emplId: "10706431",
      includeCrmDates: false,
    });
    assert.equal(n.includeCrmDates, false);
    assert.equal(e.includeCrmDates, false);
  });

  it("includeCrmDates carries through the union schema", () => {
    const n = PersonLookupItemSchema.parse({ name: "Smith, Bob", includeCrmDates: true });
    const e = PersonLookupItemSchema.parse({ emplId: "10812990", includeCrmDates: true });
    assert.equal(n.includeCrmDates, true);
    assert.equal(e.includeCrmDates, true);
  });
});

describe("derivePersonLookupItemId", () => {
  it("uses the EID as the stable item id for EID inputs", () => {
    assert.equal(derivePersonLookupItemId({ emplId: "10706431" }), "10706431");
  });

  it("uses the display name as the stable item id for name inputs", () => {
    assert.equal(derivePersonLookupItemId({ name: "zaw, hein thant" }), "Zaw, Hein Thant");
  });
});

describe("buildPersonLookupCliInput", () => {
  it("routes digit-only queries through EID validation only when they normalize to a UCPath EID", () => {
    assert.deepEqual(buildPersonLookupCliInput("10706431"), { emplId: "10706431" });
    assert.deepEqual(buildPersonLookupCliInput("10-706431"), { emplId: "10-706431" });
    assert.deepEqual(buildPersonLookupCliInput(" 10870001 "), { emplId: " 10870001 " });
  });

  it("treats short or non-10xxxxxx digit strings as name queries", () => {
    assert.deepEqual(buildPersonLookupCliInput("12345"), { name: "12345" });
    assert.deepEqual(buildPersonLookupCliInput("20706431"), { name: "20706431" });
  });

  it("never treats strings with letters as bare EID queries", () => {
    assert.deepEqual(buildPersonLookupCliInput("Room 101"), { name: "Room 101" });
    assert.deepEqual(buildPersonLookupCliInput("Zaw, Hein Thant"), { name: "Zaw, Hein Thant" });
  });
});
