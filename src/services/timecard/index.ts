import type { Page } from "playwright";

/**
 * Inclusive date window a grid-parsed month/day pair must fall inside.
 * Compared at DAY granularity — the time-of-day on `start`/`end` is ignored.
 */
export interface TimecardDateRange {
  start: Date;
  end: Date;
}

/** Local-midnight timestamp for `d` (day-granularity comparisons). */
function startOfDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** "MM/DD/YYYY – MM/DD/YYYY" for error messages. */
function describeRange(range: TimecardDateRange): string {
  const f = (d: Date) =>
    `${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}/${d.getFullYear()}`;
  return `${f(range.start)} – ${f(range.end)}`;
}

/**
 * Format a timecard month/day pair as MM/DD/YYYY, resolving the YEAR against
 * the date range the timecard view is actually showing.
 *
 * Kronos grids render dates without a year ("Mon 12/30"), so the year must be
 * inferred. Inferring it from "now" (the retired optional `referenceDate`
 * parameter, defaulted to `new Date()`) reintroduced the Dec→Jan year-stamp
 * bug whenever the caller omitted it — a December row read in January was
 * stamped with January's year. There is NO default anymore: the caller states
 * the window it requested/expects, and the year is the unique candidate year
 * (`range.start.getFullYear()`..`range.end.getFullYear()`) whose composed
 * date falls inside `[range.start, range.end]` (inclusive, day granularity).
 *
 * Fail loud (throws), never guesses:
 * - impossible month/day (out of 1-12 / 1-31 bounds, or a JS `Date` rollover
 *   like 2/30 or a non-leap 2/29);
 * - zero candidate years (the day cannot belong to the requested window);
 * - two or more candidate years (a >1-year window is ambiguous).
 *
 * @param month - 1-based month number from the timecard cell text (e.g. 3 for "Mon 3/16")
 * @param day   - 1-based day number
 * @param range - inclusive window the date must fall inside (no default)
 * @returns "MM/DD/YYYY" with zero-padded month and day
 */
export function formatTimecardDate(
  month: number,
  day: number,
  range: TimecardDateRange,
): string {
  if (!Number.isInteger(month) || !Number.isInteger(day) || month < 1 || month > 12 || day < 1 || day > 31) {
    throw new Error(
      `[timecard] invalid month/day ${month}/${day} parsed from the timecard grid — cannot resolve a date`,
    );
  }

  const lo = startOfDay(range.start);
  const hi = startOfDay(range.end);
  if (lo > hi) {
    throw new Error(
      `[timecard] inverted date range ${describeRange(range)} while resolving ${month}/${day}`,
    );
  }

  let composable = 0;
  const candidates: number[] = [];
  for (let year = range.start.getFullYear(); year <= range.end.getFullYear(); year++) {
    const composed = new Date(year, month - 1, day);
    // JS Date silently rolls an impossible day into the next month
    // (2/30 → Mar 1/2); require an exact round-trip.
    if (composed.getMonth() !== month - 1 || composed.getDate() !== day) continue;
    composable++;
    const t = composed.getTime();
    if (t >= lo && t <= hi) candidates.push(year);
  }

  if (composable === 0) {
    throw new Error(
      `[timecard] impossible date ${month}/${day} — no candidate year in ${describeRange(range)} has that calendar day`,
    );
  }
  if (candidates.length === 0) {
    throw new Error(
      `[timecard] ${month}/${day} falls outside the requested range ${describeRange(range)} in every candidate year — refusing to guess the year`,
    );
  }
  if (candidates.length > 1) {
    throw new Error(
      `[timecard] ${month}/${day} is ambiguous within ${describeRange(range)} — candidate years ${candidates.join(", ")}; narrow the range`,
    );
  }

  const mm = String(month).padStart(2, "0");
  const dd = String(day).padStart(2, "0");
  return `${mm}/${dd}/${candidates[0]}`;
}

/**
 * Positive check that a displayed pay-period label actually changed after a
 * "switch to previous period" (or "apply a custom range") action.
 *
 * Both Old and New Kronos close their period dropdown/option as soon as the
 * click registers (`.waitFor({ state: "hidden" })`) — that only proves the
 * dropdown/option DETACHED, not that the underlying timecard grid actually
 * switched periods. Trusting the dropdown-close signal alone risks reading
 * the grid while it still shows the ORIGINAL period (silently wrong LDW /
 * sick / holiday data — see root CLAUDE.md "Fail loud"). Call this
 * immediately after the dropdown-close wait, comparing the period label read
 * before the switch to the label read after, and fail loud (throw) when it
 * returns `false`.
 *
 * BOTH labels must be readable (non-blank after trimming) AND different
 * (case/whitespace insensitive). A blank BEFORE means the baseline was never
 * read — with no baseline there is nothing to compare against, so the switch
 * CANNOT be verified and the answer is `false` (a verification failure the
 * caller must throw on), never "assume it switched". When
 * `currentLabelPattern` is supplied, `after` must also NOT still match it —
 * used by New Kronos to catch the case where the label closed the dropdown
 * but is still literally showing "Current Pay Period".
 */
export function didPeriodLabelSwitch(
  before: string,
  after: string,
  currentLabelPattern?: RegExp,
): boolean {
  const b = before.trim().toLowerCase();
  const a = after.trim().toLowerCase();
  if (!b) return false;
  if (!a) return false;
  if (a === b) return false;
  if (currentLabelPattern && currentLabelPattern.test(after)) return false;
  return true;
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
  /**
   * Read the last date with time entries from the current view. `range` is
   * the inclusive window the displayed pay period must fall inside — resolve
   * grid month/day pairs against it via `formatTimecardDate(m, d, range)`.
   */
  readLastDate(page: Page, range: TimecardDateRange): Promise<string | null>;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Conservative year-resolution windows for `runTimecardCheck`'s two reads,
 * derived from `now` (the moment the check runs):
 *
 * - current pay period  ≈ [now − 60d, now + 7d]
 * - previous pay period ≈ [now − 120d, now + 7d]
 *
 * Kronos pay periods are at most a month long, so these comfortably contain
 * whatever period is displayed, and each window is well under ~330 days —
 * any month/day pair resolves to exactly ONE candidate year inside it.
 */
export function timecardCheckWindows(
  now: Date = new Date(),
): { current: TimecardDateRange; previous: TimecardDateRange } {
  const end = new Date(now.getTime() + 7 * DAY_MS);
  return {
    current: { start: new Date(now.getTime() - 60 * DAY_MS), end },
    previous: { start: new Date(now.getTime() - 120 * DAY_MS), end },
  };
}

export async function runTimecardCheck(
  page: Page,
  driver: TimecardDriver,
  now: Date = new Date(),
): Promise<string | null> {
  const windows = timecardCheckWindows(now);

  const ok = await driver.goToTimecard(page);
  if (!ok) return null;

  await page.waitForTimeout(3_000);
  if (driver.afterGoTo) await driver.afterGoTo(page);

  // Check current pay period
  let lastDate = await driver.readLastDate(page, windows.current);
  if (lastDate) return lastDate;

  // No entries in current — try previous pay period
  const switched = await driver.switchPeriod(page);
  if (switched) {
    await page.waitForTimeout(3_000);
    if (driver.afterSwitch) await driver.afterSwitch(page);
    lastDate = await driver.readLastDate(page, windows.previous);
  }

  return lastDate;
}
