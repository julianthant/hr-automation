/**
 * Pins `didPeriodLabelSwitch` — the positive "did the displayed pay-period
 * label actually change" check both Old and New Kronos run after a period
 * switch / custom-range Apply. The dropdown-close (`.waitFor({state:
 * "hidden"})`) signal only proves a link/option detached, not that the
 * timecard grid actually switched periods; this predicate is the fail-loud
 * gate that catches the mismatch before a caller reads the grid.
 */

import { describe, it } from "vitest";
import assert from "node:assert/strict";

import { didPeriodLabelSwitch } from "../../../../src/services/timecard/index.js";

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

  it("returns true when before was blank and after has content", () => {
    assert.equal(didPeriodLabelSwitch("", "Previous Pay Period"), true);
  });

  it("returns false when a currentLabelPattern still matches the after label, even if it differs from before", () => {
    // e.g. before="" (never read) after="Current Pay Period" — changed from
    // blank, but still the generic "current" label, so the switch did not land.
    assert.equal(
      didPeriodLabelSwitch("", "Current Pay Period", /current pay period/i),
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
