import { describe, it } from "vitest";
import assert from "node:assert/strict";

import { pickCrmStartDate, type CrmRecord } from "../../../../src/workflows/person-lookup/crm-search.js";
import { matchCrmEid, splitResolvedName } from "../../../../src/workflows/person-lookup/workflow.js";
import type { EidResult } from "../../../../src/systems/ucpath/person-org-summary.js";

function crmRecord(patch: Partial<CrmRecord> = {}): CrmRecord {
  return {
    name: "Sanchez, Raquel",
    ppsId: "",
    ucpathEmployeeId: "10526678",
    firstDayOfService: "10/12/2021",
    appointmentEndDate: "",
    dateSigned: "",
    department: "HOUSING/DINING/HOSPITALITY",
    titleCode: "",
    ucsdEmail: "",
    personalEmail: "",
    hireType: "",
    recordUrl: "https://act-crm.my.site.com/hr/ONB_ViewOnboarding?id=1",
    ...patch,
  };
}

function eidResult(patch: Partial<EidResult> = {}): EidResult {
  return {
    emplId: "10526678",
    emplRecord: "0",
    hrStatus: "Active",
    businessUnit: "SDCMP",
    jobCode: "",
    jobCodeDescription: "",
    lastName: "Sanchez",
    name: "Raquel Sanchez",
    department: "HOUSING/DINING/HOSPITALITY",
    startDate: "10/22/2022",
    effectiveDate: "10/22/2022",
    terminationDate: "",
    expectedJobEndDate: "",
    ...patch,
  };
}

describe("pickCrmStartDate", () => {
  it("returns the First Day of Service of the EID-matched record", () => {
    const records = [
      crmRecord({ ucpathEmployeeId: "10999999", firstDayOfService: "01/01/2020" }),
      crmRecord({ ucpathEmployeeId: "10526678", firstDayOfService: "10/12/2021" }),
    ];
    assert.equal(pickCrmStartDate(records, "10526678"), "10/12/2021");
  });

  it("falls back to the first record when no EID matches", () => {
    const records = [
      crmRecord({ ucpathEmployeeId: "10999999", firstDayOfService: "01/01/2020" }),
    ];
    assert.equal(pickCrmStartDate(records, "10526678"), "01/01/2020");
  });

  it("uses the first record when no EID is supplied", () => {
    const records = [crmRecord({ firstDayOfService: "03/03/2023" })];
    assert.equal(pickCrmStartDate(records), "03/03/2023");
  });

  it("returns blank when there are no records (CRM-only, no fallback)", () => {
    assert.equal(pickCrmStartDate([], "10526678"), "");
  });

  it("returns blank when the chosen record has no First Day of Service", () => {
    const records = [crmRecord({ ucpathEmployeeId: "10526678", firstDayOfService: "" })];
    assert.equal(pickCrmStartDate(records, "10526678"), "");
  });
});

describe("matchCrmEid", () => {
  it("prefers a direct UCPath EID match over a date match", () => {
    const result = matchCrmEid(
      [eidResult({ emplId: "10526678" })],
      [crmRecord({ ucpathEmployeeId: "10526678" })],
    );
    assert.deepEqual(result, { crmMatch: "direct", crmMatchedEmplId: "10526678" });
  });

  it("falls back to a ±7 day date match when no EID lines up", () => {
    const result = matchCrmEid(
      [eidResult({ emplId: "10526678", startDate: "10/15/2021", effectiveDate: "" })],
      [crmRecord({ ucpathEmployeeId: "", firstDayOfService: "10/12/2021" })],
    );
    assert.deepEqual(result, { crmMatch: "date", crmMatchedEmplId: "10526678" });
  });

  it("returns none when CRM records match neither EID nor date", () => {
    const result = matchCrmEid(
      [eidResult({ emplId: "10526678", startDate: "01/01/2020", effectiveDate: "" })],
      [crmRecord({ ucpathEmployeeId: "10000000", firstDayOfService: "12/31/2024" })],
    );
    assert.deepEqual(result, { crmMatch: "none" });
  });
});

describe("splitResolvedName", () => {
  it("splits a First Last name into CRM search parts", () => {
    assert.deepEqual(splitResolvedName("Raquel Sanchez"), {
      lastName: "Sanchez",
      firstName: "Raquel",
    });
  });

  it("treats the final token as the last name for First Middle Last", () => {
    assert.deepEqual(splitResolvedName("Raquel Victoria Sanchez"), {
      lastName: "Sanchez",
      firstName: "Raquel",
    });
  });

  it("handles a single token and empty input", () => {
    assert.deepEqual(splitResolvedName("Cher"), { lastName: "Cher", firstName: "" });
    assert.deepEqual(splitResolvedName("   "), { lastName: "", firstName: "" });
  });
});
