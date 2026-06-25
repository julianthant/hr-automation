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
 * Two INDEPENDENT concerns, deliberately decoupled (2026-06-24):
 *
 *   1. **Approved-reuse** (SS Smart HR search, effdt-gated). Searches SS Smart
 *      HR by EID for an existing termination (TER) and, when one is APPROVED and
 *      within ~14 days of THIS separation, reuses its transaction number — the
 *      handler then skips the UCPath create and files the duplicate-termination
 *      comment. The effdt gate is what keeps a prior-job approved TER from being
 *      reused for the wrong separation, so this concern KEEPS the search.
 *
 *   2. **Pending sweep** (in-progress grid, DATE-AGNOSTIC). On EVERY path that
 *      leads to a fresh create, delete ANY pending "Terminat" row for this EID
 *      from the "Transactions in Progress" grid — regardless of effective date.
 *      This is the real duplicate guard: a prior run can leave a pending
 *      termination whose computed effdt DIFFERS from this run's, and BOTH
 *      date-keyed backstops miss it (the SS Smart HR effdt gate above AND
 *      `ucpath-transaction`'s exact-effdt `findExistingTerminationTransaction`),
 *      so a second create produces a visible duplicate (Erick Guzman 10779506:
 *      06/14 + 06/20, 2026-06-24). The in-progress grid only holds UNPROCESSED
 *      transactions, so any termination there for this person is a superseded
 *      prior attempt; an approved prior-job TER is processed and not in this
 *      grid, so the sweep can't touch it.
 *
 * Result status:
 *   - approved              → reuse (concern 1); NO pending sweep (nothing to
 *                             create, and the approved row isn't in the grid).
 *   - pending-deleted       → the sweep removed ≥1 stale pending; proceed to create.
 *   - pending-skipped-dryrun→ a PENDING TER was visible but the sweep was skipped
 *                             (dry-run guards the only mutation).
 *   - none                  → nothing approved to reuse and nothing pending to
 *                             sweep; proceed to create.
 *
 * The DELETE is the only mutation; it is gated behind `opts.dryRun` so a dry run
 * reports what it WOULD delete without touching UCPath.
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
    // Concern 1 — approved-reuse detection. Pass the Kuali separation date so an
    // existing TER is only REUSED when its effective date is close to THIS
    // separation; a prior termination for a different job (far-off effdt) is
    // ignored. See findTerminationTransactionStatus.
    const ter = await findTerminationTransactionStatus(ucpathPage, eid, {
      separationDate: opts.separationDate,
    });

    // Best-effort audit shot of the SS Smart HR search results so the operator
    // can see exactly what the check found (the TER row + its status).
    try {
      await ctx.screenshot({ kind: "form", label: "transaction-check-ss-smart-hr", systems: ["ucpath"] });
    } catch { /* best-effort */ }

    const status = ter.found ? ter.approvalStatus.trim().toLowerCase() : "";

    if (ter.found && status === "approved") {
      log.warn(
        `[transaction-check] Existing termination #${ter.transactionId} is APPROVED — ` +
        `reusing it (skipping the UCPath transaction create) and filing a duplicate-termination note`,
      );
      return { status: "approved", transactionNumber: ter.transactionId };
    }

    // Concern 2 — every remaining path creates a fresh transaction downstream, so
    // sweep the in-progress grid of ANY stale pending termination for this EID
    // FIRST, regardless of effective date. (Decoupled from the SS Smart HR result
    // above: the sweep runs even when that search found nothing / flagged a
    // prior-job termination, because the stale pending may carry a date the
    // effdt-gated search never matched.)
    if (opts.dryRun) {
      log.warn(
        `[transaction-check] DRY RUN — would delete any pending termination for eid=${eid} from the ` +
        `in-progress grid, then create a fresh transaction (delete skipped in dry-run)`,
      );
      return ter.found && status === "pending"
        ? { status: "pending-skipped-dryrun", transactionId: ter.transactionId }
        : { status: "none" };
    }

    const deletedCount = await deletePendingTransaction(ucpathPage, eid);
    if (deletedCount > 0) {
      log.warn(
        `[transaction-check] Deleted ${deletedCount} pending termination row(s) for eid=${eid} from the ` +
        `in-progress grid before creating a fresh transaction`,
      );
      return { status: "pending-deleted", transactionId: ter.found ? ter.transactionId : "" };
    }
    log.step(
      `[transaction-check] No pending termination in the in-progress grid for eid=${eid} — ` +
      `proceeding to create`,
    );
    return { status: "none" };
  } finally {
    log.step(`[Step: transaction-check] END took=${Date.now() - t0}ms`);
  }
}
