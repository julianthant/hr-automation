import type { Page } from "playwright";
import { log } from "../../utils/log.js";
import { ActionPlan } from "../../systems/ucpath/action-plan.js";
import {
  TEMPLATE_ID,
  REASON_CODE,
  COMP_RATE_CODE,
  JOB_END_DATE,
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
  clickSaveAndSubmit,
  parsePayRate,
  buildCommentsText,
  waitForPeopleSoftProcessing,
  dismissPeopleSoftModalMask,
  waitForSaveEnabled,
} from "../../systems/ucpath/index.js";
import type { PersonalDataInput, JobDataInput } from "../../systems/ucpath/index.js";
import { comments, smartHR } from "../../systems/ucpath/selectors.js";
import type { EmployeeData } from "./schema.js";
import { ssnForUcpathEntry } from "../../domain/identity/ssn.js";

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
export function buildTransactionPlan(
  data: EmployeeData,
  page: Page,
  i9ProfileId?: string,
  options: { dryRun?: boolean } = {},
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
  if (!data.appointment?.trim()) {
    throw new Error(
      `Cannot submit onboarding transaction without employeeClassification (data.appointment) `
      + `for ${data.firstName} ${data.lastName}`,
    );
  }
  const jobData: JobDataInput = {
    positionNumber: data.positionNumber,
    employeeClassification: data.appointment,
    compRateCode: COMP_RATE_CODE,
    compensationRate: parsePayRate(data.wage),
    expectedJobEndDate: JOB_END_DATE,
  };

  plan.add(
    "Fill job data (position, classification, comp rate, end date)",
    () => fillJobData(page, getContentFrame(page), jobData),
  );

  // Step 11: Earns Dist tab
  plan.add(
    "Click Earns Dist tab",
    async () => {
      await clickEarnsDistTab(page, getContentFrame(page));
      log.step(`[TabWalk] Earns Dist loaded (tabs visited: Personal Data \u2713, Job Data \u2713, Earns Dist \u2713)`);
    },
  );

  // Step 12: Employee Experience tab
  plan.add(
    "Click Employee Experience tab",
    async () => {
      await clickEmployeeExperienceTab(page, getContentFrame(page));
      log.step(`[TabWalk] Employee Experience loaded (tabs visited: Personal Data \u2713, Job Data \u2713, Earns Dist \u2713, Employee Experience \u2713)`);
    },
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
      const result = await clickSaveAndSubmit(page, getContentFrame(page));
      if (!result.success) {
        throw new Error(result.error ?? "Save and Submit failed");
      }
    },
  );

  return plan;
}
