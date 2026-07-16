/**
 * Pins the pure timecard-date logic in `src/services/timecard/index.ts`:
 *
 * - `formatTimecardDate` — resolves a grid-parsed month/day pair to
 *   MM/DD/YYYY against the REQUESTED date range (candidate-year enumeration,
 *   fail-loud on zero or ≥2 candidates). This kills the Dec→Jan year-stamp
 *   bug for good: the old optional `referenceDate` defaulted to `new Date()`
 *   and every caller omitted it, silently stamping January's year onto
 *   December rows.
 * - `timecardCheckWindows` — the conservative current/previous windows
 *   `runTimecardCheck` derives from "now" (each well under 330 days, so any
 *   month/day resolves to exactly one year).
 * - `didPeriodLabelSwitch` — the positive "did the displayed pay-period
 *   label actually change" check both Old and New Kronos run after a period
 *   switch / custom-range Apply. The dropdown-close (`.waitFor({state:
 *   "hidden"})`) signal only proves a link/option detached, not that the
 *   timecard grid actually switched periods; this predicate is the fail-loud
 *   gate that catches the mismatch before a caller reads the grid. BOTH
 *   labels must be readable: a blank BEFORE (baseline never read) is a
 *   verification failure, never a "switch".
 */

import { describe, it } from "vitest";
import assert from "node:assert/strict";

import {
  didPeriodLabelSwitch,
  formatTimecardDate,
  timecardCheckWindows,
} from "../../../../src/services/timecard/index.js";

describe("formatTimecardDate", () => {
  // 12/01/2025 – 01/31/2026: the Dec→Jan boundary window.
  const winterWindow = { start: new Date(2025, 11, 1), end: new Date(2026, 0, 31) };

  it("resolves a December day in a Dec→Jan window to the EARLIER year", () => {
    assert.equal(formatTimecardDate(12, 30, winterWindow), "12/30/2025");
  });

  it("resolves a January day in a Dec→Jan window to the LATER year (zero-padded)", () => {
    assert.equal(formatTimecardDate(1, 2, winterWindow), "01/02/2026");
  });

  it("resolves a plain same-year window", () => {
    const spring = { start: new Date(2026, 2, 1), end: new Date(2026, 3, 15) };
    assert.equal(formatTimecardDate(3, 16, spring), "03/16/2026");
  });

  it("is inclusive at both range endpoints", () => {
    assert.equal(formatTimecardDate(12, 1, winterWindow), "12/01/2025");
    assert.equal(formatTimecardDate(1, 31, winterWindow), "01/31/2026");
  });

  it("throws when the month/day falls inside NO candidate year of the range", () => {
    assert.throws(() => formatTimecardDate(6, 15, winterWindow), /6\/15/);
  });

  it("throws when a >1-year range yields TWO candidate years (ambiguous)", () => {
    const wide = { start: new Date(2024, 11, 1), end: new Date(2026, 0, 31) };
    assert.throws(() => formatTimecardDate(12, 30, wide), /12\/30/);
  });

  it("throws on an impossible month/day (2/30 — JS Date would roll it over)", () => {
    assert.throws(() => formatTimecardDate(2, 30, winterWindow), /2\/30/);
  });

  it("throws on out-of-bounds month or day numbers", () => {
    assert.throws(() => formatTimecardDate(0, 10, winterWindow));
    assert.throws(() => formatTimecardDate(13, 10, winterWindow));
    assert.throws(() => formatTimecardDate(3, 0, winterWindow));
    assert.throws(() => formatTimecardDate(3, 32, winterWindow));
  });

  it("resolves Feb 29 only when a candidate year is a leap year", () => {
    const leap = { start: new Date(2028, 0, 1), end: new Date(2028, 11, 31) };
    assert.equal(formatTimecardDate(2, 29, leap), "02/29/2028");
    const nonLeap = { start: new Date(2026, 0, 1), end: new Date(2026, 5, 30) };
    assert.throws(() => formatTimecardDate(2, 29, nonLeap), /2\/29/);
  });
});

describe("timecardCheckWindows", () => {
  it("derives current + previous windows around `now`, each under 330 days (unambiguous)", () => {
    const now = new Date(2026, 0, 15, 14, 30);
    const { current, previous } = timecardCheckWindows(now);
    for (const w of [current, previous]) {
      assert.ok(w.start.getTime() < now.getTime() && now.getTime() < w.end.getTime());
      const days = (w.end.getTime() - w.start.getTime()) / 86_400_000;
      assert.ok(days < 330, `window spans ${days} days — must stay under 330 for a unique year`);
    }
    // The previous window reaches further back than the current one.
    assert.ok(previous.start.getTime() < current.start.getTime());
  });

  it("kills the Dec→Jan bug: a Dec 30 row read while running on Jan 15 resolves to LAST year", () => {
    const { current } = timecardCheckWindows(new Date(2026, 0, 15));
    assert.equal(formatTimecardDate(12, 30, current), "12/30/2025");
  });
});

describe("didPeriodLabelSwitch", () => {
  it("returns true when the label changed to a non-blank different value", () => {
    assert.equal(didPeriodLabelSwitch("Current Pay Period", "Previous Pay Period"), true);
  });

  it("returns true when the label changed to a date-range string", () => {
    assert.equal(didPeriodLabelSwitch("Current Pay Period", "3/01/2026 - 4/15/2026"), true);
  });

  it("returns false when the label is unchanged", () => {
    assert.equal(didPeriodLabelSwitch("Current Pay Period", "Current Pay Period"), false);
  });

  it("returns false when the label is unchanged modulo case/whitespace", () => {
    assert.equal(didPeriodLabelSwitch("Current Pay Period", "  current pay period  "), false);
  });

  it("returns false when the after label is blank", () => {
    assert.equal(didPeriodLabelSwitch("Current Pay Period", ""), false);
    assert.equal(didPeriodLabelSwitch("Current Pay Period", "   "), false);
  });

  it("returns false when the before label was blank and after is still blank", () => {
    assert.equal(didPeriodLabelSwitch("", ""), false);
  });

  it("returns false when the before label is blank, even if after has content — an unreadable baseline is a verification failure, not a switch", () => {
    assert.equal(didPeriodLabelSwitch("", "Previous Pay Period"), false);
  });

  it("returns false when the before label is whitespace-only (treated as blank)", () => {
    assert.equal(didPeriodLabelSwitch("   ", "Previous Pay Period"), false);
  });

  it("returns false when a currentLabelPattern still matches the after label, even if it differs from before", () => {
    // after="Current Pay Period" — changed from the pre-switch range label,
    // but still the generic "current" label, so the switch did not land.
    assert.equal(
      didPeriodLabelSwitch("3/01/2026 - 4/15/2026", "Current Pay Period", /current pay period/i),
      false,
    );
  });

  it("returns true when a currentLabelPattern is supplied but the after label doesn't match it", () => {
    assert.equal(
      didPeriodLabelSwitch("Current Pay Period", "Previous Pay Period", /current pay period/i),
      true,
    );
  });

  it("ignores currentLabelPattern when after already differs and isn't the current label", () => {
    assert.equal(
      didPeriodLabelSwitch("Previous Pay Period", "3/01/2026 - 4/15/2026", /current pay period/i),
      true,
    );
  });
});
