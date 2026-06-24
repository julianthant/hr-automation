import type { Locator, Page } from "playwright";
import { log } from "../../utils/log.js";
import { gotoWithRetry } from "../../infra/browser/launch.js";
import {
  actionList,
  separationForm,
  timekeeperTasks,
  finalTransactions,
  transactionResults,
  save,
} from "./selectors.js";
import { safeClick, safeFill } from "../common/index.js";

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
  await safeFill(locator, value, { timeout: 5_000, label })
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
  await safeClick(actionList.menuItem(page), {
    timeout: 15_000,
    label: "kuali action list menu item",
  });
  await page.waitForTimeout(3_000);
  log.success("Action List loaded");
}

/**
 * Enumerate the pending document numbers in the Kuali Build Action List.
 *
 * Read-only: reads the accessible text of every document-number link in the
 * Action List (the same links `clickDocument` clicks one at a time) and
 * returns the de-duplicated, trimmed list of document numbers. Opens or
 * mutates nothing. Must be called after `openActionList()`.
 *
 * The accessible-name filter in `actionList.docLinks` keeps only links whose
 * text is a bare number, so nav / action / pagination links are excluded. The
 * Action List can hold non-separation document types; this returns every
 * pending document number it finds — callers that want separations only must
 * attempt extraction per doc and skip rows whose form isn't a separation form.
 *
 * Returns an empty array when the Action List is empty (a clean no-op for
 * callers, not an error).
 */
export async function listActionListSeparations(page: Page): Promise<string[]> {
  log.step("Enumerating pending documents in the Kuali Action List...");

  const links = actionList.docLinks(page);
  // Wait briefly for at least one row to render; an empty Action List is a
  // valid state, so a timeout here means "no pending docs", not a failure.
  const count = await links
    .first()
    .waitFor({ state: "visible", timeout: 10_000 })
    .then(() => links.count())
    .catch(() => 0);

  if (count === 0) {
    log.step("Action List has no pending documents");
    return [];
  }

  const rawNames = await links.allTextContents();
  const docNumbers = Array.from(
    new Set(
      rawNames
        .map((name) => name.trim())
        .filter((name) => /^\d+$/.test(name)),
    ),
  );

  log.success(`Found ${docNumbers.length} pending document(s) in the Action List`);
  return docNumbers;
}

/**
 * Click on a document row by its document number in the Action List.
 * Returns the URL of the opened document form.
 *
 * The Action List paginates at 25 rows/page, so a target document often isn't on
 * the first page. Rather than page through, this types the document number into
 * the list's own search box and clicks GO to filter to the matching row, then
 * clicks it. `docLink` matches the row by EXACT number (anchored), so the fact
 * that Kuali's search is substring-based (a search for "414" returns 4140–4149)
 * can't open the wrong document. Throws if the search returns no matching row —
 * i.e. the document genuinely isn't in the Action List.
 */
export async function clickDocument(page: Page, docNumber: string): Promise<string> {
  log.step(`Searching for document #${docNumber}...`);

  // Filter the Action List to the target doc via its search box. fill() replaces
  // any prior query, so this also clears a stale search from a previous doc.
  await safeFill(actionList.searchInput(page), docNumber, {
    timeout: 10_000,
    label: "kuali action list search",
  });
  await safeClick(actionList.searchGoButton(page), {
    timeout: 10_000,
    label: "kuali action list search GO",
  });
  // Let the filtered result render (Kuali refetches the list server-side).
  await page.waitForLoadState("networkidle", { timeout: 8_000 }).catch(() => {});
  await page.waitForTimeout(1_500);

  const docLink = actionList.docLink(page, docNumber);
  if ((await docLink.count()) === 0) {
    throw new Error(`Document #${docNumber} not found in Action List`);
  }

  log.step(`Found document #${docNumber}, clicking...`);
  await safeClick(docLink.first(), { timeout: 10_000, label: "kuali document link" });
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

  // Kuali form inputs come back whitespace-padded (observed live: EID with a
  // leading space, Location with a trailing space). Trim every extracted field
  // so EIDs match `^\d{5,}$` and the vol/invol exact-match on terminationType
  // isn't broken by stray whitespace. This is normalization of the SAME value,
  // not a cross-source correction.
  const employeeName = (await separationForm.employeeName(page).inputValue({ timeout: 5_000 })).trim();
  log.step(`  Employee Name: ${employeeName}`);

  const eid = (await separationForm.eid(page).inputValue({ timeout: 5_000 })).trim();
  log.step(`  EID: ${eid}`);

  const lastDayWorked = (await separationForm.lastDayWorked(page).inputValue({ timeout: 5_000 })).trim();
  log.step(`  Last Day Worked: ${lastDayWorked}`);

  const separationDate = (await separationForm.separationDate(page).inputValue({ timeout: 5_000 })).trim();
  log.step(`  Separation Date: ${separationDate}`);

  // Get the selected option's visible text (not the internal value). Trim the
  // result in TS after the evaluate returns (keep the in-page function simple).
  const termCombo = separationForm.terminationType(page);
  const terminationType = (await termCombo.evaluate((el) => {
    const select = el as HTMLSelectElement;
    return select.options[select.selectedIndex]?.text ?? select.value;
  })).trim();
  log.step(`  Type of Termination: ${terminationType}`);

  let location = "";
  try {
    location = (await separationForm.location(page).inputValue({ timeout: 3_000 })).trim();
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
  await safeFill(timekeeperTasks.timekeeperName(page), timekeeperName, {
    timeout: 5_000,
    label: "kuali timekeeper name",
  });

  log.success("Timekeeper Tasks filled");
}

/**
 * Fill the Final Transactions section in the Kuali form.
 * Skips any field with an empty string value — allows partial fills.
 */
/** Normalize a department string for comparison: lowercase, collapse whitespace. */
function normDept(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * The NAME part of a Kuali department option — strip a leading numeric code
 * prefix like `"000412 - "` (PeopleSoft/Kuali options render `"CODE - Name"`).
 * Returns the whole option (normalized) when there's no code prefix.
 */
function departmentOptionName(opt: string): string {
  return normDept(opt.replace(/^\s*\d+\s*-\s*/, ""));
}

/**
 * Pick the index of the best-matching department `<option>` for a UCPath
 * department description. Returns -1 when nothing confidently matches (the
 * caller then leaves the field blank for manual entry — fail-safe, never a
 * guess).
 *
 * Two tiers, both case-insensitive with collapsed whitespace, skipping the
 * placeholder `"- - -"` row:
 *   1. The UCPath description is a substring of the option (the original,
 *      highest-confidence match — e.g. "Housing/Dining/Hospitality" ⊆
 *      "000412 - Housing/Dining/Hospitality").
 *   2. The option's NAME (after the "CODE - " prefix) is a substring of the
 *      UCPath description. This handles UCPath descriptions that carry a
 *      DIVISION PREFIX the Kuali label lacks — live: UCPath "VCSA-CL ASSOCIATED
 *      STUDENTS" / "VCSA CAMPUS RECREATION" never matched the Kuali "… Associated
 *      Students" / "… Campus Recreation" option under tier 1 ("No matching
 *      department found", 2026-06-24). To stay safe, tier 2 only considers a
 *      "specific" option name (≥2 words OR ≥8 chars — a short generic word like
 *      "Admin" can't mis-match) and picks the LONGEST matching name (most
 *      specific) when several qualify.
 *
 * Why an INDEX rather than the option label (ISS-B05, 2026-06-22 live batch):
 * the live UCSD department combobox renders options with irregular internal
 * whitespace — e.g. `"000719 -  Supply Chain Services"` (a DOUBLE space after
 * the code dash). `selectOption({ label })` matches the option's normalized
 * label exactly, so the raw `allTextContents()` string never matched and the
 * select timed out at 5s for those departments. Selecting by index sidesteps
 * all label/whitespace matching.
 */
export function pickDepartmentOptionIndex(options: string[], department: string): number {
  const needle = normDept(department);
  if (!needle) return -1;

  // Tier 1 — UCPath description ⊆ option text.
  const tier1 = options.findIndex((opt) => {
    const norm = normDept(opt);
    return norm !== "- - -" && norm.includes(needle);
  });
  if (tier1 >= 0) return tier1;

  // Tier 2 — option name ⊆ UCPath description (handles a UCPath division prefix
  // the Kuali label lacks). Specific names only; pick the longest match.
  let best = -1;
  let bestLen = 0;
  options.forEach((opt, i) => {
    const norm = normDept(opt);
    if (norm === "- - -" || !norm) return;
    const name = departmentOptionName(opt);
    if (!name) return;
    const specific = name.split(" ").length >= 2 || name.length >= 8;
    if (specific && needle.includes(name) && name.length > bestLen) {
      best = i;
      bestLen = name.length;
    }
  });
  return best;
}

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
    const matchIdx = pickDepartmentOptionIndex(allOptions, opts.department);
    const bestMatch = matchIdx >= 0 ? allOptions[matchIdx].trim() : "NONE";
    log.step(`Department: searching for "${opts.department}" — best match: "${bestMatch}"`);
    if (matchIdx >= 0) {
      // Select by INDEX, not { label }: live UCSD dept options carry irregular
      // internal whitespace that never matches Playwright's exact label compare
      // (see pickDepartmentOptionIndex / ISS-B05). Index avoids label matching.
      await deptCombo.selectOption({ index: matchIdx }, { timeout: 5_000 });
      log.step(`  Selected department: ${bestMatch}`);
    } else {
      log.error(`  No matching department found for: ${opts.department}`);
    }
  }

  // Fill Payroll Title Code (skip if empty)
  if (opts.payrollTitleCode) {
    log.step(`  Payroll Title Code: ${opts.payrollTitleCode}`);
    await safeFill(finalTransactions.payrollTitleCode(page), opts.payrollTitleCode, {
      timeout: 5_000,
      label: "kuali payroll title code",
    });
  }

  // Fill Payroll Title (skip if empty)
  if (opts.payrollTitle) {
    log.step(`  Payroll Title: ${opts.payrollTitle}`);
    await safeFill(finalTransactions.payrollTitle(page), opts.payrollTitle, {
      timeout: 5_000,
      label: "kuali payroll title",
    });
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
  const field = timekeeperTasks.timekeeperComments(page);
  const existing = (await field.inputValue({ timeout: 5_000 }).catch(() => "")).trim();
  const combined = existing ? `${existing}\n${comments}` : comments;
  log.step(
    `Filling Timekeeper/Approver Comments `
    + `(existing=${existing.length} chars, appending=${comments.length} chars)`,
  );
  await safeFill(field, combined, {
    timeout: 5_000,
    label: "kuali timekeeper comments",
  });
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
 * Update the Employee Name field ("Last Name, First Name") in the Kuali
 * separation form. Used by the separations `identity-check` step when the
 * Workforce Job Summary resolves the SAME person under a close spelling variant
 * (e.g. Kuali "Balmaceda, Jaden" vs UCPath "Jayden Balmaceda") — the EID is
 * trusted and the misspelled name is corrected in place. Mirrors
 * `updateLastDayWorked`'s clear + fill-with-verify pattern.
 */
export async function updateEmployeeName(
  page: Page,
  newName: string,
): Promise<void> {
  log.step(`Updating Employee Name to: ${newName}`);
  const field = separationForm.employeeName(page);
  await field.clear({ timeout: 5_000 });
  await fillWithVerify(field, newName, 'employeeName');
  log.success(`Employee Name set to: ${newName}`);
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
 * Defense-in-depth re-read of the Kuali transaction number input immediately
 * before Save. `fillWithVerify` at fill-time reads back the DOM value, but
 * downstream edits to sibling fields can clear this input if the form's
 * reactive bindings reset on blur. If we find it empty or wrong, we refill
 * once using Playwright's `fill()` and re-read. A second mismatch throws so
 * the run fails loud rather than persisting a Kuali row with a blank txn #.
 */
export async function verifyTxnNumberFilled(
  page: Page,
  expected: string,
): Promise<void> {
  const field = transactionResults.transactionNumber(page)
  // Brief grace period for Kuali's form bindings to settle after prior edits.
  await page.waitForTimeout(300)
  const firstRead = await field.inputValue()
  if (firstRead === expected) return

  log.warn(
    `[Kuali] Txn # unexpectedly '${firstRead}' before save — refilling to '${expected}'`,
  )
  await safeFill(field, expected, { timeout: 5_000, label: "kuali transaction number refill" })
  await page.waitForTimeout(300)
  const secondRead = await field.inputValue()
  if (secondRead !== expected) {
    throw new Error(
      `[Kuali] Transaction Number mismatch before save: expected='${expected}' actual='${secondRead}' — refusing to click Save with missing txn#`,
    )
  }
  log.success(`[Kuali] Txn # recovered to '${expected}' before save`)
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
  await safeClick(save.navbarSaveButton(page).first(), {
    timeout: 10_000,
    label: "kuali navbar save button",
  });

  // Wait for the save request to complete
  await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
  await page.waitForTimeout(2_000);

  log.success("Kuali form saved");
}
