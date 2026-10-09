import { describe, expect, it } from "vitest";
import {
  DEMO_DAY,
  DEMO_DAYS,
  buildDemoMonth,
  dayCounts,
  demoMonthRange,
  monthLabel,
  monthOfDay,
  moveCalendarFocus,
  shiftMonth,
  topLevelRowsForDay,
} from "@/components/dev/rebuild-demo/demo-days";

/**
 * DEV-ONLY (`?view=rebuild-demo`) — the TOP BAR's date picker.
 *
 * The control it replaced was a `<span>`: a calendar glyph, a date and a count,
 * none of which opened anything. Making it real put two contracts on the grid
 * that are worth holding with a test rather than by pressing keys.
 *
 *  1. **A cell's count is the corpus count.** It comes off `topLevelRowsForDay`
 *     — the one function the rail badges, the Status Bar pills and the queue
 *     already read — so the number you press and the number you land on cannot
 *     be two derivations of the same fact.
 *  2. **Arrow keys CLAMP, they do not wrap.** Running off the right edge of the
 *     last week must stop rather than teleport to the first.
 */
describe("rebuild demo — the date navigator's month grid", () => {
  it("is always six Sunday-first weeks, so stepping a month never reflows the popover", () => {
    for (const month of ["2026-01", "2026-02", "2026-07", "2026-08", "2027-02"]) {
      const cells = buildDemoMonth(month);
      expect(cells).toHaveLength(42);
      // Sunday-first: the first cell is a Sunday in every month.
      expect(new Date(`${cells[0].day}T00:00:00Z`).getUTCDay()).toBe(0);
    }
  });

  it("marks exactly the days the tracker holds as available", () => {
    const cells = buildDemoMonth(monthOfDay(DEMO_DAY));
    const available = cells.filter((c) => c.available).map((c) => c.day);
    expect(available).toEqual(DEMO_DAYS);
  });

  it("takes every count off the one corpus function, never a second tally", () => {
    const badge = dayCounts();
    for (const cell of buildDemoMonth(monthOfDay(DEMO_DAY))) {
      if (!cell.available) {
        expect(cell.count).toBe(0);
        continue;
      }
      expect(cell.count).toBe(topLevelRowsForDay(cell.day).length);
      // and the pill's own badge agrees with the cell the operator pressed
      expect(cell.count).toBe(badge[cell.day]);
    }
  });

  it("flags today, and only today", () => {
    const today = buildDemoMonth(monthOfDay(DEMO_DAY)).filter((c) => c.isToday);
    expect(today.map((c) => c.day)).toEqual([DEMO_DAY]);
  });

  it("keeps the leading and trailing cells out of the month", () => {
    const month = monthOfDay(DEMO_DAY);
    for (const cell of buildDemoMonth(month)) {
      expect(cell.inMonth).toBe(cell.day.slice(0, 7) === month);
    }
  });

  it("shifts months across a year boundary in both directions", () => {
    expect(shiftMonth("2026-01", -1)).toBe("2025-12");
    expect(shiftMonth("2026-12", 1)).toBe("2027-01");
    expect(shiftMonth("2026-07", 0)).toBe("2026-07");
  });

  it("labels a month the way the header prints it", () => {
    expect(monthLabel("2026-07")).toBe("July 2026");
  });

  it("browses only the months the tracker has partitions in", () => {
    const { first, last } = demoMonthRange();
    expect(first).toBe(monthOfDay(DEMO_DAYS[0]));
    expect(last).toBe(monthOfDay(DEMO_DAYS[DEMO_DAYS.length - 1]));
    expect(first <= last).toBe(true);
  });

  describe("keyboard movement clamps to the grid", () => {
    it("moves by one day and by one week", () => {
      expect(moveCalendarFocus(10, "ArrowRight")).toBe(11);
      expect(moveCalendarFocus(10, "ArrowLeft")).toBe(9);
      expect(moveCalendarFocus(10, "ArrowDown")).toBe(17);
      expect(moveCalendarFocus(10, "ArrowUp")).toBe(3);
    });

    it("stops at both edges rather than wrapping", () => {
      expect(moveCalendarFocus(0, "ArrowLeft")).toBe(0);
      expect(moveCalendarFocus(0, "ArrowUp")).toBe(0);
      expect(moveCalendarFocus(41, "ArrowRight")).toBe(41);
      expect(moveCalendarFocus(41, "ArrowDown")).toBe(41);
    });

    it("takes Home and End to the edges of the focused week", () => {
      expect(moveCalendarFocus(10, "Home")).toBe(7);
      expect(moveCalendarFocus(10, "End")).toBe(13);
      expect(moveCalendarFocus(41, "Home")).toBe(35);
      expect(moveCalendarFocus(35, "End")).toBe(41);
    });

    it("answers null for a key it does not own, so the event is not swallowed", () => {
      expect(moveCalendarFocus(10, "Enter")).toBeNull();
      expect(moveCalendarFocus(10, "Escape")).toBeNull();
      expect(moveCalendarFocus(10, "Tab")).toBeNull();
    });
  });
});
