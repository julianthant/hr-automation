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

// ─── WFD loading overlay ──────────────────────────────────────────────────
//
// Dayforce shows a full-page loading mask (.wfd-loading-overlay or
// [data-wfd-loading]) during navigation and after actions. Clicks that land
// while the overlay is visible are intercepted with "Another element
// intercepted the click (modal/overlay)". Wait for it to disappear before
// clicking. // NEEDS LIVE RE-VERIFY 2026-06-17

export const loadingOverlay = {
  /**
   * WFD full-page loading overlay — wait for it to be hidden before clicking.
   * Common selectors for Dayforce loading masks; at least one fires on the
   * employee-search button click. // NEEDS LIVE RE-VERIFY 2026-06-17
   * @tags loading, overlay, spinner, busy, wfd, dayforce, new-kronos
   */
  overlay: (page: Page): Locator =>
    page.locator(".wfd-loading-overlay, [data-wfd-loading], .wfd-modal-overlay, .wfd-busy-indicator"),
};

// ─── Top-level navbar ──────────────────────────────────────────────────────

export const navbar = {
  /**
   * Open the Employee Search sidebar. verified 2026-04-06
   * @tags employee, search, button, sidebar, navbar, new-kronos
   */
  employeeSearchButton: (page: Page): Locator =>
    page.getByRole("button", { name: "Employee Search" }).first(),
};

// ─── Employee Search sidebar (portal-frame iframe OR top-level page) ──────
//
// The WFD search sidebar renders its input/results either INSIDE the
// portal-frame iframe (fresh page load) or TOP-LEVEL on the page (e.g. when
// reached after a timecard navigation). So every search selector accepts a
// `SearchRoot` (FrameLocator | Page); navigate.ts resolves the live root via
// `resolveSearchRoot`. (2026-06-18: the iframe-only assumption caused a
// `locator.fill: Timeout` on the top-level variant — EID 10602099.)

/** The search sidebar's root context — the portal-frame iframe or the page. */
export type SearchRoot = FrameLocator | Page;

export const search = {
  /**
   * Search textbox (resolved iframe-or-top-level). verified 2026-06-18
   * @tags search, input, textbox, employee, name, id, new-kronos
   */
  searchInput: (root: SearchRoot): Locator =>
    root.getByRole("textbox", { name: "Search by Employee Name or ID" }),

  /**
   * Search submit (exact name to distinguish from other Search buttons). verified 2026-06-18
   * @tags search, submit, button, new-kronos
   */
  searchSubmitButton: (root: SearchRoot): Locator =>
    root.getByRole("button", { name: "Search", exact: true }),

  /**
   * "There are no items to display" text — no-results probe. verified 2026-06-18
   * @tags no-results, empty, text, probe, search, new-kronos
   */
  noResultsText: (root: SearchRoot): Locator =>
    root.getByText("There are no items to display."),

  /**
   * First result's "Select Item" checkbox — checking it SELECTS the employee,
   * which is what ENABLES the Go To button (it is `ng-disabled` until a slat is
   * selected). Target it PRECISELY by accessible name "Select Item" — do NOT
   * union with a bare `input[type=checkbox]`, which would also match the
   * "Select All" header checkbox and pick the wrong control (leaving
   * Selected[0]). The result control is a native input with role=checkbox, so
   * getByRole still matches it. verified 2026-06-18
   * @tags first, result, checkbox, select-item, search, new-kronos
   */
  firstResultCheckbox: (root: SearchRoot): Locator =>
    root.getByRole("checkbox", { name: "Select Item" }).first(),

  /**
   * First result row fallback — the result renders as a `menuitemradio`
   * ("Item Name <name> not checked"); clicking it also selects the employee.
   * verified 2026-06-18
   * @tags first, result, row, menuitemradio, fallback, search, new-kronos
   */
  firstResultRow: (root: SearchRoot): Locator =>
    root.getByRole("menuitemradio").or(root.locator('[role="row"]')).first(),

  /**
   * First result SLAT — a "somebody showed up" signal for found-detection. The
   * live WFD result renders as a `menuitemradio` ("Item Name <name> not
   * checked"); its presence means the search returned an employee. Kept TIGHT
   * (no `[role=row]` fallback, unlike `firstResultRow`) so a header/placeholder
   * row can never false-positive a not-found search into found. Used to detect a
   * present result INDEPENDENTLY of the "Select Item" checkbox, whose backing
   * native input is visually hidden — see `searchEmployee`.
   * @tags first, result, slat, menuitemradio, found, probe, search, new-kronos
   */
  // NEEDS LIVE RE-VERIFY 2026-06-22
  firstResultSlat: (root: SearchRoot): Locator =>
    root.getByRole("menuitemradio").first(),

  /**
   * Close the sidebar. verified 2026-06-18
   * @tags close, sidebar, button, search, new-kronos
   */
  closeButton: (root: SearchRoot): Locator =>
    root.getByRole("button", { name: "Employee Search Close" }),
};

// ─── Go To → Timecard menu (page-scoped + frame-scoped fallbacks) ─────────

export const goToMenu = {
  /**
   * Employee Search panel's "Go To" dropdown (top-level page render). MUST be
   * scoped to the Quick Find slide-out — a bare page-wide `/go to/i` ALSO matches
   * the timecard TOOLBAR "Go to" button (`aria-label="Go to"`,
   * `class="btn widget-button-icon"`), which is always enabled and sits BEHIND the
   * Employee Search slide-out's `slideout__mask`, so clicking it dies with "Another
   * element intercepted the click (modal/overlay)" (live log 2026-06-22: doc reached
   * "Employee checkbox checked" then 5s mask-interception timeout → empty timecard).
   * Primary = the panel's stable `#goToDropdownButton`
   * (`ng-disabled="!quickFind.slatOptions.selectedslats.length"`); fallback = the
   * `/go to/i` role match SCOPED to the `.quick-find-content` slide-out container
   * (verified present in the live log) so it can never resolve the toolbar button.
   * // NEEDS LIVE RE-VERIFY 2026-06-22 (derived from live error log + the 2026-06-18 id, not a fresh snapshot)
   * @tags go-to, button, page, quick-find, slideout, dropdown, navigation, new-kronos
   */
  goToButtonOnPage: (page: Page): Locator =>
    page
      .locator("#goToDropdownButton")
      .or(page.locator(".quick-find-content").getByRole("button", { name: /go to/i }))
      .first(),

  /**
   * Employee Search panel's "Go To" dropdown (portal-frame iframe render). Same
   * slide-out scoping as `goToButtonOnPage` — never the timecard toolbar "Go to".
   * // NEEDS LIVE RE-VERIFY 2026-06-22
   * @tags go-to, button, frame, quick-find, slideout, dropdown, navigation, new-kronos
   */
  goToButtonInFrame: (f: FrameLocator): Locator =>
    f
      .locator("#goToDropdownButton")
      .or(f.locator(".quick-find-content").getByRole("button", { name: /go to/i }))
      .first(),

  /**
   * Timecard menu item — 8-deep fallback chain. The live Dayforce Go To menu
   * renders Timecard as role="option" (not "menuitem") — option variants are
   * tried first. Covers both frame- and page-level renderings plus
   * "Timecards" plural / "Timecard" singular variants.
   * verified 2026-06-18
   * @tags timecard, menu, item, option, fallback, navigation, new-kronos
   */
  timecardItem: (page: Page): Locator => {
    const f = searchFrame(page);
    return f
      .getByRole("option", { name: /timecard/i })
      .or(page.getByRole("option", { name: /timecard/i }))
      .or(f.getByRole("menuitem", { name: /timecard/i }))
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
   * Pay-period trigger button — text varies ("Current Pay Period",
   * "Previous Pay Period", or a date range). Match all three.
   * verified 2026-06-18
   * @tags pay, period, trigger, button, timecard, new-kronos
   */
  payPeriodTriggerButton: (page: Page): Locator =>
    page
      .getByRole("button", {
        name: /Pay Period|Schedule Period|^\d+\/\d+\/\d+/,
      })
      .first(),

  /**
   * Previous Pay Period option (inside an open period dropdown). verified 2026-06-18
   * @tags previous, pay, period, option, timecard, new-kronos
   */
  previousPayPeriodOption: (page: Page): Locator =>
    page.getByRole("option", { name: "Previous Pay Period" }),

  /**
   * "Select range" button to switch to custom date range. verified 2026-06-18
   * @tags select, range, button, custom, date, timecard, new-kronos
   */
  selectRangeButton: (page: Page): Locator =>
    page.getByRole("button", { name: "Select range" }),

  /**
   * Start date input (custom range) — NATIVE `<input type=date>`, value held as
   * ISO `YYYY-MM-DD` (NOT a masked text field). Targeted by id. verified 2026-06-22
   * @tags start, date, input, range, timecard, native, new-kronos
   */
  startDateInput: (page: Page): Locator => page.locator("#startDateTimeInput"),

  /**
   * End date input (custom range) — NATIVE `<input type=date>` (ISO value).
   * Targeted by id. verified 2026-06-22
   * @tags end, date, input, range, timecard, native, new-kronos
   */
  endDateInput: (page: Page): Locator => page.locator("#endDateTimeInput"),

  /**
   * Moment-picker month/year header (e.g. "Jun 2026") — read to know which way
   * to step the calendar. verified 2026-06-22
   * @tags calendar, month, header, range, timecard, new-kronos
   */
  calendarMonthHeader: (page: Page): Locator =>
    page.locator("th.js-moment-picker-parent-view").first(),

  /**
   * Moment-picker "Previous month" arrow. verified 2026-06-22
   * @tags calendar, previous, month, arrow, range, timecard, new-kronos
   */
  calendarPrevMonth: (page: Page): Locator =>
    page.getByRole("button", { name: "Previous month" }).first(),

  /**
   * Moment-picker "Next month" arrow. verified 2026-06-22
   * @tags calendar, next, month, arrow, range, timecard, new-kronos
   */
  calendarNextMonth: (page: Page): Locator =>
    page.getByRole("button", { name: "Next month" }).first(),

  /**
   * Moment-picker day cell for a specific date. `name` matches the cell's
   * full-date aria-label ("Monday, June 11, 2026"); `:not(.out-of-month)` keeps
   * an adjacent-month trailing day from being hit. verified 2026-06-22
   * @tags calendar, day, cell, gridcell, range, timecard, new-kronos
   */
  calendarDayCell: (page: Page, name: string | RegExp): Locator =>
    page
      .getByRole("gridcell", { name })
      .and(page.locator("td.js-moment-picker-item:not(.out-of-month)")),

  /**
   * Apply button (custom range). verified 2026-06-18
   * @tags apply, button, range, timecard, new-kronos
   */
  applyButton: (page: Page): Locator =>
    page.getByRole("button", { name: "Apply" }),
};

export const newKronosSelectors = {
  searchFrame,
  loadingOverlay,
  navbar,
  search,
  goToMenu,
  timecard,
};
