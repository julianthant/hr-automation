import { describe, it } from "vitest";
import assert from "node:assert/strict";
import {
  ActiveCheckEidInputSchema,
  ActiveCheckItemSchema,
  ActiveCheckNameInputSchema,
  buildActiveCheckCliInput,
  deriveActiveCheckItemId,
  isActiveCheckEidInput,
} from "../../../../src/workflows/active-check/schema.js";

describe("ActiveCheckItemSchema", () => {
  it("accepts a name input", () => {
    const parsed = ActiveCheckNameInputSchema.parse({ name: "Zaw, Hein Thant" });
    assert.deepEqual(parsed, { name: "Zaw, Hein Thant" });
  });

  it("accepts an EID input", () => {
    const parsed = ActiveCheckEidInputSchema.parse({ emplId: "10706431" });
    assert.deepEqual(parsed, { emplId: "10706431" });
  });

  it("rejects non-numeric or too-short EIDs", () => {
    assert.throws(() => ActiveCheckEidInputSchema.parse({ emplId: "abc" }));
    assert.throws(() => ActiveCheckEidInputSchema.parse({ emplId: "1234" }));
  });

  it("preserves keepNonHdh on both input shapes", () => {
    assert.equal(ActiveCheckNameInputSchema.parse({ name: "Zaw, Hein", keepNonHdh: true }).keepNonHdh, true);
    assert.equal(ActiveCheckEidInputSchema.parse({ emplId: "10706431", keepNonHdh: true }).keepNonHdh, true);
  });

  it("discriminates name and EID inputs", () => {
    assert.equal(isActiveCheckEidInput(ActiveCheckItemSchema.parse({ name: "Zaw, Hein" })), false);
    assert.equal(isActiveCheckEidInput(ActiveCheckItemSchema.parse({ emplId: "10706431" })), true);
  });
});

describe("deriveActiveCheckItemId", () => {
  it("uses the EID as the stable item id for EID inputs", () => {
    assert.equal(deriveActiveCheckItemId({ emplId: "10706431" }), "10706431");
  });

  it("uses the display name as the stable item id for name inputs", () => {
    assert.equal(deriveActiveCheckItemId({ name: "zaw, hein thant" }), "Zaw, Hein Thant");
  });
});

describe("buildActiveCheckCliInput", () => {
  it("routes digit-only queries through EID validation only when they normalize to a UCPath EID", () => {
    assert.deepEqual(buildActiveCheckCliInput("10706431"), { emplId: "10706431" });
    assert.deepEqual(buildActiveCheckCliInput("10-706431"), { emplId: "10-706431" });
    assert.deepEqual(buildActiveCheckCliInput(" 10870001 "), { emplId: " 10870001 " });
  });

  it("treats short or non-10xxxxxx digit strings as name queries", () => {
    assert.deepEqual(buildActiveCheckCliInput("12345"), { name: "12345" });
    assert.deepEqual(buildActiveCheckCliInput("20706431"), { name: "20706431" });
  });

  it("never treats strings with letters as bare EID queries", () => {
    assert.deepEqual(buildActiveCheckCliInput("Room 101"), { name: "Room 101" });
    assert.deepEqual(buildActiveCheckCliInput("Zaw, Hein Thant"), { name: "Zaw, Hein Thant" });
  });
});
