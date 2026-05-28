import { describe, it } from "vitest";
import assert from "node:assert/strict";
import {
  PersonLookupEidInputSchema,
  PersonLookupItemSchema,
  PersonLookupNameInputSchema,
  buildPersonLookupCliInput,
  derivePersonLookupItemId,
  isEidInput,
} from "../../../../src/workflows/person-lookup/schema.js";

describe("PersonLookupItemSchema", () => {
  it("accepts a name input", () => {
    const parsed = PersonLookupNameInputSchema.parse({ name: "Zaw, Hein Thant" });
    assert.deepEqual(parsed, { name: "Zaw, Hein Thant" });
  });

  it("accepts an EID input", () => {
    const parsed = PersonLookupEidInputSchema.parse({ emplId: "10706431" });
    assert.deepEqual(parsed, { emplId: "10706431" });
  });

  it("rejects non-numeric or too-short EIDs", () => {
    assert.throws(() => PersonLookupEidInputSchema.parse({ emplId: "abc" }));
    assert.throws(() => PersonLookupEidInputSchema.parse({ emplId: "1234" }));
  });

  it("preserves keepNonHdh on both input shapes", () => {
    assert.equal(PersonLookupNameInputSchema.parse({ name: "Zaw, Hein", keepNonHdh: true }).keepNonHdh, true);
    assert.equal(PersonLookupEidInputSchema.parse({ emplId: "10706431", keepNonHdh: true }).keepNonHdh, true);
  });

  it("discriminates name and EID inputs", () => {
    assert.equal(isEidInput(PersonLookupItemSchema.parse({ name: "Zaw, Hein" })), false);
    assert.equal(isEidInput(PersonLookupItemSchema.parse({ emplId: "10706431" })), true);
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
