import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isAcceptedHdhDepartment } from "../../../../src/domain/hdh/departments.js";
import { parsePersonOrgNameInput } from "../../../../src/systems/ucpath/person-org-summary.js";

describe("HDH department policy", () => {
  it("accepts housing, dining, and hospitality departments", () => {
    assert.equal(isAcceptedHdhDepartment("HOUSING/DINING/HOSPITALITY"), true);
    assert.equal(isAcceptedHdhDepartment("On Campus Housing"), true);
    assert.equal(isAcceptedHdhDepartment("Dining Services"), true);
    assert.equal(isAcceptedHdhDepartment("Hospitality Services"), true);
  });

  it("rejects unrelated SDCMP departments", () => {
    assert.equal(isAcceptedHdhDepartment("QUALCOMM INSTITUTE"), false);
    assert.equal(isAcceptedHdhDepartment("RADY SCHOOL OF MANAGEMENT"), false);
    assert.equal(isAcceptedHdhDepartment(undefined), false);
  });
});

describe("parsePersonOrgNameInput", () => {
  it("parses normalized Last, First Middle names", () => {
    assert.deepEqual(parsePersonOrgNameInput("zaw, hein thant"), {
      lastName: "Zaw",
      first: "Hein",
      middle: "Thant",
    });
  });

  it("throws a helpful error for invalid input", () => {
    assert.throws(
      () => parsePersonOrgNameInput("plain string"),
      /Expected "Last, First Middle" or "Last, First"/,
    );
  });
});
