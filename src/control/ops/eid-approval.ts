/**
 * Identity-approval review — workflow-agnostic approve / dismiss handlers.
 *
 * When a workflow's identity resolution finds a DIFFERENT valid person than the
 * one on the input record, the run PAUSES into the EID-approval review
 * (`data.eidApproval = "pending"`, see `src/domain/identity-approval.ts`). The
 * operator then either:
 *
 *   - **approves** a chosen EID (the input record's, the resolved one, or a
 *     manually-typed one) → we RE-ENQUEUE the item as a FRESH run carrying ONLY
 *     `prefilledData.eidApproved = <chosen>`. The handler forces that EID, skips
 *     the identity gate (no re-pause), and otherwise runs fully fresh. We
 *     deliberately do NOT merge the paused run's accumulated tracker strings (the
 *     way `/api/run-with-data` does): that would prefill downstream values and
 *     carry the stale `eidApproval=pending` forward.
 *
 *   - **dismisses** it → we stamp the paused row `eidApproval = "dismissed"` (a
 *     neutral terminal, NOT a failure) and re-queue nothing; the operator fixes
 *     the input record by hand.
 *
 * These are the SAME handlers separations uses (via the separations-named facade
 * in `separations-eid-approval.ts`); the workflow now rides the request payload
 * instead of being baked into the builder, so onboarding (and future adopters)
 * reuse them by adding the workflow to `EID_APPROVAL_WORKFLOWS`.
 */
import { enqueueFromHttp } from "../../core/daemon/enqueue-dispatch.js";
import { isUcpathEmployeeId, normalizeEid } from "../../domain/identity/eid.js";
import { findEntryInput } from "./retry.js";
import { emitInheritedRow, PriorTrackerRowNotFoundError } from "./emit-inherited.js";
import { errorMessage } from "../../utils/errors.js";
import { log } from "../../utils/log.js";

/**
 * Workflows that adopt the identity-approval gate. A re-enqueue drives a REAL
 * transaction, so an unknown/forged workflow name must fail loud rather than
 * enqueue into an arbitrary daemon. Add a workflow here when it adopts the gate.
 */
export const EID_APPROVAL_WORKFLOWS = new Set<string>(["separations", "onboarding"]);

export interface ApproveEidRequest {
  workflow: string;
  id: string;
  runId?: string;
  /** The EID the operator chose to proceed with (original / proposed / manual). */
  eid: string;
  date?: string;
}

export interface DismissEidRequest {
  workflow: string;
  id: string;
  runId?: string;
  date?: string;
}

export interface EidApprovalResult {
  ok: boolean;
  error?: string;
}

/** Approve a chosen EID and re-enqueue the item as a fresh, gate-skipping run. */
export function buildApproveEidHandler(dir: string) {
  return async (req: ApproveEidRequest): Promise<EidApprovalResult> => {
    if (!EID_APPROVAL_WORKFLOWS.has(req.workflow)) {
      return { ok: false, error: `approve-eid: unsupported workflow "${req.workflow}"` };
    }
    const eid = normalizeEid(req.eid ?? "");
    if (!isUcpathEmployeeId(eid)) {
      return { ok: false, error: `approve-eid: "${req.eid}" is not a valid 8-digit UCPath EID` };
    }
    if (!req.id) return { ok: false, error: "approve-eid: id is required" };

    // Read the pristine original input (docId/email, dryRun, …) for this paused run.
    const lookup = findEntryInput(req.workflow, req.id, req.runId, dir, req.date);
    if ("error" in lookup) return { ok: false, error: lookup.error };

    // Fresh run = original input + ONLY the approved-EID marker (no accumulated
    // merge). The handler reads `prefilledData.eidApproved`, forces the EID, and
    // skips the gate.
    const input = { ...lookup.input, prefilledData: { eidApproved: eid } };
    const result = await enqueueFromHttp(req.workflow, [input], { trackerDir: dir });
    if (!result.ok) return { ok: false, error: result.error ?? "approve-eid: enqueue failed" };

    log.step(
      `[approve-eid] re-queued ${req.workflow} item id=${req.id} with operator-approved EID ${eid}`,
    );
    return { ok: true };
  };
}

/** Dismiss the review: mark the paused row dismissed (neutral terminal); no re-queue. */
export function buildDismissEidHandler(dir: string) {
  return (req: DismissEidRequest): Promise<EidApprovalResult> => {
    if (!EID_APPROVAL_WORKFLOWS.has(req.workflow)) {
      return Promise.resolve({ ok: false, error: `dismiss-eid: unsupported workflow "${req.workflow}"` });
    }
    if (!req.id) return Promise.resolve({ ok: false, error: "dismiss-eid: id is required" });
    try {
      emitInheritedRow({
        workflow: req.workflow,
        trackerDir: dir,
        id: req.id,
        runId: req.runId,
        status: "done",
        data: {
          eidApproval: "dismissed",
          status: "EID Approval Dismissed",
        },
      });
      log.step(`[dismiss-eid] dismissed EID-approval review for ${req.workflow} item id=${req.id}`);
      return Promise.resolve({ ok: true });
    } catch (err) {
      if (err instanceof PriorTrackerRowNotFoundError) {
        return Promise.resolve({ ok: false, error: errorMessage(err) });
      }
      throw err;
    }
  };
}
