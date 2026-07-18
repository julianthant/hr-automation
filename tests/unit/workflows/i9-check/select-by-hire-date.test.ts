/**
 * Pure hire-date corroboration for the i9-check person-lookup path.
 */
import { describe, it } from "vitest";
import assert from "node:assert/strict";

import {
  selectPersonLookupByHireDate,
  I9_HIRE_DATE_TOLERANCE_DAYS,
} from "../../../../src/workflows/i9-check/select-by-hire-date.js";

describe("selectPersonLookupByHireDate", () => {
  it("empty results → not-found", () => {
    const out = selectPersonLookupByHireDate("04/25/2016", []);
    assert.deepEqual(out, { status: "not-found", candidateCount: 0 });
  });

  it("missing I-9 hire date → ambiguous (never accept a name-only hit)", () => {
    const out = selectPersonLookupByHireDate(undefined, [
      { emplId: "10411099", name: "Sanchez, Gabriel", startDate: "04/25/2016" },
    ]);
    assert.equal(out.status, "ambiguous");
    if (out.status === "ambiguous") {
      assert.equal(out.reason, "missing-hire-date");
      assert.equal(out.candidateCount, 1);
    }
  });

  it("exactly one Last Hire within ±7 days → found", () => {
    const out = selectPersonLookupByHireDate("04/25/2016", [
      { emplId: "10411099", name: "Sanchez, Gabriel", startDate: "04/20/2016" },
      { emplId: "10999999", name: "Other, Person", startDate: "01/01/2010" },
    ]);
    assert.deepEqual(out, {
      status: "found",
      emplId: "10411099",
      matchedName: "Sanchez, Gabriel",
      startDate: "04/20/2016",
    });
  });

  it("uses assignment EFFDT when Last Hire is blank", () => {
    const out = selectPersonLookupByHireDate("04/25/2016", [
      { emplId: "10411099", name: "Sanchez, Gabriel", effectiveDate: "04/25/2016" },
    ]);
    assert.equal(out.status, "found");
    if (out.status === "found") {
      assert.equal(out.emplId, "10411099");
      assert.equal(out.startDate, "04/25/2016");
    }
  });

  it("zero candidates within tolerance → not-found (candidateCount = unique name hits)", () => {
    const out = selectPersonLookupByHireDate("04/25/2016", [
      { emplId: "10411099", name: "Sanchez, Gabriel", startDate: "01/01/2010" },
    ]);
    assert.deepEqual(out, { status: "not-found", candidateCount: 1 });
  });

  it("two+ Empl IDs within tolerance → ambiguous", () => {
    const out = selectPersonLookupByHireDate("04/25/2016", [
      { emplId: "10411099", name: "Sanchez, A", startDate: "04/25/2016" },
      { emplId: "10411100", name: "Sanchez, B", startDate: "04/26/2016" },
    ]);
    assert.equal(out.status, "ambiguous");
    if (out.status === "ambiguous") {
      assert.equal(out.reason, "multiple-hire-date-matches");
      assert.equal(out.candidateCount, 2);
    }
  });

  it("dedupes the same Empl ID appearing twice", () => {
    const out = selectPersonLookupByHireDate("04/25/2016", [
      { emplId: "10411099", name: "Sanchez, Gabriel", startDate: "04/25/2016" },
      { emplId: "10411099", name: "Sanchez, Gabriel", startDate: "04/25/2016" },
    ]);
    assert.equal(out.status, "found");
    if (out.status === "found") assert.equal(out.emplId, "10411099");
  });

  it(`default tolerance is ${I9_HIRE_DATE_TOLERANCE_DAYS} days`, () => {
    // Exactly 7 days apart → match; 8 days → miss.
    const within = selectPersonLookupByHireDate("04/25/2016", [
      { emplId: "1", name: "A", startDate: "05/02/2016" },
    ]);
    const outside = selectPersonLookupByHireDate("04/25/2016", [
      { emplId: "1", name: "A", startDate: "05/03/2016" },
    ]);
    assert.equal(within.status, "found");
    assert.equal(outside.status, "not-found");
  });
});
