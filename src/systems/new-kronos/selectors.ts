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
 * @tags iframe, frame, search, portal, dayforce, new-kronos
 */
export function searchFrame(page: Page): FrameLocator {
  return page.frameLocator('iframe[name^="portal-frame-"]');
}

// ─── Top-level navbar ──────────────────────────────────────────────────────

export const navbar = {
  /**
   * Open the Employee Search sidebar. verified 2026-04-06
   * @tags employee, search, button, sidebar, navbar, new-kronos
   */
  employeeSearchButton: (page: Page): Locator =>
    page.getByRole("button", { name: "Employee Search" }).first(),
};

// ─── Employee Search sidebar (inside portal-frame-*) ──────────────────────

export const search = {
  /**
   * Search textbox inside the frame. verified 2026-04-06
   * @tags search, input, textbox, employee, name, id, new-kronos
   */
  searchInput: (f: FrameLocator): Locator =>
    f.getByRole("textbox", { name: "Search by Employee Name or ID" }),

  /**
   * Search submit (exact name to distinguish from other Search buttons). verified 2026-04-06
   * @tags search, submit, button, new-kronos
   */
  searchSubmitButton: (f: FrameLocator): Locator =>
    f.getByRole("button", { name: "Search", exact: true }),

  /**
   * "There are no items to display" text — no-results probe. verified 2026-04-06
   * @tags no-results, empty, text, probe, search, new-kronos
   */
  noResultsText: (f: FrameLocator): Locator =>
    f.getByText("There are no items to display."),

  /**
   * First-row checkbox on employee results. verified 2026-04-06
   * @tags first, result, checkbox, search, new-kronos
   */
  firstResultCheckbox: (f: FrameLocator): Locator =>
    f.locator('input[type="checkbox"]').first(),

  /**
   * First-row fallback (click the row directly). verified 2026-04-06
   * @tags first, result, row, fallback, search, new-kronos
   */
  firstResultRow: (f: FrameLocator): Locator =>
    f.locator('[role="row"]').first(),

  /**
   * Close the sidebar. verified 2026-04-06
   * @tags close, sidebar, button, search, new-kronos
   */
  closeButton: (f: FrameLocator): Locator =>
    f.getByRole("button", { name: "Employee Search Close" }),
};

// ─── Go To → Timecard menu (page-scoped + frame-scoped fallbacks) ─────────

export const goToMenu = {
  /**
   * Go To button (outside the search frame). Two-deep fallback for the
   * regex + literal variants. verified 2026-04-06
   * @tags go-to, button, page, navigation, new-kronos
   */
  goToButtonOnPage: (page: Page): Locator =>
    page
      .getByRole("button", { name: /go to/i })
      .or(page.locator("button:has-text('Go To')")),

  /**
   * Go To button inside the search frame. verified 2026-04-06
   * @tags go-to, button, frame, navigation, new-kronos
   */
  goToButtonInFrame: (f: FrameLocator): Locator =>
    f.getByRole("button", { name: /go to/i }).or(f.locator("text=Go To")),

  /**
   * Timecard menu item — 6-deep fallback chain covering both frame
   * (searchFrame) and page-level renderings, plus "Timecards" plural /
   * "Timecard" singular variants. verified 2026-04-06
   * @tags timecard, menu, item, fallback, navigation, new-kronos
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
  /**
   * Current Pay Period button (first). verified 2026-04-06
   * @tags current, pay, period, button, timecard, new-kronos
   */
  currentPayPeriodButton: (page: Page): Locator =>
    page.getByRole("button", { name: "Current Pay Period" }).first(),

  /**
   * Pay-period trigger button — text varies ("Current Pay Period",
   * "Previous Pay Period", or a date range). Match all three.
   * verified 2026-04-06
   * @tags pay, period, trigger, button, timecard, new-kronos
   */
  payPeriodTriggerButton: (page: Page): Locator =>
    page
      .getByRole("button", {
        name: /Pay Period|Schedule Period|^\d+\/\d+\/\d+/,
      })
      .first(),

  /**
   * Previous Pay Period option (inside an open period dropdown). verified 2026-04-06
   * @tags previous, pay, period, option, timecard, new-kronos
   */
  previousPayPeriodOption: (page: Page): Locator =>
    page.getByRole("option", { name: "Previous Pay Period" }),

  /**
   * "Select range" button to switch to custom date range. verified 2026-04-06
   * @tags select, range, button, custom, date, timecard, new-kronos
   */
  selectRangeButton: (page: Page): Locator =>
    page.getByRole("button", { name: "Select range" }),

  /**
   * Start date input (custom range). verified 2026-04-06
   * @tags start, date, input, range, timecard, new-kronos
   */
  startDateInput: (page: Page): Locator =>
    page.getByRole("textbox", { name: "Start date" }),

  /**
   * End date input (custom range). verified 2026-04-06
   * @tags end, date, input, range, timecard, new-kronos
   */
  endDateInput: (page: Page): Locator =>
    page.getByRole("textbox", { name: "End date" }),

  /**
   * Apply button (custom range). verified 2026-04-06
   * @tags apply, button, range, timecard, new-kronos
   */
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
