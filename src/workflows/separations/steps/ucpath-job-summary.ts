import type { Page } from "playwright";
import { log } from "../../../utils/log.js";
import { fillFinalTransactions } from "../../../systems/kuali/index.js";
import type { JobSummaryData } from "../../../systems/ucpath/index.js";

/**
 * Body of the `ucpath-job-summary` step.
 * Fills Kuali department + payroll from UCPath Job Summary data.
 */
export async function runUcpathJobSummary(
  kualiPage: Page,
  jobSummaryData: JobSummaryData,
  eid: string,
): Promise<void> {
  const t0 = Date.now();
  log.debug(`[Step: ucpath-job-summary] START eid='${eid}'`);
  log.step("[Kuali] Filling department + payroll from UCPath Job Summary...");
  await fillFinalTransactions(kualiPage, {
    department: jobSummaryData.departmentDescription,
    payrollTitleCode: jobSummaryData.jobCode,
    payrollTitle: jobSummaryData.jobDescription,
  });
  log.success("[Kuali] Department + payroll filled");
  log.step(
    `[Step: ucpath-job-summary] END took=${Date.now() - t0}ms `
    + `dept='${jobSummaryData.departmentDescription ?? ""}' `
    + `jobCode='${jobSummaryData.jobCode ?? ""}' `
    + `payrollTitle='${jobSummaryData.jobDescription ?? ""}'`,
  );
}
