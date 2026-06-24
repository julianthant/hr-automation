import { log } from "../../../utils/log.js";
import {
  findTerminationTransactionStatus,
  deletePendingTransaction,
} from "../../../systems/ucpath/index.js";
import type { Ctx } from "../../../core/kernel/types.js";

/**
 * Outcome of the `transaction-check` step. The handler branches on `status`:
 *   - `none`                  → no existing termination (or one in an unhandled
 *                               status) → create a new UCPath transaction as usual.
 *   - `approved`              → an APPROVED termination already exists → reuse its
 *                               `transactionNumber`, SKIP the UCPath create, and
 *                               file the duplicate-termination comment in Kuali.
 *   - `pending-deleted`       → a PENDING termination was found AND deleted (live)
 *                               → proceed to create a fresh transaction.
 *   - `pending-skipped-dryrun`→ a PENDING termination was found but NOT deleted
 *                               (dry-run guards the mutation) → preview only.
 */
export type TransactionCheckResult =
  | { status: "none" }
  | { status: "approved"; transactionNumber: string }
  | { status: "pending-deleted"; transactionId: string }
  | { status: "pending-skipped-dryrun"; transactionId: string };

/**
 * Body of the `transaction-check` step. Runs AFTER `identity-check`, so the EID
 * it searches with is the verified one (a wrong EID is corrected by
 * person-lookup inside identity-check first).
 *
 * Searches SS Smart HR Transactions by EID for an existing termination (TER)
 * row and branches on its approval status:
 *   - none      → proceed (create the transaction downstream).
 *   - Approved  → reuse the existing transaction number; the handler skips the
 *                 UCPath create and files the duplicate-termination comment.
 *   - Pending   → delete it (LIVE only; the dry-run path reports the intent),
 *                 then proceed to create a fresh transaction.
 *   - other     → log + proceed; `ucpath-transaction`'s own
 *                 `findExistingTerminationTransaction` is the duplicate backstop.
 *
 * The DELETE is the only mutation; it is gated behind `opts.dryRun` so a dry
 * run reports what it WOULD delete without touching UCPath.
 */
export async function runTransactionCheck(
  ctx: Ctx<readonly string[], Record<string, unknown>>,
  eid: string,
  opts: { dryRun: boolean; separationDate?: string },
): Promise<TransactionCheckResult> {
  const t0 = Date.now();
  log.debug(`[Step: transaction-check] START eid='${eid}' dryRun=${opts.dryRun} sepDate='${opts.separationDate ?? ""}'`);
  try {
    log.step("=== Transaction Check (SS Smart HR) ===");
    const ucpathPage = await ctx.page("ucpath");
    // Pass the Kuali separation date so an existing TER is only reused/deleted
    // when its effective date is close to THIS separation — a prior termination
    // for a different job (far-off effdt) is ignored and a fresh transaction is
    // created. See findTerminationTransactionStatus.
    const ter = await findTerminationTransactionStatus(ucpathPage, eid, {
      separationDate: opts.separationDate,
    });

    // Best-effort audit shot of the SS Smart HR search results so the operator
    // can see exactly what the check found (the TER row + its status).
    try {
      await ctx.screenshot({ kind: "form", label: "transaction-check-ss-smart-hr", systems: ["ucpath"] });
    } catch { /* best-effort */ }

    if (!ter.found) {
      log.step(
        ter.priorTerminationSkipped
          ? `[transaction-check] The only existing termination (effdt ${ter.effectiveDate}) is a PRIOR ` +
            `termination for a different job — not this separation; proceeding to create a fresh transaction`
          : "[transaction-check] No existing termination — proceeding to create one",
      );
      return { status: "none" };
    }

    const status = ter.approvalStatus.trim().toLowerCase();

    if (status === "approved") {
      log.warn(
        `[transaction-check] Existing termination #${ter.transactionId} is APPROVED — ` +
        `reusing it (skipping the UCPath transaction create) and filing a duplicate-termination note`,
      );
      return { status: "approved", transactionNumber: ter.transactionId };
    }

    if (status === "pending") {
      if (opts.dryRun) {
        log.warn(
          `[transaction-check] DRY RUN — existing termination #${ter.transactionId} is PENDING; ` +
          `would delete it (delete skipped in dry-run), then create a fresh transaction`,
        );
        return { status: "pending-skipped-dryrun", transactionId: ter.transactionId };
      }
      log.warn(
        `[transaction-check] Existing termination #${ter.transactionId} is PENDING — deleting it, ` +
        `then creating a fresh transaction`,
      );
      const deleted = await deletePendingTransaction(ucpathPage, eid);
      if (!deleted) {
        log.warn(
          `[transaction-check] Could not delete pending termination #${ter.transactionId} — ` +
          `proceeding anyway (ucpath-transaction's existence check is the duplicate backstop)`,
        );
      }
      return { status: "pending-deleted", transactionId: ter.transactionId };
    }

    // Any other status (Denied / Error / Pushed Back / Cancelled / Manually
    // Processed): not one of the two handled cases. Log and proceed normally —
    // ucpath-transaction's own existence check still guards against a duplicate
    // submit. (Operator-confirmed: only Approved reuses, only Pending deletes.)
    log.warn(
      `[transaction-check] Existing termination #${ter.transactionId} has status ` +
      `'${ter.approvalStatus}' (not Approved/Pending) — proceeding normally`,
    );
    return { status: "none" };
  } finally {
    log.step(`[Step: transaction-check] END took=${Date.now() - t0}ms`);
  }
}
