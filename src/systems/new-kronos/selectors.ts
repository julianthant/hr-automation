import type { Page, Locator, FrameLocator, Frame } from "playwright";

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
  // verified 2026-07-06
  firstResultSlat: (root: SearchRoot): Locator =>
    root.getByRole("menuitemradio").first(),

  /**
   * The searched employee's ID in the result slat (e.g. "10714794" under the
   * name). A "somebody showed up" signal independent of checkbox/slat roles.
   * verified 2026-07-06
   * @tags result, employee-id, eid, found, probe, search, new-kronos
   */
  resultEmployeeId: (root: SearchRoot, employeeId: string): Locator =>
    root.getByText(employeeId, { exact: true }),

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
   * Timecard menu item in the open Go To dropdown — role-scoped to the option
   * ITSELF. The live Dayforce Go To menu renders Timecard as role="option"
   * (menuitem kept as a fallback); both frame- and page-level renderings plus
   * the "Timecards" plural variant are covered.
   *
   * The name is ANCHORED `^timecards?$` (was a bare `/timecard/i` substring) and
   * the old bare `text=Timecard`/`text=Timecards` `.or()` branches are REMOVED:
   * once a timecard is loaded behind the slide-out, "Employee timecards" (the
   * page title) and other chrome CONTAIN "timecard", so a substring match
   * resolved `count()` to stale, non-actionable elements — clicking them failed
   * and every employee after the first in a batch reported "Timecard option not
   * found in Go To menu" (2026-06-24). Anchored role-name match can only hit the
   * dropdown option.
   * verified 2026-06-18 (role=option Timecard); anchoring + drop-text 2026-06-24
   * @tags timecard, menu, item, option, navigation, new-kronos
   */
  timecardItem: (page: Page): Locator => {
    const f = searchFrame(page);
    const name = /^\s*timecards?\s*$/i;
    return f
      .getByRole("option", { name })
      .or(page.getByRole("option", { name }))
      .or(f.getByRole("menuitem", { name }))
      .or(page.getByRole("menuitem", { name }));
  },

  /**
   * People menu item in the open Go To dropdown — used to navigate to the
   * People page (Timekeeper / Pay Rule editing). Follows the same selector
   * strategy as `timecardItem`: anchored role-name match so stale/hidden
   * elements from the chrome behind the slideout never resolve.
   * // verified 2026-07-02
   * @tags people, menu, item, option, navigation, new-kronos
   */
  peopleItem: (page: Page): Locator => {
    const f = searchFrame(page);
    const name = /^\s*people\s*$/i;
    return f
      .getByRole("option", { name })
      .or(page.getByRole("option", { name }))
      .or(f.getByRole("menuitem", { name }))
      .or(page.getByRole("menuitem", { name }));
  },
};

// ─── Timecard view / pay period controls ──────────────────────────────────

export const timecard = {
  /**
   * Authoritative employee EID in the open desktop timecard header. The live
   * WFD DOM renders `<div class="emp-nav-id">10403587</div>` next to the
   * employee-name control; unlike page-wide text, this cannot match an EID
   * lingering in search chrome. verified 2026-07-16
   * @tags employee, eid, identity, header, timecard, new-kronos
   */
  loadedEmployeeId: (page: Page): Locator => page.locator(".emp-nav-id").first(),

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

// ─── Go To → People page (Timekeeper / Pay Rule editing) ──────────────────

/** Page or the managePeople iframe — Pay Rule UI renders in the latter. */
export type PeopleRoot = Page | Frame;

/**
 * People editor content loads in the managePeople route — either as a full-page
 * navigation or inside a child frame. Fail loud if neither is present.
 * verified 2026-07-02
 */
export function peopleFrame(page: Page): Frame {
  if (/managePeople/i.test(page.url())) {
    return page.mainFrame();
  }
  const frame = page.frame({ url: /managePeople/i });
  if (!frame) {
    throw new Error(
      "[New Kronos] managePeople frame not found — open Go To → People before editing pay rules",
    );
  }
  return frame;
}

/** Page or managePeople frame — whichever currently hosts the People editor. */
export function resolvePeopleRoot(page: Page): PeopleRoot | null {
  if (/managePeople/i.test(page.url())) return page;
  return page.frame({ url: /managePeople/i });
}

export const people = {
  /**
   * Expanded Timekeeper accordion panel on the People editor.
   * verified 2026-07-02
   * @tags timekeeper, section, accordion, panel, people, new-kronos
   */
  timekeeperPanel: (root: PeopleRoot): Locator =>
    root.locator("#TimekeeperPanelPlugin"),

  /**
   * Timekeeper accordion header — the panel heading that toggles `#TimekeeperPanelPlugin`.
   * The inner `<a>` is not reliably exposed as a link role; target `data-target` instead.
   * verified 2026-07-02
   * @tags timekeeper, section, accordion, expand, people, new-kronos
   */
  timekeeperSection: (root: PeopleRoot): Locator =>
    root.locator('.panel-heading[data-target="#TimekeeperPanelPlugin"]'),

  /**
   * Pay Rule column header inside the jqx payRuleGrid — signals Timekeeper is expanded.
   * verified 2026-07-02
   * @tags pay-rule, column, header, grid, timekeeper, people, new-kronos
   */
  payRuleColumnHeader: (root: PeopleRoot): Locator =>
    root.locator("#payRuleGrid .renderer-grid-header").filter({ hasText: /^Pay Rule$/ }),

  /**
   * Pay Rule jqx grid on the People → Timekeeper page.
   * verified 2026-07-02
   * @tags pay-rule, table, grid, jqx, timekeeper, people, new-kronos
   */
  payRuleGrid: (root: PeopleRoot): Locator => root.locator("#payRuleGrid"),

  /**
   * "+" Add Row control on the empty pay-rule row (row1).
   * verified 2026-07-02
   * @tags pay-rule, add, plus, button, timekeeper, people, new-kronos
   */
  payRuleAddButton: (root: PeopleRoot): Locator =>
    root.locator("#row1payRuleGrid .iconBtn[title='Add Row']"),

  /**
   * Empty Pay Rule cell on row1 (below the current effective-dated rule).
   * Column order: add | delete | pay rule | effective date.
   * verified 2026-07-02
   * @tags pay-rule, empty, cell, row, timekeeper, people, new-kronos
   */
  payRuleEmptyCell: (root: PeopleRoot): Locator =>
    root.locator("#row1payRuleGrid [role='gridcell']").nth(2),

  /**
   * Same row1 Pay Rule cell as {@link payRuleEmptyCell}, read AFTER the lookup
   * modal commits a selection — used to confirm the chosen code actually landed
   * in the grid before Save (fail-loud readback; the modal closing alone does
   * not prove the code committed).
   * verified 2026-07-02
   * @tags pay-rule, code, cell, readback, verify, timekeeper, people, new-kronos
   */
  payRuleCodeCell: (root: PeopleRoot): Locator =>
    root.locator("#row1payRuleGrid [role='gridcell']").nth(2),

  /**
   * Inline pay-rule dropdown list opened after clicking the empty cell.
   * verified 2026-07-02
   * @tags pay-rule, dropdown, listbox, editor, timekeeper, people, new-kronos
   */
  payRuleDropdownList: (root: PeopleRoot): Locator =>
    root.locator("[id^='innerListBoxdropdownlisteditorpayRuleGrid']"),

  /**
   * jqx dropdown popup shell for the pay-rule inline editor (hidden until the
   * empty cell is activated).
   * verified 2026-07-02
   * @tags pay-rule, dropdown, popup, editor, timekeeper, people, new-kronos
   */
  payRuleDropdownPopup: (root: PeopleRoot): Locator =>
    root.locator("[id^='listBoxdropdownlisteditorpayRuleGrid']"),

  /**
   * "Search..." affordance at the bottom of the pay-rule jqx dropdown — a
   * `.pe-search-button` div, NOT a `[role=option]` (verified live 2026-07-02).
   * verified 2026-07-02
   * @tags pay-rule, search, option, dropdown, lookup, people, new-kronos
   */
  payRuleSearchOption: (root: PeopleRoot): Locator =>
    root
      .locator("[id^='innerListBoxdropdownlisteditorpayRuleGrid']")
      .locator(".searchComponent.pe-search-button, .pe-search-button"),

  /**
   * Pay-rule lookup search input — after choosing Search, exactly one textbox
   * appears on the People editor (verified live 2026-07-02).
   * verified 2026-07-02
   * @tags pay-rule, search, dialog, input, textbox, lookup, people, new-kronos
   */
  payRuleSearchInput: (root: PeopleRoot): Locator => root.getByRole("textbox"),

  /**
   * Pay-rule lookup modal shell (`modal-window-pe`).
   * verified 2026-07-02
   * @tags pay-rule, search, dialog, modal, lookup, people, new-kronos
   */
  payRuleSearchModal: (root: PeopleRoot): Locator =>
    root.locator(".modal-window-pe, .pe-modal-container").first(),

  /**
   * Matching pay-rule row in the lookup modal grid after typing a code.
   * verified 2026-07-02
   * @tags pay-rule, search, dialog, result, grid, lookup, people, new-kronos
   */
  payRuleSearchResultRow: (root: PeopleRoot, code: string): Locator =>
    root
      .locator(".modal-window-pe, .pe-modal-container")
      .first()
      .locator(".jqx-grid")
      .getByText(code, { exact: true })
      .first(),

  /**
   * OK button in the pay-rule lookup overlay (confirms the selected row).
   * verified 2026-07-02
   * @tags pay-rule, search, dialog, ok, submit, button, lookup, people, new-kronos
   */
  payRuleSearchOk: (root: PeopleRoot): Locator =>
    root.locator(".modal-window-pe, .pe-modal-container").first().getByRole("button", { name: /^OK$/i }),

  /**
   * Effective Date cell on the empty pay-rule row (row1).
   * verified 2026-07-02
   * @tags pay-rule, effective-date, cell, grid, timekeeper, people, new-kronos
   */
  effectiveDateCell: (root: PeopleRoot): Locator =>
    root.locator("#row1payRuleGrid [role='gridcell']").nth(3),

  /**
   * Inline jqx datetime editor opened after clicking the effective-date cell.
   * verified 2026-07-02
   * @tags pay-rule, effective-date, editor, datetime, jqx, timekeeper, people, new-kronos
   */
  effectiveDateEditor: (root: PeopleRoot): Locator =>
    root.locator("#datetimeeditorpayRuleGrideffectiveDate"),

  /**
   * Calendar icon inside the effective-date inline editor (opens the jqx picker).
   * verified 2026-07-02
   * @tags pay-rule, effective-date, calendar, icon, button, jqx, timekeeper, people, new-kronos
   */
  effectiveDateCalendarButton: (root: PeopleRoot): Locator =>
    root.locator("#datetimeeditorpayRuleGrideffectiveDate .jqx-icon-calendar"),

  /**
   * jqx calendar popup for the pay-rule effective date.
   * verified 2026-07-02
   * @tags pay-rule, effective-date, calendar, picker, popup, jqx, timekeeper, people, new-kronos
   */
  payRuleDatePicker: (root: PeopleRoot): Locator =>
    root.locator(".jqx-calendar").last(),

  /**
   * Month/year title on the jqx effective-date calendar (e.g. "July 2026").
   * verified 2026-07-02
   * @tags pay-rule, effective-date, calendar, title, month, jqx, timekeeper, people, new-kronos
   */
  payRuleDatePickerTitle: (root: PeopleRoot): Locator =>
    root.locator(".jqx-calendar-title-content").last(),

  /**
   * Previous-month arrow on the jqx effective-date calendar.
   * verified 2026-07-02
   * @tags pay-rule, effective-date, calendar, prev, navigation, jqx, timekeeper, people, new-kronos
   */
  payRuleDatePickerPrevMonth: (root: PeopleRoot): Locator =>
    root.locator(".jqx-icon-arrow-left").last(),

  /**
   * Next-month arrow on the jqx effective-date calendar.
   * verified 2026-07-02
   * @tags pay-rule, effective-date, calendar, next, navigation, jqx, timekeeper, people, new-kronos
   */
  payRuleDatePickerNextMonth: (root: PeopleRoot): Locator =>
    root.locator(".jqx-icon-arrow-right").last(),

  /**
   * Day-of-month cell in the current month on the jqx effective-date calendar.
   * verified 2026-07-02
   * @tags pay-rule, effective-date, calendar, day, cell, jqx, timekeeper, people, new-kronos
   */
  payRuleDatePickerDay: (root: PeopleRoot, day: number): Locator =>
    root
      .locator(".jqx-calendar-cell-month:not(.jqx-calendar-cell-othermonth)")
      .getByText(String(day), { exact: true })
      .first(),

  /**
   * Inline editor input for Effective Date after the cell is activated.
   * verified 2026-07-02
   * @tags pay-rule, effective-date, input, editor, timekeeper, people, new-kronos
   */
  effectiveDateInput: (root: PeopleRoot): Locator =>
    root.locator("#inputdatetimeeditorpayRuleGrideffectiveDate"),

  /**
   * Save button on the People editor toolbar. State contract (live-verified
   * 2026-07-04, read-only probe `scripts/verify-kronos-save-state.ts`): the
   * button carries a native `disabled` attribute whenever there are NO pending
   * edits, and enables once the editor holds unsaved changes — so a committed
   * save returns it to `disabled`. `savePersonRecord` uses that as its
   * fail-loud post-save readback.
   * verified 2026-07-04
   * @tags save, button, toolbar, people, new-kronos
   */
  saveButton: (root: PeopleRoot): Locator =>
    root.locator("#com\\.kronos\\.wfc\\.ngui\\.peopleeditor\\.save button[aria-label='Save']"),

  /**
   * The People editor's LOADED-employee header (`.empName`, inside `#peEmpList`).
   * Its `title` reads "<Full Name> <EID>" (e.g. "KentHodge, Michele L 10604376")
   * and its text shows the name + `employee.personNumber`. This is the editor's
   * OWN identity — the authoritative "who is displayed" signal — distinct from
   * the global Employee Search slide-out where the searched EID lingers. Use it
   * (never whole-page text) to confirm a batch employee switch actually landed.
   * verified 2026-07-02
   * @tags employee, header, identity, loaded, empName, peEmpList, people, new-kronos
   */
  loadedEmployeeName: (root: PeopleRoot): Locator => root.locator(".empName"),
};

export const newKronosSelectors = {
  searchFrame,
  loadingOverlay,
  navbar,
  search,
  goToMenu,
  timecard,
  people,
};
