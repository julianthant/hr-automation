import { describe, it } from "vitest";
import assert from "node:assert/strict";
import type { PersonLookupResult } from "../../../../src/workflows/person-lookup/outcome.js";
import {
  deriveActiveCheckOutcome,
  deriveCrmOnlyCheckOutcome,
} from "../../../../src/workflows/person-lookup/outcome.js";

function eidResult(patch: Partial<PersonLookupResult> = {}): PersonLookupResult {
  return {
    emplId: "10090175",
    hrStatus: "Active",
    lastName: "Zun",
    name: "Haki Tuwom Zun",
    department: "Dining Services",
    terminationDate: "",
    expectedJobEndDate: "",
    ...patch,
  };
}

describe("deriveActiveCheckOutcome", () => {
  it("marks an active HDH employee active when no termination date is present", () => {
    const outcome = deriveActiveCheckOutcome({ kind: "by-eid", emplId: "10090175" }, [eidResult()]);

    assert.equal(outcome.activeStatus, "active");
    assert.equal(outcome.isActive, true);
    assert.equal(outcome.isHdhAccepted, true);
    assert.equal(outcome.emplId, "10090175");
  });

  it("marks a person inactive when UCPath has a termination date", () => {
    const outcome = deriveActiveCheckOutcome({ kind: "by-eid", emplId: "10090175" }, [
      eidResult({ terminationDate: "04/30/2026", hrStatus: "Inactive" }),
    ]);

    assert.equal(outcome.activeStatus, "inactive");
    assert.equal(outcome.isActive, false);
    assert.equal(outcome.terminationDate, "04/30/2026");
  });

  it("surfaces the termination reason alongside a termination date", () => {
    const outcome = deriveActiveCheckOutcome({ kind: "by-eid", emplId: "10090175" }, [
      eidResult({
        terminationDate: "06/13/2023",
        terminationReason: "Resign - Personal Reasons",
        hrStatus: "Inactive",
      }),
    ]);

    assert.equal(outcome.terminationDate, "06/13/2023");
    assert.equal(outcome.terminationReason, "Resign - Personal Reasons");
  });

  it("blanks the termination reason for an active employee even if one leaks through", () => {
    const outcome = deriveActiveCheckOutcome({ kind: "by-eid", emplId: "10090175" }, [
      eidResult({ terminationDate: "", terminationReason: "Resign - Personal Reasons" }),
    ]);

    assert.equal(outcome.activeStatus, "active");
    assert.equal(outcome.terminationReason, "");
  });

  it("keeps expected job end date as context without making an employee inactive", () => {
    const outcome = deriveActiveCheckOutcome({ kind: "by-eid", emplId: "10090175" }, [
      eidResult({ expectedJobEndDate: "06/30/2026", terminationDate: "" }),
    ]);

    assert.equal(outcome.activeStatus, "active");
    assert.equal(outcome.isActive, true);
    assert.equal(outcome.expectedJobEndDate, "06/30/2026");
  });

  it("carries first day of service as startDate without replacing EFFDT", () => {
    const outcome = deriveActiveCheckOutcome({ kind: "by-eid", emplId: "10090175" }, [
      eidResult({
        effectiveDate: "04/01/2026",
        startDate: "03/15/2026",
      }),
    ]);

    assert.equal(outcome.effdt, "04/01/2026");
    assert.equal(outcome.startDate, "03/15/2026");
  });

  it("falls back to EFFDT for startDate when first day of service is unavailable", () => {
    const outcome = deriveActiveCheckOutcome({ kind: "by-eid", emplId: "10090175" }, [
      eidResult({ effectiveDate: "04/01/2026", startDate: "" }),
    ]);

    assert.equal(outcome.startDate, "04/01/2026");
  });

  it("flags active non-HDH employees without hiding their active state", () => {
    const outcome = deriveActiveCheckOutcome({ kind: "by-eid", emplId: "10090175" }, [
      eidResult({ department: "QUALCOMM INSTITUTE" }),
    ]);

    assert.equal(outcome.activeStatus, "non-hdh");
    assert.equal(outcome.isActive, true);
    assert.equal(outcome.isHdhAccepted, false);
  });

  it("marks a missing result not-found", () => {
    const outcome = deriveActiveCheckOutcome({ kind: "by-eid", emplId: "10090175" }, []);

    assert.equal(outcome.activeStatus, "not-found");
    assert.equal(outcome.isActive, false);
    assert.equal(outcome.emplId, "10090175");
  });

  it("marks CRM-only hits as n/a with CRM identity filled", () => {
    const outcome = deriveCrmOnlyCheckOutcome(
      { kind: "by-eid", emplId: "10090204" },
      {
        name: "Mesopu, Aosamon",
        department: "HOUSING/DINING/HOSPITALITY (900001)",
        emplId: "10090204",
      },
    );

    assert.equal(outcome.activeStatus, "n/a");
    assert.equal(outcome.hrStatus, "N/A");
    assert.equal(outcome.isActive, false);
    assert.equal(outcome.name, "Mesopu, Aosamon");
    assert.equal(outcome.department, "HOUSING/DINING/HOSPITALITY (900001)");
    assert.equal(outcome.emplId, "10090204");
  });

  it("marks name searches with multiple candidates ambiguous", () => {
    const outcome = deriveActiveCheckOutcome({ kind: "by-name", name: "Zun, Haki" }, [
      eidResult({ emplId: "10090175" }),
      eidResult({ emplId: "10090176", name: "Haki Zun" }),
    ]);

    assert.equal(outcome.activeStatus, "ambiguous");
    assert.equal(outcome.isActive, false);
    assert.deepEqual(outcome.candidateEids, ["10090175", "10090176"]);
  });

  it("uses the active instance when a name search returns active and inactive rows for the same EID", () => {
    const outcome = deriveActiveCheckOutcome({ kind: "by-name", name: "Aafav, Maczzd" }, [
      eidResult({
        emplId: "10090187",
        name: "Maczzd Aafav",
        hrStatus: "Inactive",
        department: "TEMPORARY EMPLOYMENT SERVICES",
        effectiveDate: "04/13/2026",
        terminationDate: "04/12/2026",
      }),
      eidResult({
        emplId: "10090187",
        name: "Maczzd Aafav",
        hrStatus: "Active",
        department: "HOUSING/DINING/HOSPITALITY",
        effectiveDate: "04/13/2026",
        terminationDate: "",
      }),
    ]);

    assert.equal(outcome.activeStatus, "active");
    assert.equal(outcome.isActive, true);
    assert.equal(outcome.emplId, "10090187");
    assert.equal(outcome.department, "HOUSING/DINING/HOSPITALITY");
    assert.equal(outcome.hrStatus, "Active");
    assert.equal(outcome.terminationDate, "");
    assert.deepEqual(outcome.candidateEids, ["10090187"]);
  });
});
