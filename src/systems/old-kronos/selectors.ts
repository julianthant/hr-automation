import type { Page, Frame, Locator } from "playwright";

/**
 * Old Kronos (UKG) selector registry.
 *
 * UKG is a deeply-nested-iframe beast: main content sits inside
 * `widgetFrame804` (or any `widgetFrame*`), and the Reports page adds two
 * more nested frames (`khtmlReportList`, `khtmlReportWorkspace`,
 * `khtmlReportingContentIframe`). Many selectors target specific frames.
 *
 * Some UKG selectors are string arrays passed to `clickInFrames()` /
 * `jsClickText()` helpers rather than Playwright locator chains. Those live
 * here as string constants with verified-date comments.
 */

// ─── SSO session-expiry detection ─────────────────────────────────────────

export const ssoProbe = {
  /**
   * SSO username field — detects when UKG has bounced us back to the SSO
   * login page after a page refresh. verified 2026-03-16
   * @tags sso, username, login, probe, ukg, old-kronos
   */
  ssoField: (page: Page): Locator =>
    page.locator('#ssousername, input[name="j_username"]'),
};

// ─── Employee grid (Manage My Department / Genies iframe) ─────────────────

export const employeeGrid = {
  /**
   * QuickFind search input. verified 2026-03-16
   * @tags quickfind, search, input, employee, ukg, old-kronos
   */
  quickFindInput: (iframe: Frame): Locator => iframe.locator("#searchQuery"),

  /**
   * QuickFind search submit button. verified 2026-03-16
   * @tags quickfind, search, submit, button, employee, ukg, old-kronos
   */
  quickFindSubmitButton: (iframe: Frame): Locator =>
    iframe.locator("#quickfindsearch_btn"),

  /**
   * First row of the Genies grid. verified 2026-03-16
   * @tags first, row, genies, grid, employee, ukg, old-kronos
   */
  firstRow: (iframe: Frame): Locator => iframe.locator("#row0genieGrid"),

  /**
   * All rows via ARIA role=row. verified 2026-03-16
   * @tags rows, role, grid, employee, ukg, old-kronos
   */
  allRowsByRole: (iframe: Frame): Locator => iframe.locator("div[role='row']"),

  /**
   * Gridcell containing a specific employee ID. verified 2026-03-16
   * @tags gridcell, employee, id, grid, ukg, old-kronos
   */
  cellByEmployeeId: (iframe: Frame, employeeId: string): Locator =>
    iframe.locator(`div[role='gridcell']:has-text('${employeeId}')`).first(),

  /**
   * Network-change-detected error text — if visible in the iframe, page
   * needs reload. verified 2026-04-01
   * @tags network, change, error, reload, ukg, old-kronos
   */
  networkChangeError: (iframe: Frame): Locator =>
    iframe.locator("text=network change was detected"),
};

// ─── Modal dismiss candidates ─────────────────────────────────────────────

/**
 * `dismissModal()` iterates through OK/Close button variants. Different from
 * the UCPath `#pt_modalMask` hide helper in common/ — this one actually
 * clicks a button inside the iframe to dismiss a dialog box.
 */
export const modalDismiss = {
  /**
   * OK button (modal dismiss). verified 2026-03-16
   * @tags ok, modal, dismiss, button, ukg, old-kronos
   */
  okButton: (iframe: Frame): Locator => iframe.locator("button:has-text('OK')"),

  /**
   * Close button (multiple CSS variants). verified 2026-03-16
   * @tags close, modal, dismiss, button, ukg, old-kronos
   */
  closeButton: (iframe: Frame): Locator =>
    iframe.locator(
      "button.close-handler, button:has-text('Close'), .jqx-window-close-button",
    ),
};

// ─── Date range dialog ────────────────────────────────────────────────────

export const dateRange = {
  /**
   * Calendar button — two variants covering different UKG builds.
   * verified 2026-03-16
   * @tags calendar, button, date, range, dialog, ukg, old-kronos
   */
  calendarButton: (iframe: Frame): Locator =>
    iframe
      .locator("button:has(i.icon-k-calendar)")
      .or(iframe.locator("button.btn.i.dropdown-toggle[title='Select Dates']")),

  /**
   * Date input fields inside the timeframeSelection dialog. verified 2026-03-16
   * @tags date, input, range, timeframe, dialog, ukg, old-kronos
   */
  dateInputs: (iframe: Frame): Locator =>
    iframe.locator("div.timeframeSelection input.jqx-input-content"),

  /**
   * Apply button — two variants covering different UKG builds.
   * verified 2026-03-16
   * @tags apply, button, date, range, dialog, ukg, old-kronos
   */
  applyButton: (iframe: Frame): Locator =>
    iframe
      .locator("div.timeframeSelection button[title='Apply']")
      .or(iframe.locator("div.timeframeSelection button:has-text('Apply')")),
};

// ─── Go To menu / navigation ──────────────────────────────────────────────

export const goToMenu = {
  /**
   * "Go To" trigger text. verified 2026-03-16
   * @tags go-to, trigger, navigation, ukg, old-kronos
   */
  goToTrigger: (iframe: Frame): Locator => iframe.locator("text=Go To").first(),

  /**
   * Dropdown toggles inside the iframe (used in GoTo → Reports strategy). verified 2026-03-16
   * @tags dropdown, toggle, go-to, reports, ukg, old-kronos
   */
  dropdownToggles: (iframe: Frame): Locator => iframe.locator(".dropdown-toggle"),

  /**
   * "Reports" menu item. verified 2026-03-16
   * @tags reports, menu, item, ukg, old-kronos
   */
  reportsItem: (iframe: Frame): Locator =>
    iframe.locator("text=Reports").first(),

  /**
   * Sidebar fallback for Reports. verified 2026-03-16
   * @tags reports, sidebar, fallback, ukg, old-kronos
   */
  sidebarReports: (page: Page): Locator => page.locator("div[title='Reports']"),

  /**
   * Timecards menu item (exact match to avoid "Approve Timecards").
   * verified 2026-03-16
   * @tags timecards, menu, item, ukg, old-kronos
   */
  timecardsItem: (iframe: Frame): Locator =>
    iframe.locator("a, li, span").filter({ hasText: /^Timecards$/ }).first(),
};

// ─── Timecard view ────────────────────────────────────────────────────────

export const timecard = {
  /**
   * Previous Pay Period link (inside an open period dropdown). verified 2026-04-01
   * @tags previous, pay, period, link, timecard, ukg, old-kronos
   */
  previousPayPeriodLink: (f: Frame): Locator =>
    f.getByRole("link", { name: "Previous Pay Period" }),
};

// ─── Workspace tabs ───────────────────────────────────────────────────────

export const workspace = {
  /**
   * Manage My Department tab (preferred). verified 2026-03-16
   * @tags manage, department, tab, workspace, ukg, old-kronos
   */
  manageDeptTab: (page: Page): Locator =>
    page.locator("span.krn-workspace-tabs__tab-title:has-text('Manage My Department')"),

  /**
   * Manage My Department li tab fallback. verified 2026-03-16
   * @tags manage, department, tab, fallback, workspace, ukg, old-kronos
   */
  manageDeptLi: (page: Page): Locator =>
    page.locator("li[title='Manage My Department']"),
};

// ─── Reports page (string selector arrays + one Locator) ──────────────────

/**
 * CSS selector strings for multi-anchor click helpers (`clickInFrames`,
 * `jsClickText`) in `reports.ts`. Kept as `as const` arrays so the full set of
 * known anchors is in the registry.
 */
export const reportsPage = {
  runReportSelectors: [
    "input[value='Run Report']",
    "button:has-text('Run Report')",
    "a:has-text('Run Report')",
    "td:has-text('Run Report')",
    "input[type='submit'][value*='Run']",
    "input[type='button'][value*='Run']",
  ] as const, // verified 2026-03-16

  viewReportSelectors: [
    "input[value='View Report']",
    "button:has-text('View Report')",
    "text=View Report",
  ] as const, // verified 2026-03-16

  checkStatusSelectors: [
    "text=CHECK REPORT STATUS",
    "a:has-text('Check Report Status')",
    "td:has-text('Check Report Status')",
  ] as const, // verified 2026-03-16

  refreshStatusSelectors: ["text=Refresh Status"] as const, // verified 2026-03-16

  /**
   * Timecard nav-tree entry. verified 2026-03-16
   * @tags timecard, nav, tree, entry, reports, ukg, old-kronos
   */
  timecardNavTreeEntry: (listFrame: Frame): Locator =>
    listFrame.locator("a:text-is('Timecard'), span:text-is('Timecard')"),
};

export const oldKronosSelectors = {
  ssoProbe,
  employeeGrid,
  modalDismiss,
  dateRange,
  goToMenu,
  timecard,
  workspace,
  reportsPage,
};
