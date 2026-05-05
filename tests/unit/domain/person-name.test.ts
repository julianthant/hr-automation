import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  canonicalPersonNameKey,
  displayPersonName,
  parseLastFirstName,
  titleCasePersonToken,
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
});
