import { launchBrowser } from "../../browser/launch.js";
import { log, withLogContext } from "../../utils/log.js";
import { errorMessage } from "../../utils/errors.js";
import { loginToUCPath } from "../../auth/login.js";
import { TransactionError } from "../../ucpath/types.js";
import { buildWorkStudyPlan } from "./enter.js";
import type { WorkStudyContext } from "./enter.js";
import type { WorkStudyInput } from "./schema.js";
import { updateWorkStudyTracker } from "./tracker.js";
import { startDashboard, stopDashboard } from "../../tracker/dashboard.js";

export interface WorkStudyOptions {
  dryRun?: boolean;
}

/**
 * Run the work study PayPath workflow for a single employee.
 *
 * Flow: Login to UCPath → Navigate to PayPath Actions → Search employee →
 *       Fill position data (eff date, reason JRL, pool F) →
 *       Fill Job Data comments → Fill Initiator's Comments → Save and Submit
 */
export async function runWorkStudy(
  input: WorkStudyInput,
  options: WorkStudyOptions = {},
): Promise<void> {
  startDashboard("work-study");
  try {
  await withLogContext("work-study", input.emplId, async () => {
  if (options.dryRun) {
    const ctx: WorkStudyContext = { employeeName: "" };
    const plan = buildWorkStudyPlan(input, null as never, ctx);
    log.step("=== DRY RUN MODE ===");
    plan.preview();
    log.success("Dry run complete -- no changes made to UCPath");
    return;
  }

  const { browser, page } = await launchBrowser();
  const ctx: WorkStudyContext = { employeeName: "" };

  try {
    log.step("Authenticating to UCPath...");
    const ok = await loginToUCPath(page);
    if (!ok) {
      log.error("UCPath authentication failed");
      process.exit(1);
    }

    const plan = buildWorkStudyPlan(input, page, ctx);
    log.step("Executing work study transaction plan...");
    await plan.execute();

    log.success("Work study transaction completed successfully");

    try {
      await updateWorkStudyTracker({
        emplId: input.emplId,
        employeeName: ctx.employeeName,
        effectiveDate: input.effectiveDate,
        positionPool: "F",
        status: "Done",
        error: "",
        timestamp: new Date().toISOString(),
      });
      log.success("Tracker updated: work-study-tracker.xlsx");
    } catch (trackerErr) {
      log.error(`Tracker update failed (non-fatal): ${errorMessage(trackerErr)}`);
    }
  } catch (error) {
    const errMsg = error instanceof TransactionError
      ? `Transaction failed at step: ${error.step ?? "unknown"} — ${error.message}`
      : errorMessage(error);

    try {
      await updateWorkStudyTracker({
        emplId: input.emplId,
        employeeName: ctx.employeeName,
        effectiveDate: input.effectiveDate,
        positionPool: "F",
        status: "Failed",
        error: errMsg,
        timestamp: new Date().toISOString(),
      });
    } catch {
      // Non-fatal
    }

    if (error instanceof TransactionError) {
      log.error(`Transaction failed at step: ${error.step ?? "unknown"}`);
      log.error(error.message);
    } else {
      log.error(`Transaction failed: ${errorMessage(error)}`);
    }
    process.exit(1);
  }
  }); // end withLogContext
  } finally {
    stopDashboard();
  }
}
