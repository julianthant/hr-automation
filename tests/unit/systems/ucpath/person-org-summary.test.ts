import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { isAcceptedHdhDepartment } from "../../../../src/domain/hdh/departments.js";
import {
  PERSON_ORG_NAME_LABELS,
  deriveAssignmentDetailsFromCells,
  parsePersonOrgNameInput,
  selectPersonName,
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

describe("selectPersonName", () => {
  it("picks a real two-word name", () => {
    assert.equal(selectPersonName(["Leo Langley"]), "Leo Langley");
  });

  it("picks the name and skips two-word UI labels in front of it", () => {
    assert.equal(
      selectPersonName(["Person ID", "HR Status", "Leo Langley"]),
      "Leo Langley",
    );
  });

  it("rejects 'Person ID' rendered with a non-breaking space", () => {
    // Regression: PeopleSoft renders 'Person ID' as a leaf span. Pre-fix,
    // text.includes('Person ID') returned false (regular space mismatch) and
    // 'Person ID' leaked through as the picked name.
    assert.equal(
      selectPersonName(["Person ID", "Leo Langley"]),
      "Leo Langley",
    );
  });

  it("matches labels case-insensitively", () => {
    assert.equal(
      selectPersonName(["person id", "PERSON ID", "Leo Langley"]),
      "Leo Langley",
    );
  });

  it("returns the normalized form (collapses internal NBSP/whitespace)", () => {
    assert.equal(
      selectPersonName(["Leo Langley"]),
      "Leo Langley",
    );
  });

  it("rejects candidates containing digits", () => {
    assert.equal(
      selectPersonName(["12345 Foo", "Leo Langley"]),
      "Leo Langley",
    );
  });

  it("rejects candidates of length ≥ 60", () => {
    const long = "A" + " B".repeat(40); // exceeds 60 chars
    assert.equal(selectPersonName([long, "Leo Langley"]), "Leo Langley");
  });

  it("returns null when no candidate qualifies", () => {
    assert.equal(selectPersonName(["Person ID", "HR Status", "Active"]), null);
  });

  it("rejects single-word candidates", () => {
    assert.equal(selectPersonName(["Active", "Leo Langley"]), "Leo Langley");
  });

  it("rejects 'Loading Complete' UI status text leaking from UCPath", () => {
    // Regression observed 2026-05-08 on a fresh-daemon Person Org Summary
    // single-result page: "Loading Complete" passed the two-word + no-digit
    // shape filter and was picked as the name when the page hadn't fully
    // settled. Skip-list now rejects it.
    assert.equal(
      selectPersonName(["Loading Complete", "Leo Langley"]),
      "Leo Langley",
    );
  });

  it("PERSON_ORG_NAME_LABELS is the default label list", () => {
    assert.ok(PERSON_ORG_NAME_LABELS.includes("Person ID"));
    assert.ok(PERSON_ORG_NAME_LABELS.includes("HR Status"));
    assert.equal(PERSON_ORG_NAME_LABELS.includes("Julian Zaw"), false);
  });
});
