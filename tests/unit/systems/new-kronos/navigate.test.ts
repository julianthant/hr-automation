/**
 * Pins resolveSearchResult — the New Kronos employee-search outcome resolver.
 *
 * Regression guard for ISS-B04 (surfaced by the live separations e2e): a New
 * Kronos search for an employee with no usable record timed out after 15s and
 * THREW `[New Kronos] Timed out waiting for search results`, a fatal-looking `✗`
 * even though New Kronos is a BEST-EFFORT source (the separations handler falls
 * back to the Kuali Last Day Worked when New Kronos returns nothing). The race
 * now resolves a both-waiters-rejected timeout to NOT FOUND (`false`) with a
 * `log.warn`, not a throw.
 */

import { describe, it, vi } from "vitest";
import assert from "node:assert/strict";

import {
  resolveSearchResult,
  parseMmddyyyy,
  toIsoDate,
  calendarDayLabelPattern,
  parseCalendarHeaderOrdinal,
  probeEidInTimecardText,
} from "../../../../src/systems/new-kronos/navigate.js";
import { log } from "../../../../src/utils/log.js";

describe("probeEidInTimecardText", () => {
  it("matches when the searched EID appears in the timecard header text", () => {
    const probe = probeEidInTimecardText(
      "Employee timecards\n10864213 · Argumedo, Zaira N\nMon 6/23",
      "10864213",
    );
    assert.equal(probe.match, true);
    assert.equal(probe.otherEid, null);
  });

  it("reports a different 8-digit EID as a wrong-person signal", () => {
    const probe = probeEidInTimecardText(
      "Employee timecards\n10851756 · Someone Else\nMon 6/23",
      "10864213",
    );
    assert.equal(probe.match, false);
    assert.equal(probe.otherEid, "10851756");
  });

  it("returns no otherEid when no 8-digit id is visible", () => {
    const probe = probeEidInTimecardText("Employee timecards\nLoading…", "10864213");
    assert.equal(probe.match, false);
    assert.equal(probe.otherEid, null);
  });
});

describe("resolveSearchResult", () => {
  it("returns true when the result checkbox appears first", async () => {
    const result = await resolveSearchResult(
      Promise.resolve(), // checkbox visible
      new Promise(() => {}), // no-results sentinel never appears
      "10000001",
    );
    assert.equal(result, true);
  });

  it("returns false when the no-results sentinel appears first", async () => {
    const result = await resolveSearchResult(
      new Promise(() => {}), // checkbox never appears
      Promise.resolve(), // "no items to display"
      "10000002",
    );
    assert.equal(result, false);
  });

  it("treats a timeout (neither waiter resolves) as NOT FOUND, never throws (ISS-B04)", async () => {
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
    try {
      const result = await resolveSearchResult(
        Promise.reject(new Error("checkbox timeout")),
        Promise.reject(new Error("no-results timeout")),
        "10000003",
      );
      assert.equal(result, false, "a both-rejected race resolves to not-found, not a throw");
      assert.ok(warn.mock.calls.length >= 1, "the best-effort miss is logged as a warning");
    } finally {
      warn.mockRestore();
    }
  });
});

/**
 * Pins the native-date-input helpers that replaced the masked-keystroke entry
 * (ISS-B05, after a live DOM dump proved the WFD "Select range" fields are
 * NATIVE `<input type=date>` — value held as ISO `YYYY-MM-DD`, not a masked text
 * field). `toIsoDate` is what `setRangeDate` fills (the input rejects MM/DD/YYYY,
 * which is why every prior fill "reverted to today"); `parseMmddyyyy`,
 * `calendarDayLabelPattern`, and `parseCalendarHeaderOrdinal` drive the calendar
 * grid FALLBACK (day-cell aria-label match + month-nav stepping).
 */
describe("toIsoDate", () => {
  it("converts M/D/YYYY to the ISO value a native date input accepts", () => {
    assert.equal(toIsoDate("5/11/2026"), "2026-05-11");
    assert.equal(toIsoDate("05/11/2026"), "2026-05-11");
    assert.equal(toIsoDate("12/1/2026"), "2026-12-01");
  });

  it("throws loud on a malformed date instead of applying a wrong window", () => {
    assert.throws(() => toIsoDate("2026-05-11"));
    assert.throws(() => toIsoDate("13/40/2026"));
  });
});

describe("parseMmddyyyy", () => {
  it("parses to 0-based month for calendar math", () => {
    assert.deepEqual(parseMmddyyyy("6/11/2026"), { year: 2026, monthIndex: 5, day: 11 });
    assert.deepEqual(parseMmddyyyy("01/01/2026"), { year: 2026, monthIndex: 0, day: 1 });
  });
});

describe("calendarDayLabelPattern", () => {
  it("matches the day cell's full-date aria-label, weekday-agnostic", () => {
    const re = calendarDayLabelPattern({ year: 2026, monthIndex: 5, day: 11 });
    assert.ok(re.test("Monday, June 11, 2026"));
    assert.ok(re.test("June 11, 2026"));
  });

  it("does not let a single-digit day match a two-digit day (June 1 vs June 11)", () => {
    const re = calendarDayLabelPattern({ year: 2026, monthIndex: 5, day: 1 });
    assert.ok(re.test("Monday, June 1, 2026"));
    assert.equal(re.test("Thursday, June 11, 2026"), false);
  });
});

describe("parseCalendarHeaderOrdinal", () => {
  it("parses the moment-picker header ('Jun 2026') to a comparable month ordinal", () => {
    const jun = parseCalendarHeaderOrdinal("Jun 2026");
    const may = parseCalendarHeaderOrdinal("May 2026");
    const jul = parseCalendarHeaderOrdinal("Jul 2026");
    assert.equal(jun, 2026 * 12 + 5);
    assert.equal(may! < jun!, true, "May steps backward from Jun");
    assert.equal(jul! > jun!, true, "Jul steps forward from Jun");
  });

  it("tolerates trailing whitespace and full month names", () => {
    assert.equal(parseCalendarHeaderOrdinal("Jun 2026 "), 2026 * 12 + 5);
    assert.equal(parseCalendarHeaderOrdinal("June 2026"), 2026 * 12 + 5);
  });

  it("returns null on an unparseable header (caller stops navigating)", () => {
    assert.equal(parseCalendarHeaderOrdinal(""), null);
    assert.equal(parseCalendarHeaderOrdinal("loading…"), null);
  });
});
