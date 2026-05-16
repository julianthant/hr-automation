import { log } from "../../../utils/log.js";
import { errorMessage } from "../../../utils/errors.js";
import {
  navigateToSmartHR,
  getContentFrame,
  clickSmartHRTransactions,
  selectTemplate,
  enterEffectiveDate,
  clickCreateTransaction,
  selectReasonCode,
  fillComments,
  clickSaveAndSubmit,
  findExistingTerminationTransaction,
} from "../../../systems/ucpath/index.js";
import { ssSmartHRTransactions } from "../../../systems/ucpath/selectors.js";
import type { KualiSeparationData } from "../../../systems/kuali/index.js";
import type { Ctx } from "../../../core/kernel/types.js";

export interface UcpathTransactionResult {
  transactionNumber: string;
  submittedWithoutTxnNumber: boolean;
}

/**
 * Body of the `ucpath-transaction` step.
 * Creates the UCPath Smart HR termination transaction.
 * Returns the transaction number (may be empty on soft failures) and
 * a flag indicating whether submit succeeded but no txn # was extracted.
 */
export async function runUcpathTransaction(
  ctx: Ctx<readonly string[], Record<string, unknown>>,
  kualiData: KualiSeparationData,
  finalTermEffDate: string,
  ucpathReason: string,
  finalComments: string,
  template: string,
  initialTransactionNumber: string,
): Promise<UcpathTransactionResult> {
  const t0 = Date.now();
  log.debug(`[Step: ucpath-transaction] START empl='${kualiData.eid}' template='${template}'`);
  let transactionNumber = initialTransactionNumber;
  let submittedWithoutTxnNumber = false;
  try {
    log.step("=== UCPath Smart HR Transaction ===");
    const ucpathPage = await ctx.page("ucpath");

    // Pre-submit existence check — match by EID (Person ID column) +
    // effective date + "Terminatn" action. Names are unreliable
    // (Kuali-vs-UCPath nickname/spelling/column-order variants cause
    // real dupes — EID 10794813 Aki Uchida, 2026-04-24); EID is
    // deterministic. If a row already exists, reuse its txn# and skip
    // the submit.
    const existingTxn = await findExistingTerminationTransaction(
      ucpathPage,
      kualiData.eid,
      finalTermEffDate,
    );
    if (existingTxn) {
      log.warn(`[UCPath Txn] Existing termination transaction #${existingTxn} found on Smart HR list — skipping submit.`);
      transactionNumber = existingTxn;
      // Persist the txn # immediately. If kuali-finalization throws
      // later, the handler exits before the final updateData at the end
      // of the body — without this inline call the dashboard detail
      // panel shows "—".
      ctx.updateData({ transactionNumber, existingTransactionFound: "true" });
      await ctx.screenshot({ kind: 'form', label: 'ucpath-transaction-existing' });
      return { transactionNumber, submittedWithoutTxnNumber };
    }

    try {
      await navigateToSmartHR(ucpathPage);
      await clickSmartHRTransactions(ucpathPage);

      const frame = getContentFrame(ucpathPage);
      await selectTemplate(frame, template);
      await enterEffectiveDate(frame, finalTermEffDate);

      const createResult = await clickCreateTransaction(ucpathPage, frame);
      if (!createResult.success) {
        log.error(`[UCPath Txn] Create failed: ${createResult.error}`);
        return { transactionNumber, submittedWithoutTxnNumber };
      }
      log.step("[UCPath Txn] Filling Empl ID...");
      await ssSmartHRTransactions.emplIdInput(frame).fill(kualiData.eid, { timeout: 10_000 });
      await selectReasonCode(ucpathPage, frame, ucpathReason);
      await fillComments(frame, finalComments);

      const submitResult = await clickSaveAndSubmit(ucpathPage, frame, kualiData.eid);
      transactionNumber = submitResult.transactionNumber ?? "";
      log.step(
        `[UCPath Txn] submit result: success=${submitResult.success} `
        + `txnNumber='${transactionNumber || "<empty>"}' `
        + `reasonMessage='${submitResult.error ?? "<none>"}'`,
      );
      if (!submitResult.success) {
        log.error(`[UCPath Txn] Submit failed: ${submitResult.error}`);
        return { transactionNumber, submittedWithoutTxnNumber };
      }
      if (!transactionNumber) {
        submittedWithoutTxnNumber = true;
        return { transactionNumber, submittedWithoutTxnNumber };
      }
      // Persist txn # immediately so kuali-finalization failures don't
      // drop it from the tracker entry's data.
      ctx.updateData({ transactionNumber });
      log.success(`[UCPath Txn] Transaction submitted (#${transactionNumber})`);
      await ctx.screenshot({ kind: 'form', label: 'ucpath-transaction-submitted' });
    } catch (e) {
      log.error(`[UCPath Txn] Failed: ${errorMessage(e)}`);
      // Diagnostic capture for this soft-failure path. The handler
      // intentionally swallows the throw (kuali-finalization still runs
      // with an empty txn#), so the kernel's step-failure screenshot
      // never fires — explicit ctx.screenshot keeps the debug image
      // reachable from the dashboard Screenshots panel.
      await ctx.screenshot({ kind: "error", label: "ucpath-transaction-failed" });
    }

    // In batch mode, navigate UCPath back to Smart HR base URL so the next
    // doc's transaction starts from a clean page. Kernel's between-items
    // reset also does this via the resetUrl SystemConfig field, but
    // we do it immediately here so the current phase3 step doesn't collide
    // with a confirmation modal left over on the page.
    if (ctx.isBatch) {
      try {
        await navigateToSmartHR(ucpathPage);
      } catch {
        // Non-fatal — the between-items reset will retry
      }
    }
  } finally {
    log.step(
      `[Step: ucpath-transaction] END took=${Date.now() - t0}ms `
      + `txnNumber='${transactionNumber || "<empty>"}'`,
    );
  }
  return { transactionNumber, submittedWithoutTxnNumber };
}
