/**
 * Separations EID-approval review — approve / dismiss facade.
 *
 * The mechanism is now workflow-agnostic (`src/control/ops/eid-approval.ts` +
 * `src/domain/identity-approval.ts`); separations was the first adopter. These
 * separations-named builders are preserved so existing routes + tests keep
 * working unchanged — they just bind `workflow: "separations"` onto the generic
 * handler. See `eid-approval.ts` for the full approve/dismiss contract.
 */
import {
  buildApproveEidHandler,
  buildDismissEidHandler,
  type EidApprovalResult,
} from "./eid-approval.js";

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

export type SeparationEidApprovalResult = EidApprovalResult;

/** Approve a chosen EID and re-enqueue the doc as a fresh, gate-skipping run. */
export function buildApproveSeparationEidHandler(dir: string) {
  const approve = buildApproveEidHandler(dir);
  return (req: ApproveSeparationEidRequest): Promise<SeparationEidApprovalResult> =>
    approve({ ...req, workflow: WORKFLOW });
}

/** Dismiss the review: mark the paused row dismissed (neutral terminal); no re-queue. */
export function buildDismissSeparationEidHandler(dir: string) {
  const dismiss = buildDismissEidHandler(dir);
  return (req: DismissSeparationEidRequest): Promise<SeparationEidApprovalResult> =>
    dismiss({ ...req, workflow: WORKFLOW });
}
