/**
 * Separations EID-approval review — approve / dismiss handlers.
 *
 * When `identity-check` resolves a DIFFERENT EID by name, the run PAUSES into the
 * EID-approval review (`data.eidApproval = "pending"`, see
 * `src/workflows/separations/workflow.ts` + `src/domain/separations-status.ts`).
 * The operator then either:
 *
 *   - **approves** a chosen EID (the original Kuali one, the proposed
 *     name-resolved one, or a manually-typed one) → we RE-ENQUEUE the doc as a
 *     FRESH run carrying ONLY `prefilledData.eidApproved = <chosen>`. The handler
 *     forces that EID, skips the identity-check gate (no re-pause), and otherwise
 *     runs fully fresh — re-reading the form, the approved person's Job Summary +
 *     Kronos, and filing the transaction. We deliberately do NOT merge the
 *     paused run's accumulated tracker strings (the way `/api/run-with-data`
 *     does): that would prefill the dates and skip the approved person's Kronos
 *     read, and would carry the stale `eidApproval=pending` forward.
 *
 *   - **dismisses** it → we stamp the paused row `eidApproval = "dismissed"` (a
 *     neutral terminal, NOT a failure) and re-queue nothing; the operator fixes
 *     the Kuali form by hand.
 */
import { enqueueFromHttp } from "../../core/daemon/enqueue-dispatch.js";
import { isUcpathEmployeeId, normalizeEid } from "../../domain/identity/eid.js";
import { findEntryInput } from "./retry.js";
import { emitInheritedRow, PriorTrackerRowNotFoundError } from "./emit-inherited.js";
import { errorMessage } from "../../utils/errors.js";
import { log } from "../../utils/log.js";

const WORKFLOW = "separations";

export interface ApproveSeparationEidRequest {
  id: string;
  runId?: string;
  /** The EID the operator chose to proceed with (original / proposed / manual). */
  eid: string;
  date?: string;
}

export interface DismissSeparationEidRequest {
  id: string;
  runId?: string;
  date?: string;
}

export interface SeparationEidApprovalResult {
  ok: boolean;
  error?: string;
}

/** Approve a chosen EID and re-enqueue the doc as a fresh, gate-skipping run. */
export function buildApproveSeparationEidHandler(dir: string) {
  return async (req: ApproveSeparationEidRequest): Promise<SeparationEidApprovalResult> => {
    const eid = normalizeEid(req.eid ?? "");
    if (!isUcpathEmployeeId(eid)) {
      return { ok: false, error: `approve-eid: "${req.eid}" is not a valid 8-digit UCPath EID` };
    }
    if (!req.id) return { ok: false, error: "approve-eid: id is required" };

    // Read the pristine original input (docId, dryRun, …) for this paused run.
    const lookup = findEntryInput(WORKFLOW, req.id, req.runId, dir, req.date);
    if ("error" in lookup) return { ok: false, error: lookup.error };

    // Fresh run = original input + ONLY the approved-EID marker (no accumulated
    // merge). The handler reads `prefilledData.eidApproved`, forces the EID, and
    // skips the gate.
    const input = { ...lookup.input, prefilledData: { eidApproved: eid } };
    const result = await enqueueFromHttp(WORKFLOW, [input], { trackerDir: dir });
    if (!result.ok) return { ok: false, error: result.error ?? "approve-eid: enqueue failed" };

    log.step(
      `[approve-eid] re-queued separations doc id=${req.id} with operator-approved EID ${eid}`,
    );
    return { ok: true };
  };
}

/** Dismiss the review: mark the paused row dismissed (neutral terminal); no re-queue. */
export function buildDismissSeparationEidHandler(dir: string) {
  return (req: DismissSeparationEidRequest): Promise<SeparationEidApprovalResult> => {
    if (!req.id) return Promise.resolve({ ok: false, error: "dismiss-eid: id is required" });
    try {
      emitInheritedRow({
        workflow: WORKFLOW,
        trackerDir: dir,
        id: req.id,
        runId: req.runId,
        status: "done",
        data: {
          eidApproval: "dismissed",
          status: "EID Approval Dismissed",
        },
      });
      log.step(`[dismiss-eid] dismissed EID-approval review for separations doc id=${req.id}`);
      return Promise.resolve({ ok: true });
    } catch (err) {
      if (err instanceof PriorTrackerRowNotFoundError) {
        return Promise.resolve({ ok: false, error: errorMessage(err) });
      }
      throw err;
    }
  };
}
