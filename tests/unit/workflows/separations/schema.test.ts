import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  computeTerminationEffDate,
  buildTerminationComments,
  mapReasonCode,
  getInitials,
  resolveKronosDates,
  computeKronosDateRange,
  buildDateChangeComments,
} from "../../../../src/workflows/separations/schema.js";

describe("computeTerminationEffDate", () => {
  it("adds one day to a normal mid-month date", () => {
    assert.equal(computeTerminationEffDate("03/14/2026"), "03/15/2026");
  });

  it("rolls over end-of-month (March 31 → April 1)", () => {
    assert.equal(computeTerminationEffDate("03/31/2026"), "04/01/2026");
  });

  it("rolls over end-of-year (Dec 31 → Jan 1 next year)", () => {
    assert.equal(computeTerminationEffDate("12/31/2026"), "01/01/2027");
  });

  it("handles leap year Feb 28 → Feb 29", () => {
    assert.equal(computeTerminationEffDate("02/28/2024"), "02/29/2024");
  });

  it("handles leap year Feb 29 → Mar 1", () => {
    assert.equal(computeTerminationEffDate("02/29/2024"), "03/01/2024");
  });

  it("handles non-leap year Feb 28 → Mar 1", () => {
    assert.equal(computeTerminationEffDate("02/28/2026"), "03/01/2026");
  });

  it("zero-pads single-digit months and days in output", () => {
    assert.equal(computeTerminationEffDate("01/01/2026"), "01/02/2026");
    assert.equal(computeTerminationEffDate("09/09/2026"), "09/10/2026");
  });

  it("handles April 30 → May 1 (30-day month boundary)", () => {
    assert.equal(computeTerminationEffDate("04/30/2026"), "05/01/2026");
  });
});

describe("buildTerminationComments", () => {
  it("formats eff date, last day worked, and doc id in the expected order", () => {
    const result = buildTerminationComments("03/15/2026", "03/14/2026", "999888");
    assert.equal(
      result,
      "Termination EFF 03/15/2026. Last day worked 03/14/2026. Kuali form #999888.",
    );
  });

  it("passes values through verbatim (no trimming or transformation)", () => {
    const result = buildTerminationComments("03/15/2026", "03/14/2026", "DOC-42");
    assert.ok(result.includes("DOC-42"));
  });
});

describe("mapReasonCode", () => {
  it("maps exact voluntary key 'Accepted Another Job' to 'Resign - Accept Another Job'", () => {
    assert.equal(mapReasonCode("Accepted Another Job"), "Resign - Accept Another Job");
  });

  it("maps exact voluntary key 'Personal Reasons' to 'Resign - Personal Reasons'", () => {
    assert.equal(mapReasonCode("Personal Reasons"), "Resign - Personal Reasons");
  });

  it("maps 'Graduated/No longer a Student' to UCPath 'No Longer Student'", () => {
    assert.equal(mapReasonCode("Graduated/No longer a Student"), "No Longer Student");
  });

  it("maps 'Retirement' to the 'Voluntary Separation Program' reason (special case)", () => {
    assert.equal(mapReasonCode("Retirement"), "Voluntary Separation Program");
  });

  it("maps 'Appointment Expired' to 'Resign - No Reason Given' (Kuali overrides UCPath INVOL code)", () => {
    assert.equal(mapReasonCode("Appointment Expired"), "Resign - No Reason Given");
  });

  it("maps intra-campus transfer to 'Transfer - Intra Location'", () => {
    assert.equal(
      mapReasonCode("Transferring to a different UCSD department (outside of RRSS)"),
      "Transfer - Intra Location",
    );
  });

  it("maps inter-campus transfer to 'Interlocation (BU) Transfer'", () => {
    assert.equal(
      mapReasonCode("Transferring to another UC Campus (outside of UCSD)"),
      "Interlocation (BU) Transfer",
    );
  });

  it("fuzzy-matches case-insensitively when lowercase input contains the key", () => {
    assert.equal(mapReasonCode("attend school"), "Resign - Attend School");
  });

  it("fuzzy-matches when input is a substring of a Kuali key", () => {
    // "School" is a substring of "Attend School" — caught by kualiType.includes(lowerType)
    assert.equal(mapReasonCode("School"), "Resign - Attend School");
  });

  it("fuzzy-matches when input is a superset of a Kuali key", () => {
    // "Military Service" is a substring of "Extended Military Service Duty"
    assert.equal(mapReasonCode("Extended Military Service Duty"), "Resign - Military Service");
  });

  it("falls back to 'Resign - No Reason Given' when no exact or fuzzy match exists", () => {
    assert.equal(mapReasonCode("Some Completely Unrelated Reason xyz"), "Resign - No Reason Given");
  });

  it("returns the first map entry for empty-string input (current fuzzy behavior)", () => {
    // Documenting current behavior: every key contains "" as a substring, so the
    // first REASON_CODE_MAP entry wins. This is a known quirk — upstream callers
    // should never pass an empty terminationType (Zod schema requires min(1)).
    assert.equal(mapReasonCode(""), "Resign - Accept Another Job");
  });
});

describe("getInitials", () => {
  it("returns initials for a two-word name", () => {
    assert.equal(getInitials("Julian Zaw"), "JZ");
  });

  it("returns initials for a three-word name", () => {
    assert.equal(getInitials("Mary Ann Smith"), "MAS");
  });

  it("returns a single initial for a single-word name", () => {
    assert.equal(getInitials("Cher"), "C");
  });

  it("uppercases lowercase input", () => {
    assert.equal(getInitials("john doe"), "JD");
  });

  it("collapses multiple spaces and tabs via /\\s+/ split", () => {
    assert.equal(getInitials("John   Doe"), "JD");
    assert.equal(getInitials("John\tDoe"), "JD");
  });

  it("treats hyphenated words as a single token (first char only)", () => {
    // "Mary-Jane" is one token → first char "M", Smith → "S"
    assert.equal(getInitials("Mary-Jane Smith"), "MS");
  });
});

describe("resolveKronosDates", () => {
  it("returns Kuali dates unchanged when both Kronos dates are null", () => {
    const result = resolveKronosDates("03/14/2026", "03/14/2026", null, null);
    assert.deepEqual(result, {
      lastDayWorked: "03/14/2026",
      separationDate: "03/14/2026",
      changed: false,
    });
  });

  it("returns unchanged when the only Kronos date equals both Kuali dates", () => {
    const result = resolveKronosDates("03/14/2026", "03/14/2026", "03/14/2026", null);
    assert.equal(result.changed, false);
    assert.equal(result.lastDayWorked, "03/14/2026");
  });

  it("overrides both Kuali dates when old Kronos is the only source and differs", () => {
    const result = resolveKronosDates("03/14/2026", "03/14/2026", "03/20/2026", null);
    assert.deepEqual(result, {
      lastDayWorked: "03/20/2026",
      separationDate: "03/20/2026",
      changed: true,
    });
  });

  it("overrides both Kuali dates when new Kronos is the only source and differs", () => {
    const result = resolveKronosDates("03/14/2026", "03/14/2026", null, "03/21/2026");
    assert.deepEqual(result, {
      lastDayWorked: "03/21/2026",
      separationDate: "03/21/2026",
      changed: true,
    });
  });

  it("picks the later date when both Kronos sources report different dates (old > new)", () => {
    const result = resolveKronosDates("03/01/2026", "03/01/2026", "03/20/2026", "03/15/2026");
    assert.equal(result.lastDayWorked, "03/20/2026");
    assert.equal(result.separationDate, "03/20/2026");
  });

  it("picks the later date when both Kronos sources report different dates (new > old)", () => {
    const result = resolveKronosDates("03/01/2026", "03/01/2026", "03/10/2026", "03/25/2026");
    assert.equal(result.lastDayWorked, "03/25/2026");
    assert.equal(result.separationDate, "03/25/2026");
  });

  it("picks either when both Kronos dates are equal (no distinction needed)", () => {
    const result = resolveKronosDates("03/01/2026", "03/01/2026", "03/15/2026", "03/15/2026");
    assert.equal(result.lastDayWorked, "03/15/2026");
    assert.equal(result.separationDate, "03/15/2026");
    assert.equal(result.changed, true);
  });

  it("overrides Kuali dates even when Kronos is EARLIER (Kronos is ground truth)", () => {
    // Per CLAUDE.md 2026-04-10 lesson: Kronos always wins when it differs, not just when later.
    const result = resolveKronosDates("03/20/2026", "03/20/2026", "03/10/2026", null);
    assert.deepEqual(result, {
      lastDayWorked: "03/10/2026",
      separationDate: "03/10/2026",
      changed: true,
    });
  });

  it("updates only lastDayWorked when Kronos matches Kuali separationDate", () => {
    const result = resolveKronosDates("03/14/2026", "03/20/2026", "03/20/2026", null);
    assert.deepEqual(result, {
      lastDayWorked: "03/20/2026",
      separationDate: "03/20/2026",
      changed: true,
    });
  });

  it("updates only separationDate when Kronos matches Kuali lastDayWorked", () => {
    const result = resolveKronosDates("03/20/2026", "03/14/2026", "03/20/2026", null);
    assert.deepEqual(result, {
      lastDayWorked: "03/20/2026",
      separationDate: "03/20/2026",
      changed: true,
    });
  });

  it("overwrites both Kuali dates to the same Kronos date when it differs from both", () => {
    const result = resolveKronosDates("03/10/2026", "03/12/2026", "03/25/2026", null);
    assert.deepEqual(result, {
      lastDayWorked: "03/25/2026",
      separationDate: "03/25/2026",
      changed: true,
    });
  });
});

describe("computeKronosDateRange", () => {
  it("expands ±1 month when lastDayWorked < separationDate", () => {
    const result = computeKronosDateRange("03/10/2026", "03/20/2026");
    assert.equal(result.startDate, "02/10/2026");
    assert.equal(result.endDate, "04/20/2026");
  });

  it("expands ±1 month when lastDayWorked > separationDate", () => {
    const result = computeKronosDateRange("03/20/2026", "03/10/2026");
    assert.equal(result.startDate, "02/10/2026");
    assert.equal(result.endDate, "04/20/2026");
  });

  it("expands to -1 month / +1 month when both dates are equal", () => {
    const result = computeKronosDateRange("03/15/2026", "03/15/2026");
    assert.equal(result.startDate, "02/15/2026");
    assert.equal(result.endDate, "04/15/2026");
  });

  it("crosses the year boundary backwards (Jan 15 → Dec 15 prev year)", () => {
    const result = computeKronosDateRange("01/15/2026", "01/15/2026");
    assert.equal(result.startDate, "12/15/2025");
    assert.equal(result.endDate, "02/15/2026");
  });

  it("crosses the year boundary forwards (Dec 15 → Jan 15 next year)", () => {
    const result = computeKronosDateRange("12/15/2026", "12/15/2026");
    assert.equal(result.startDate, "11/15/2026");
    assert.equal(result.endDate, "01/15/2027");
  });

  it("zero-pads single-digit months in output", () => {
    const result = computeKronosDateRange("05/05/2026", "05/05/2026");
    assert.equal(result.startDate, "04/05/2026");
    assert.equal(result.endDate, "06/05/2026");
  });

  it("documents JS setMonth overflow on March 31: start rolls to March 3 (Feb 31 → Mar 3)", () => {
    // Known JS Date quirk: setMonth(month - 1) on March 31 targets Feb 31, which
    // doesn't exist, so Date normalizes it to March 3 (non-leap) / March 2 (leap).
    // ±1 month widens the window anyway, so this under-expansion is harmless in
    // practice — but worth pinning so a future refactor doesn't silently "fix" it.
    const result = computeKronosDateRange("03/31/2026", "03/31/2026");
    assert.equal(result.startDate, "03/03/2026");
    assert.equal(result.endDate, "05/01/2026");
  });
});

describe("buildDateChangeComments", () => {
  it("returns an empty string when no dates changed", () => {
    const result = buildDateChangeComments(
      "03/14/2026",
      "03/14/2026",
      "03/14/2026",
      "03/14/2026",
      "JZ",
    );
    assert.equal(result, "");
  });

  it("produces a single line when only lastDayWorked changed", () => {
    const result = buildDateChangeComments(
      "03/14/2026",
      "03/20/2026",
      "03/14/2026",
      "03/14/2026",
      "JZ",
    );
    assert.equal(
      result,
      "Updated Last Day Worked from 03/14/2026 to 03/20/2026 per Kronos timesheet. -JZ",
    );
  });

  it("produces a single line when only separationDate changed", () => {
    const result = buildDateChangeComments(
      "03/14/2026",
      "03/14/2026",
      "03/14/2026",
      "03/20/2026",
      "JZ",
    );
    assert.equal(
      result,
      "Updated Separation Date from 03/14/2026 to 03/20/2026 per Kronos timesheet. -JZ",
    );
  });

  it("produces two newline-separated lines when both dates changed", () => {
    const result = buildDateChangeComments(
      "03/14/2026",
      "03/20/2026",
      "03/14/2026",
      "03/20/2026",
      "JZ",
    );
    const lines = result.split("\n");
    assert.equal(lines.length, 2);
    assert.ok(lines[0].includes("Last Day Worked"));
    assert.ok(lines[1].includes("Separation Date"));
    assert.ok(lines[0].endsWith("-JZ"));
    assert.ok(lines[1].endsWith("-JZ"));
  });

  it("embeds the initials verbatim (no case change, no prefix)", () => {
    const result = buildDateChangeComments(
      "03/14/2026",
      "03/20/2026",
      "03/14/2026",
      "03/14/2026",
      "maS",
    );
    assert.ok(result.endsWith("-maS"));
  });
});
