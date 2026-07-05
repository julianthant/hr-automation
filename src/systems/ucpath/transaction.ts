import type { Page, FrameLocator, Locator } from "playwright";
import { setTimeout as sleep } from "node:timers/promises";
import type { TransactionResult } from "./types.js";
import {
  waitForPeopleSoftProcessing,
  navigateToSmartHR,
  collapseSidebar,
  dismissPeopleSoftDialog,
} from "./navigate.js";
import {
  smartHR,
  hrTasks,
  personalData as personalDataSelectors,
  comments as commentsSelectors,
  jobData as jobDataSelectors,
  getContentFrame,
} from "./selectors.js";
import { log } from "../../utils/log.js";
import { dismissPeopleSoftModalMask } from "../common/modal.js";
import { clickIfPresent, safeClick, safeFill } from "../common/index.js";

// ─── Transaction outcome verification (error banner vs success marker) ───────

/**
 * Pure decision for one poll tick of {@link waitForTransactionOutcome}: given
 * whether the error banner and the success marker are currently visible,
 * classify this tick. An error banner takes precedence over a success marker (a
 * PeopleSoft form can briefly paint both mid-render; the error banner is the
 * authoritative failure signal). Unit-pinned.
 */
export function classifyOutcomeSignals(
  errorVisible: boolean,
  successVisible: boolean,
): "error" | "success" | "pending" {
  if (errorVisible) return "error";
  if (successVisible) return "success";
  return "pending";
}

/**
 * Poll for a DEFINITIVE transaction outcome — the error banner appearing OR a
 * success marker (a positive next-page element) appearing — instead of sampling
 * `errorBanner.count()` ONCE right after a fixed sleep. A banner that renders
 * late read `count() === 0` at that single instant and wrongly returned
 * `{ success: true }` for a transaction that actually errored. Returns
 * `"timeout"` when neither resolves in the window so callers can fall back to
 * the legacy point-in-time check (behavior never regresses below today's).
 */
export async function waitForTransactionOutcome(
  errorLocator: Locator,
  successLocator: Locator,
  opts: { timeoutMs?: number; pollMs?: number } = {},
): Promise<"error" | "success" | "timeout"> {
  const { timeoutMs = 20_000, pollMs = 500 } = opts;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const errorVisible = (await errorLocator.count().catch(() => 0)) > 0;
    const successVisible = await successLocator.first().isVisible().catch(() => false);
    const signal = classifyOutcomeSignals(errorVisible, successVisible);
    if (signal !== "pending") return signal;
    await sleep(pollMs);
  }
  return "timeout";
}

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

  await safeClick(hrTasks.smartHRTemplatesLink(page), {
    timeout: 10_000,
    label: "ucpath smart hr templates sidebar link",
  });
  await page.waitForTimeout(1_000);

  log.step("Clicking Smart HR Transactions...");
  await safeClick(hrTasks.smartHRTransactionsLink(page), {
    timeout: 10_000,
    label: "ucpath smart hr transactions sidebar link",
  });
  await page.waitForTimeout(5_000);
  await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});

  // Collapse the sidebar navigation to prevent overlay blocking iframe buttons
  log.step("Collapsing sidebar navigation...");
  await collapseSidebar(page);

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

  await safeFill(smartHR.templateInput(frame), templateId, {
    timeout: 10_000,
    label: "ucpath smart hr template input",
  });

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

  await safeFill(smartHR.effectiveDateInput(frame), date, {
    timeout: 10_000,
    label: "ucpath smart hr effective date",
  });

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

  await safeClick(smartHR.createTransactionButton(frame), {
    timeout: 10_000,
    label: "ucpath create transaction button",
  });

  // Wait for PeopleSoft server round-trip
  log.step("Waiting for PeopleSoft to process transaction creation...");
  await page.waitForTimeout(5_000);
  await waitForPeopleSoftProcessing(frame, 30_000);

  // Decide on a DEFINITIVE outcome — error banner vs the reason-code page (the
  // next step's dropdown) rendering — rather than sampling errorBanner.count()
  // once (a late-rendering banner read 0 at that instant and returned success
  // for a failed create). On timeout, fall back to the legacy point-in-time
  // check so behavior never regresses.
  const errorLocator = smartHR.errorBanner(frame);
  const successMarker = smartHR.reasonCodeSelect(frame);
  const outcome = await waitForTransactionOutcome(errorLocator, successMarker, { timeoutMs: 20_000 });
  if (outcome === "error" || (outcome === "timeout" && (await errorLocator.count().catch(() => 0)) > 0)) {
    const errorText = await errorLocator.nth(0).textContent({ timeout: 5_000 }).catch(() => null);
    log.error(`Transaction creation error: ${errorText ?? "Unknown error"}`);
    return { success: false, error: errorText ?? "Unknown error" };
  }

  // A timeout is NOT a confirmation. If the poll window expired with no error
  // banner, do one last direct check of the reason-code page itself before
  // reporting success — a PeopleSoft hang with no visible error banner must
  // not be reported as a successful transaction creation.
  if (outcome === "timeout") {
    const confirmed = await successMarker.first().isVisible().catch(() => false);
    if (!confirmed) {
      throw new Error(
        "Create Transaction timed out with no error banner and no reason-code page " +
        "confirmation — PeopleSoft's outcome is unknown, refusing to report success.",
      );
    }
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

  // Dismiss pt_modalMask raised by the dropdown round-trip before clicking Continue.
  // Without this the mask intercepts the click for the full 5s timeout and the
  // JS fallback below has to fire every time (2026-06-17).
  await dismissPeopleSoftModalMask(page);

  // Click Continue — may need force or JS due to sidebar overlay
  log.step("Clicking Continue...");
  try {
    await safeClick(smartHR.continueButton(frame), {
      timeout: 5_000,
      label: "ucpath reason continue button",
    });
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
  await safeFill(personalDataSelectors.legalFirstName(frame), data.firstName, {
    timeout: 10_000,
    label: "ucpath legal first name",
  });

  log.step("Filling legal last name...");
  await safeFill(personalDataSelectors.legalLastName(frame), data.lastName, {
    timeout: 10_000,
    label: "ucpath legal last name",
  });

  if (data.middleName) {
    log.step("Filling legal middle name...");
    await safeFill(personalDataSelectors.legalMiddleName(frame), data.middleName, {
      timeout: 10_000,
      label: "ucpath legal middle name",
    });
  }

  // --- Preferred / Lived Name (mirror legal names when no lived name available) ---
  log.step("Filling preferred first name...");
  await safeFill(personalDataSelectors.preferredFirstName(frame), data.firstName, {
    timeout: 10_000,
    label: "ucpath preferred first name",
  });

  log.step("Filling preferred last name...");
  await safeFill(personalDataSelectors.preferredLastName(frame), data.lastName, {
    timeout: 10_000,
    label: "ucpath preferred last name",
  });

  if (data.middleName) {
    log.step("Filling preferred middle name...");
    await safeFill(personalDataSelectors.preferredMiddleName(frame), data.middleName, {
      timeout: 10_000,
      label: "ucpath preferred middle name",
    });
  }

  // --- Date of Birth ---
  log.step("Filling date of birth...");
  await safeFill(personalDataSelectors.dateOfBirth(frame), data.dob, {
    timeout: 10_000,
    label: "ucpath date of birth",
  });

  // --- National ID (SSN) ---
  if (data.ssn) {
    log.step("Filling national ID...");
    await safeFill(personalDataSelectors.nationalId(frame), data.ssn, {
      timeout: 10_000,
      label: "ucpath national id",
    });
  } else {
    log.step("No SSN — skipping national ID field");
  }

  // --- Address ---
  log.step("Filling address...");
  await safeFill(personalDataSelectors.addressLine1(frame), data.address, {
    timeout: 10_000,
    label: "ucpath address line 1",
  });

  if (data.city) {
    await safeFill(personalDataSelectors.city(frame), data.city, {
      timeout: 10_000,
      label: "ucpath city",
    });
  }

  if (data.state) {
    await safeFill(personalDataSelectors.state(frame), data.state, {
      timeout: 10_000,
      label: "ucpath state",
    });
  }

  if (data.postalCode) {
    await safeFill(personalDataSelectors.postalCode(frame), data.postalCode, {
      timeout: 10_000,
      label: "ucpath postal code",
    });
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
    await safeFill(personalDataSelectors.phoneNumberInput(frame), data.phone, {
      timeout: 10_000,
      label: "ucpath phone number",
    });

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
    await safeFill(personalDataSelectors.emailAddressInput(frame), data.email, {
      timeout: 10_000,
      label: "ucpath email address",
    });
  }

  // --- Tracker Profile ID (I9) ---
  if (data.i9ProfileId) {
    log.step("Filling tracker profile ID...");
    await safeFill(personalDataSelectors.trackerProfileIdInput(frame), data.i9ProfileId, {
      timeout: 10_000,
      label: "ucpath tracker profile id",
    });
  }

  log.success("Personal data filled");
}

// ─── STEP 5: Comments + Initiator Comments ───

/**
 * Fill the Comments and Initiator Comments fields.
 *
 * @param page - Playwright page (for dismissing the pt_modalMask overlay)
 * @param frame - PeopleSoft content iframe FrameLocator
 * @param comments - Comment text (same for both fields)
 */
export async function fillComments(
  page: Page,
  frame: FrameLocator,
  commentsText: string,
): Promise<void> {
  log.step("Filling comments...");

  // Dismiss pt_modalMask that can linger after tab switches / round-trips
  // before attempting to fill the textarea (2026-06-17).
  await dismissPeopleSoftModalMask(page);

  await safeFill(commentsSelectors.commentsTextarea(frame), commentsText, {
    timeout: 10_000,
    label: "ucpath comments textarea",
  });

  log.step("Filling initiator comments...");
  await safeFill(commentsSelectors.initiatorCommentsTextarea(frame), commentsText, {
    timeout: 10_000,
    label: "ucpath initiator comments textarea",
  });

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
  await dismissPeopleSoftModalMask(page);

  await safeClick(smartHR.tab.jobData(frame), {
    timeout: 10_000,
    label: "ucpath job data tab",
  });
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
  await safeFill(jobDataSelectors.positionNumberInput(frame), data.positionNumber, {
    timeout: 10_000,
    label: "ucpath position number",
  });
  // Position number fill triggers PeopleSoft refresh — wait for it
  await page.waitForTimeout(5_000);
  await waitForPeopleSoftProcessing(frame, 15_000);
  log.step("Position number filled — page refreshed, grid indices may have changed");

  log.step("Filling employee classification...");
  await safeFill(jobDataSelectors.employeeClassificationInput(frame), data.employeeClassification, {
    timeout: 10_000,
    label: "ucpath employee classification",
  });
  await page.waitForTimeout(2_000);

  log.step("Filling comp rate code: UCHRLY...");
  await safeFill(jobDataSelectors.compRateCodeInput(frame), data.compRateCode, {
    timeout: 10_000,
    label: "ucpath comp rate code",
  });
  await page.waitForTimeout(1_000);
  // Blur to trigger PeopleSoft validation
  await page.keyboard.press("Tab");
  await page.waitForTimeout(2_000);

  log.step("Filling compensation rate...");
  await safeFill(jobDataSelectors.compensationRateInput(frame), data.compensationRate, {
    timeout: 10_000,
    label: "ucpath compensation rate",
  });
  await page.waitForTimeout(1_000);
  // Blur to trigger PeopleSoft validation + auto-fill Compensation Frequency
  await page.keyboard.press("Tab");
  await page.waitForTimeout(2_000);

  // Fill Compensation Frequency ("H" for Hourly) — required field, sometimes not auto-populated
  log.step("Filling compensation frequency: H (Hourly)...");
  const compFreq = jobDataSelectors.compensationFrequencyInput(frame);
  const freqValue = await compFreq.inputValue().catch(() => "");
  if (!freqValue || freqValue.trim() === "") {
    await safeFill(compFreq, "H", {
      timeout: 10_000,
      label: "ucpath compensation frequency",
    });
    await page.waitForTimeout(1_000);
    await page.keyboard.press("Tab");
    await page.waitForTimeout(2_000);
  } else {
    log.step(`Compensation Frequency already set: ${freqValue}`);
  }

  log.step("Filling expected job end date...");
  await safeFill(jobDataSelectors.expectedJobEndDateInput(frame), data.expectedJobEndDate, {
    timeout: 10_000,
    label: "ucpath expected job end date",
  });

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
  await clickTransactionTab(page, frame, "Earns Dist", smartHR.tab.earnsDist(frame));
}

/**
 * Click the Employee Experience tab (no fields to fill, just visit it).
 */
export async function clickEmployeeExperienceTab(
  page: Page,
  frame: FrameLocator,
): Promise<void> {
  await clickTransactionTab(page, frame, "Employee Experience", smartHR.tab.employeeExperience(frame));
}

async function clickTransactionTab(
  page: Page,
  frame: FrameLocator,
  tabName: string,
  locator: Locator,
): Promise<void> {
  log.step(`Clicking ${tabName} tab...`);
  await dismissPeopleSoftModalMask(page);
  await safeClick(locator, {
    timeout: 10_000,
    label: `ucpath ${tabName.toLowerCase()} tab`,
  });
  await page.waitForTimeout(3_000);
  await waitForPeopleSoftProcessing(frame, 10_000);
  log.success(`${tabName} tab loaded`);
}

// ─── STEP 8: Save and Submit ───

export async function waitForSaveEnabled(
  btn: Locator,
  opts: { timeoutMs?: number; pollMs?: number } = {},
): Promise<void> {
  const { timeoutMs = 15_000, pollMs = 500 } = opts;
  await btn.waitFor({ state: "visible", timeout: Math.min(timeoutMs, 10_000) }).catch(() => {});
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await btn.isEnabled().catch(() => false)) return;
    await sleep(pollMs);
  }
  throw new Error(
    "Save and Submit remained disabled after 15 s — tab walk likely incomplete (visit all 4 Smart HR tabs + fill Initiator Comments + re-click Personal Data before save)",
  );
}

/**
 * @param employeeId - EID used to match the transaction row by its Person
 *   ID column after submit. Required to read back the transaction number;
 *   if omitted, the post-submit txn# readback is skipped. Onboarding
 *   omits it because new-hire rows show Person ID "NEW" until the
 *   transaction is fully processed — no EID exists to match against.
 */
export async function clickSaveAndSubmit(
  page: Page,
  frame: FrameLocator,
  employeeId?: string,
): Promise<TransactionResult> {
  log.step("Clicking Save and Submit...");
  await dismissPeopleSoftModalMask(page);

  const btn = smartHR.saveAndSubmitButton(frame);
  // Any ad-hoc save-disabled screenshot lives on the handler side via
  // ctx.screenshot() — keeping this module ctx-free means separations /
  // onboarding / etc can attach their own labeling + kind without
  // teaching this low-level function about the kernel.
  await waitForSaveEnabled(btn, { timeoutMs: 15_000 });
  await safeClick(btn, {
    timeout: 10_000,
    label: "ucpath save and submit button",
  });
  await page.waitForTimeout(5_000);
  await waitForPeopleSoftProcessing(frame, 30_000);

  // Decide on a DEFINITIVE outcome — error banner vs the post-submit confirmation
  // OK dialog — rather than sampling errorBanner.count() once after a fixed sleep
  // (a banner that renders late read 0 at that instant and returned
  // { success: true } for a submit that actually errored). On timeout, fall back
  // to the legacy point-in-time check so behavior never regresses. On success the
  // confirmation OK is already visible, so the txn# readback flow below proceeds
  // immediately.
  const errorLocator = smartHR.errorBanner(frame);
  const okMarker = smartHR.confirmationOkButton(frame);
  const outcome = await waitForTransactionOutcome(errorLocator, okMarker, { timeoutMs: 20_000 });
  if (outcome === "error" || (outcome === "timeout" && (await errorLocator.count().catch(() => 0)) > 0)) {
    const errorText = await errorLocator.nth(0).textContent({ timeout: 5_000 }).catch(() => null);
    log.error(`Save and Submit error: ${errorText ?? "Unknown error"}`);
    return { success: false, error: errorText ?? "Unknown error" };
  }

  // A timeout is NOT a confirmation. If the poll window expired with no error
  // banner, do one last direct check of the confirmation OK button itself
  // before reporting success — a PeopleSoft hang with no visible error banner
  // must not be reported as a successful save/submit (this is the real UCPath
  // termination/hire mutation).
  if (outcome === "timeout") {
    const confirmed = await okMarker.first().isVisible().catch(() => false);
    if (!confirmed) {
      throw new Error(
        `Save and Submit timed out with no error banner and no confirmation OK dialog` +
        `${employeeId ? ` (EID ${employeeId})` : ""} — PeopleSoft's outcome is unknown, ` +
        "refusing to report success.",
      );
    }
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

    if (await clickIfPresent(okButton, {
      timeout: 5_000,
      label: "ucpath save confirmation ok button",
    })) {
      log.step("Clicked OK on confirmation page...");
      await page.waitForTimeout(3_000);

      if (employeeId) {
        transactionNumber = await readLatestTransactionNumber(page, employeeId);
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

/**
 * Re-navigate to Smart HR Transactions, find the employee's most recent
 * transaction row, and extract its `T######` transaction number.
 *
 * Used both by `clickSaveAndSubmit` (immediately after OK on the confirmation
 * dialog) and by retry/recovery paths that know a transaction was submitted
 * but didn't capture the number on the first pass. Returns empty string when
 * the lookup fails — callers should treat that as "couldn't read back",
 * never as "no transaction exists".
 *
 * Row match is by the Person ID column (EID) — deterministic and
 * unambiguous. Name matching was removed because upstream records (Kuali)
 * can disagree with UCPath's stored display name (nicknames like "Aki" vs
 * "Akitsugu", Last/First column confusion, spelling variants) and a
 * name-miss here cascades to "submit with no txn#" → retry → duplicate.
 *
 * Polls the Transactions list for up to 15s — the newly-submitted
 * transaction takes a beat to appear.
 */
export async function readLatestTransactionNumber(
  page: Page,
  employeeId: string,
): Promise<string> {
  log.step("Re-navigating to Smart HR Transactions...");
  await navigateToSmartHR(page);
  await clickSmartHRTransactions(page);
  // clickSmartHRTransactions already awaits networkidle — no extra sleep needed.
  const txnFrame = getContentFrame(page);

  if (!employeeId) {
    log.warn("[Txn Readback] No EID provided — cannot locate the submitted transaction");
    return "";
  }

  const deadline = Date.now() + 15_000;
  let linkText = "";
  while (!linkText && Date.now() < deadline) {
    // This poll is a best-effort post-submit readback (the transaction was
    // already submitted) — retry on a transient scan error the same as a
    // "not found yet" tick, rather than aborting the poll early. Unlike
    // findExistingTerminationTransaction's pre-submit duplicate guard, a
    // failure here does not risk a duplicate create.
    try {
      linkText = (await findTransactionRowLinkByEid(txnFrame, employeeId)) ?? "";
    } catch (e) {
      log.warn(`[Txn Readback] Row scan threw while polling for EID ${employeeId} — retrying: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (!linkText) await page.waitForTimeout(1_500);
  }
  if (!linkText) {
    log.step(`Transaction row for EID ${employeeId} not found after 15s poll`);
    return "";
  }

  log.step(`Clicking transaction row for EID ${employeeId} (link='${linkText}')`);
  const link = txnFrame.getByRole("link", { name: linkText }); // allow-inline-selector -- dynamic matched-name link
  if (!(await clickIfPresent(link, {
    timeout: 5_000,
    label: "ucpath transaction row link",
  }))) {
    log.warn(`[Txn Readback] Row matched but link '${linkText}' disappeared before click`);
    return "";
  }
  // Wait for PeopleSoft to render the transaction detail page.
  await waitForPeopleSoftProcessing(txnFrame, 15_000);
  await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});

  // Click Continue on transaction details page
  const continueBtn = smartHR.continueButton(txnFrame);
  if (!(await clickIfPresent(continueBtn, {
    timeout: 5_000,
    label: "ucpath transaction detail continue button",
  }))) return "";
  // Wait for PeopleSoft to load the Enter Transaction Information page.
  await waitForPeopleSoftProcessing(txnFrame, 15_000);
  await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});

  // Extract "Transaction ID: T002XXXXXX" from the re-opened form.
  // The ID is below the comments/save area on the readback page, so
  // scroll there first. This also leaves the page positioned where the
  // workflow-level audit screenshot can show the T-number.
  await scrollToTransactionReadbackArea(txnFrame);
  const txnNumber = await readTxnNumberFromDetailPage(txnFrame);
  if (txnNumber) {
    log.step(`Transaction number: ${txnNumber}`);
    return txnNumber;
  }
  return "";
}

/** Result returned by `findExistingTerminationTransaction`. */
export interface ExistingTerminationResult {
  /** Transaction number if a matching row was found; `null` otherwise. */
  txnNumber: string | null;
  /**
   * `true` when the function left the page positioned at the Smart HR
   * Transactions list — i.e. it successfully navigated there but found no
   * matching row. The caller can skip a redundant
   * navigateToSmartHR + clickSmartHRTransactions when this is `true`.
   */
  alreadyAtSmartHR: boolean;
}

/**
 * Look up an existing Smart HR termination transaction for a given
 * employee. Returns an `ExistingTerminationResult` whose `txnNumber` is
 * the existing transaction number (e.g. "T002126379") if a row was found,
 * or `null` if no matching row exists.
 *
 * Used as a pre-submit idempotence check: before creating a new
 * termination transaction, callers check whether one already exists for
 * this EID + effective date. A hit means the prior run already submitted
 * (possibly without capturing the txn# locally) — return the number,
 * skip the resubmit, propagate it to downstream steps (e.g. Kuali
 * finalization).
 *
 * `alreadyAtSmartHR` is set to `true` when no row was found but the
 * function successfully navigated to Smart HR Transactions. The caller can
 * use this to skip a redundant double navigation (~12s saving per doc).
 *
 * Match semantics: row's Person ID column equals `employeeId`, row text
 * contains the effective date (MM/DD/YYYY), and row text contains
 * "Terminat" (covers "Terminatn"/"Termination" Action display variants —
 * avoids false positives on non-termination JOB rows like transfers for
 * the same employee on the same day). Name is NOT used for matching
 * because upstream records can disagree with UCPath's stored display
 * name (nicknames like "Aki" vs "Akitsugu", Last/First column confusion,
 * spelling variants) — the previous name+template approach silently
 * missed duplicates and produced real dupes (EID 10794813 Aki Uchida,
 * 2026-04-24).
 *
 * This is the pre-submit duplicate-termination guard, so a genuine scan
 * that finds no matching row returns `{ txnNumber: null }` — but a THROWN
 * navigation/scan/click error does NOT degrade to that same shape. Reading
 * "the lookup failed" as "no existing transaction found" would clear the
 * way for a second real duplicate termination, so an unresolved failure
 * now propagates instead of being swallowed here.
 */
export async function findExistingTerminationTransaction(
  page: Page,
  employeeId: string,
  effectiveDate: string,
): Promise<ExistingTerminationResult> {
  try {
    log.step(`[Txn Lookup] Checking for existing termination: eid='${employeeId}' effDate='${effectiveDate}'`);
    if (!employeeId) {
      log.warn(`[Txn Lookup] Empty EID — skipping pre-submit existence check`);
      return { txnNumber: null, alreadyAtSmartHR: false };
    }
    await navigateToSmartHR(page);
    await clickSmartHRTransactions(page);
    // clickSmartHRTransactions already awaits networkidle — no extra sleep needed.
    const frame = getContentFrame(page);

    const linkText = await findTransactionRowLinkByEid(frame, employeeId, {
      effectiveDate,
      requireTerminationAction: true,
    });
    if (!linkText) {
      log.step(`[Txn Lookup] No existing termination found for eid=${employeeId} date=${effectiveDate}`);
      // Caller can skip re-navigation — page is already at Smart HR Transactions.
      return { txnNumber: null, alreadyAtSmartHR: true };
    }
    log.step(`[Txn Lookup] Matching row found (link='${linkText}') — reading txn #`);

    const link = frame.getByRole("link", { name: linkText }); // allow-inline-selector -- dynamic matched-name link
    if (!(await clickIfPresent(link, {
      timeout: 5_000,
      label: "ucpath existing transaction row link",
    }))) {
      log.warn(`[Txn Lookup] Row matched but link '${linkText}' disappeared before click — treating as no match`);
      return { txnNumber: null, alreadyAtSmartHR: true };
    }
    // Wait for PeopleSoft to render the transaction detail page.
    await waitForPeopleSoftProcessing(frame, 15_000);
    await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});

    const continueBtn = smartHR.continueButton(frame);
    if (await clickIfPresent(continueBtn, {
      timeout: 5_000,
      label: "ucpath existing transaction continue button",
    })) {
      // Wait for PeopleSoft to load the transaction form after Continue.
      await waitForPeopleSoftProcessing(frame, 15_000);
      await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
    }

    const txnNumber = await readTxnNumberFromDetailPage(frame);
    if (txnNumber) {
      log.success(`[Txn Lookup] Existing transaction #${txnNumber} found for eid=${employeeId}`);
      return { txnNumber, alreadyAtSmartHR: false };
    }
    log.warn(`[Txn Lookup] Matched row but couldn't extract Transaction ID from detail page — treating as no match`);
    return { txnNumber: null, alreadyAtSmartHR: false };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    throw new Error(
      `[Txn Lookup] Existing-termination lookup threw for eid=${employeeId} effDate=${effectiveDate} — ` +
      `result unknown, refusing to report "no existing transaction found" (would clear the way for a ` +
      `duplicate termination): ${message}`,
      { cause: e },
    );
  }
}

/**
 * Delete EVERY pending termination transaction for an employee from the Smart HR
 * Transactions page's "Transactions in Progress" grid, REGARDLESS of effective
 * date.
 *
 * Used by separations' `transaction-check` step before a fresh termination is
 * created. This is the real duplicate guard: a prior run can leave a pending
 * termination whose computed effective date DIFFERS from this run's, which both
 * the SS-Smart-HR effdt gate (it only reuses/flags a TER within ~14 days of THIS
 * separation) AND `findExistingTerminationTransaction`'s exact-effdt match miss —
 * so the stale pending survives and a second create produces a visible duplicate
 * in this grid (Erick Guzman 10779506: 06/14 + 06/20, 2026-06-24). The
 * in-progress grid only holds UNPROCESSED transactions, so ANY "Terminat" row
 * here for this person is a superseded prior attempt that must go before the new
 * create. (An APPROVED prior-job termination is processed and never appears in
 * this grid, so the date-agnostic sweep cannot touch it — the SS Smart HR effdt
 * gate still owns the approved-reuse decision upstream.)
 *
 * Navigates to Smart HR Transactions, ticks the Select checkbox of EVERY
 * in-progress row whose Person ID cell equals `employeeId` AND whose row text
 * contains "Terminat" (names/transaction-id columns aren't shown on this grid),
 * clicks "Delete Selected Transactions" once (it deletes all checked rows), and
 * confirms the PeopleSoft dialog (#ICOK).
 *
 * Returns the COUNT of rows deleted — `0` means a genuine "no matching pending
 * row" scan. A THROWN error (navigation/click/scan failure) is NOT swallowed
 * into that same `0`: this is the real duplicate guard the caller uses to
 * decide whether it's safe to create a fresh transaction, so reading "the
 * sweep failed" as "0 pending rows, nothing to delete" would leave a stale
 * pending termination in place while a new one gets created on top of it. The
 * checkboxes are clicked inside `frame.evaluate` because PeopleSoft's overlay
 * can intercept a Playwright click — the same escape hatch used for the #ICOK
 * dialog.
 *
 * LIVE-VERIFIED 2026-06-24 (playwright-cli, real UCPath): the EID + "Terminat"
 * exact-cell match selects precisely the right rows (real duplicate EID 10629763
 * selected both its rows; a single-row EID selected 1; an absent EID 0);
 * `checkbox.click()` inside `evaluate` flips the real PeopleSoft grid checkboxes;
 * `Delete Selected Transactions` resolves to exactly 1 button; the confirm dialog
 * is the `#ICOK` element (`document.getElementById("#ICOK")`, value "OK", text
 * "Select Ok to confirm deletion of this transaction…"). A real stale duplicate
 * row was deleted and the keeper preserved.
 */
export async function deletePendingTransaction(
  page: Page,
  employeeId: string,
): Promise<number> {
  try {
    log.step(`[Txn Delete] Deleting pending termination(s) for eid='${employeeId}'`);
    if (!employeeId) {
      log.warn(`[Txn Delete] Empty EID — skipping delete`);
      return 0;
    }
    await navigateToSmartHR(page);
    await clickSmartHRTransactions(page);
    const frame = getContentFrame(page);

    const checkedCount = await checkPendingTransactionRowsByEid(frame, employeeId);
    if (checkedCount === 0) {
      log.step(
        `[Txn Delete] No in-progress Terminatn row found for eid=${employeeId} — nothing to delete`,
      );
      return 0;
    }
    await page.waitForTimeout(1_000);

    await safeClick(smartHR.deleteSelectedTransactionsButton(frame), {
      timeout: 10_000,
      label: "ucpath delete selected transactions button",
    });
    await page.waitForTimeout(2_000);
    await waitForPeopleSoftProcessing(frame, 15_000);

    // Confirm the PeopleSoft "Delete this transaction?" dialog (OK = #ICOK).
    if (await dismissPeopleSoftDialog(page)) log.step("[Txn Delete] Confirmed delete dialog");
    await page.waitForTimeout(2_000);
    await waitForPeopleSoftProcessing(frame, 15_000);
    await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});

    log.success(`[Txn Delete] Deleted ${checkedCount} pending termination row(s) for eid=${employeeId}`);
    return checkedCount;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    throw new Error(
      `[Txn Delete] Pending-termination sweep threw for eid=${employeeId} — result unknown, refusing ` +
      `to report "0 pending rows" (would leave a stale pending termination in place for a fresh ` +
      `create to duplicate): ${message}`,
      { cause: e },
    );
  }
}

/**
 * Scan the "Transactions in Progress" grid and tick the Select checkbox of EVERY
 * row whose Person ID cell equals `employeeId` and whose text contains
 * "Terminat". Returns the number of checkboxes clicked. The clicks happen inside
 * `frame.evaluate` (PeopleSoft overlay can intercept Playwright clicks).
 *
 * Checks ALL matching rows (not just the first) so a single "Delete Selected
 * Transactions" submit clears every accumulated duplicate for the EID at once.
 *
 * A genuine scan that matches zero rows already returns `0` via the normal
 * return path below — that's a real "nothing pending" result. A THROWN
 * error (frame detached, evaluate failure, etc.) is NOT swallowed into that
 * same `0`: this count backs the pending-termination sweep, so misreading
 * "the scan failed" as "0 pending rows" would leave a stale pending
 * termination in place while a new one gets created on top of it.
 */
async function checkPendingTransactionRowsByEid(
  frame: FrameLocator,
  employeeId: string,
): Promise<number> {
  return await frame.locator("body").evaluate( // allow-inline-selector -- body scan + checkbox clicks on transactions-in-progress grid
    (body, eid: string) => {
      let checked = 0;
      const tables = body.querySelectorAll("table");
      for (const table of Array.from(tables)) {
        for (const row of Array.from((table).rows)) {
          const rowText = row.textContent ?? "";
          if (!/Terminat/i.test(rowText)) continue;
          const hasEidCell = Array.from(row.cells).some(
            (c) => (c.textContent ?? "").trim() === eid,
          );
          if (!hasEidCell) continue;
          const checkbox = row.querySelector<HTMLInputElement>('input[type="checkbox"]');
          if (checkbox && !checkbox.checked) {
            checkbox.click();
            checked++;
          }
        }
      }
      return checked;
    },
    employeeId,
  );
}

/**
 * Pure predicate: a "Transactions in Progress" row matches the target when
 * some cell's trimmed text exactly equals the EID **and** the full row text
 * reads as a termination action.
 *
 * This encodes the same rule used inside `checkPendingTransactionRowByEid`'s
 * `frame.evaluate(...)` browser context — extracted as a Node-side pure
 * function so it can be unit-pinned. (The checkbox click must remain inside
 * `evaluate` because PeopleSoft's overlay intercepts Playwright clicks; a
 * Node-side rewire would require splitting the evaluate into two round-trips
 * and is therefore left as-is.)
 *
 * Pure — unit-pinned by tests/unit/systems/ucpath/transaction.test.ts.
 */
export function rowMatchesTerminationEid(
  cellTexts: readonly string[],
  rowText: string,
  eid: string,
): boolean {
  return cellTexts.some((c) => c.trim() === eid) && /Terminat/i.test(rowText);
}

export function extractSmartHrTransactionNumber(text: string): string | null {
  const normalized = text
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+/g, " ");
  const match =
    normalized.match(/Transaction\s+ID\s*:?\s*(T\d{6,})/i)
    ?? normalized.match(/Transaction\s*:?\s*(T\d{6,})/i)
    ?? normalized.match(/\b(T\d{6,})\b/i);
  return match?.[1]?.toUpperCase() ?? null;
}

async function readTxnNumberFromDetailPage(frame: FrameLocator): Promise<string | null> {
  const body = frame.locator("body"); // allow-inline-selector -- body readback for PeopleSoft transaction detail scrape
  const bodyText = await body.innerText({ timeout: 5_000 }).catch(() => "");
  const textContent = await body.evaluate((el) => el.textContent ?? "").catch(() => "");
  return extractSmartHrTransactionNumber(`${bodyText}\n${textContent}`);
}

export async function scrollToTransactionReadbackArea(frame: FrameLocator): Promise<boolean> {
  return await frame.locator("body").evaluate((body) => { // allow-inline-selector -- body-scoped scroll to Smart HR readback markers
    const markerRe = /Transaction\s*(?:ID)?\s*:|\bT\d{6,}\b/i;
    const all = Array.from(body.querySelectorAll<HTMLElement>("span, div, td, th, label, a, textarea"));
    const target = all.find((el) => markerRe.test(el.textContent ?? ""));
    if (target) {
      target.scrollIntoView({ block: "center", inline: "nearest", behavior: "auto" });
      return true;
    }
    const doc = body.ownerDocument;
    doc.defaultView?.scrollTo(0, Math.max(body.scrollHeight, doc.documentElement.scrollHeight));
    return false;
  }).catch(() => false);
}

/**
 * Scan the Smart HR Transactions list inside `frame` for a row whose
 * Person ID cell equals `employeeId`. Returns the row's employee-link
 * text (which callers can pass to `getByRole("link", { name })` for
 * clicking) or `null` if no row matches.
 *
 * EID match is done by exact cell content (`cell.textContent.trim() ===
 * employeeId`) rather than substring-of-row-text to avoid false positives
 * from dept IDs / location codes that might incidentally contain the EID
 * digits.
 *
 * A genuine scan that finds no matching row returns `null` via the normal
 * return path above. A THROWN scan error (frame detached, evaluate
 * failure, etc.) is NOT swallowed into that same `null` here — one caller
 * (`findExistingTerminationTransaction`) uses this as a pre-submit
 * duplicate-termination guard, where "scan failed" misread as "no row"
 * would clear the way for a duplicate create. Callers that want a
 * best-effort degrade (e.g. `readLatestTransactionNumber`'s post-submit
 * readback poll) catch locally at their own call site instead.
 */
async function findTransactionRowLinkByEid(
  frame: FrameLocator,
  employeeId: string,
  opts?: { effectiveDate?: string; requireTerminationAction?: boolean },
): Promise<string | null> {
  return await frame.locator("body").evaluate( // allow-inline-selector -- body scan for smart-hr-transactions list
    (body, { eid, date, requireTerm }: { eid: string; date?: string; requireTerm?: boolean }) => {
      const tables = body.querySelectorAll("table");
      for (const table of Array.from(tables)) {
        for (const row of Array.from((table).rows)) {
          const rowText = row.textContent ?? "";
          if (date && !rowText.includes(date)) continue;
          if (requireTerm && !/Terminat/i.test(rowText)) continue;
          const hasEidCell = Array.from(row.cells).some(
            (c) => (c.textContent ?? "").trim() === eid,
          );
          if (!hasEidCell) continue;
          const link = row.querySelector("a");
          const linkText = (link?.textContent ?? "").trim();
          if (!linkText) continue;
          return linkText;
        }
      }
      return null;
    },
    { eid: employeeId, date: opts?.effectiveDate, requireTerm: opts?.requireTerminationAction },
  );
}

// ─── Helpers ───

/**
 * Extract numeric pay rate from CRM wage string.
 * e.g. "$17.75 per hour" → "17.75"
 */
export function parsePayRate(wage: string): string {
  // First number-like token, commas included — wages arrive as "$17.75 per
  // hour", "$1,250.00 biweekly", or bare "20". The previous /[\d.]+/ stopped at
  // the first comma, so "$1,250.00" silently parsed as "1" — a wrong rate typed
  // into a real UCPath transaction.
  const match = wage.match(/\$?\s*([\d,]*\d(?:\.\d+)?)/);
  if (!match) {
    // Fail loud: a non-numeric wage ("TBD", "Negotiable", "N/A") must NOT be
    // typed verbatim into the UCPath Compensation Rate field. Surface it so the
    // upstream CRM record gets fixed, rather than silently submitting garbage.
    throw new Error(
      `parsePayRate: no numeric rate found in wage string "${wage}" — refusing to submit an unparseable pay rate to UCPath`,
    );
  }
  const token = match[1];
  // Commas must be well-formed thousands groups ("1,250" / "12,345.67").
  // Stripping the comma from a malformed token like "1,25.00" would silently
  // submit 125 — refuse instead so the source record gets fixed.
  if (token.includes(",") && !/^\d{1,3}(?:,\d{3})+(?:\.\d+)?$/.test(token)) {
    throw new Error(
      `parsePayRate: ambiguous digit separators in wage string "${wage}" — refusing to submit an unparseable pay rate to UCPath`,
    );
  }
  return token.replace(/,/g, "");
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
