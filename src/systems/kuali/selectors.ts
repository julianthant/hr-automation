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
   * Document link matching a doc number regex. verified 2026-03-16
   * @tags document, doc, link, action-list, kuali
   */
  docLink: (page: Page, docNumber: string): Locator =>
    page.getByRole("link", { name: new RegExp(docNumber) }),
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
