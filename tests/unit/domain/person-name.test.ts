import { describe, it } from "vitest";
import assert from "node:assert/strict";
import {
  canonicalPersonNameKey,
  displayPersonName,
  normalizePersonNameForCompare,
  parseLastFirstName,
  titleCasePersonToken,
  toLastFirstName,
  toLastFirstSearchName,
} from "../../../src/domain/identity/person-name.js";

describe("person-name identity helpers", () => {
  it("formats messy Last, First Middle input for operator display", () => {
    assert.equal(displayPersonName("  zAW ,   hEIN   thANT "), "Zaw, Hein Thant");
  });

  it("keeps already-normalized Last, First input stable", () => {
    assert.equal(displayPersonName("Smith, John"), "Smith, John");
  });

  it("parses Last, First Middle into parts", () => {
    assert.deepEqual(parseLastFirstName("Zaw, Hein Thant"), {
      lastName: "Zaw",
      firstName: "Hein",
      middleName: "Thant",
      display: "Zaw, Hein Thant",
    });
  });

  it("parses Last, First without a middle name", () => {
    assert.deepEqual(parseLastFirstName("Smith, John"), {
      lastName: "Smith",
      firstName: "John",
      middleName: null,
      display: "Smith, John",
    });
  });

  it("returns null for strings that are not Last, First", () => {
    assert.equal(parseLastFirstName("plain string"), null);
    assert.equal(parseLastFirstName("smith,"), null);
  });

  it("creates comparison keys that ignore casing, commas, and spacing", () => {
    assert.equal(
      canonicalPersonNameKey("  ZAW,   HEIN   THANT "),
      canonicalPersonNameKey("zaw hein thant"),
    );
  });

  it("title-cases hyphenated and apostrophe tokens without breaking separators", () => {
    assert.equal(titleCasePersonToken("o'NEIL-smith"), "O'Neil-Smith");
  });

  it("normalizes names for loose comparison while preserving punctuation by default", () => {
    assert.equal(normalizePersonNameForCompare("  O'NEIL-SMITH,   JANE "), "o'neil-smith, jane");
  });

  it("can normalize names to letters and spaces only for fuzzy roster matching", () => {
    assert.equal(normalizePersonNameForCompare("  O'NEIL-SMITH,   JANE ", { lettersOnly: true }), "oneilsmith jane");
  });
});

describe("toLastFirstName", () => {
  it("converts \"First Last\" + lastName anchor to \"Last, First\"", () => {
    assert.equal(toLastFirstName("Leo Langley", "Langley"), "Langley, Leo");
  });

  it("preserves middle name(s) when splitting at the trailing last-name anchor", () => {
    assert.equal(toLastFirstName("Hein Thant Zaw", "Zaw"), "Zaw, Hein Thant");
  });

  it("is idempotent on already-comma-formatted input", () => {
    assert.equal(toLastFirstName("Langley, Leo", "Langley"), "Langley, Leo");
  });

  it("matches the trailing last name case-insensitively and normalizes display casing", () => {
    assert.equal(toLastFirstName("LEO LANGLEY", "langley"), "Langley, Leo");
  });

  it("falls back to displayPersonName(fullName) when the lastName does not match the trailing tokens", () => {
    assert.equal(toLastFirstName("Leo Langley", "Smith"), "Leo Langley");
  });

  it("falls back to displayPersonName(fullName) when the lastName is missing", () => {
    assert.equal(toLastFirstName("Leo Langley", ""), "Leo Langley");
    assert.equal(toLastFirstName("Leo Langley", null), "Leo Langley");
  });

  it("returns empty string for empty fullName regardless of lastName", () => {
    assert.equal(toLastFirstName("", "Langley"), "");
    assert.equal(toLastFirstName(null, "Langley"), "");
  });

  it("handles multi-token last names like \"Van Dyke\"", () => {
    assert.equal(toLastFirstName("Dick Van Dyke", "Van Dyke"), "Van Dyke, Dick");
  });
});

describe("toLastFirstSearchName", () => {
  it("formats OCR comma variants for Person Org Summary search", () => {
    assert.equal(toLastFirstSearchName("barahona martell, carlos, d"), "Barahona Martell, Carlos D");
  });

  it("formats OCR first-middle-last variants for Person Org Summary search", () => {
    assert.equal(toLastFirstSearchName("Carlos D. Barahona Martell"), "Barahona Martell, Carlos D");
  });

  it("strips a trailing period after middle initial in Last, First display", () => {
    assert.equal(displayPersonName("Barahona Martell, Carlos D."), "Barahona Martell, Carlos D");
  });
});
