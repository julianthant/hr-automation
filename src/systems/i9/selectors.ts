import type { Page, Locator } from "playwright";

/**
 * I-9 Complete (Tracker I-9 by Mitratech) selector registry.
 *
 * Email/password auth (no Duo). Form fields use accessible names
 * consistently. No grid-index mutation issues.
 */

// ─── Login flow ────────────────────────────────────────────────────────────

export const login = {
  /** Email / username textbox. verified 2026-03-16 */
  usernameInput: (page: Page): Locator =>
    page.getByRole("textbox", { name: "Username or Email*" }),

  /** Next button (email-first login flow). verified 2026-03-16 */
  nextButton: (page: Page): Locator =>
    page.getByRole("button", { name: "Next" }),

  /** Password textbox. verified 2026-03-16 */
  passwordInput: (page: Page): Locator =>
    page.getByRole("textbox", { name: "Password*" }),

  /** Log in button. verified 2026-03-16 */
  loginButton: (page: Page): Locator =>
    page.getByRole("button", { name: "Log in" }),

  /** Training-notification dismiss button. verified 2026-03-16 */
  dismissNotificationButton: (page: Page): Locator =>
    page.getByRole("button", { name: "Dismiss the Notification" }),

  /** Training-notification confirm "Yes". verified 2026-03-16 */
  confirmYesButton: (page: Page): Locator =>
    page.getByRole("button", { name: "Yes" }),
};

// ─── Dashboard → Create new employee ──────────────────────────────────────

export const dashboard = {
  /** "Create New I-9 : New Employee" entry link. verified 2026-03-16 */
  createNewI9Link: (page: Page): Locator =>
    page.getByRole("link", { name: "create new I9: new employee" }),

  /** Search Options button (opens search dialog). verified 2026-03-16 (id-anchored) */
  searchOptionsButton: (page: Page): Locator =>
    page.locator("#divSearchOptions"),
};

// ─── New Employee Profile form ────────────────────────────────────────────

export const profile = {
  firstName: (page: Page): Locator =>
    page.getByRole("textbox", { name: "First Name (Given Name)*" }),
  middleName: (page: Page): Locator =>
    page.getByRole("textbox", { name: "Middle Name" }),
  lastName: (page: Page): Locator =>
    page.getByRole("textbox", { name: "Last Name (Family Name)*" }),
  ssn: (page: Page): Locator =>
    page.getByRole("textbox", { name: "U.S. Social Security Number" }),
  dob: (page: Page): Locator =>
    page.getByRole("textbox", { name: "Date of Birth" }),
  email: (page: Page): Locator =>
    page.getByRole("textbox", { name: "Employee's Email Address" }),

  /** Worksite listbox. verified 2026-03-16 */
  worksiteListbox: (page: Page): Locator =>
    page.getByRole("listbox", { name: "Worksite *" }),

  /**
   * Worksite option by regex (matches `6-{deptNum}` prefix).
   * verified 2026-03-16
   */
  worksiteOption: (page: Page, pattern: RegExp): Locator =>
    page.getByRole("option", { name: pattern }),

  /** Save & Continue button. verified 2026-03-16 */
  saveContinueButton: (page: Page): Locator =>
    page.getByRole("button", { name: "Save & Continue" }),

  /** Error summary heading (validation errors). verified 2026-03-16 */
  errorSummary: (page: Page): Locator =>
    page.getByRole("heading", { name: "Error Summary:" }),

  /** Generic OK button (first) on confirmation dialogs. verified 2026-03-16 */
  okButtonFirst: (page: Page): Locator =>
    page.getByRole("button", { name: "OK" }).first(),

  /** Mobile loader overlay (wait for it to hide post-save). verified 2026-03-16 */
  loaderOverlay: (page: Page): Locator =>
    page.locator(".mobile-responsive-loader"),

  /** Duplicate Employee Record dialog. verified 2026-04-16 */
  duplicateDialog: (page: Page): Locator =>
    page.getByRole("dialog", { name: "Duplicate Employee Record" }),

  /** First row of the duplicate-dialog grid (select existing record). verified 2026-04-16 */
  duplicateFirstRow: (page: Page): Locator =>
    page.getByRole("grid").last().getByRole("row").first(),

  /** View/Edit Selected Record button (inside duplicate dialog). verified 2026-04-16 */
  viewEditSelectedButton: (page: Page): Locator =>
    page.getByRole("button", { name: "View/Edit Selected Record" }),
};

// ─── Remote I-9 section (post-save) ───────────────────────────────────────

export const remoteI9 = {
  /** Remote - Section 1 Only radio. verified 2026-03-16 */
  remoteSection1OnlyRadio: (page: Page): Locator =>
    page.getByRole("radio", { name: "Remote - Section 1 Only" }),

  /** Start Date textbox. verified 2026-03-16 */
  startDateInput: (page: Page): Locator =>
    page.getByRole("textbox", { name: "Start Date*" }),

  /** Create I-9 button. verified 2026-03-16 */
  createI9Button: (page: Page): Locator =>
    page.getByRole("button", { name: "Create I-9" }),

  /** OK confirm after Create I-9 click. verified 2026-03-16 */
  createI9OkButton: (page: Page): Locator =>
    page.getByRole("button", { name: "OK" }),
};

// ─── Search dialog ────────────────────────────────────────────────────────

const SEARCH_DIALOG_NAME = "Search for Existing Employee";

export const search = {
  /** The search dialog itself. verified 2026-03-16 */
  dialog: (page: Page): Locator =>
    page.getByRole("dialog", { name: SEARCH_DIALOG_NAME }),

  /** Clear Search Filters & Results link. verified 2026-03-16 */
  clearFiltersLink: (page: Page): Locator =>
    page.getByRole("link", { name: "Clear Search Filters & Results" }),

  /** Last Name textbox (dialog-scoped). verified 2026-03-16 */
  lastNameInput: (page: Page): Locator =>
    page
      .getByRole("dialog", { name: SEARCH_DIALOG_NAME })
      .getByRole("textbox", { name: "Last Name" }),

  /** First Name textbox (dialog-scoped, regex for flexibility). verified 2026-03-16 */
  firstNameInput: (page: Page): Locator =>
    page
      .getByRole("dialog", { name: SEARCH_DIALOG_NAME })
      .getByRole("textbox", { name: /First Name/ }),

  /** SSN textbox (dialog-scoped). verified 2026-03-16 */
  ssnInput: (page: Page): Locator =>
    page
      .getByRole("dialog", { name: SEARCH_DIALOG_NAME })
      .getByRole("textbox", { name: "Social Security Number" }),

  /** Profile ID textbox (dialog-scoped). verified 2026-03-16 */
  profileIdInput: (page: Page): Locator =>
    page
      .getByRole("dialog", { name: SEARCH_DIALOG_NAME })
      .getByRole("textbox", { name: "Profile ID" }),

  /** Employee ID textbox (dialog-scoped). verified 2026-03-16 */
  employeeIdInput: (page: Page): Locator =>
    page
      .getByRole("dialog", { name: SEARCH_DIALOG_NAME })
      .getByRole("textbox", { name: "Employee ID" }),

  /** Search submit button (page-scoped — there's only one). verified 2026-03-16 */
  submitButton: (page: Page): Locator =>
    page.getByRole("button", { name: "Search" }),

  /**
   * Results grid rows. The last grid in the dialog is the results grid
   * (earlier grid contains headers). verified 2026-03-16
   */
  resultRows: (page: Page): Locator =>
    page
      .getByRole("dialog", { name: SEARCH_DIALOG_NAME })
      .getByRole("grid")
      .last()
      .getByRole("row"),
};

export const i9Selectors = {
  login,
  dashboard,
  profile,
  remoteI9,
  search,
};
