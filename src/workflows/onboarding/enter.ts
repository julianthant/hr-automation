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
  dismissModalMask,
} from "../../systems/ucpath/index.js";
import type { PersonalDataInput, JobDataInput } from "../../systems/ucpath/index.js";
import type { EmployeeData } from "./schema.js";

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
  // data.ssn may be undefined or "" (both mean no SSN provided)
  const ssnDigits = data.ssn ? data.ssn.replace(/-/g, "") : undefined;
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
  // data.ssn may be undefined or "" (both mean no SSN provided)
  const hasSsn = Boolean(data.ssn);
  const commentsText = buildCommentsText(
    data.effectiveDate,
    data.recruitmentNumber ?? "N/A",
    hasSsn,
  );

  plan.add(
    "Fill comments",
    async () => {
      const frame = getContentFrame(page);
      await frame.locator("#HR_TBH_WRK_DESCRLONG_NOTES").fill(commentsText, { timeout: 10_000 });
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
  const jobData: JobDataInput = {
    positionNumber: data.positionNumber,
    employeeClassification: data.appointment ?? "5",
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
      await frame.locator("#UC_SS_TRANSACT_COMMENTS").fill(commentsText, { timeout: 10_000 });
      log.step(`[TabWalk] Initiator Comments filled (${commentsText.length} chars)`);
    },
  );

  // Step 14: Click back to Personal Data tab (PeopleSoft requires all tabs visited to enable Save)
  plan.add(
    "Click Personal Data tab",
    async () => {
      const frame = getContentFrame(page);
      await dismissModalMask(page);
      await frame.getByRole("tab", { name: "Personal Data" }).click({ timeout: 10_000 });
      await page.waitForTimeout(3_000);
      await waitForPeopleSoftProcessing(frame, 10_000);
      log.success("Personal Data tab loaded (all tabs visited)");
      log.step(`[TabWalk] Personal Data re-clicked — all 4 tabs visited, Save should now be enabled`);
    },
  );

  // Step 15: Save and Submit
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
