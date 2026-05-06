import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isAcceptedHdhDepartment } from "../../../../src/domain/hdh/departments.js";
import {
  deriveAssignmentDetailsFromCells,
  parsePersonOrgNameInput,
} from "../../../../src/systems/ucpath/person-org-summary.js";

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

describe("deriveAssignmentDetailsFromCells", () => {
  it("extracts expected job end date separately from termination date", () => {
    const assignment = deriveAssignmentDetailsFromCells([
      "0",
      "04/01/2026",
      "Active",
      "SDCMP",
      "40012345",
      "660042",
      "Dining Services",
      "004722",
      "Student 2",
      "06/30/2026",
      "0.500000",
      "Per Diem",
    ]);

    assert.deepEqual(assignment, {
      emplRecord: "0",
      effectiveDate: "04/01/2026",
      hrStatus: "Active",
      businessUnit: "SDCMP",
      positionNumber: "40012345",
      deptId: "660042",
      department: "Dining Services",
      jobCode: "004722",
      jobCodeDescription: "Student 2",
      expectedJobEndDate: "06/30/2026",
      fte: "0.500000",
      emplClass: "Per Diem",
    });
  });

  it("returns null for header or malformed rows", () => {
    assert.equal(
      deriveAssignmentDetailsFromCells([
        "Empl Record",
        "EFFDT",
        "HR Status",
        "Business Unit",
        "Position Number",
        "Dept ID",
        "Department Description",
      ]),
      null,
    );
  });
});
