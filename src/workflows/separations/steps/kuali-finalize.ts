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
  /** Reconciled Last Day Worked (New Kronos last punch override, else Kuali's). */
  lastDayWorked: string;
  /** Kuali-authoritative separation date (never overridden by Kronos). */
  separationDate: string;
  /** True when `lastDayWorked` differs from the Kuali-extracted LDW. */
  ldwChanged: boolean;
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
  const { kualiPage, kualiData, lastDayWorked, ldwChanged, transactionNumber, finalTermEffDate, timekeeperName } = args;
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
  // Only the Last Day Worked can change (New Kronos last punch overrides Kuali's
  // LDW); the Separation Date is Kuali-authoritative. Emit the date-change note
  // only when the LDW actually moved.
  const dateChangeComments = ldwChanged
    ? buildDateChangeComments(kualiData.lastDayWorked, lastDayWorked, initials)
    : "";
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
  // Capture the ENTIRE Kuali finalization form as ONE clean image of ONLY the
  // Kuali page. `bounded` takes a fixed-width (1280px) full-page shot clipped to
  // that width, so the tall form reads top-to-bottom at a normal column width
  // instead of the old over-widened ribbon slices (the promo footer blew the
  // width to ~2038px → 3 unreadable 6.3:1 ribbons). No stable selector exists
  // for the Kuali finalization document container yet; if one is mapped live,
  // switch this to `region` to also drop the surrounding page chrome.
  await ctx.screenshot({ kind: 'form', label: 'kuali-finalization-saved', systems: ['kuali'], bounded: true });
  log.step(`[Step: kuali-finalization] END took=${Date.now() - t0}ms success`);
}
