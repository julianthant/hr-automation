import type { Locator, Page } from "playwright";
import { log } from "../../utils/log.js";
import { gotoWithRetry } from "../../browser/launch.js";
import {
  actionList,
  separationForm,
  timekeeperTasks,
  finalTransactions,
  transactionResults,
  save,
} from "./selectors.js";

const KUALI_SPACE_URL = "https://ucsd.kualibuild.com/build/space/5e47518b90adda9474c14adb";

/**
 * Fill a Kuali input field and verify the value was accepted.
 * Some Kuali date and text inputs silently drop fill() on first attempt.
 * If the readback does not match, retries with pressSequentially (character-by-character).
 * Throws if both strategies fail.
 */
export async function fillWithVerify(
  locator: Locator,
  value: string,
  label: string,
): Promise<void> {
  await locator.fill(value, { timeout: 5_000 })
  const actual = await locator.inputValue()
  if (actual === value) return
  log.warn(`[Kuali] ${label} fill silently dropped — retrying with type()`)
  await locator.clear()
  await locator.pressSequentially(value, { delay: 30 })
  const after = await locator.inputValue()
  if (after !== value) {
    throw new Error(
      `[Kuali] ${label} fill failed after type() retry: expected="${value}" got="${after}"`,
    )
  }
}

/**
 * Navigate to the Kuali Build Action List page.
 */
export async function openActionList(page: Page): Promise<void> {
  log.step("Navigating to Kuali Build...");
  await gotoWithRetry(
    page,
    KUALI_SPACE_URL,
    actionList.menuItem(page),
  );
  await page.waitForTimeout(3_000);

  log.step("Clicking Action List...");
  await actionList.menuItem(page).click({ timeout: 15_000 });
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
  const docLink = actionList.docLink(page, docNumber);
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

  const employeeName = await separationForm.employeeName(page).inputValue({ timeout: 5_000 });
  log.step(`  Employee Name: ${employeeName}`);

  const eid = await separationForm.eid(page).inputValue({ timeout: 5_000 });
  log.step(`  EID: ${eid}`);

  const lastDayWorked = await separationForm.lastDayWorked(page).inputValue({ timeout: 5_000 });
  log.step(`  Last Day Worked: ${lastDayWorked}`);

  const separationDate = await separationForm.separationDate(page).inputValue({ timeout: 5_000 });
  log.step(`  Separation Date: ${separationDate}`);

  // Get the selected option's visible text (not the internal value)
  const termCombo = separationForm.terminationType(page);
  const terminationType = await termCombo.evaluate((el) => {
    const select = el as HTMLSelectElement;
    return select.options[select.selectedIndex]?.text ?? select.value;
  });
  log.step(`  Type of Termination: ${terminationType}`);

  let location = "";
  try {
    location = await separationForm.location(page).inputValue({ timeout: 3_000 });
    log.step(`  Location: ${location}`);
  } catch {
    log.step("  Location: (not found)");
  }

  log.success("Separation data extracted");
  return { employeeName, eid, lastDayWorked, separationDate, terminationType, location };
}

/**
 * Involuntary termination types from Kuali.
 * Everything NOT in this list is considered voluntary.
 */
const INVOLUNTARY_TYPES = [
  "Never Started Employment",
  "Graduated/No longer a Student",
];

/**
 * Determine if the termination type is voluntary or involuntary.
 */
export function isVoluntaryTermination(terminationType: string): boolean {
  return !INVOLUNTARY_TYPES.includes(terminationType);
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
  const checkbox = timekeeperTasks.requestAcknowledgedCheckbox(page);
  if (!(await checkbox.isChecked())) {
    await checkbox.check({ timeout: 5_000 });
  }
  log.step("  Request Acknowledged checked");

  // Fill Timekeeper Name
  log.step(`  Filling Timekeeper Name: ${timekeeperName}`);
  await timekeeperTasks.timekeeperName(page).fill(timekeeperName, { timeout: 5_000 });

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
    await fillWithVerify(
      finalTransactions.terminationEffDate(page),
      opts.terminationEffDate,
      'terminationEffDate',
    );
  }

  // Select Department from dropdown (best match, skip if empty)
  if (opts.department) {
    log.step(`  Department: ${opts.department}`);
    const deptCombo = finalTransactions.department(page);
    const allOptions = await deptCombo.locator("option").allTextContents(); // allow-inline-selector -- enumerating option elements of a combobox
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
    await finalTransactions.payrollTitleCode(page).fill(opts.payrollTitleCode, { timeout: 5_000 });
  }

  // Fill Payroll Title (skip if empty)
  if (opts.payrollTitle) {
    log.step(`  Payroll Title: ${opts.payrollTitle}`);
    await finalTransactions.payrollTitle(page).fill(opts.payrollTitle, { timeout: 5_000 });
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
  const checkbox = transactionResults.submittedTemplateCheckbox(page);
  if (!(await checkbox.isChecked())) {
    await checkbox.check({ timeout: 5_000 });
  }
  log.step("  Submitted Termination Template checked");

  // Fill Transaction Number (skip if empty — user will fill manually)
  if (transactionNumber) {
    log.step(`  Transaction Number: ${transactionNumber}`);
    await fillWithVerify(
      transactionResults.transactionNumber(page),
      transactionNumber,
      'transactionNumber',
    );
  } else {
    log.step("  Transaction Number: (empty — fill manually)");
  }

  // Select "Does not need Final Pay (student employee)" radio
  log.step("  Selecting Final Pay: Does not need Final Pay (student employee)...");
  await transactionResults.doesNotNeedFinalPayRadio(page).check({ timeout: 5_000 });

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
  await timekeeperTasks.timekeeperComments(page).fill(comments, { timeout: 5_000 });
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
  const field = separationForm.lastDayWorked(page);
  await field.clear({ timeout: 5_000 });
  await fillWithVerify(field, newDate, 'lastDayWorked');
  log.success(`Last Day Worked set to: ${newDate}`);
}

/**
 * Update the Separation Date field in the Kuali form.
 */
export async function updateSeparationDate(
  page: Page,
  newDate: string,
): Promise<void> {
  log.step(`Updating Separation Date to: ${newDate}`);
  const field = separationForm.separationDate(page);
  await field.clear({ timeout: 5_000 });
  await fillWithVerify(field, newDate, 'separationDate');
  log.success(`Separation Date set to: ${newDate}`);
}

/**
 * Click the Save button in the Kuali form top navbar.
 * Waits for network idle to ensure the AJAX save request completes
 * (critical for batch mode where the process may exit after the last doc).
 *
 * Targets the navbar save button specifically — scrolls to top first to ensure
 * the navbar is visible and no other element intercepts the click.
 */
export async function clickSave(page: Page): Promise<void> {
  log.step("Clicking Save on Kuali form...");

  // Scroll to top so the navbar save button is visible and not obscured
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(500);

  // Target the navbar save button — registry carries the 3-deep .or() fallback.
  await save.navbarSaveButton(page).first().click({ timeout: 10_000 });

  // Wait for the save request to complete
  await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
  await page.waitForTimeout(2_000);

  log.success("Kuali form saved");
}
