import type { Page } from "playwright";
import { mkdir } from "node:fs/promises";
import { log } from "../../utils/log.js";
import { ActionPlan } from "../../systems/ucpath/action-plan.js";
import {
  TEMPLATE_ID,
  REASON_CODE,
  COMP_RATE_CODE,
  JOB_END_DATE,
  CONC_HIRE_TEMPLATE_ID,
  CONC_HIRE_REASON_CODE,
} from "./config.js";
import {
  navigateToSmartHR,
  getContentFrame,
  clickSmartHRTransactions,
  selectTemplate,
  enterEffectiveDate,
  clickCreateTransaction,
  selectReasonCode,
  fillPersonalData,
  clickJobDataTab,
  fillJobData,
  clickEarnsDistTab,
  clickEmployeeExperienceTab,
  clickPersonalDataTab,
  clickSaveAndSubmit,
  ssnLast4,
  parsePayRate,
  buildCommentsText,
  buildConcurrentHireCommentsText,
  waitForPeopleSoftProcessing,
  dismissPeopleSoftModalMask,
  waitForSaveEnabled,
  fillTransactionDetailsEmplId,
  acknowledgePersonIdExistsDialog,
  waitForJobDataForm,
  readPersonalDataLegalName,
  cancelTransactionDraft,
} from "../../systems/ucpath/index.js";
import type { PersonalDataInput, JobDataInput } from "../../systems/ucpath/index.js";
import { comments, smartHR } from "../../systems/ucpath/selectors.js";
import type { EmployeeData } from "./schema.js";
import { ssnForUcpathEntry } from "../../domain/identity/ssn.js";
import { isUcpathEmployeeId } from "../../domain/identity/eid.js";
import { classifyNameSimilarity } from "../../services/matching/match.js";

/**
 * Build an ActionPlan for the full UC_FULL_HIRE Smart HR Transaction.
 *
 * Steps:
 *  1.  Navigate to HR Tasks sidebar
 *  2.  Click Smart HR Templates → Smart HR Transactions
 *  3.  Select UC_FULL_HIRE template
 *  4.  Enter effective date
 *  5.  Click Create Transaction
 *  6.  Select reason code: Hire - No Prior UC Affiliation
 *  7.  Fill personal data (name, DOB, SSN, address, phone, email, profile ID)
 *  8.  Fill comments + initiator comments (persists across all tabs)
 *  9.  Click Job Data tab
 *  10. Fill job data (position, classification, comp rate, end date)
 *  11. Click Earns Dist tab
 *  12. Click Employee Experience tab
 *  13. Save and Submit
 */

/**
 * Stage capture for the Smart HR transaction walk.
 *
 * Opt-in via `HR_ONBOARDING_CAPTURE_STEPS=1` so production runs are unaffected.
 * Writes numbered PNGs the operator can review as a filmstrip of what the
 * automation actually did on each tab.
 */
async function captureStage(page: Page, order: number, label: string): Promise<void> {
  if (process.env.HR_ONBOARDING_CAPTURE_STEPS !== "1") return;
  const dir = ".screenshots/onboarding-process";
  await mkdir(dir, { recursive: true });
  const name = `${String(order).padStart(2, "0")}-${label}.png`;
  await page.screenshot({ path: `${dir}/${name}`, fullPage: true }).catch(() => {});
  log.step(`[Capture] ${name}`);
}


/**
 * Is `candidate` (MM/DD/YYYY) on or after `floor` (MM/DD/YYYY)?
 *
 * Returns false when either date is unparseable — an unreadable date must not
 * pass a safety check by accident.
 */
export function isOnOrAfter(candidate: string, floor: string): boolean {
  const parse = (value: string): number | null => {
    const m = value.trim().match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
    if (!m) return null;
    const [, mm, dd, yyyy] = m;
    const month = Number(mm), day = Number(dd), year = Number(yyyy);
    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    return Date.UTC(year, month - 1, day);
  };
  const a = parse(candidate);
  const b = parse(floor);
  if (a === null || b === null) return false;
  return a >= b;
}

/**
 * Resolve the Job Data tab input shared by BOTH Smart HR hire templates
 * (UC_FULL_HIRE new hire and UC_CONC_HIRE concurrent hire — the Job Data tab
 * is the same grid on both, live 2026-08-21). Fails loud on a missing
 * classification or an end date before the effective date.
 */
export function buildJobDataInput(data: EmployeeData): JobDataInput {
  if (!data.appointment?.trim()) {
    throw new Error(
      `Cannot submit onboarding transaction without employeeClassification (data.appointment) `
      + `for ${data.firstName} ${data.lastName}`,
    );
  }
  // Expected Job End Date comes from the CRM UCPath Entry Sheet when present —
  // it is a PER-HIRE value, not a per-fiscal-year constant. `JOB_END_DATE` is
  // only a fallback for a record where CRM left it blank ("if applicable").
  //
  // This is load-bearing: a stale constant made UCPath reject the entire
  // transaction with a BLOCKING modal — "Expected Job End Date cannot be before
  // Job Effective Date" — which the automation then acknowledged as though it
  // were the submit confirmation, so the hire silently never filed (live
  // 2026-08-18: effdt 09/11/2026 against a 06/30/2026 default).
  const crmJobEndDate = data.expectedJobEndDate?.trim();
  const expectedJobEndDate = crmJobEndDate || JOB_END_DATE;
  if (crmJobEndDate) {
    log.step(`Expected Job End Date from CRM: ${crmJobEndDate}`);
  } else {
    log.step(`CRM had no Expected Job End Date — using the configured default ${JOB_END_DATE}`);
  }
  // Fail loud BEFORE building a transaction UCPath will refuse. Comparing the
  // two MM/DD/YYYY dates here turns a silent, mis-read dialog into a legible
  // error naming both values.
  if (!isOnOrAfter(expectedJobEndDate, data.effectiveDate)) {
    throw new Error(
      `Expected Job End Date ${expectedJobEndDate} is BEFORE the effective date ${data.effectiveDate} `
      + `for ${data.firstName} ${data.lastName}. UCPath rejects this outright, so the transaction is `
      + `not attempted. Fix "Expected Job End Date" on the CRM UCPath Entry Sheet, or roll the `
      + `ANNUAL_DATES_END / Settings job-end-date default if CRM left it blank.`,
    );
  }

  return {
    positionNumber: data.positionNumber,
    employeeClassification: data.appointment,
    compRateCode: COMP_RATE_CODE,
    compensationRate: parsePayRate(data.wage),
    expectedJobEndDate,
  };
}

export function buildTransactionPlan(
  data: EmployeeData,
  page: Page,
  i9ProfileId?: string,
  options: {
    dryRun?: boolean;
    /**
     * Receives the transaction number the SUBMIT itself read back (via the
     * Transactions-in-Progress row -> Continue -> "Transaction ID:" path).
     * This is the authoritative number for a new hire — do NOT re-derive it
     * from the SS Smart HR list, which does not carry an unprocessed hire.
     */
    onTransactionNumber?: (txnNumber: string) => void;
    /**
     * Operator-reviewed "NOT this person" UCPath EIDs (`data.notMatchEids`).
     * Consulted only if Save and Submit lands on the "Person Match Found"
     * page — see `decidePersonMatchContinue` in `systems/ucpath/transaction.ts`.
     */
    notMatchEids?: readonly string[];
  } = {},
): ActionPlan {
  const plan = new ActionPlan();

  // Step 1: Navigate to HR Tasks
  plan.add(
    "Navigate to Smart HR page",
    () => navigateToSmartHR(page),
  );

  // Step 2: Sidebar → Smart HR Templates → Smart HR Transactions
  plan.add(
    "Click Smart HR Templates → Smart HR Transactions",
    () => clickSmartHRTransactions(page),
  );

  // Step 3: Select template
  plan.add(
    `Select template ${TEMPLATE_ID}`,
    () => selectTemplate(getContentFrame(page), TEMPLATE_ID),
  );

  // Step 4: Enter effective date
  plan.add(
    `Enter effective date: ${data.effectiveDate}`,
    () => enterEffectiveDate(getContentFrame(page), data.effectiveDate),
  );

  // Step 5: Create Transaction
  plan.add(
    "Click Create Transaction",
    async () => {
      const result = await clickCreateTransaction(page, getContentFrame(page));
      if (!result.success) {
        throw new Error(result.error ?? "Transaction creation failed");
      }
    },
  );

  plan.add(
    "Capture: transaction-created",
    () => captureStage(page, 1, "transaction-created"),
  );

  // Step 6: Reason code
  plan.add(
    `Select reason: ${REASON_CODE}`,
    () => selectReasonCode(page, getContentFrame(page), REASON_CODE),
  );

  // Step 7: Fill personal data
  //
  // data.ssn may be undefined or "" (both mean no SSN provided). It may ALSO be
  // a value UCPath refuses outright — anything with 900-999 in positions 1-3
  // (the ITIN range, and CRM's all-9s "no SSN on file" placeholder). Entering
  // one raises a BLOCKING error modal that then swallows every later click, so
  // the run dies much later at an unrelated step. Treat it as "no SSN", which is
  // a real and expected state for a new international student (2026-08-18).
  const enterableSsn = ssnForUcpathEntry(data.ssn);
  if (data.ssn && !enterableSsn) {
    log.warn(
      `SSN for ${data.firstName} ${data.lastName} begins 900-999 (ITIN range or the all-9s `
      + `"no SSN yet" placeholder) — UCPath rejects it, so the National ID is left BLANK and the `
      + `transaction comment records that no SSN is on file.`,
    );
  }
  const ssnDigits = enterableSsn ? enterableSsn.replace(/-/g, "") : undefined;
  const personalData: PersonalDataInput = {
    firstName: data.firstName,
    lastName: data.lastName,
    middleName: data.middleName,
    preferredFirstName: data.preferredFirstName,
    preferredLastName: data.preferredLastName,
    preferredMiddleName: data.preferredMiddleName,
    dob: data.dob ?? "",
    ssn: ssnDigits,
    address: data.address,
    city: data.city,
    state: data.state,
    postalCode: data.postalCode,
    phone: data.phone,
    email: data.email,
    i9ProfileId,
  };

  plan.add(
    "Fill personal data (name, DOB, SSN, address, phone, email, profile ID)",
    () => fillPersonalData(page, getContentFrame(page), personalData),
  );

  plan.add(
    "Capture: personal-data-filled",
    () => captureStage(page, 2, "personal-data-filled"),
  );

  // Step 8: Comments on Personal Data page
  // Keyed on what actually got ENTERED, not on what CRM held — a rejected
  // 900-999 value means the National ID is blank, so the comment must say so.
  const hasSsn = Boolean(enterableSsn);
  const commentsText = buildCommentsText(
    data.effectiveDate,
    data.recruitmentNumber ?? "N/A",
    hasSsn,
  );

  plan.add(
    "Fill comments",
    async () => {
      const frame = getContentFrame(page);
      await comments.commentsTextarea(frame).fill(commentsText, { timeout: 10_000 });
    },
  );

  // Step 9: Job Data tab
  plan.add(
    "Click Job Data tab",
    async () => {
      await clickJobDataTab(page, getContentFrame(page));
      log.step(`[TabWalk] Job Data loaded (tabs visited: Personal Data \u2713, Job Data \u2713)`);
    },
  );

  // Step 10: Fill job data
  const jobData = buildJobDataInput(data);

  plan.add(
    "Fill job data (position, classification, comp rate, end date)",
    () => fillJobData(page, getContentFrame(page), jobData),
  );

  plan.add(
    "Capture: job-data-filled",
    () => captureStage(page, 3, "job-data-filled"),
  );

  // Step 11: Earns Dist tab
  plan.add(
    "Click Earns Dist tab",
    async () => {
      await clickEarnsDistTab(page, getContentFrame(page));
      log.step(`[TabWalk] Earns Dist loaded (tabs visited: Personal Data \u2713, Job Data \u2713, Earns Dist \u2713)`);
    },
  );

  plan.add(
    "Capture: earns-dist",
    () => captureStage(page, 4, "earns-dist"),
  );

  // Step 12: Employee Experience tab
  plan.add(
    "Click Employee Experience tab",
    async () => {
      await clickEmployeeExperienceTab(page, getContentFrame(page));
      log.step(`[TabWalk] Employee Experience loaded (tabs visited: Personal Data \u2713, Job Data \u2713, Earns Dist \u2713, Employee Experience \u2713)`);
    },
  );

  plan.add(
    "Capture: employee-experience",
    () => captureStage(page, 5, "employee-experience"),
  );

  // Step 13: Initiator comments (fill on last tab before submit)
  plan.add(
    "Fill initiator comments",
    async () => {
      const frame = getContentFrame(page);
      await comments.initiatorCommentsTextarea(frame).fill(commentsText, { timeout: 10_000 });
      log.step(`[TabWalk] Initiator Comments filled (${commentsText.length} chars)`);
    },
  );

  // Dry-run diagnostic: report whether Save and Submit is already enabled at the
  // END of the tab walk (i.e. while still on Employee Experience), BEFORE the
  // Personal Data re-click below. If it is enabled here and disabled after, the
  // re-click is what disables it and step 14 is wrong.
  if (options.dryRun) {
    plan.add(
      "Probe Save and Submit state on the last tab (before returning to Personal Data)",
      async () => {
        const enabled = await smartHR
          .saveAndSubmitButton(getContentFrame(page))
          .isEnabled()
          .catch(() => false);
        log.step(
          `[SaveProbe] after full tab walk, still on Employee Experience: Save and Submit `
          + `${enabled ? "ENABLED" : "DISABLED"}`,
        );
      },
    );
  }

  // Step 14: Click back to Personal Data tab (PeopleSoft requires all tabs visited to enable Save)
  plan.add(
    "Click Personal Data tab",
    async () => {
      const frame = getContentFrame(page);
      await dismissPeopleSoftModalMask(page);
      await smartHR.tab.personalData(frame).click({ timeout: 10_000 });
      await page.waitForTimeout(3_000);
      await waitForPeopleSoftProcessing(frame, 10_000);
      log.success("Personal Data tab loaded (all tabs visited)");
      log.step(`[TabWalk] Personal Data re-clicked — all 4 tabs visited, Save should now be enabled`);
      if (options.dryRun) {
        const enabled = await smartHR
          .saveAndSubmitButton(frame)
          .isEnabled()
          .catch(() => false);
        log.step(
          `[SaveProbe] after returning to Personal Data: Save and Submit `
          + `${enabled ? "ENABLED" : "DISABLED"}`,
        );
      }
    },
  );

  plan.add(
    "Capture: before submit (back on Personal Data)",
    () => captureStage(page, 6, "before-submit-personal-data"),
  );

  // Step 15: Save and Submit
  //
  // DRY-RUN BOUNDARY (2026-08-18). A dry run walks every step above — it opens
  // the transaction, fills all four tabs, and writes the comments — and stops
  // exactly HERE. The operator gets to inspect the completed form as it would
  // be submitted; the only thing that never happens is the submit itself.
  // The transaction is therefore left as an UNSUBMITTED DRAFT in UCPath.
  if (options.dryRun) {
    log.warn(
      "DRY RUN: transaction form will be filled completely, then STOP before Save and Submit "
      + "(an unsubmitted draft is left in UCPath).",
    );
    // The whole point of the rehearsal is proving the transaction reached a
    // genuinely SUBMITTABLE state. PeopleSoft keeps Save and Submit greyed out
    // until every tab has been visited and the required fields are filled, so
    // an ENABLED button is the real "this would have gone through" evidence.
    // Fail loud if it is still disabled — a dry run that quietly ended on a
    // greyed-out button would falsely read as a successful rehearsal.
    plan.add(
      "Verify Save and Submit is enabled (dry run — button NOT clicked)",
      async () => {
        await dismissPeopleSoftModalMask(page);
        await waitForSaveEnabled(smartHR.saveAndSubmitButton(getContentFrame(page)), {
          timeoutMs: 15_000,
        });
        log.success(
          "DRY RUN: Save and Submit is ENABLED (clickable, not greyed out) — the transaction is "
          + "complete and would submit. Not clicking it.",
        );
      },
    );
    return plan;
  }

  plan.add(
    "Save and Submit transaction",
    async () => {
      // Pass the person's name: a new hire has no EID, so the post-submit
      // readback locates its Transactions-in-Progress row by the Name cell.
      // hireIdentity feeds the Person-Match-Found exclusion rule ONLY: the
      // hire's real SSN last-4 (none for a 900-999 placeholder) and DOB.
      const result = await clickSaveAndSubmit(page, getContentFrame(page), undefined, {
        personName: `${data.firstName} ${data.lastName}`.trim(),
        hireIdentity: {
          ssnLast4: ssnLast4(ssnForUcpathEntry(data.ssn)),
          dob: data.dob,
        },
        notMatchEids: options.notMatchEids ?? [],
      });
      await captureStage(page, 7, "after-save-and-submit");
      if (!result.success) {
        throw new Error(result.error ?? "Save and Submit failed");
      }
      if (result.transactionNumber) {
        options.onTransactionNumber?.(result.transactionNumber);
      }
    },
  );

  return plan;
}

/**
 * Build an ActionPlan for the REHIRE run mode — a UC_CONC_HIRE "Staff Concurrent
 * Hire/Inter Location Transfer" Smart HR transaction on an EXISTING UCPath
 * person's Empl ID (live-mapped 2026-08-21; operator procedure 2026-08-20,
 * T002216750). No I-9 and no Personal Data entry: the person record exists.
 *
 * Steps:
 *  1.  Navigate to HR Tasks sidebar → Smart HR Templates → Smart HR Transactions
 *  2.  Select UC_CONC_HIRE, enter effective date, Create Transaction
 *  3.  "Enter Transaction Details": fill Empl ID, READ BACK the resolved name and
 *      refuse a `different` name (a bogus EID resolves to some real person)
 *  4.  Reason code "Concurrent Hire - Non Dual Emp" + Continue
 *  5.  Acknowledge ONLY the "Person ID <eid> already exists … Select OK to
 *      continue" dialog (any other dialog / no dialog throws)
 *  6.  Job Data tab (the landing tab): position, classification, comp rate,
 *      end date — identical grid to UC_FULL_HIRE — then Comments
 *  7.  Earns Dist tab, then Personal Data tab (pre-filled legal name is a second
 *      wrong-person readback); visiting all three enables Save and Submit
 *  8.  Initiator comments; Save and Submit (EID-keyed readback) — or, dry run:
 *      assert Save and Submit is ENABLED, then CANCEL the draft so no stale
 *      in-progress row sits on this Empl ID before the real run
 */
export function buildConcurrentHirePlan(
  data: EmployeeData,
  page: Page,
  emplId: string,
  options: {
    dryRun?: boolean;
    /** Receives the transaction number the SUBMIT itself read back (EID-keyed row). */
    onTransactionNumber?: (txnNumber: string) => void;
    /** Whether the operator reviewed and approved this specific EID for this person */
    eidApproved?: boolean;
  } = {},
): ActionPlan {
  const expectedName = `${data.firstName} ${data.lastName}`.trim();
  if (!isUcpathEmployeeId(emplId)) {
    throw new Error(
      `Cannot build a UC_CONC_HIRE concurrent-hire plan for ${expectedName} without a valid `
      + `UCPath Empl ID (got '${emplId || "<empty>"}') — the rehire mode needs the matched person's EID.`,
    );
  }
  const plan = new ActionPlan();

  plan.add("Navigate to Smart HR page", () => navigateToSmartHR(page));
  plan.add(
    "Click Smart HR Templates → Smart HR Transactions",
    () => clickSmartHRTransactions(page),
  );
  plan.add(
    `Select template ${CONC_HIRE_TEMPLATE_ID}`,
    () => selectTemplate(getContentFrame(page), CONC_HIRE_TEMPLATE_ID),
  );
  plan.add(
    `Enter effective date: ${data.effectiveDate}`,
    () => enterEffectiveDate(getContentFrame(page), data.effectiveDate),
  );
  plan.add(
    "Click Create Transaction",
    async () => {
      const result = await clickCreateTransaction(page, getContentFrame(page));
      if (!result.success) {
        throw new Error(result.error ?? "Transaction creation failed");
      }
    },
  );

  // "Enter Transaction Details" — the EID-keyed page. The resolved-name readback
  // is the wrong-person guard: refuse to continue unless it is the CRM person.
  plan.add(
    `Enter Empl ID ${emplId} and verify the resolved name is ${expectedName}`,
    async () => {
      const resolved = await fillTransactionDetailsEmplId(page, getContentFrame(page), emplId);
      const tier = classifyNameSimilarity(expectedName, resolved);
      if (tier === "different") {
        throw new Error(
          `Empl ID ${emplId} resolved to "${resolved}" on "Enter Transaction Details", which does NOT `
          + `match the CRM person "${expectedName}" — refusing to file a concurrent hire against the `
          + `wrong person. Verify the Empl ID in Person Org Summary.`,
        );
      }
      log.success(`Empl ID ${emplId} → "${resolved}" matches "${expectedName}" (${tier})`);
    },
  );
  plan.add(
    `Select reason: ${CONC_HIRE_REASON_CODE}`,
    () => selectReasonCode(page, getContentFrame(page), CONC_HIRE_REASON_CODE),
  );
  plan.add(
    `Acknowledge "Person ID ${emplId} already exists" → continue with this Person ID`,
    async () => { await acknowledgePersonIdExistsDialog(page, emplId); },
  );
  plan.add(
    "Wait for the transaction form (lands on Job Data)",
    () => waitForJobDataForm(getContentFrame(page)),
  );
  plan.add(
    "Capture: transaction-created",
    () => captureStage(page, 1, "conc-hire-transaction-created"),
  );

  const jobData = buildJobDataInput(data);
  plan.add(
    "Fill job data (position, classification, comp rate, end date)",
    () => fillJobData(page, getContentFrame(page), jobData),
  );

  const commentsText = buildConcurrentHireCommentsText(
    data.effectiveDate,
    data.positionNumber,
    data.recruitmentNumber ?? "N/A",
  );
  plan.add(
    "Fill comments",
    async () => {
      const frame = getContentFrame(page);
      await comments.commentsTextarea(frame).fill(commentsText, { timeout: 10_000 });
      log.step(`[TabWalk] Comments filled: ${commentsText}`);
    },
  );
  plan.add(
    "Capture: job-data-filled",
    () => captureStage(page, 2, "conc-hire-job-data-filled"),
  );

  plan.add(
    "Click Earns Dist tab",
    async () => {
      await clickEarnsDistTab(page, getContentFrame(page));
      log.step("[TabWalk] Earns Dist loaded (tabs visited: Job Data ✓, Earns Dist ✓)");
    },
  );

  // Personal Data is the LAST tab on this template; its legal name is pre-filled
  // from the existing person record — assert it is still our person.
  plan.add(
    "Click Personal Data tab and verify the pre-filled legal name",
    async () => {
      const frame = getContentFrame(page);
      await clickPersonalDataTab(page, frame);
      const legal = await readPersonalDataLegalName(frame);
      const legalName = `${legal.firstName} ${legal.lastName}`.trim();
      const tier = classifyNameSimilarity(expectedName, legalName);
      if (tier === "different") {
        if (options.eidApproved) {
          log.step(
            `[TabWalk] Personal Data loaded — legal name "${legalName}" accepted via operator-approved `
            + `EID review for Empl ID ${emplId} (CRM expected "${expectedName}"); all 3 tabs visited`,
          );
        } else {
          throw new Error(
            `Personal Data tab is pre-filled for "${legalName}" (Empl ID ${emplId}), which does NOT match `
            + `the CRM person "${expectedName}" — refusing to submit a concurrent hire for the wrong person.`,
          );
        }
      } else {
        log.step(`[TabWalk] Personal Data loaded — legal name "${legalName}" matches (${tier}); all 3 tabs visited`);
      }
    },
  );

  plan.add(
    "Fill initiator comments",
    async () => {
      const frame = getContentFrame(page);
      await comments.initiatorCommentsTextarea(frame).fill(commentsText, { timeout: 10_000 });
      log.step(`[TabWalk] Initiator Comments filled (${commentsText.length} chars)`);
    },
  );
  plan.add(
    "Capture: before submit (Personal Data)",
    () => captureStage(page, 3, "conc-hire-before-submit"),
  );

  // DRY-RUN BOUNDARY. Prove the form is genuinely submittable (Save and Submit
  // ENABLED), then discard the draft: unlike the new-hire rehearsal, this draft
  // sits on a REAL Empl ID, and a stale in-progress row there is exactly the
  // kind of state a later live run should not have to reason about.
  if (options.dryRun) {
    log.warn(
      "DRY RUN: concurrent-hire form will be filled completely, Save and Submit asserted ENABLED, "
      + "then the draft is CANCELLED (nothing is submitted, no draft is left).",
    );
    plan.add(
      "Verify Save and Submit is enabled (dry run — button NOT clicked)",
      async () => {
        await dismissPeopleSoftModalMask(page);
        await waitForSaveEnabled(smartHR.saveAndSubmitButton(getContentFrame(page)), {
          timeoutMs: 15_000,
        });
        log.success(
          "DRY RUN: Save and Submit is ENABLED (clickable, not greyed out) — the concurrent hire is "
          + "complete and would submit. Not clicking it.",
        );
      },
    );
    return plan;
  }

  plan.add(
    "Save and Submit transaction",
    async () => {
      // EID-keyed readback: the Transactions-in-Progress row carries this
      // Person ID, so the submit can read its own T-number back. No
      // hireIdentity/notMatchEids: a Person Match page cannot apply to an
      // EID-bearing template, and if one appears it fails loud.
      const result = await clickSaveAndSubmit(page, getContentFrame(page), emplId, {
        personName: expectedName,
      });
      await captureStage(page, 4, "conc-hire-after-save-and-submit");
      if (!result.success) {
        throw new Error(result.error ?? "Save and Submit failed");
      }
      if (result.transactionNumber) {
        options.onTransactionNumber?.(result.transactionNumber);
      }
    },
  );

  return plan;
}

/**
 * Dry-run epilogue for the concurrent-hire plan: discard the filled draft. Kept
 * OUT of the plan so the operator's dry-run screenshot is taken while the
 * completed form is still on screen, then this runs.
 */
export async function cancelConcurrentHireDraft(page: Page): Promise<void> {
  await cancelTransactionDraft(page, getContentFrame(page));
}
