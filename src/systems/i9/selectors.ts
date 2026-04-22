import type { Page, Locator } from "playwright";

/**
 * I-9 Complete (Tracker I-9 by Mitratech) selector registry.
 *
 * Email/password auth (no Duo). Form fields use accessible names
 * consistently. No grid-index mutation issues.
 */

// ─── Login flow ────────────────────────────────────────────────────────────

export const login = {
  /**
   * Email / username textbox. verified 2026-03-16
   * @tags username, email, login, textbox, i9
   */
  usernameInput: (page: Page): Locator =>
    page.getByRole("textbox", { name: "Username or Email*" }),

  /**
   * Next button (email-first login flow). verified 2026-03-16
   * @tags next, login, button, i9
   */
  nextButton: (page: Page): Locator =>
    page.getByRole("button", { name: "Next" }),

  /**
   * Password textbox. verified 2026-03-16
   * @tags password, login, textbox, i9
   */
  passwordInput: (page: Page): Locator =>
    page.getByRole("textbox", { name: "Password*" }),

  /**
   * Log in button. verified 2026-03-16
   * @tags login, submit, button, i9
   */
  loginButton: (page: Page): Locator =>
    page.getByRole("button", { name: "Log in" }),

  /**
   * Training-notification dismiss button. verified 2026-03-16
   * @tags training, notification, dismiss, button, i9
   */
  dismissNotificationButton: (page: Page): Locator =>
    page.getByRole("button", { name: "Dismiss the Notification" }),

  /**
   * Training-notification confirm "Yes". verified 2026-03-16
   * @tags training, notification, confirm, yes, button, i9
   */
  confirmYesButton: (page: Page): Locator =>
    page.getByRole("button", { name: "Yes" }),
};

// ─── Dashboard → Create new employee ──────────────────────────────────────

export const dashboard = {
  /**
   * "Create New I-9 : New Employee" entry link. verified 2026-03-16
   * @tags create, new, i9, employee, link, dashboard
   */
  createNewI9Link: (page: Page): Locator =>
    page.getByRole("link", { name: "create new I9: new employee" }),

  /**
   * Search Options button (opens search dialog). verified 2026-03-16 (id-anchored)
   * @tags search, options, button, dashboard, i9
   */
  searchOptionsButton: (page: Page): Locator =>
    page.locator("#divSearchOptions"),
};

// ─── New Employee Profile form ────────────────────────────────────────────

export const profile = {
  /**
   * First (Given) Name textbox.
   * @tags first-name, given-name, name, textbox, profile, i9
   */
  firstName: (page: Page): Locator =>
    page.getByRole("textbox", { name: "First Name (Given Name)*" }),
  /**
   * Middle Name textbox.
   * @tags middle-name, name, textbox, profile, i9
   */
  middleName: (page: Page): Locator =>
    page.getByRole("textbox", { name: "Middle Name" }),
  /**
   * Last (Family) Name textbox.
   * @tags last-name, family-name, name, textbox, profile, i9
   */
  lastName: (page: Page): Locator =>
    page.getByRole("textbox", { name: "Last Name (Family Name)*" }),
  /**
   * U.S. Social Security Number textbox.
   * @tags ssn, social-security, textbox, profile, i9
   */
  ssn: (page: Page): Locator =>
    page.getByRole("textbox", { name: "U.S. Social Security Number" }),
  /**
   * Date of Birth textbox.
   * @tags dob, date-of-birth, textbox, profile, i9
   */
  dob: (page: Page): Locator =>
    page.getByRole("textbox", { name: "Date of Birth" }),
  /**
   * Employee's Email Address textbox.
   * @tags email, address, textbox, profile, i9
   */
  email: (page: Page): Locator =>
    page.getByRole("textbox", { name: "Employee's Email Address" }),

  /**
   * Worksite listbox. verified 2026-03-16
   * @tags worksite, listbox, profile, i9
   */
  worksiteListbox: (page: Page): Locator =>
    page.getByRole("listbox", { name: "Worksite *" }),

  /**
   * Worksite option by regex (matches `6-{deptNum}` prefix).
   * verified 2026-03-16
   * @tags worksite, option, regex, profile, i9
   */
  worksiteOption: (page: Page, pattern: RegExp): Locator =>
    page.getByRole("option", { name: pattern }),

  /**
   * Save & Continue button. verified 2026-03-16
   * @tags save, continue, button, profile, i9
   */
  saveContinueButton: (page: Page): Locator =>
    page.getByRole("button", { name: "Save & Continue" }),

  /**
   * Error summary heading (validation errors). verified 2026-03-16
   * @tags error, summary, heading, validation, profile, i9
   */
  errorSummary: (page: Page): Locator =>
    page.getByRole("heading", { name: "Error Summary:" }),

  /**
   * Generic OK button (first) on confirmation dialogs. verified 2026-03-16
   * @tags ok, button, confirmation, dialog, profile, i9
   */
  okButtonFirst: (page: Page): Locator =>
    page.getByRole("button", { name: "OK" }).first(),

  /**
   * Mobile loader overlay (wait for it to hide post-save). verified 2026-03-16
   * @tags loader, overlay, mobile, profile, i9
   */
  loaderOverlay: (page: Page): Locator =>
    page.locator(".mobile-responsive-loader"),

  /**
   * Duplicate Employee Record dialog. verified 2026-04-16
   * @tags duplicate, employee, dialog, profile, i9
   */
  duplicateDialog: (page: Page): Locator =>
    page.getByRole("dialog", { name: "Duplicate Employee Record" }),

  /**
   * First row of the duplicate-dialog grid (select existing record). verified 2026-04-16
   * @tags duplicate, row, grid, dialog, profile, i9
   */
  duplicateFirstRow: (page: Page): Locator =>
    page.getByRole("grid").last().getByRole("row").first(),

  /**
   * View/Edit Selected Record button (inside duplicate dialog). verified 2026-04-16
   * @tags view, edit, selected, record, button, duplicate, profile, i9
   */
  viewEditSelectedButton: (page: Page): Locator =>
    page.getByRole("button", { name: "View/Edit Selected Record" }),
};

// ─── Remote I-9 section (post-save) ───────────────────────────────────────

export const remoteI9 = {
  /**
   * Remote - Section 1 Only radio. verified 2026-03-16
   * @tags remote, section, radio, i9
   */
  remoteSection1OnlyRadio: (page: Page): Locator =>
    page.getByRole("radio", { name: "Remote - Section 1 Only" }),

  /**
   * Start Date textbox. verified 2026-03-16
   * @tags start, date, textbox, remote, i9
   */
  startDateInput: (page: Page): Locator =>
    page.getByRole("textbox", { name: "Start Date*" }),

  /**
   * Create I-9 button. verified 2026-03-16
   * @tags create, i9, button, remote
   */
  createI9Button: (page: Page): Locator =>
    page.getByRole("button", { name: "Create I-9" }),

  /**
   * OK confirm after Create I-9 click. verified 2026-03-16
   * @tags ok, confirm, button, i9, remote
   */
  createI9OkButton: (page: Page): Locator =>
    page.getByRole("button", { name: "OK" }),
};

// ─── Search dialog ────────────────────────────────────────────────────────

const SEARCH_DIALOG_NAME = "Search for Existing Employee";

export const search = {
  /**
   * The search dialog itself. verified 2026-03-16
   * @tags search, dialog, i9
   */
  dialog: (page: Page): Locator =>
    page.getByRole("dialog", { name: SEARCH_DIALOG_NAME }),

  /**
   * Clear Search Filters & Results link. verified 2026-03-16
   * @tags clear, filters, link, search, i9
   */
  clearFiltersLink: (page: Page): Locator =>
    page.getByRole("link", { name: "Clear Search Filters & Results" }),

  /**
   * Last Name textbox (dialog-scoped). verified 2026-03-16
   * @tags last-name, name, textbox, search, i9
   */
  lastNameInput: (page: Page): Locator =>
    page
      .getByRole("dialog", { name: SEARCH_DIALOG_NAME })
      .getByRole("textbox", { name: "Last Name" }),

  /**
   * First Name textbox (dialog-scoped, regex for flexibility). verified 2026-03-16
   * @tags first-name, name, textbox, search, i9
   */
  firstNameInput: (page: Page): Locator =>
    page
      .getByRole("dialog", { name: SEARCH_DIALOG_NAME })
      .getByRole("textbox", { name: /First Name/ }),

  /**
   * SSN textbox (dialog-scoped). verified 2026-03-16
   * @tags ssn, social-security, textbox, search, i9
   */
  ssnInput: (page: Page): Locator =>
    page
      .getByRole("dialog", { name: SEARCH_DIALOG_NAME })
      .getByRole("textbox", { name: "Social Security Number" }),

  /**
   * Profile ID textbox (dialog-scoped). verified 2026-03-16
   * @tags profile, id, textbox, search, i9
   */
  profileIdInput: (page: Page): Locator =>
    page
      .getByRole("dialog", { name: SEARCH_DIALOG_NAME })
      .getByRole("textbox", { name: "Profile ID" }),

  /**
   * Employee ID textbox (dialog-scoped). verified 2026-03-16
   * @tags employee, id, textbox, search, i9
   */
  employeeIdInput: (page: Page): Locator =>
    page
      .getByRole("dialog", { name: SEARCH_DIALOG_NAME })
      .getByRole("textbox", { name: "Employee ID" }),

  /**
   * Search submit button (page-scoped — there's only one). verified 2026-03-16
   * @tags search, submit, button, i9
   */
  submitButton: (page: Page): Locator =>
    page.getByRole("button", { name: "Search" }),

  /**
   * Results grid rows. The last grid in the dialog is the results grid
   * (earlier grid contains headers). verified 2026-03-16
   * @tags results, grid, rows, search, i9
   */
  resultRows: (page: Page): Locator =>
    page
      .getByRole("dialog", { name: SEARCH_DIALOG_NAME })
      .getByRole("grid")
      .last()
      .getByRole("row"),
};

// ─── Summary / Electronic I-9 Audit Trail ─────────────────────────────────
//
// Section 2 signer lookup: when an I-9 is opened via the
// `/employee/navToNextAction/{profileId}?i9Id={i9Id}` link from search
// results, the page lands on `/form-I9/summary/{profileId}/{i9Id}` (modern
// records) or `/form-I9-historical/{profileId}/{i9Id}/0` (paper-imported).
// Both render the same "I-9 Record Summary Information" heading and the
// Electronic I-9 Audit Trail table below it. Modern records that have been
// signed include a row whose accessible name contains "Signed Section 2";
// the 4th cell of that row is the signer's name.

const SIGNED_SECTION_2_RE = /Signed Section 2/;

export const summary = {
  /**
   * I-9 Record Summary heading. Anchor for "summary view has rendered".
   * verified 2026-04-22
   * @tags summary, heading, i9, record
   */
  heading: (page: Page): Locator =>
    page.getByRole("heading", { name: "I-9 Record Summary Information" }),

  /**
   * Electronic I-9 Audit Trail row whose event cell reads
   * "Signed Section 2". `.first()` guards against amended records with
   * multiple Section 2 signings — the most recent is always the top row.
   * Absent on paper-imported (historical) records. The signer name is in
   * the 4th cell of this row — read via a row-scoped `.getByRole("cell")`
   * inline selector in the consumer (see `i9-signer.ts`). verified 2026-04-22
   * @tags audit-trail, signed, section2, row, i9
   */
  signedSection2Row: (page: Page): Locator =>
    page.getByRole("row", { name: SIGNED_SECTION_2_RE }).first(),
};

export const i9Selectors = {
  login,
  dashboard,
  profile,
  remoteI9,
  search,
  summary,
};
