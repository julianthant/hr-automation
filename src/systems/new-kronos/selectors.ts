import type { Page, Locator, FrameLocator } from "playwright";

/**
 * New Kronos (WFD / Dayforce) selector registry.
 *
 * Search sidebar and timecard content live inside an iframe with a
 * session-dependent name: `portal-frame-*`. We expose a `searchFrame(page)`
 * helper for dynamic iframe lookup.
 */

// ─── Dynamic iframe lookup ────────────────────────────────────────────────

/**
 * Grab the Employee Search sidebar iframe (dynamic name).
 * verified 2026-04-06 (selector: iframe[name^="portal-frame-"])
 */
export function searchFrame(page: Page): FrameLocator {
  return page.frameLocator('iframe[name^="portal-frame-"]');
}

// ─── Top-level navbar ──────────────────────────────────────────────────────

export const navbar = {
  /** Open the Employee Search sidebar. verified 2026-04-06 */
  employeeSearchButton: (page: Page): Locator =>
    page.getByRole("button", { name: "Employee Search" }).first(),
};

// ─── Employee Search sidebar (inside portal-frame-*) ──────────────────────

export const search = {
  /** Search textbox inside the frame. verified 2026-04-06 */
  searchInput: (f: FrameLocator): Locator =>
    f.getByRole("textbox", { name: "Search by Employee Name or ID" }),

  /** Search submit (exact name to distinguish from other Search buttons). verified 2026-04-06 */
  searchSubmitButton: (f: FrameLocator): Locator =>
    f.getByRole("button", { name: "Search", exact: true }),

  /** "There are no items to display" text — no-results probe. verified 2026-04-06 */
  noResultsText: (f: FrameLocator): Locator =>
    f.getByText("There are no items to display."),

  /** First-row checkbox on employee results. verified 2026-04-06 */
  firstResultCheckbox: (f: FrameLocator): Locator =>
    f.locator('input[type="checkbox"]').first(),

  /** First-row fallback (click the row directly). verified 2026-04-06 */
  firstResultRow: (f: FrameLocator): Locator =>
    f.locator('[role="row"]').first(),

  /** Close the sidebar. verified 2026-04-06 */
  closeButton: (f: FrameLocator): Locator =>
    f.getByRole("button", { name: "Employee Search Close" }),
};

// ─── Go To → Timecard menu (page-scoped + frame-scoped fallbacks) ─────────

export const goToMenu = {
  /**
   * Go To button (outside the search frame). Two-deep fallback for the
   * regex + literal variants. verified 2026-04-06
   */
  goToButtonOnPage: (page: Page): Locator =>
    page
      .getByRole("button", { name: /go to/i })
      .or(page.locator("button:has-text('Go To')")),

  /** Go To button inside the search frame. verified 2026-04-06 */
  goToButtonInFrame: (f: FrameLocator): Locator =>
    f.getByRole("button", { name: /go to/i }).or(f.locator("text=Go To")),

  /**
   * Timecard menu item — 6-deep fallback chain covering both frame
   * (searchFrame) and page-level renderings, plus "Timecards" plural /
   * "Timecard" singular variants. verified 2026-04-06
   */
  timecardItem: (page: Page): Locator => {
    const f = searchFrame(page);
    return f
      .getByRole("menuitem", { name: /timecard/i })
      .or(f.locator("text=Timecards").first())
      .or(f.locator("text=Timecard").first())
      .or(page.getByRole("menuitem", { name: /timecard/i }))
      .or(page.locator("text=Timecards").first())
      .or(page.locator("text=Timecard").first());
  },
};

// ─── Timecard view / pay period controls ──────────────────────────────────

export const timecard = {
  /** Current Pay Period button (first). verified 2026-04-06 */
  currentPayPeriodButton: (page: Page): Locator =>
    page.getByRole("button", { name: "Current Pay Period" }).first(),

  /**
   * Pay-period trigger button — text varies ("Current Pay Period",
   * "Previous Pay Period", or a date range). Match all three.
   * verified 2026-04-06
   */
  payPeriodTriggerButton: (page: Page): Locator =>
    page
      .getByRole("button", {
        name: /Pay Period|Schedule Period|^\d+\/\d+\/\d+/,
      })
      .first(),

  /** Previous Pay Period option (inside an open period dropdown). verified 2026-04-06 */
  previousPayPeriodOption: (page: Page): Locator =>
    page.getByRole("option", { name: "Previous Pay Period" }),

  /** "Select range" button to switch to custom date range. verified 2026-04-06 */
  selectRangeButton: (page: Page): Locator =>
    page.getByRole("button", { name: "Select range" }),

  /** Start date input (custom range). verified 2026-04-06 */
  startDateInput: (page: Page): Locator =>
    page.getByRole("textbox", { name: "Start date" }),

  /** End date input (custom range). verified 2026-04-06 */
  endDateInput: (page: Page): Locator =>
    page.getByRole("textbox", { name: "End date" }),

  /** Apply button (custom range). verified 2026-04-06 */
  applyButton: (page: Page): Locator =>
    page.getByRole("button", { name: "Apply" }),
};

export const newKronosSelectors = {
  searchFrame,
  navbar,
  search,
  goToMenu,
  timecard,
};
