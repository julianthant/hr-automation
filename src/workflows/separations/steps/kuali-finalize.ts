import type { Page } from "playwright";
import { log } from "../../../utils/log.js";
import {
  fillTransactionResults,
  fillTimekeeperComments,
  verifyTxnNumberFilled,
  clickSave,
} from "../../../systems/kuali/index.js";
import { finalTransactions } from "../../../systems/kuali/selectors.js";
import { buildDateChangeComments, buildSeparationDateChangeComment, getInitials, joinComments } from "../schema.js";
import type { KualiSeparationData } from "../../../systems/kuali/index.js";
import type { Ctx } from "../../../core/kernel/types.js";

export interface KualiFinalizationArgs {
  kualiPage: Page;
  kualiData: KualiSeparationData;
  /** Reconciled Last Day Worked (New Kronos last punch override, else Kuali's). */
  lastDayWorked: string;
  /** Reconciled separation date (last day worked + sick/holiday leave). */
  separationDate: string;
  /** True when `lastDayWorked` differs from the Kuali-extracted LDW. */
  ldwChanged: boolean;
  /** True when `separationDate` differs from the Kuali-extracted separation date. */
  separationDateChanged: boolean;
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
  const { kualiPage, kualiData, lastDayWorked, separationDate, ldwChanged, separationDateChanged, transactionNumber, finalTermEffDate, timekeeperName } = args;
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
  // Both reconciled dates can move: the Last Day Worked (New Kronos last punch
  // override) and the Separation Date (last day worked + sick/holiday leave).
  // Emit an audit line for each that actually changed, newline-joined.
  const dateChangeComments = joinComments(
    ldwChanged ? buildDateChangeComments(kualiData.lastDayWorked, lastDayWorked, initials) : "",
    separationDateChanged
      ? buildSeparationDateChangeComment(kualiData.separationDate, separationDate, initials)
      : "",
  );
  // User-supplied free-form Kuali timekeeper-comments override (set
  // via the dashboard's EditDataTab → prefilledData channel). Joined
  // with auto-generated date-change comments using a newline. The
  // combined string is then handed to `fillTimekeeperComments`, which
  // reads the form's existing value and prepends it (also newline-
  // joined) so nothing the user / prior run wrote gets clobbered.
  const newComments = joinComments(dateChangeComments, (ctx.data.comments as string | undefined) ?? "");
  if (newComments) {
    log.step(`[Kuali] Comments to add: ${newComments}`);
    await fillTimekeeperComments(kualiPage, newComments);
  }

  await verifyTxnNumberFilled(kualiPage, transactionNumber);

  // Capture the FILLED finalization form BEFORE saving. The form's displayed
  // values are identical pre/post-save, so the pre-save shot is the faithful
  // proof of what we finalized; capturing here also sidesteps the post-save
  // navigation back to the Kuali Home apps directory.
  //
  // Written as readable `-cNN` page slices (NO `stitch`) of the ENTIRE
  // finalization form, so the operator steps through it field-by-field in the
  // Screenshots tab (top → … → the Final Transactions section) rather than
  // scrolling one giant tile. The Kuali Build apps catalog stays MOUNTED behind
  // the document view (a ~16000px `overflow:auto` grid); the kernel's
  // `planScrollCapture` occlusion-rejects it (it is painted BEHIND the form, so
  // it is never the top `elementFromPoint`) and picks the visible document
  // scroll container, scroll-capturing its painted bands top-to-bottom so the
  // form is never clipped at its fold. See src/core/CLAUDE.md (Audit Screenshots).
  await ctx.screenshot({ kind: 'form', label: 'kuali-finalization-saved', systems: ['kuali'] });

  await clickSave(kualiPage);
  log.step(`[Step: kuali-finalization] END took=${Date.now() - t0}ms success`);
}
