import type { Page } from "playwright";

/**
 * Format a timecard month/day pair as MM/DD/YYYY.
 *
 * Uses `referenceDate` (default: current date) to determine the year.
 * Pass an explicit date when the workflow has a known reference point —
 * prevents the Dec→Jan year-stamp bug where `new Date().getFullYear()`
 * stamps January's year onto a December timecard date.
 *
 * @param month - 1-based month number extracted from the timecard cell text (e.g. 3 for "Mon 3/16")
 * @param day   - 1-based day number
 * @param referenceDate - date used to derive the year; defaults to `new Date()`
 * @returns "MM/DD/YYYY" with zero-padded month and day
 */
export function formatTimecardDate(
  month: number,
  day: number,
  referenceDate: Date = new Date(),
): string {
  const mm = String(month).padStart(2, "0");
  const dd = String(day).padStart(2, "0");
  return `${mm}/${dd}/${referenceDate.getFullYear()}`;
}

/**
 * Generic timecard-check orchestration: navigate to timecard, check the
 * current pay period, and if empty, switch to the previous period and
 * re-check.
 *
 * Each Kronos driver exposes a concrete `TimecardDriver` that maps the
 * three abstract operations to its own system-specific implementation.
 * The caller passes a `Page` plus a driver; this function handles
 * only the control-flow.
 *
 * Returns the last date with In/Out entries as "MM/DD/YYYY", or null
 * if no entries are found in either period.
 */
export interface TimecardDriver {
  /** Navigate to the timecard view. Returns true on success. */
  goToTimecard(page: Page): Promise<boolean>;
  /**
   * Optional post-navigation hook (e.g. dismiss a modal, take a screenshot).
   * Called after `goToTimecard` resolves and after the 3s settle wait.
   */
  afterGoTo?(page: Page): Promise<void>;
  /**
   * Optional post-switch hook (e.g. dismiss a modal, take a screenshot).
   * Called after `switchPeriod` resolves and after the 3s settle wait.
   */
  afterSwitch?(page: Page): Promise<void>;
  /** Switch to the previous pay period. Returns true if switched. */
  switchPeriod(page: Page): Promise<boolean>;
  /** Read the last date with time entries from the current view. */
  readLastDate(page: Page): Promise<string | null>;
}

export async function runTimecardCheck(
  page: Page,
  driver: TimecardDriver,
): Promise<string | null> {
  const ok = await driver.goToTimecard(page);
  if (!ok) return null;

  await page.waitForTimeout(3_000);
  if (driver.afterGoTo) await driver.afterGoTo(page);

  // Check current pay period
  let lastDate = await driver.readLastDate(page);
  if (lastDate) return lastDate;

  // No entries in current — try previous pay period
  const switched = await driver.switchPeriod(page);
  if (switched) {
    await page.waitForTimeout(3_000);
    if (driver.afterSwitch) await driver.afterSwitch(page);
    lastDate = await driver.readLastDate(page);
  }

  return lastDate;
}
