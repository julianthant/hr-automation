import type { Page, FrameLocator } from "playwright";
import type { TransactionResult } from "./types.js";
import { getContentFrame, waitForPeopleSoftProcessing } from "./navigate.js";
import { log } from "../utils/log.js";

// ─── STEP 1: Navigate sidebar → Smart HR Templates → Smart HR Transactions ───

/**
 * Click "Smart HR Templates" in the sidebar to expand it, then click
 * "Smart HR Transactions" child link. Loads the transaction form in the iframe.
 *
 * SELECTOR: verified v1.0 — sidebar link text matches exactly
 *
 * After clicking, must collapse navigation sidebar so it doesn't block
 * buttons in the iframe (PeopleSoft overlay issue).
 */
export async function clickSmartHRTransactions(page: Page): Promise<void> {
  log.step("Clicking Smart HR Templates in sidebar...");

  // SELECTOR: verified v1.0 — sidebar link with "(select to expand or collapse child steps)"
  await page
    .getByRole("link", { name: /Smart HR Templates/i })
    .first()
    .click({ timeout: 10_000 });
  await page.waitForTimeout(1_000);

  // SELECTOR: verified v1.0 — exact text match child link
  log.step("Clicking Smart HR Transactions...");
  await page
    .getByRole("link", { name: "Smart HR Transactions", exact: true })
    .click({ timeout: 10_000 });
  await page.waitForTimeout(5_000);
  await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});

  // Collapse the sidebar navigation to prevent overlay blocking iframe buttons
  // SELECTOR: verified v1.0 — "Navigation Area" toggle button
  log.step("Collapsing sidebar navigation...");
  try {
    await page.getByRole("button", { name: "Navigation Area" }).click({ timeout: 5_000 });
    await page.waitForTimeout(1_000);
  } catch {
    log.step("Sidebar collapse failed (non-fatal) — may already be collapsed");
  }

  log.success("Smart HR Transactions page loaded");
}

// ─── STEP 2: Select template + effective date + Create Transaction ───

/**
 * Fill the template input with UC_FULL_HIRE.
 *
 * SELECTOR: verified v1.0 — textbox labeled "Select Template" in iframe
 */
export async function selectTemplate(
  frame: FrameLocator,
  templateId: string,
): Promise<void> {
  log.step(`Selecting template: ${templateId}`);

  // SELECTOR: verified v1.0 — textbox "Select Template" in the Smart HR Transactions form
  await frame
    .getByRole("textbox", { name: "Select Template" })
    .fill(templateId, { timeout: 10_000 });
  log.step(`Template input filled: ${templateId}`);

  log.success(`Template "${templateId}" selected`);
}

/**
 * Fill the effective date field.
 *
 * SELECTOR: verified v1.0 — textbox "Effective Date" in iframe
 *
 * @param frame - PeopleSoft content iframe FrameLocator
 * @param date - Date string in MM/DD/YYYY format
 */
export async function enterEffectiveDate(
  frame: FrameLocator,
  date: string,
): Promise<void> {
  log.step(`Entering effective date: ${date}`);

  // SELECTOR: verified v1.0 — textbox "Effective Date"
  await frame
    .getByRole("textbox", { name: "Effective Date" })
    .fill(date, { timeout: 10_000 });
  log.step("Effective date filled");

  log.success("Effective date entered");
}

/**
 * Click the Create Transaction button and wait for the form to load.
 *
 * SELECTOR: verified v1.0 — button "Create Transaction" in iframe
 *
 * @param frame - PeopleSoft content iframe FrameLocator
 * @returns TransactionResult indicating success or failure
 */
export async function clickCreateTransaction(
  page: Page,
  frame: FrameLocator,
): Promise<TransactionResult> {
  log.step("Clicking Create Transaction...");

  // SELECTOR: verified v1.0 — button "Create Transaction"
  await frame
    .getByRole("button", { name: "Create Transaction" })
    .click({ timeout: 10_000 });

  // Wait for PeopleSoft server round-trip
  log.step("Waiting for PeopleSoft to process transaction creation...");
  await page.waitForTimeout(5_000);
  await waitForPeopleSoftProcessing(frame, 30_000);

  // Check for errors
  const errorLocator = frame.locator(".PSERROR, #ALERTMSG, .ps_alert-error");
  try {
    const errorCount = await errorLocator.count();
    if (errorCount > 0) {
      const errorText = await errorLocator.first().textContent({ timeout: 5_000 });
      log.error(`Transaction creation error: ${errorText ?? "Unknown error"}`);
      return { success: false, error: errorText ?? "Unknown error" };
    }
  } catch {
    // No error elements — good
  }

  log.success("Transaction created");
  return { success: true };
}

// ─── STEP 3: Reason code + Continue ───

/**
 * Select the reason code from the dropdown and click Continue.
 *
 * SELECTOR: verified v1.0
 * - Reason Code: combobox "Reason Code"
 * - Continue: button "Continue" (or JS submitAction with HR_TBH_WRK_TBH_NEXT)
 *
 * @param page - Playwright page (for dismissing dialogs)
 * @param frame - PeopleSoft content iframe FrameLocator
 * @param reasonLabel - Visible label text, e.g. "Hire - No Prior UC Affiliation"
 */
export async function selectReasonCode(
  page: Page,
  frame: FrameLocator,
  reasonLabel: string,
): Promise<void> {
  log.step(`Selecting reason code: ${reasonLabel}`);

  // SELECTOR: verified v1.0 — combobox "Reason Code"
  await frame
    .getByLabel("Reason Code")
    .selectOption(reasonLabel, { timeout: 10_000 });
  log.step("Reason code selected");

  await page.waitForTimeout(2_000);

  // Click Continue — may need force or JS due to sidebar overlay
  // SELECTOR: verified v1.0 — button "Continue" (id: HR_TBH_WRK_TBH_NEXT)
  log.step("Clicking Continue...");
  try {
    await frame
      .getByRole("button", { name: "Continue" })
      .click({ timeout: 5_000 });
  } catch {
    // Fallback: use PeopleSoft submitAction if sidebar overlay blocks click
    log.step("Regular click blocked — using JS submitAction...");
    await frame.locator("body").evaluate(() => {
      // @ts-expect-error PeopleSoft global
      submitAction_win0(document.win0, "HR_TBH_WRK_TBH_NEXT");
    });
  }

  await page.waitForTimeout(8_000);
  await waitForPeopleSoftProcessing(frame, 15_000);

  log.success("Reason code selected and continued");
}

// ─── STEP 4: Fill personal data ───

export interface PersonalDataInput {
  firstName: string;
  lastName: string;
  middleName?: string;
  dob: string;
  ssn?: string; // without dashes — just digits; optional for international students
  address: string;
  city?: string;
  state?: string;
  postalCode?: string;
  phone?: string;
  email?: string;
  i9ProfileId?: string;
}

/**
 * Fill all personal data fields on the Smart HR Transaction form.
 *
 * All selectors verified v1.0 against live UCPath PeopleSoft.
 *
 * Fields: legal first/last/middle name, DOB, national ID (SSN),
 * address, phone (Mobile - Personal), email (Home), tracker profile ID.
 */
export async function fillPersonalData(
  page: Page,
  frame: FrameLocator,
  data: PersonalDataInput,
): Promise<void> {
  log.step("Filling personal data...");

  // --- Legal Name ---
  // SELECTOR: verified v1.0 — textbox "Legal First Name"
  log.step("Filling legal first name...");
  await frame.getByRole("textbox", { name: "Legal First Name" }).fill(data.firstName, { timeout: 10_000 });
  log.step("First name filled");

  // SELECTOR: verified v1.0 — textbox "Legal Last Name"
  log.step("Filling legal last name...");
  await frame.getByRole("textbox", { name: "Legal Last Name" }).fill(data.lastName, { timeout: 10_000 });
  log.step("Last name filled");

  if (data.middleName) {
    // SELECTOR: verified v1.0 — textbox "Legal Middle Name"
    log.step("Filling middle name...");
    await frame.getByRole("textbox", { name: "Legal Middle Name" }).fill(data.middleName, { timeout: 10_000 });
    log.step("Middle name filled");
  }

  // --- Date of Birth ---
  // SELECTOR: verified v1.0 — textbox "Date of Birth"
  log.step("Filling date of birth...");
  await frame.getByRole("textbox", { name: "Date of Birth" }).fill(data.dob, { timeout: 10_000 });
  log.step("DOB filled");

  // --- National ID (SSN) ---
  if (data.ssn) {
    // SELECTOR: verified v1.0 — textbox "National ID" (exact match to avoid National ID Type)
    log.step("Filling national ID...");
    await frame.getByRole("textbox", { name: "National ID", exact: true }).fill(data.ssn, { timeout: 10_000 });
    log.step("National ID filled");
  } else {
    log.step("No SSN — skipping national ID field");
  }

  // --- Address ---
  // SELECTOR: verified v1.0 — textbox "Address Line 1"
  log.step("Filling address...");
  await frame.getByRole("textbox", { name: "Address Line 1" }).fill(data.address, { timeout: 10_000 });
  log.step("Address filled");

  if (data.city) {
    // SELECTOR: verified v1.0 — textbox "City"
    await frame.getByRole("textbox", { name: "City" }).fill(data.city, { timeout: 10_000 });
    log.step("City filled");
  }

  if (data.state) {
    // SELECTOR: verified v1.0 — textbox "State"
    await frame.getByRole("textbox", { name: "State" }).fill(data.state, { timeout: 10_000 });
    log.step("State filled");
  }

  if (data.postalCode) {
    // SELECTOR: verified v1.0 — textbox "Postal Code"
    await frame.getByRole("textbox", { name: "Postal Code" }).fill(data.postalCode, { timeout: 10_000 });
    log.step("Postal code filled");
  }

  // --- Phone ---
  if (data.phone) {
    // SELECTOR: verified v1.0 — Phone Type dropdown (grid combobox at index $6)
    // PeopleSoft ID: HR_TBH_G_SCR_WK_TBH_G_LG_DD1$6
    log.step("Selecting phone type: Mobile - Personal...");
    await frame
      .locator('[id="HR_TBH_G_SCR_WK_TBH_G_LG_DD1$6"]')
      .selectOption("Mobile - Personal", { timeout: 10_000 });
    await page.waitForTimeout(3_000);
    await waitForPeopleSoftProcessing(frame);
    log.step("Phone type selected");

    // SELECTOR: verified v1.0 — Phone number textbox (grid input at index $6)
    // PeopleSoft ID: HR_TBH_G_SCR_WK_TBH_G_SH_EDIT2$6
    log.step("Filling phone number...");
    await frame
      .locator('[id="HR_TBH_G_SCR_WK_TBH_G_SH_EDIT2$6"]')
      .fill(data.phone, { timeout: 10_000 });
    log.step("Phone number filled");

    // SELECTOR: verified v1.0 — Preferred checkbox (grid checkbox at index $6)
    // PeopleSoft ID: HR_TBH_G_SCR_WK_TBH_G_CHK3$6
    log.step("Checking Preferred checkbox...");
    await frame
      .locator('[id="HR_TBH_G_SCR_WK_TBH_G_CHK3$6"]')
      .check({ timeout: 5_000 });
    log.step("Preferred checkbox checked");
  }

  // --- Email ---
  if (data.email) {
    // SELECTOR: verified v1.0 — Email Type dropdown (grid combobox at index $7)
    // PeopleSoft ID: HR_TBH_G_SCR_WK_TBH_G_LG_DD1$7
    log.step("Selecting email type: Home...");
    await frame
      .locator('[id="HR_TBH_G_SCR_WK_TBH_G_LG_DD1$7"]')
      .selectOption("Home", { timeout: 10_000 });
    await page.waitForTimeout(3_000);
    await waitForPeopleSoftProcessing(frame);
    log.step("Email type selected");

    // SELECTOR: verified v1.0 — Email address textbox (grid input at index $7)
    // PeopleSoft ID: HR_TBH_G_SCR_WK_TBH_G_LG_EDIT2$7
    log.step("Filling email address...");
    await frame
      .locator('[id="HR_TBH_G_SCR_WK_TBH_G_LG_EDIT2$7"]')
      .fill(data.email, { timeout: 10_000 });
    log.step("Email address filled");
  }

  // --- Tracker Profile ID (I9) ---
  if (data.i9ProfileId) {
    // SELECTOR: verified v1.0 — textbox "Tracker Profile ID"
    log.step("Filling tracker profile ID...");
    await frame
      .getByRole("textbox", { name: "Tracker Profile ID" })
      .fill(data.i9ProfileId, { timeout: 10_000 });
    log.step("Tracker profile ID filled");
  }

  log.success("Personal data filled");
}

// ─── STEP 5: Comments + Initiator Comments ───

/**
 * Fill the Comments and Initiator Comments fields.
 *
 * SELECTOR: verified v1.0
 * - Comments: textarea id="HR_TBH_WRK_DESCRLONG_NOTES"
 * - Initiator Comments: textarea id="UC_SS_TRANSACT_COMMENTS"
 *
 * @param frame - PeopleSoft content iframe FrameLocator
 * @param comments - Comment text (same for both fields)
 */
export async function fillComments(
  frame: FrameLocator,
  comments: string,
): Promise<void> {
  log.step("Filling comments...");

  // SELECTOR: verified v1.0 — textarea "Comments" (exact ID)
  await frame
    .locator("#HR_TBH_WRK_DESCRLONG_NOTES")
    .fill(comments, { timeout: 10_000 });
  log.step("Comments filled");

  // SELECTOR: verified v1.0 — textarea "Initiator Comments" (exact ID)
  log.step("Filling initiator comments...");
  await frame
    .locator("#UC_SS_TRANSACT_COMMENTS")
    .fill(comments, { timeout: 10_000 });
  log.step("Initiator comments filled");

  log.success("Comments filled");
}

// ─── STEP 6: Click Job Data tab ───

/**
 * Click the Job Data tab to proceed to the next section.
 *
 * SELECTOR: verified v1.0 — tab "Job Data"
 *
 * @param page - Playwright page
 * @param frame - PeopleSoft content iframe FrameLocator
 */
export async function clickJobDataTab(
  page: Page,
  frame: FrameLocator,
): Promise<void> {
  log.step("Clicking Job Data tab...");

  // SELECTOR: verified v1.0 — tab "Job Data"
  await frame
    .getByRole("tab", { name: "Job Data" })
    .click({ timeout: 10_000 });
  await page.waitForTimeout(5_000);
  await waitForPeopleSoftProcessing(frame, 15_000);

  log.success("Job Data tab loaded");
}

// ─── STEP 6b: Fill Job Data tab fields ───

export interface JobDataInput {
  positionNumber: string;
  employeeClassification: string; // from CRM Appointment field (usually "5")
  compRateCode: string; // constant "UCHRLY"
  compensationRate: string; // pay rate from CRM (numeric, e.g. "17.75")
  expectedJobEndDate: string; // constant "06/30/2026"
}

/**
 * Fill Job Data tab fields: position number, employee classification,
 * comp rate code, compensation rate, expected job end date, and initiator comments.
 *
 * NOTE: Position number fill triggers a PeopleSoft page refresh which changes
 * the grid input IDs from $11 to $0. All grid selectors use $0 indices.
 *
 * SELECTOR: all verified v1.0 against live UCPath PeopleSoft.
 */
export async function fillJobData(
  page: Page,
  frame: FrameLocator,
  data: JobDataInput,
): Promise<void> {
  log.step("Filling Job Data...");

  // SELECTOR: verified v1.0 — textbox "Position Number" (exact to avoid "Reports To Position Number")
  log.step("Filling position number...");
  await frame
    .getByRole("textbox", { name: "Position Number", exact: true })
    .fill(data.positionNumber, { timeout: 10_000 });
  // Position number fill triggers PeopleSoft refresh — wait for it
  await page.waitForTimeout(5_000);
  await waitForPeopleSoftProcessing(frame, 15_000);
  log.step("Position number filled");

  // SELECTOR: verified v1.0 — textbox "Employee Classification"
  log.step("Filling employee classification...");
  await frame
    .getByRole("textbox", { name: "Employee Classification" })
    .fill(data.employeeClassification, { timeout: 10_000 });
  await page.waitForTimeout(2_000);
  log.step("Employee classification filled");

  // SELECTOR: verified v1.0 — Comp Rate Code (grid input, dynamic index after position refresh)
  // PeopleSoft IDs vary: SH_EDIT1$0, SH_PROMPT1$11, etc. Must target input not div.
  log.step("Filling comp rate code: UCHRLY...");
  const compRateInput = frame
    .locator('input[id="HR_TBH_G_SCR_WK_TBH_G_SH_EDIT1$0"]')
    .or(frame.locator('input[id="HR_TBH_G_SCR_WK_TBH_G_SH_PROMPT1$11"]'))
    .or(frame.locator('input[id="HR_TBH_G_SCR_WK_TBH_G_SH_PROMPT1$0"]'))
    .or(frame.locator('input[id="HR_TBH_G_SCR_WK_TBH_G_SH_EDIT1$11"]'));
  await compRateInput.first().fill(data.compRateCode, { timeout: 10_000 });
  await page.waitForTimeout(1_000);
  log.step("Comp rate code filled");

  // SELECTOR: verified v1.0 — Compensation Rate (grid input, dynamic index)
  // PeopleSoft IDs vary: SH_EDIT2$0, SH_NUM2$11, etc. Must target input not div.
  log.step("Filling compensation rate...");
  const compRateValue = frame
    .locator('input[id="HR_TBH_G_SCR_WK_TBH_G_SH_EDIT2$0"]')
    .or(frame.locator('input[id="HR_TBH_G_SCR_WK_TBH_G_SH_NUM2$11"]'))
    .or(frame.locator('input[id="HR_TBH_G_SCR_WK_TBH_G_SH_NUM2$0"]'))
    .or(frame.locator('input[id="HR_TBH_G_SCR_WK_TBH_G_SH_EDIT2$11"]'));
  await compRateValue.first().fill(data.compensationRate, { timeout: 10_000 });
  await page.waitForTimeout(1_000);
  log.step("Compensation rate filled");

  // SELECTOR: verified v1.0 — textbox "Expected Job End Date"
  log.step("Filling expected job end date...");
  await frame
    .getByRole("textbox", { name: "Expected Job End Date" })
    .fill(data.expectedJobEndDate, { timeout: 10_000 });
  log.step("Expected job end date filled");

  log.success("Job Data filled");
}

// ─── STEP 7: Click through remaining tabs ───

/**
 * Click the Earns Dist tab (no fields to fill, just visit it).
 */
export async function clickEarnsDistTab(
  page: Page,
  frame: FrameLocator,
): Promise<void> {
  log.step("Clicking Earns Dist tab...");
  await frame
    .getByRole("tab", { name: "Earns Dist" })
    .click({ timeout: 10_000 });
  await page.waitForTimeout(3_000);
  await waitForPeopleSoftProcessing(frame, 10_000);
  log.success("Earns Dist tab loaded");
}

/**
 * Click the Employee Experience tab (no fields to fill, just visit it).
 */
export async function clickEmployeeExperienceTab(
  page: Page,
  frame: FrameLocator,
): Promise<void> {
  log.step("Clicking Employee Experience tab...");
  await frame
    .getByRole("tab", { name: "Employee Experience" })
    .click({ timeout: 10_000 });
  await page.waitForTimeout(3_000);
  await waitForPeopleSoftProcessing(frame, 10_000);
  log.success("Employee Experience tab loaded");
}

// ─── STEP 8: Save and Submit ───

/**
 * Click Save and Submit to finalize the transaction.
 *
 * SELECTOR: verified v1.0 — button "Save and Submit"
 */
export async function clickSaveAndSubmit(
  page: Page,
  frame: FrameLocator,
): Promise<TransactionResult> {
  log.step("Clicking Save and Submit...");

  await frame
    .getByRole("button", { name: "Save and Submit" })
    .click({ timeout: 10_000 });
  await page.waitForTimeout(5_000);
  await waitForPeopleSoftProcessing(frame, 30_000);

  // Check for errors
  const errorLocator = frame.locator(".PSERROR, #ALERTMSG, .ps_alert-error");
  try {
    const errorCount = await errorLocator.count();
    if (errorCount > 0) {
      const errorText = await errorLocator.first().textContent({ timeout: 5_000 });
      log.error(`Save and Submit error: ${errorText ?? "Unknown error"}`);
      return { success: false, error: errorText ?? "Unknown error" };
    }
  } catch {
    // No error elements — good
  }

  log.success("Transaction saved and submitted");
  return { success: true };
}

// ─── Helpers ───

/**
 * Extract numeric pay rate from CRM wage string.
 * e.g. "$17.75 per hour" → "17.75"
 */
export function parsePayRate(wage: string): string {
  const match = wage.match(/\$?([\d.]+)/);
  return match?.[1] ?? wage;
}

/**
 * Build the comments string for a new hire transaction.
 *
 * When SSN is present:
 *   "New Dining Student Hire Effective {date}. Job number #{num}."
 *
 * When SSN is missing (international student):
 *   "New Dining Student Hire Effective {date}. Job number #{num}. International Student. NO SSN."
 */
export function buildCommentsText(
  effectiveDate: string,
  recruitmentNumber: string,
  hasSsn = true,
): string {
  const base = `New Dining Student Hire Effective ${effectiveDate}. Job number #${recruitmentNumber}.`;
  if (!hasSsn) {
    return `${base} International Student. NO SSN.`;
  }
  return base;
}
