import type { Page, FrameLocator } from "playwright";
import type { TransactionResult } from "./types.js";
import {
  waitForPeopleSoftProcessing,
  navigateToSmartHR,
  dismissModalMask,
} from "./navigate.js";
import {
  smartHR,
  personalData as personalDataSelectors,
  comments as commentsSelectors,
  jobData as jobDataSelectors,
  getContentFrame,
} from "./selectors.js";
import { log } from "../../utils/log.js";

// ─── STEP 1: Navigate sidebar → Smart HR Templates → Smart HR Transactions ───

/**
 * Click "Smart HR Templates" in the sidebar to expand it, then click
 * "Smart HR Transactions" child link. Loads the transaction form in the iframe.
 *
 * After clicking, must collapse navigation sidebar so it doesn't block
 * buttons in the iframe (PeopleSoft overlay issue).
 */
export async function clickSmartHRTransactions(page: Page): Promise<void> {
  log.step("Clicking Smart HR Templates in sidebar...");

  await smartHR.sidebarTemplatesLink(page).click({ timeout: 10_000 });
  await page.waitForTimeout(1_000);

  log.step("Clicking Smart HR Transactions...");
  await smartHR.sidebarTransactionsLink(page).click({ timeout: 10_000 });
  await page.waitForTimeout(5_000);
  await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});

  // Collapse the sidebar navigation to prevent overlay blocking iframe buttons
  log.step("Collapsing sidebar navigation...");
  try {
    await smartHR.sidebarNavigationToggle(page).click({ timeout: 5_000 });
    await page.waitForTimeout(1_000);
  } catch {
    log.step("Sidebar collapse failed (non-fatal) — may already be collapsed");
  }

  log.success("Smart HR Transactions page loaded");
}

// ─── STEP 2: Select template + effective date + Create Transaction ───

/**
 * Fill the template input with e.g. UC_FULL_HIRE.
 */
export async function selectTemplate(
  frame: FrameLocator,
  templateId: string,
): Promise<void> {
  log.step(`Selecting template: ${templateId}`);

  await smartHR.templateInput(frame).fill(templateId, { timeout: 10_000 });
  log.step(`Template input filled: ${templateId}`);

  log.step(`Template: "${templateId}" selected for this transaction`);
  log.success(`Template "${templateId}" selected`);
}

/**
 * Fill the effective date field.
 *
 * @param frame - PeopleSoft content iframe FrameLocator
 * @param date - Date string in MM/DD/YYYY format
 */
export async function enterEffectiveDate(
  frame: FrameLocator,
  date: string,
): Promise<void> {
  log.step(`Entering effective date: ${date}`);

  await smartHR.effectiveDateInput(frame).fill(date, { timeout: 10_000 });
  log.step("Effective date filled");

  log.success("Effective date entered");
}

/**
 * Click the Create Transaction button and wait for the form to load.
 *
 * @param frame - PeopleSoft content iframe FrameLocator
 * @returns TransactionResult indicating success or failure
 */
export async function clickCreateTransaction(
  page: Page,
  frame: FrameLocator,
): Promise<TransactionResult> {
  log.step("Clicking Create Transaction...");

  await smartHR.createTransactionButton(frame).click({ timeout: 10_000 });

  // Wait for PeopleSoft server round-trip
  log.step("Waiting for PeopleSoft to process transaction creation...");
  await page.waitForTimeout(5_000);
  await waitForPeopleSoftProcessing(frame, 30_000);

  // Check for errors
  const errorLocator = smartHR.errorBanner(frame);
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

  await smartHR
    .reasonCodeSelect(frame)
    .selectOption(reasonLabel, { timeout: 10_000 });
  log.step(`Reason: "${reasonLabel}" selected`);
  log.step("Reason code selected");

  await page.waitForTimeout(2_000);

  // Click Continue — may need force or JS due to sidebar overlay
  log.step("Clicking Continue...");
  try {
    await smartHR.continueButton(frame).click({ timeout: 5_000 });
  } catch {
    // Fallback: use PeopleSoft submitAction if sidebar overlay blocks click
    log.step("Regular click blocked — using JS submitAction...");
    await frame.locator("body").evaluate(() => { // allow-inline-selector -- root for JS-eval-only path (no click/fill)
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
 * Fields: legal first/last/middle name, preferred first/last/middle name
 * (mirrored from legal when no lived name supplied), DOB, national ID (SSN),
 * address, phone (Mobile - Personal), email (Home), tracker profile ID.
 */
export async function fillPersonalData(
  page: Page,
  frame: FrameLocator,
  data: PersonalDataInput,
): Promise<void> {
  log.step("Filling personal data...");

  // --- Legal Name ---
  log.step("Filling legal first name...");
  await personalDataSelectors
    .legalFirstName(frame)
    .fill(data.firstName, { timeout: 10_000 });
  log.step("Legal first name filled");

  log.step("Filling legal last name...");
  await personalDataSelectors
    .legalLastName(frame)
    .fill(data.lastName, { timeout: 10_000 });
  log.step("Legal last name filled");

  if (data.middleName) {
    log.step("Filling legal middle name...");
    await personalDataSelectors
      .legalMiddleName(frame)
      .fill(data.middleName, { timeout: 10_000 });
    log.step("Legal middle name filled");
  }

  // --- Preferred / Lived Name (mirror legal names when no lived name available) ---
  log.step("Filling preferred first name...");
  await personalDataSelectors
    .preferredFirstName(frame)
    .fill(data.firstName, { timeout: 10_000 });
  log.step("Preferred first name filled");

  log.step("Filling preferred last name...");
  await personalDataSelectors
    .preferredLastName(frame)
    .fill(data.lastName, { timeout: 10_000 });
  log.step("Preferred last name filled");

  if (data.middleName) {
    log.step("Filling preferred middle name...");
    await personalDataSelectors
      .preferredMiddleName(frame)
      .fill(data.middleName, { timeout: 10_000 });
    log.step("Preferred middle name filled");
  }

  // --- Date of Birth ---
  log.step("Filling date of birth...");
  await personalDataSelectors
    .dateOfBirth(frame)
    .fill(data.dob, { timeout: 10_000 });
  log.step("DOB filled");

  // --- National ID (SSN) ---
  if (data.ssn) {
    log.step("Filling national ID...");
    await personalDataSelectors
      .nationalId(frame)
      .fill(data.ssn, { timeout: 10_000 });
    log.step("National ID filled");
  } else {
    log.step("No SSN — skipping national ID field");
  }

  // --- Address ---
  log.step("Filling address...");
  await personalDataSelectors
    .addressLine1(frame)
    .fill(data.address, { timeout: 10_000 });
  log.step("Address filled");

  if (data.city) {
    await personalDataSelectors.city(frame).fill(data.city, { timeout: 10_000 });
    log.step("City filled");
  }

  if (data.state) {
    await personalDataSelectors
      .state(frame)
      .fill(data.state, { timeout: 10_000 });
    log.step("State filled");
  }

  if (data.postalCode) {
    await personalDataSelectors
      .postalCode(frame)
      .fill(data.postalCode, { timeout: 10_000 });
    log.step("Postal code filled");
  }

  // --- Phone ---
  if (data.phone) {
    log.step("Selecting phone type: Mobile - Personal...");
    await personalDataSelectors
      .phoneTypeSelect(frame)
      .selectOption("Mobile - Personal", { timeout: 10_000 });
    await page.waitForTimeout(3_000);
    await waitForPeopleSoftProcessing(frame);
    log.step("Phone type selected");

    log.step("Filling phone number...");
    await personalDataSelectors
      .phoneNumberInput(frame)
      .fill(data.phone, { timeout: 10_000 });
    log.step("Phone number filled");

    log.step("Checking Preferred checkbox...");
    await personalDataSelectors
      .phonePreferredCheckbox(frame)
      .check({ timeout: 5_000 });
    log.step("Preferred checkbox checked");
  }

  // --- Email ---
  if (data.email) {
    log.step("Selecting email type: Home...");
    await personalDataSelectors
      .emailTypeSelect(frame)
      .selectOption("Home", { timeout: 10_000 });
    await page.waitForTimeout(3_000);
    await waitForPeopleSoftProcessing(frame);
    log.step("Email type selected");

    log.step("Filling email address...");
    await personalDataSelectors
      .emailAddressInput(frame)
      .fill(data.email, { timeout: 10_000 });
    log.step("Email address filled");
  }

  // --- Tracker Profile ID (I9) ---
  if (data.i9ProfileId) {
    log.step("Filling tracker profile ID...");
    await personalDataSelectors
      .trackerProfileIdInput(frame)
      .fill(data.i9ProfileId, { timeout: 10_000 });
    log.step("Tracker profile ID filled");
  }

  log.success("Personal data filled");
}

// ─── STEP 5: Comments + Initiator Comments ───

/**
 * Fill the Comments and Initiator Comments fields.
 *
 * @param frame - PeopleSoft content iframe FrameLocator
 * @param comments - Comment text (same for both fields)
 */
export async function fillComments(
  frame: FrameLocator,
  commentsText: string,
): Promise<void> {
  log.step("Filling comments...");

  await commentsSelectors
    .commentsTextarea(frame)
    .fill(commentsText, { timeout: 10_000 });
  log.step("Comments filled");

  log.step("Filling initiator comments...");
  await commentsSelectors
    .initiatorCommentsTextarea(frame)
    .fill(commentsText, { timeout: 10_000 });
  log.step("Initiator comments filled");

  log.success("Comments filled");
}

// ─── STEP 6: Click Job Data tab ───

/**
 * Click the Job Data tab to proceed to the next section.
 *
 * @param page - Playwright page
 * @param frame - PeopleSoft content iframe FrameLocator
 */
export async function clickJobDataTab(
  page: Page,
  frame: FrameLocator,
): Promise<void> {
  log.step("Clicking Job Data tab...");
  await dismissModalMask(page);

  await smartHR.tab.jobData(frame).click({ timeout: 10_000 });
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
 * comp rate code, compensation rate, expected job end date.
 *
 * NOTE: Position number fill triggers a PeopleSoft page refresh which changes
 * the grid input IDs from $11 to $0. Selectors in the registry use fallback
 * chains (`.or()`) that cover both states.
 */
export async function fillJobData(
  page: Page,
  frame: FrameLocator,
  data: JobDataInput,
): Promise<void> {
  log.step("Filling Job Data...");

  log.step("Filling position number...");
  await jobDataSelectors
    .positionNumberInput(frame)
    .fill(data.positionNumber, { timeout: 10_000 });
  // Position number fill triggers PeopleSoft refresh — wait for it
  await page.waitForTimeout(5_000);
  await waitForPeopleSoftProcessing(frame, 15_000);
  log.step("Position number filled — page refreshed, grid indices may have changed");
  log.step("Position number filled");

  log.step("Filling employee classification...");
  await jobDataSelectors
    .employeeClassificationInput(frame)
    .fill(data.employeeClassification, { timeout: 10_000 });
  await page.waitForTimeout(2_000);
  log.step("Employee classification filled");

  log.step("Filling comp rate code: UCHRLY...");
  await jobDataSelectors
    .compRateCodeInput(frame)
    .first()
    .fill(data.compRateCode, { timeout: 10_000 });
  await page.waitForTimeout(1_000);
  // Blur to trigger PeopleSoft validation
  await page.keyboard.press("Tab");
  await page.waitForTimeout(2_000);
  log.step(`Comp Rate Code: filled "${data.compRateCode}"`);

  log.step("Filling compensation rate...");
  await jobDataSelectors
    .compensationRateInput(frame)
    .first()
    .fill(data.compensationRate, { timeout: 10_000 });
  await page.waitForTimeout(1_000);
  // Blur to trigger PeopleSoft validation + auto-fill Compensation Frequency
  await page.keyboard.press("Tab");
  await page.waitForTimeout(2_000);
  log.step(`Compensation Rate: $${data.compensationRate} filled`);

  // Fill Compensation Frequency ("H" for Hourly) — required field, sometimes not auto-populated
  log.step("Filling compensation frequency: H (Hourly)...");
  const compFreq = jobDataSelectors.compensationFrequencyInput(frame);
  const freqValue = await compFreq.inputValue().catch(() => "");
  if (!freqValue || freqValue.trim() === "") {
    await compFreq.fill("H", { timeout: 10_000 });
    await page.waitForTimeout(1_000);
    await page.keyboard.press("Tab");
    await page.waitForTimeout(2_000);
    log.step("Compensation Frequency filled: H");
  } else {
    log.step(`Compensation Frequency already set: ${freqValue}`);
  }

  log.step("Filling expected job end date...");
  await jobDataSelectors
    .expectedJobEndDateInput(frame)
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
  await dismissModalMask(page);
  await smartHR.tab.earnsDist(frame).click({ timeout: 10_000 });
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
  await dismissModalMask(page);
  await smartHR.tab.employeeExperience(frame).click({ timeout: 10_000 });
  await page.waitForTimeout(3_000);
  await waitForPeopleSoftProcessing(frame, 10_000);
  log.success("Employee Experience tab loaded");
}

// ─── STEP 8: Save and Submit ───

/**
 * @param employeeName - Full name (e.g. "Ivette Lima Montes") used to find the
 *   transaction in the Transactions in Progress list after submit.
 */
export async function clickSaveAndSubmit(
  page: Page,
  frame: FrameLocator,
  employeeName?: string,
): Promise<TransactionResult> {
  log.step("Clicking Save and Submit...");
  await dismissModalMask(page);

  await smartHR.saveAndSubmitButton(frame).click({ timeout: 10_000 });
  await page.waitForTimeout(5_000);
  await waitForPeopleSoftProcessing(frame, 30_000);

  // Check for errors
  const errorLocator = smartHR.errorBanner(frame);
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

  // Mapped via playwright-cli 2026-04-01:
  // Flow to extract transaction number:
  //   1. Confirmation page appears → click OK
  //   2. Back on Smart HR Transactions list → click employee name link
  //   3. Enter Transaction Details → click Continue
  //   4. Enter Transaction Information → "Transaction ID:" shows actual number (e.g. T002114817)
  let transactionNumber = "";
  try {
    // Step 1: Click OK on confirmation page
    const okButton = smartHR.confirmationOkButton(frame);
    await okButton.waitFor({ state: "visible", timeout: 15_000 }).catch(() => {});
    await page.waitForTimeout(2_000);

    if ((await okButton.count()) > 0) {
      log.step("Clicking OK on confirmation page...");
      await okButton.click({ timeout: 5_000 });
      await page.waitForTimeout(3_000);

      // Step 2: Re-navigate same way as initial: URL to HR Tasks, then sidebar click
      log.step("Re-navigating to Smart HR Transactions...");
      await navigateToSmartHR(page);
      await clickSmartHRTransactions(page);
      await page.waitForTimeout(3_000);
      const txnFrame = getContentFrame(page);

      if (employeeName) {
        // Search for exact name link (e.g. "Ivette Lima Montes"). PeopleSoft
        // shows first name + last name as a link. Dynamic name → inline.
        const nameLink = txnFrame.getByRole("link", { name: employeeName }); // allow-inline-selector
        if ((await nameLink.count()) > 0) {
          log.step(`Clicking employee: ${employeeName}`);
          await nameLink.first().click({ timeout: 5_000 });
        } else {
          // Try partial match — last name only. Dynamic regex → inline.
          const lastName = employeeName.split(",")[0]?.trim() ?? employeeName.split(" ").pop() ?? "";
          const partialLink = txnFrame.getByRole("link", { name: new RegExp(lastName, "i") }); // allow-inline-selector
          if ((await partialLink.count()) > 0) {
            log.step(`Clicking employee (partial match): ${lastName}`);
            await partialLink.last().click({ timeout: 5_000 });
          } else {
            log.step(`Employee link not found: ${employeeName}`);
          }
        }
        await page.waitForTimeout(5_000);

        // Step 3: Click Continue on transaction details page
        const continueBtn = smartHR.continueButton(txnFrame);
        if ((await continueBtn.count()) > 0) {
          await continueBtn.click({ timeout: 5_000 });
          await page.waitForTimeout(8_000);

          // Step 4: Extract "Transaction ID: T002XXXXXX" from the re-opened form
          const bodyText = await txnFrame.locator("body").innerText({ timeout: 5_000 }).catch(() => ""); // allow-inline-selector -- body innerText readback for regex scrape
          const tMatch = bodyText.match(/Transaction ID:\s*(T\d+)/)
            ?? bodyText.match(/Transaction:\s*(T\d+)/i);
          if (tMatch) {
            transactionNumber = tMatch[1];
            log.step(`Transaction number: ${transactionNumber}`);
          }
        }
      }
    }

    if (!transactionNumber) {
      log.step("Transaction number not found — will need manual entry");
    }
  } catch (e) {
    log.step(`Transaction number extraction failed: ${e instanceof Error ? e.message : e}`);
  }

  return { success: true, transactionNumber };
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
