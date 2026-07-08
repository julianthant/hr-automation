import { log } from "../../../utils/log.js";
import { errorMessage } from "../../../utils/errors.js";
import { WorkflowError } from "../../../domain/workflow-error.js";
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
  scrollToTransactionReadbackArea,
} from "../../../systems/ucpath/index.js";
import { ssSmartHRTransactions } from "../../../systems/ucpath/selectors.js";
import type { KualiSeparationData } from "../../../systems/kuali/index.js";
import type { Ctx } from "../../../core/kernel/types.js";

export interface UcpathTransactionResult {
  transactionNumber: string;
  submittedWithoutTxnNumber: boolean;
}

/**
 * Thrown when UCPath rejects the Empl ID on the "Enter Transaction Details"
 * page: the field renders red, "Continue" never advances, and the downstream
 * comments fill times out on a page that never loaded. We detect that stuck
 * state and surface a clear, actionable error instead of the opaque
 * comments-textarea timeout. It is FATAL — it escapes the step's soft-failure
 * catch (which otherwise swallows the error and lets Kuali finalization run
 * with a blank txn #).
 */
export class EmplIdNotRecognizedError extends WorkflowError {
  constructor(emplId: string, employeeName: string) {
    super(
      `UCPath did not recognize Empl ID "${emplId}" for "${employeeName}" — the Smart HR ` +
      `transaction never advanced past "Enter Transaction Details" (the Empl ID field is in an ` +
      `error state / no Employment Record was found). The EID was name-verified upstream, so ` +
      `confirm the employee has an active employment record eligible for termination, then retry.`,
    );
    this.name = "EmplIdNotRecognizedError";
  }
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
    const lookupResult = await findExistingTerminationTransaction(
      ucpathPage,
      kualiData.eid,
      finalTermEffDate,
    );
    if (lookupResult.txnNumber) {
      log.warn(`[UCPath Txn] Existing termination transaction #${lookupResult.txnNumber} found on Smart HR list — skipping submit.`);
      transactionNumber = lookupResult.txnNumber;
      // Persist the txn # immediately. If kuali-finalization throws
      // later, the handler exits before the final updateData at the end
      // of the body — without this inline call the dashboard detail
      // panel shows "—".
      ctx.updateData({ transactionNumber });
      await ctx.screenshot({ kind: 'form', label: 'ucpath-transaction-existing', systems: ['ucpath'], stitch: true });
      return { transactionNumber, submittedWithoutTxnNumber };
    }

    try {
      // When findExistingTerminationTransaction left the page at Smart HR
      // Transactions (alreadyAtSmartHR=true), skip the double navigation
      // (~12s saving per doc). Otherwise navigate from scratch.
      if (!lookupResult.alreadyAtSmartHR) {
        await navigateToSmartHR(ucpathPage);
        await clickSmartHRTransactions(ucpathPage);
      } else {
        log.step("[UCPath Txn] Already at Smart HR Transactions — skipping re-navigation");
      }

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

      // fillComments fills the first field on the page AFTER "Enter Transaction
      // Details". If it times out, the most common cause is that "Continue"
      // never advanced because UCPath rejected the Empl ID (red field / no
      // Employment Record). Detect that stuck state — the Empl ID input is
      // still present because we never left the details page — and rethrow a
      // clear, FATAL error instead of the opaque comments-textarea timeout.
      // Only runs on the failure path, so the happy path is untouched.
      try {
        await fillComments(ucpathPage, frame, finalComments);
      } catch (e) {
        const stillOnDetails = await ssSmartHRTransactions
          .emplIdInput(frame)
          .isVisible({ timeout: 2_000 })
          .catch(() => false);
        if (stillOnDetails) {
          await ctx.screenshot({ kind: "error", label: "ucpath-emplid-not-recognized", systems: ['ucpath'], stitch: true });
          throw new EmplIdNotRecognizedError(kualiData.eid, kualiData.employeeName);
        }
        throw e;
      }

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
        await scrollToTransactionReadbackArea(getContentFrame(ucpathPage));
        await ctx.screenshot({ kind: 'error', label: 'ucpath-transaction-submitted-missing-number', systems: ['ucpath'], stitch: true });
        return { transactionNumber, submittedWithoutTxnNumber };
      }
      // Persist txn # immediately so kuali-finalization failures don't
      // drop it from the tracker entry's data.
      ctx.updateData({ transactionNumber });
      log.success(`[UCPath Txn] Transaction submitted (#${transactionNumber})`);
      // Unified whole-page/form capture of the WHOLE submitted UCPath
      // confirmation. The kernel detects the nested PeopleSoft content frame
      // (`#main_target_win0`) as the dominant scroll target and scroll-captures
      // its painted bands, so the entire in-frame form — Position → Last Date
      // Worked → Comments → the `Transaction ID: T…` readback at the very bottom —
      // is captured, proving the transaction number. LIVE-VERIFIED 2026-06-25
      // (dry-run): the nested iframe's bottom status box + footer buttons are
      // present. The scrolled bands composite into ONE continuous image (the whole
      // Smart HR transaction as a single screenshot). The kernel stitches every
      // capture by default now (2026-07-01), so `stitch: true` is redundant here —
      // kept explicit to document the intent. See src/core/CLAUDE.md.
      await ctx.screenshot({ kind: 'form', label: 'ucpath-transaction-submitted', systems: ['ucpath'], stitch: true });
    } catch (e) {
      // Empl-ID-not-recognized is FATAL and self-explanatory — let it escape so
      // the run fails with the clear message (its own screenshot already fired)
      // instead of falling through to a blank Kuali finalization.
      if (e instanceof EmplIdNotRecognizedError) throw e;
      log.error(`[UCPath Txn] Failed: ${errorMessage(e)}`);
      // Diagnostic capture for this soft-failure path. The error is swallowed
      // here (kuali-finalization still runs, preps the form blank for manual
      // entry); the run then fails downstream on the empty txn # (see the
      // separations handler), so the kernel's step-failure screenshot never
      // fires — explicit ctx.screenshot keeps the debug image reachable from
      // the dashboard Screenshots panel.
      await ctx.screenshot({ kind: "error", label: "ucpath-transaction-failed", systems: ['ucpath'], stitch: true });
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
