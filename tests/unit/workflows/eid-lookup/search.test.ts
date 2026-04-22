import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isAcceptedDept, parseNameInput } from "../../../../src/workflows/eid-lookup/search.js";

describe("isAcceptedDept", () => {
  it("accepts HOUSING/DINING/HOSPITALITY", () => {
    assert.equal(isAcceptedDept("HOUSING/DINING/HOSPITALITY"), true);
  });

  it("accepts mixed-case On Campus Housing", () => {
    assert.equal(isAcceptedDept("On Campus Housing"), true);
  });

  it("accepts a 'Dining Services' dept", () => {
    assert.equal(isAcceptedDept("Dining Services"), true);
  });

  it("accepts any dept containing 'Hospitality'", () => {
    assert.equal(isAcceptedDept("Hospitality Services"), true);
  });

  it("rejects QUALCOMM INSTITUTE (common SDCMP non-HDH dept)", () => {
    assert.equal(isAcceptedDept("QUALCOMM INSTITUTE"), false);
  });

  it("rejects empty / undefined department", () => {
    assert.equal(isAcceptedDept(""), false);
    assert.equal(isAcceptedDept(undefined), false);
  });

  it("rejects random SDCMP departments", () => {
    assert.equal(isAcceptedDept("RADY SCHOOL OF MANAGEMENT"), false);
    assert.equal(isAcceptedDept("ENROLLMENT MANAGEMENT"), false);
  });

  it("is case-insensitive", () => {
    assert.equal(isAcceptedDept("housing/dining/hospitality"), true);
    assert.equal(isAcceptedDept("HOUSING"), true);
    assert.equal(isAcceptedDept("dining"), true);
  });
});

describe("parseNameInput (regression)", () => {
  it("still parses normalized 'Last, First Middle' correctly", () => {
    const parsed = parseNameInput("Zaw, Hein Thant");
    assert.equal(parsed.lastName, "Zaw");
    assert.equal(parsed.first, "Hein");
    assert.equal(parsed.middle, "Thant");
  });

  it("still parses 'Last, First' (no middle)", () => {
    const parsed = parseNameInput("Smith, John");
    assert.equal(parsed.lastName, "Smith");
    assert.equal(parsed.first, "John");
    assert.equal(parsed.middle, null);
  });
});
