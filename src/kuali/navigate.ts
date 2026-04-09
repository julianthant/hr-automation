import type { Page } from "playwright";
import { log } from "../utils/log.js";
import { gotoWithRetry } from "../browser/launch.js";

const KUALI_SPACE_URL = "https://ucsd.kualibuild.com/build/space/5e47518b90adda9474c14adb";

/**
 * Navigate to the Kuali Build Action List page.
 */
export async function openActionList(page: Page): Promise<void> {
  log.step("Navigating to Kuali Build...");
  await gotoWithRetry(
    page,
    KUALI_SPACE_URL,
    page.getByRole("menuitem", { name: "Action List" }),
  );
  await page.waitForTimeout(3_000);

  log.step("Clicking Action List...");
  await page.getByRole("menuitem", { name: "Action List" }).click({ timeout: 15_000 });
  await page.waitForTimeout(3_000);
  log.success("Action List loaded");
}

/**
 * Click on a document row by its document number in the Action List.
 * Returns the URL of the opened document form.
 */
export async function clickDocument(page: Page, docNumber: string): Promise<string> {
  log.step(`Searching for document #${docNumber}...`);

  // Find link containing the doc number in the action list table
  const docLink = page.getByRole("link", { name: new RegExp(`${docNumber}`) });
  const count = await docLink.count();

  if (count === 0) {
    throw new Error(`Document #${docNumber} not found in Action List`);
  }

  log.step(`Found document #${docNumber}, clicking...`);
  await docLink.first().click({ timeout: 10_000 });
  await page.waitForTimeout(3_000);

  const url = page.url();
  log.success(`Document #${docNumber} opened: ${url}`);
  return url;
}

/**
 * Data extracted from the Kuali separation form.
 */
export interface KualiSeparationData {
  employeeName: string;
  eid: string;
  lastDayWorked: string;
  separationDate: string;
  terminationType: string;
  location: string;
}

/**
 * Extract separation data from the currently open Kuali document form.
 * Must be called after clickDocument().
 */
export async function extractSeparationData(page: Page): Promise<KualiSeparationData> {
  log.step("Extracting separation data from Kuali form...");

  const employeeName = await page.getByRole("textbox", { name: "Employee Last Name, First Name*" }).inputValue({ timeout: 5_000 });
  log.step(`  Employee Name: ${employeeName}`);

  const eid = await page.getByRole("textbox", { name: "EID*" }).inputValue({ timeout: 5_000 });
  log.step(`  EID: ${eid}`);

  const lastDayWorked = await page.getByRole("textbox", { name: "Last Day Worked*" }).inputValue({ timeout: 5_000 });
  log.step(`  Last Day Worked: ${lastDayWorked}`);

  const separationDate = await page.getByRole("textbox", { name: /Separation Date/ }).inputValue({ timeout: 5_000 });
  log.step(`  Separation Date: ${separationDate}`);

  // Get the selected option's visible text (not the internal value)
  const termCombo = page.getByRole("combobox", { name: "Type of Termination*" });
  const terminationType = await termCombo.evaluate((el) => {
    const select = el as HTMLSelectElement;
    return select.options[select.selectedIndex]?.text ?? select.value;
  });
  log.step(`  Type of Termination: ${terminationType}`);

  let location = "";
  try {
    location = await page.getByRole("textbox", { name: "Location *" }).inputValue({ timeout: 3_000 });
    log.step(`  Location: ${location}`);
  } catch {
    log.step("  Location: (not found)");
  }

  log.success("Separation data extracted");
  return { employeeName, eid, lastDayWorked, separationDate, terminationType, location };
}

/**
 * Determine if the termination type is voluntary or involuntary.
 * Everything except "Never Started Employment" is voluntary.
 */
export function isVoluntaryTermination(terminationType: string): boolean {
  return terminationType !== "Never Started Employment";
}

/**
 * Map Kuali termination type to UCPath reason code.
 * "Graduated/No longer a Student" maps to "No Longer Student" in UCPath.
 */
export function mapTerminationToUCPathReason(terminationType: string): string {
  if (terminationType.toLowerCase().includes("graduated")) {
    const result = "No Longer Student";
    log.step(`Reason code: Kuali type "${terminationType}" → UCPath reason "${result}"`);
    return result;
  }
  log.step(`Reason code: Kuali type "${terminationType}" → UCPath reason "${terminationType}" (no mapping)`);
  return terminationType;
}

/**
 * Fill the Timekeeper Tasks section in the Kuali form.
 */
export async function fillTimekeeperTasks(
  page: Page,
  timekeeperName: string,
): Promise<void> {
  log.step("Filling Timekeeper Tasks...");

  // Check the Request Acknowledged checkbox
  log.step("  Checking Request Acknowledged...");
  const checkbox = page.getByRole("checkbox", { name: "Request Acknowledged - In Progress" });
  if (!(await checkbox.isChecked())) {
    await checkbox.check({ timeout: 5_000 });
  }
  log.step("  Request Acknowledged checked");

  // Fill Timekeeper Name
  log.step(`  Filling Timekeeper Name: ${timekeeperName}`);
  await page.getByRole("textbox", { name: "Timekeeper Name:*" }).fill(timekeeperName, { timeout: 5_000 });

  log.success("Timekeeper Tasks filled");
}

/**
 * Fill the Final Transactions section in the Kuali form.
 * Skips any field with an empty string value — allows partial fills.
 */
export async function fillFinalTransactions(
  page: Page,
  opts: {
    terminationEffDate?: string;
    department?: string;
    payrollTitleCode?: string;
    payrollTitle?: string;
  },
): Promise<void> {
  log.step("Filling Final Transactions...");

  // Fill Termination Effective Date (skip if empty)
  if (opts.terminationEffDate) {
    log.step(`  Termination Effective Date: ${opts.terminationEffDate}`);
    await page.getByRole("textbox", { name: "Termination Effective Date*" }).fill(opts.terminationEffDate, { timeout: 5_000 });
  }

  // Select Department from dropdown (best match, skip if empty)
  if (opts.department) {
    log.step(`  Department: ${opts.department}`);
    const deptCombo = page.getByRole("combobox", { name: "Department*" });
    const allOptions = await deptCombo.locator("option").allTextContents();
    const bestMatch = allOptions.find((opt) =>
      opt.toLowerCase().includes(opts.department!.toLowerCase()),
    );
    log.step(`Department: searching for "${opts.department}" — best match: "${bestMatch || "NONE"}"`);
    if (bestMatch && bestMatch !== "- - -") {
      await deptCombo.selectOption({ label: bestMatch }, { timeout: 5_000 });
      log.step(`  Selected department: ${bestMatch}`);
    } else {
      log.error(`  No matching department found for: ${opts.department}`);
    }
  }

  // Fill Payroll Title Code (skip if empty)
  if (opts.payrollTitleCode) {
    log.step(`  Payroll Title Code: ${opts.payrollTitleCode}`);
    await page.getByRole("textbox", { name: "Payroll Title Code*" }).fill(opts.payrollTitleCode, { timeout: 5_000 });
  }

  // Fill Payroll Title (skip if empty)
  if (opts.payrollTitle) {
    log.step(`  Payroll Title: ${opts.payrollTitle}`);
    await page.getByRole("textbox", { name: "Payroll Title*" }).fill(opts.payrollTitle, { timeout: 5_000 });
  }

  log.success("Final Transactions filled");
}

/**
 * Fill UCPath transaction results in the Kuali form.
 * - Check "Submitted Termination Template" checkbox
 * - Fill Transaction Number
 * - Select "Does not need Final Pay (student employee)" radio
 */
export async function fillTransactionResults(
  page: Page,
  transactionNumber: string,
): Promise<void> {
  log.step("Filling UCPath transaction results in Kuali...");

  // Check "Submitted Termination Template" checkbox
  log.step("  Checking Submitted Termination Template...");
  const checkbox = page.getByRole("checkbox", { name: "Submitted Termination Template" });
  if (!(await checkbox.isChecked())) {
    await checkbox.check({ timeout: 5_000 });
  }
  log.step("  Submitted Termination Template checked");

  // Fill Transaction Number (skip if empty — user will fill manually)
  if (transactionNumber) {
    log.step(`  Transaction Number: ${transactionNumber}`);
    await page.getByRole("textbox", { name: "Transaction Number:*" }).fill(transactionNumber, { timeout: 5_000 });
  } else {
    log.step("  Transaction Number: (empty — fill manually)");
  }

  // Select "Does not need Final Pay (student employee)" radio
  log.step("  Selecting Final Pay: Does not need Final Pay (student employee)...");
  await page.getByRole("radio", { name: "Does not need Final Pay (student employee)" }).check({ timeout: 5_000 });

  log.success("Transaction results filled in Kuali");
}

/**
 * Fill the Timekeeper/Approver Comments field.
 */
export async function fillTimekeeperComments(
  page: Page,
  comments: string,
): Promise<void> {
  if (!comments) return;
  log.step(`Filling Timekeeper/Approver Comments: ${comments}`);
  await page.getByRole("textbox", { name: "Timekeeper/Approver Comments:" }).fill(comments, { timeout: 5_000 });
  log.success("Timekeeper comments filled");
}

/**
 * Update the Last Day Worked field in the Kuali form.
 */
export async function updateLastDayWorked(
  page: Page,
  newDate: string,
): Promise<void> {
  log.step(`Updating Last Day Worked to: ${newDate}`);
  const field = page.getByRole("textbox", { name: "Last Day Worked*" });
  await field.clear({ timeout: 5_000 });
  await field.fill(newDate, { timeout: 5_000 });
}

/**
 * Update the Separation Date field in the Kuali form.
 */
export async function updateSeparationDate(
  page: Page,
  newDate: string,
): Promise<void> {
  log.step(`Updating Separation Date to: ${newDate}`);
  const field = page.getByRole("textbox", { name: /Separation Date/ });
  await field.clear({ timeout: 5_000 });
  await field.fill(newDate, { timeout: 5_000 });
}

/**
 * Click the Save button in the Kuali form top navbar.
 */
export async function clickSave(page: Page): Promise<void> {
  log.step("Clicking Save on Kuali form...");
  const saveBtn = page.getByRole("button", { name: "Save", exact: true })
    .or(page.locator("button:has-text('Save')").first());
  await saveBtn.first().click({ timeout: 10_000 });
  await page.waitForTimeout(3_000);
  log.success("Kuali form saved");
}
