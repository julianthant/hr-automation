import type { Page } from "playwright";
import { log } from "../../../utils/log.js";
import {
  fillTransactionResults,
  fillTimekeeperComments,
  verifyTxnNumberFilled,
  clickSave,
} from "../../../systems/kuali/index.js";
import { finalTransactions } from "../../../systems/kuali/selectors.js";
import { buildDateChangeComments, getInitials } from "../schema.js";
import type { KualiSeparationData } from "../../../systems/kuali/index.js";
import type { Ctx } from "../../../core/kernel/types.js";

export interface KualiFinalizationArgs {
  kualiPage: Page;
  kualiData: KualiSeparationData;
  resolved: { lastDayWorked: string; separationDate: string; changed: boolean };
  transactionNumber: string;
  finalTermEffDate: string;
  timekeeperName: string;
}

/**
 * Body of the `kuali-finalization` step.
 * Fills Termination Effective Date, transaction results, date-change comments,
 * and saves the Kuali form.
 */
export async function runKualiFinalize(
  ctx: Ctx<readonly string[], Record<string, unknown>>,
  args: KualiFinalizationArgs,
): Promise<void> {
  const { kualiPage, kualiData, resolved, transactionNumber, finalTermEffDate, timekeeperName } = args;
  const t0 = Date.now();
  log.debug(`[Step: kuali-finalization] START txnNumber='${transactionNumber || "<empty>"}'`);
  log.step("=== PHASE 3: Kuali finalization ===");

  // Termination Effective Date — required for every Kuali save. Lives
  // here (not inside ucpath-job-summary) so the dashboard pipeline
  // accurately distinguishes "Kuali fill" from "UCPath dept/payroll
  // lookup". When no UCPath data was fetched (edit-and-resume bypass
  // path), ucpath-job-summary is skipped entirely and this fill is
  // the only Kuali term-eff-date write that happens.
  log.step(`[Kuali] Filling Termination Effective Date: ${finalTermEffDate}`);
  await finalTransactions.terminationEffDate(kualiPage).fill(finalTermEffDate, { timeout: 5_000 });

  // Always fill checkbox + radio; fill txn number if we have it
  await fillTransactionResults(kualiPage, transactionNumber);
  if (!transactionNumber) {
    log.error("[Kuali] No transaction number — left blank for manual entry");
  }

  const initials = getInitials(timekeeperName);
  const dateChangeComments = buildDateChangeComments(
    kualiData.lastDayWorked, resolved.lastDayWorked,
    kualiData.separationDate, resolved.separationDate,
    initials,
  );
  // User-supplied free-form Kuali timekeeper-comments override (set
  // via the dashboard's EditDataTab → prefilledData channel). Joined
  // with auto-generated date-change comments using a newline. The
  // combined string is then handed to `fillTimekeeperComments`, which
  // reads the form's existing value and prepends it (also newline-
  // joined) so nothing the user / prior run wrote gets clobbered.
  const userComments = ((ctx.data.comments as string | undefined) ?? "").trim();
  const newComments = [dateChangeComments, userComments].filter(Boolean).join("\n");
  if (newComments) {
    log.step(`[Kuali] Comments to add: ${newComments}`);
    await fillTimekeeperComments(kualiPage, newComments);
  }

  await verifyTxnNumberFilled(kualiPage, transactionNumber);
  await clickSave(kualiPage);
  await ctx.screenshot({ kind: 'form', label: 'kuali-finalization-saved' });
  log.step(`[Step: kuali-finalization] END took=${Date.now() - t0}ms success`);
}
