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
  /** "Action List" menu item. verified 2026-03-16 */
  menuItem: (page: Page): Locator =>
    page.getByRole("menuitem", { name: "Action List" }),

  /** Document link matching a doc number regex. verified 2026-03-16 */
  docLink: (page: Page, docNumber: string): Locator =>
    page.getByRole("link", { name: new RegExp(docNumber) }),
};

// ─── Separation form: extraction / base fields ────────────────────────────

export const separationForm = {
  employeeName: (page: Page): Locator =>
    page.getByRole("textbox", { name: "Employee Last Name, First Name*" }),
  eid: (page: Page): Locator =>
    page.getByRole("textbox", { name: "EID*" }),
  lastDayWorked: (page: Page): Locator =>
    page.getByRole("textbox", { name: "Last Day Worked*" }),
  separationDate: (page: Page): Locator =>
    page.getByRole("textbox", { name: /Separation Date/ }),
  terminationType: (page: Page): Locator =>
    page.getByRole("combobox", { name: "Type of Termination*" }),
  location: (page: Page): Locator =>
    page.getByRole("textbox", { name: "Location *" }),
};

// ─── Timekeeper Tasks section ─────────────────────────────────────────────

export const timekeeperTasks = {
  requestAcknowledgedCheckbox: (page: Page): Locator =>
    page.getByRole("checkbox", { name: "Request Acknowledged - In Progress" }),

  timekeeperName: (page: Page): Locator =>
    page.getByRole("textbox", { name: "Timekeeper Name:*" }),

  timekeeperComments: (page: Page): Locator =>
    page.getByRole("textbox", { name: "Timekeeper/Approver Comments:" }),
};

// ─── Final Transactions section ───────────────────────────────────────────

export const finalTransactions = {
  terminationEffDate: (page: Page): Locator =>
    page.getByRole("textbox", { name: "Termination Effective Date*" }),

  department: (page: Page): Locator =>
    page.getByRole("combobox", { name: "Department*" }),

  payrollTitleCode: (page: Page): Locator =>
    page.getByRole("textbox", { name: "Payroll Title Code*" }),

  payrollTitle: (page: Page): Locator =>
    page.getByRole("textbox", { name: "Payroll Title*" }),
};

// ─── UCPath Transaction Results section ───────────────────────────────────

export const transactionResults = {
  submittedTemplateCheckbox: (page: Page): Locator =>
    page.getByRole("checkbox", { name: "Submitted Termination Template" }),

  transactionNumber: (page: Page): Locator =>
    page.getByRole("textbox", { name: "Transaction Number:*" }),

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
