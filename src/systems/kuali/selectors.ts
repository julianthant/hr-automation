import type { Page, Locator } from "playwright";

/**
 * Kuali Build selector registry.
 *
 * Separation form on Kuali Build space 5e47518b90adda9474c14adb. Selectors
 * are `getByRole({ name: "<exact label>*" })` — the asterisks are literal in
 * the form labels.
 */

// ─── Action List navigation ───────────────────────────────────────────────

export const actionList = {
  /**
   * "Action List" menu item. verified 2026-03-16
   * @tags action, list, menu, kuali
   */
  menuItem: (page: Page): Locator =>
    page.getByRole("menuitem", { name: "Action List" }),

  /**
   * Document link matching a doc number EXACTLY (anchored). verified 2026-06-17
   *
   * The Action List row exposes its document number as the accessible name of a
   * bare-number link. The match is anchored (`^\s*<n>\s*$`) so a doc id that is a
   * substring of another can never resolve the wrong row — important because
   * `clickDocument` filters via the substring-based Action List search box (a
   * search for "414" returns 4140–4149). A row shows the number in both the
   * "Document #" and "Document Title" columns, so this can match 2 links for one
   * doc; `clickDocument` clicks `.first()`.
   * @tags document, doc, link, action-list, exact, kuali
   */
  docLink: (page: Page, docNumber: string): Locator =>
    page.getByRole("link", { name: new RegExp(`^\\s*${docNumber}\\s*$`) }),

  /**
   * All pending-document links in the Action List, one per row. Each
   * Kuali Build Action List row exposes its document number as the
   * accessible name of a link (the same anchor `docLink` matches by an
   * exact number). This enumerates every such link so a caller can read
   * the full set of pending document numbers without knowing them ahead
   * of time. The accessible-name filter `/^\s*\d+\s*$/` keeps only links
   * whose text is a bare document number, excluding the page's nav /
   * action / pagination links (which carry word labels).
   *
   * Read-only: locating these links never opens or mutates a document.
   *
   * NEEDS LIVE VERIFICATION — derived from the single-doc `docLink`
   * pattern + Kuali Build Action List DOM conventions; not yet confirmed
   * against a live Action List (Duo MFA is manual). Bump to
   * `// verified <date>` once driven live.
   * @tags document, doc, links, action-list, pending, enumerate, kuali
   */
  docLinks: (page: Page): Locator =>
    page.getByRole("link", { name: /^\s*\d+\s*$/ }),

  /**
   * Action List search box. verified 2026-06-17
   *
   * The Action List paginates at 25 rows/page; rather than page through,
   * `clickDocument` types the document number here and clicks `searchGoButton`
   * to filter the list to the matching row(s). Scoped to the `.kp-input-group`
   * that holds the GO button so it never resolves the global nav search box —
   * a second textbox also labelled "Search" (top-right) that has no GO button.
   * @tags action-list, search, input, textbox, filter, kuali
   */
  searchInput: (page: Page): Locator =>
    page
      .locator('.kp-input-group:has(.kp-input-button-right)')
      .getByRole("textbox", { name: "Search" }),

  /**
   * Action List search "GO" button. verified 2026-06-17
   *
   * Submits the `searchInput` filter. The only "GO" button on the page (the
   * `.kp-input-button-right` affixed to the Action List search box).
   * @tags action-list, search, go, button, submit, kuali
   */
  searchGoButton: (page: Page): Locator =>
    page.getByRole("button", { name: "GO", exact: true }),
};

// ─── Separation form: extraction / base fields ────────────────────────────

export const separationForm = {
  /**
   * Employee name textbox (last, first format).
   * @tags employee, name, last, first, textbox, separation, kuali
   */
  employeeName: (page: Page): Locator =>
    page.getByRole("textbox", { name: "Employee Last Name, First Name*" }),
  /**
   * EID textbox.
   * @tags eid, employee, id, textbox, separation, kuali
   */
  eid: (page: Page): Locator =>
    page.getByRole("textbox", { name: "EID*" }),
  /**
   * Last Day Worked date textbox.
   * @tags last-day, worked, date, textbox, separation, kuali
   */
  lastDayWorked: (page: Page): Locator =>
    page.getByRole("textbox", { name: "Last Day Worked*" }),
  /**
   * Separation Date textbox.
   * @tags separation, date, textbox, kuali
   */
  separationDate: (page: Page): Locator =>
    page.getByRole("textbox", { name: /Separation Date/ }),
  /**
   * Type of Termination combobox.
   * @tags type, termination, combobox, separation, kuali
   */
  terminationType: (page: Page): Locator =>
    page.getByRole("combobox", { name: "Type of Termination*" }),
  /**
   * Location textbox (optional field).
   * @tags location, textbox, separation, kuali
   */
  location: (page: Page): Locator =>
    page.getByRole("textbox", { name: "Location *" }),
};

// ─── Timekeeper Tasks section ─────────────────────────────────────────────

export const timekeeperTasks = {
  /**
   * Request Acknowledged checkbox.
   * @tags request, acknowledged, checkbox, timekeeper, kuali
   */
  requestAcknowledgedCheckbox: (page: Page): Locator =>
    page.getByRole("checkbox", { name: "Request Acknowledged - In Progress" }),

  /**
   * Timekeeper Name textbox.
   * @tags timekeeper, name, textbox, kuali
   */
  timekeeperName: (page: Page): Locator =>
    page.getByRole("textbox", { name: "Timekeeper Name:*" }),

  /**
   * Timekeeper / Approver Comments textbox.
   * @tags timekeeper, approver, comments, textbox, kuali
   */
  timekeeperComments: (page: Page): Locator =>
    page.getByRole("textbox", { name: "Timekeeper/Approver Comments:" }),
};

// ─── Final Transactions section ───────────────────────────────────────────

export const finalTransactions = {
  /**
   * Termination Effective Date textbox.
   * @tags termination, effective, date, textbox, final, kuali
   */
  terminationEffDate: (page: Page): Locator =>
    page.getByRole("textbox", { name: "Termination Effective Date*" }),

  /**
   * Department combobox.
   * @tags department, combobox, final, kuali
   */
  department: (page: Page): Locator =>
    page.getByRole("combobox", { name: "Department*" }),

  /**
   * Payroll Title Code textbox.
   * @tags payroll, title, code, textbox, final, kuali
   */
  payrollTitleCode: (page: Page): Locator =>
    page.getByRole("textbox", { name: "Payroll Title Code*" }),

  /**
   * Payroll Title textbox.
   * @tags payroll, title, textbox, final, kuali
   */
  payrollTitle: (page: Page): Locator =>
    page.getByRole("textbox", { name: "Payroll Title*" }),
};

// ─── UCPath Transaction Results section ───────────────────────────────────

export const transactionResults = {
  /**
   * Submitted Termination Template checkbox.
   * @tags submitted, template, termination, checkbox, transaction, kuali
   */
  submittedTemplateCheckbox: (page: Page): Locator =>
    page.getByRole("checkbox", { name: "Submitted Termination Template" }),

  /**
   * Transaction Number textbox.
   * @tags transaction, number, textbox, kuali
   */
  transactionNumber: (page: Page): Locator =>
    page.getByRole("textbox", { name: "Transaction Number:*" }),

  /**
   * "Does not need Final Pay (student employee)" radio.
   * @tags final, pay, student, radio, transaction, kuali
   */
  doesNotNeedFinalPayRadio: (page: Page): Locator =>
    page.getByRole("radio", {
      name: "Does not need Final Pay (student employee)",
    }),
};

// ─── Save button (navbar) ─────────────────────────────────────────────────

/**
 * Save button. 3-deep fallback chain:
 *   1. Navbar action-bar save
 *   2. Generic nav save
 *   3. Global role-based Save button (exact: true)
 *
 * verified 2026-04-10
 */
export const save = {
  /**
   * Navbar Save button (3-deep fallback chain).
   * @tags save, navbar, button, fallback, kuali
   */
  navbarSaveButton: (page: Page): Locator =>
    page
      .locator('[class*="action-bar"] button:has-text("Save")')
      .or(page.locator('nav button:has-text("Save")'))
      .or(page.getByRole("button", { name: "Save", exact: true })),
};

export const kualiSelectors = {
  actionList,
  separationForm,
  timekeeperTasks,
  finalTransactions,
  transactionResults,
  save,
};
