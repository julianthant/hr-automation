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
  buildLastFirstSearchNames,
} from "../../../src/domain/identity/person-name.js";

describe("person-name identity helpers", () => {
  it("formats messy Last, First Middle input for operator display", () => {
    assert.equal(displayPersonName("  zun ,   haki   tuwom "), "Zun, Haki Tuwom");
  });

  it("keeps already-normalized Last, First input stable", () => {
    assert.equal(displayPersonName("Smith, John"), "Smith, John");
  });

  it("parses Last, First Middle into parts", () => {
    assert.deepEqual(parseLastFirstName("Zun, Haki Tuwom"), {
      lastName: "Zun",
      firstName: "Haki",
      middleName: "Tuwom",
      display: "Zun, Haki Tuwom",
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
      canonicalPersonNameKey("  ZUN,   HAKI   TUWOM "),
      canonicalPersonNameKey("zun haki tuwom"),
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
    assert.equal(toLastFirstName("Laq Livovot", "Livovot"), "Livovot, Laq");
  });

  it("preserves middle name(s) when splitting at the trailing last-name anchor", () => {
    assert.equal(toLastFirstName("Haki Tuwom Zun", "Zun"), "Zun, Haki Tuwom");
  });

  it("is idempotent on already-comma-formatted input", () => {
    assert.equal(toLastFirstName("Livovot, Laq", "Livovot"), "Livovot, Laq");
  });

  it("matches the trailing last name case-insensitively and normalizes display casing", () => {
    assert.equal(toLastFirstName("LAQ LIVOVOT", "livovot"), "Livovot, Laq");
  });

  it("falls back to displayPersonName(fullName) when the lastName does not match the trailing tokens", () => {
    assert.equal(toLastFirstName("Laq Livovot", "Smith"), "Laq Livovot");
  });

  it("falls back to displayPersonName(fullName) when the lastName is missing", () => {
    assert.equal(toLastFirstName("Laq Livovot", ""), "Laq Livovot");
    assert.equal(toLastFirstName("Laq Livovot", null), "Laq Livovot");
  });

  it("returns empty string for empty fullName regardless of lastName", () => {
    assert.equal(toLastFirstName("", "Livovot"), "");
    assert.equal(toLastFirstName(null, "Livovot"), "");
  });

  it("handles multi-token last names like \"Vuf Dyke\"", () => {
    assert.equal(toLastFirstName("Dick Vuf Dyke", "Vuf Dyke"), "Vuf Dyke, Dick");
  });
});

describe("toLastFirstSearchName", () => {
  it("formats OCR comma variants for Person Org Summary search", () => {
    assert.equal(toLastFirstSearchName("bemidipu mirofaw, cugiti, d"), "Bemidipu Mirofaw, Cugiti D");
  });

  it("formats OCR first-middle-last variants for Person Org Summary search", () => {
    assert.equal(toLastFirstSearchName("Cugiti D. Bemidipu Mirofaw"), "Bemidipu Mirofaw, Cugiti D");
  });

  it("strips a trailing period after middle initial in Last, First display", () => {
    assert.equal(displayPersonName("Bemidipu Mirofaw, Cugiti D."), "Bemidipu Mirofaw, Cugiti D");
  });
});

describe("buildLastFirstSearchNames", () => {
  it("tries natural First Last names as Last, First first", () => {
    assert.deepEqual(buildLastFirstSearchNames("Moz Towa"), ["Towa, Moz", "Moz, Towa"]);
  });

  it("adds no-comma Last First Middle as a fallback", () => {
    assert.deepEqual(
      buildLastFirstSearchNames("Towa Moz V"),
      ["V, Towa Moz", "Towa, Moz V"],
    );
  });

  it("collapses extra comma OCR variants without adding fallback noise", () => {
    assert.deepEqual(buildLastFirstSearchNames("Gowopo, Noban, K"), ["Gowopo, Noban K"]);
  });
});
