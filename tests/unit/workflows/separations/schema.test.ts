import { describe, it } from "vitest";
import assert from "node:assert/strict";
import {
  computeTerminationEffDate,
  computeSeparationDate,
  buildTerminationComments,
  mapReasonCode,
  getInitials,
  computeKronosDateRange,
  buildDateChangeComments,
  buildSeparationDateChangeComment,
  buildDuplicateTerminationComment,
  todayMmDdYyyy,
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

describe("computeSeparationDate", () => {
  // Separation Date = the last day the employee was PAID for (worked OR on paid
  // leave) = max(lastDayWorked, last sick date, last holiday date).
  it("equals the last day worked when there is no sick/holiday leave", () => {
    assert.equal(computeSeparationDate("06/12/2026", [], []), "06/12/2026");
  });

  it("equals the last day worked when leave arrays are omitted", () => {
    assert.equal(computeSeparationDate("06/12/2026"), "06/12/2026");
  });

  it("moves forward to the latest sick date when sick leave extends past the last punch", () => {
    // Lydia Li (#3949): lastPunch 04/23, sick 04/27→04/30 → Sep 04/30.
    assert.equal(
      computeSeparationDate("04/23/2026", ["04/27/2026", "04/28/2026", "04/30/2026"], []),
      "04/30/2026",
    );
  });

  it("moves forward to the holiday date when holiday pay extends past the last punch", () => {
    // Kou Nathan (#4016): lastPunch 06/12, holiday 06/19 → Sep 06/19.
    assert.equal(computeSeparationDate("06/12/2026", [], ["06/19/2026"]), "06/19/2026");
  });

  it("takes the latest across BOTH sick and holiday dates", () => {
    assert.equal(
      computeSeparationDate("04/23/2026", ["04/27/2026", "04/28/2026"], ["04/30/2026"]),
      "04/30/2026",
    );
  });

  it("keeps the last day worked when it is later than every leave date", () => {
    // Defensive: a stray earlier leave date never pulls the separation backwards.
    assert.equal(
      computeSeparationDate("06/20/2026", ["06/10/2026"], ["06/05/2026"]),
      "06/20/2026",
    );
  });

  it("crosses a month boundary when leave runs into the next month", () => {
    assert.equal(computeSeparationDate("05/30/2026", ["06/01/2026"], []), "06/01/2026");
  });
});

describe("buildSeparationDateChangeComment", () => {
  it("returns an empty string when the Separation Date did not change", () => {
    assert.equal(buildSeparationDateChangeComment("06/12/2026", "06/12/2026", "JZ"), "");
  });

  it("produces the Separation Date audit line when it changed", () => {
    assert.equal(
      buildSeparationDateChangeComment("06/11/2026", "06/19/2026", "JZ"),
      "Updated Separation Date from 06/11/2026 to 06/19/2026 per Kronos timesheet. -JZ",
    );
  });

  it("embeds the initials verbatim (no case change, no prefix)", () => {
    assert.ok(buildSeparationDateChangeComment("06/11/2026", "06/19/2026", "maS").endsWith("-maS"));
  });
});

describe("buildTerminationComments", () => {
  // ─── Worked reference cases (live separations, pinned as exact strings) ───
  it("Lydia Li (#3949): multi-sick → only the LATEST sick date (no range)", () => {
    // New Kronos: lastPunch 04/23, sick ["04/27","04/28","04/30"], Kuali Sep 04/30.
    // → LDW 04/23 (unchanged), Sep 04/30, TermEff 05/01.
    const result = buildTerminationComments(
      "05/01/2026",
      "04/23/2026",
      "3949",
      { sickDates: ["04/27/2026", "04/28/2026", "04/30/2026"], holidayDates: [] },
    );
    assert.equal(
      result,
      "Termination eff 05/01/2026. Last Day Worked 04/23/2026. Sick Leave on 04/30/2026. Kuali form #3949.",
    );
  });

  it("Kou Nathan (#4016): single-holiday clause — 'Holiday Pay on …'", () => {
    // New Kronos: lastPunch 06/12, holiday ["06/19"], Kuali Sep 06/19.
    // → LDW 06/12, Sep 06/19, TermEff 06/20.
    const result = buildTerminationComments(
      "06/20/2026",
      "06/12/2026",
      "4016",
      { sickDates: [], holidayDates: ["06/19/2026"] },
    );
    assert.equal(
      result,
      "Termination eff 06/20/2026. Last Day Worked 06/12/2026. Holiday Pay on 06/19/2026. Kuali form #4016.",
    );
  });

  it("Normal (#4131): no sick/holiday — no leave clause at all", () => {
    const result = buildTerminationComments("06/20/2026", "06/19/2026", "4131");
    assert.equal(
      result,
      "Termination eff 06/20/2026. Last Day Worked 06/19/2026. Kuali form #4131.",
    );
  });

  it("≥2 holiday dates → 'Holiday Pay from … to …'", () => {
    const result = buildTerminationComments(
      "06/20/2026",
      "06/12/2026",
      "4016",
      { sickDates: [], holidayDates: ["06/19/2026", "06/26/2026"] },
    );
    assert.equal(
      result,
      "Termination eff 06/20/2026. Last Day Worked 06/12/2026. Holiday Pay from 06/19/2026 to 06/26/2026. Kuali form #4016.",
    );
  });

  it("single sick date → 'Sick Leave on …' (title-case 'Leave')", () => {
    const result = buildTerminationComments(
      "05/01/2026",
      "04/23/2026",
      "3949",
      { sickDates: ["04/27/2026"], holidayDates: [] },
    );
    assert.equal(
      result,
      "Termination eff 05/01/2026. Last Day Worked 04/23/2026. Sick Leave on 04/27/2026. Kuali form #3949.",
    );
  });

  it("both sick + holiday present, holiday LATER → only the holiday clause (not both)", () => {
    // Latest sick 04/28, latest holiday 04/30 → holiday is the separation-
    // determining leave day, so ONLY the holiday clause is reported.
    const result = buildTerminationComments(
      "05/01/2026",
      "04/23/2026",
      "3949",
      {
        sickDates: ["04/27/2026", "04/28/2026"],
        holidayDates: ["04/30/2026"],
      },
    );
    assert.equal(
      result,
      "Termination eff 05/01/2026. Last Day Worked 04/23/2026. Holiday Pay on 04/30/2026. Kuali form #3949.",
    );
  });

  it("both sick + holiday present, sick LATER → only the sick clause (not both)", () => {
    // Latest sick 05/02 > latest holiday 04/30 → sick wins; holiday is dropped.
    const result = buildTerminationComments(
      "05/03/2026",
      "04/23/2026",
      "3949",
      {
        sickDates: ["04/27/2026", "05/02/2026"],
        holidayDates: ["04/30/2026"],
      },
    );
    assert.equal(
      result,
      "Termination eff 05/03/2026. Last Day Worked 04/23/2026. Sick Leave on 05/02/2026. Kuali form #3949.",
    );
  });

  it("both present, holiday range LATER → only 'Holiday Pay from … to …' (sick dropped)", () => {
    // Holiday spans 06/19→06/26 (latest 06/26) and beats the latest sick 06/12 →
    // the holiday RANGE clause wins and the sick clause is dropped.
    const result = buildTerminationComments(
      "06/27/2026",
      "06/10/2026",
      "4016",
      {
        sickDates: ["06/11/2026", "06/12/2026"],
        holidayDates: ["06/19/2026", "06/26/2026"],
      },
    );
    assert.equal(
      result,
      "Termination eff 06/27/2026. Last Day Worked 06/10/2026. Holiday Pay from 06/19/2026 to 06/26/2026. Kuali form #4016.",
    );
  });

  it("both present, same latest date → sick wins the tie (only the sick clause)", () => {
    const result = buildTerminationComments(
      "06/13/2026",
      "06/10/2026",
      "4016",
      { sickDates: ["06/12/2026"], holidayDates: ["06/12/2026"] },
    );
    assert.equal(
      result,
      "Termination eff 06/13/2026. Last Day Worked 06/10/2026. Sick Leave on 06/12/2026. Kuali form #4016.",
    );
  });

  it("matches the operator-reported #4299 case — latest sick date, not the range", () => {
    // Sick 05/19/2026 → 06/11/2026; LDW 06/10, Sep 06/11, TermEff 06/12.
    const result = buildTerminationComments(
      "06/12/2026",
      "06/10/2026",
      "4299",
      { sickDates: ["05/19/2026", "06/11/2026"], holidayDates: [] },
    );
    assert.equal(
      result,
      "Termination eff 06/12/2026. Last Day Worked 06/10/2026. Sick Leave on 06/11/2026. Kuali form #4299.",
    );
  });

  it("treats an omitted leave argument as no leave clause", () => {
    const result = buildTerminationComments("03/15/2026", "03/14/2026", "DOC-42");
    assert.equal(
      result,
      "Termination eff 03/15/2026. Last Day Worked 03/14/2026. Kuali form #DOC-42.",
    );
  });

  it("passes the doc id through verbatim (no trimming or transformation)", () => {
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

  it("maps 'Appointment Expired' to the UCPath INVOL_TERM 'Appointment Expired' reason", () => {
    assert.equal(mapReasonCode("Appointment Expired"), "Appointment Expired");
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

  it("falls back to 'Resign - No Reason Given' for empty-string input (not the first map entry)", () => {
    // Every key contains "" as a substring, so an unguarded fuzzy loop would return
    // whichever REASON_CODE_MAP entry happens to be first — an arbitrary wrong
    // VOL_TERM reason on a live termination. Empty/whitespace-only input must be
    // caught before the fuzzy loop and resolve to the documented default instead.
    assert.equal(mapReasonCode(""), "Resign - No Reason Given");
  });

  it("falls back to 'Resign - No Reason Given' for whitespace-only input", () => {
    assert.equal(mapReasonCode("   "), "Resign - No Reason Given");
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
  it("returns an empty string when the Last Day Worked did not change", () => {
    const result = buildDateChangeComments("03/14/2026", "03/14/2026", "JZ");
    assert.equal(result, "");
  });

  it("produces the Last Day Worked audit line when it changed", () => {
    const result = buildDateChangeComments("03/14/2026", "03/20/2026", "JZ");
    assert.equal(
      result,
      "Updated Last Day Worked from 03/14/2026 to 03/20/2026 per Kronos timesheet. -JZ",
    );
  });

  it("never mentions the Separation Date (that audit line has its own builder)", () => {
    // buildDateChangeComments is LDW-only; the Separation Date change line is
    // produced by buildSeparationDateChangeComment and joined in kuali-finalize.
    const result = buildDateChangeComments("03/14/2026", "03/20/2026", "JZ");
    assert.equal(result.includes("Separation Date"), false);
  });

  it("embeds the initials verbatim (no case change, no prefix)", () => {
    const result = buildDateChangeComments("03/14/2026", "03/20/2026", "maS");
    assert.ok(result.endsWith("-maS"));
  });
});

describe("buildDuplicateTerminationComment", () => {
  it("produces the two-line Image-7 comment with form #, initials, and today", () => {
    const result = buildDuplicateTerminationComment("4222", "JR", "02/22/2026");
    assert.equal(
      result,
      "Duplicate termination. Re Kuali Form #4222. -JR 02/22/2026\n" +
        "EE termination approved on UCPath. -JR 02/22/2026",
    );
  });

  it("is exactly two newline-joined lines", () => {
    const lines = buildDuplicateTerminationComment("4290", "MAS", "06/22/2026").split("\n");
    assert.equal(lines.length, 2);
    assert.ok(lines[0].startsWith("Duplicate termination. Re Kuali Form #4290."));
    assert.ok(lines[1].startsWith("EE termination approved on UCPath."));
  });

  it("stamps the initials and date verbatim on both lines", () => {
    const result = buildDuplicateTerminationComment("100", "jr", "12/31/2026");
    for (const line of result.split("\n")) {
      assert.ok(line.endsWith("-jr 12/31/2026"), `line should end with the stamp: ${line}`);
    }
  });
});

describe("todayMmDdYyyy", () => {
  it("formats an injected date as zero-padded MM/DD/YYYY", () => {
    assert.equal(todayMmDdYyyy(new Date(2026, 1, 5)), "02/05/2026");
    assert.equal(todayMmDdYyyy(new Date(2026, 11, 31)), "12/31/2026");
  });

  it("defaults to the current date (MM/DD/YYYY shape)", () => {
    assert.match(todayMmDdYyyy(), /^\d{2}\/\d{2}\/\d{4}$/);
  });
});
