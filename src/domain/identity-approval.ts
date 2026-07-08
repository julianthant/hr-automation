/**
 * Identity-approval review — the workflow-agnostic pause-on-identity-mismatch
 * gate, extracted from separations so any identity-resolving workflow can adopt
 * it.
 *
 * ## What it is
 *
 * When a workflow resolves a person's identity (an EID, a name→UCPath match)
 * and the resolved identity is a DIFFERENT valid person than the one on the
 * input record, it is dangerous to silently proceed — separations once
 * terminated the wrong person this way (ticket T002173685). Instead of
 * overriding, the run **PAUSES** into an operator review: it stamps
 * `data.eidApproval = "pending"` + both candidate identities, returns cleanly
 * (the row ends `done` so browsers/queue release), and the dashboard renders the
 * shared `EidApprovalBanner` for the operator to approve a chosen EID (re-queue)
 * or dismiss.
 *
 * ## The three moving parts (all shared, all workflow-agnostic)
 *
 *   1. **Pause data** — `buildIdentityApprovalPauseData(candidates)` produces the
 *      exact `data` stamp the banner reads (`eidApproval`, `status`, both
 *      candidates' `originalEid*`/`proposedEid*` fields).
 *   2. **Status extension** — `identityApprovalStatusExtensions` maps
 *      `data.eidApproval` → the derived `awaitingApproval` / `dismissed` badge.
 *      Declare it as the workflow's `statusExtensions` AND register it in
 *      `queue-row-status-index.ts` for the client bundle.
 *   3. **Approve / dismiss** — `buildApproveEidHandler` / `buildDismissEidHandler`
 *      (`src/control/ops/eid-approval.ts`) re-queue the paused run carrying
 *      `prefilledData.eidApproved = <chosen>` (approve) or stamp the row
 *      `dismissed` (dismiss). Wire the workflow into `EID_APPROVAL_WORKFLOWS`.
 *
 * ## Adoption recipe (how emergency-contact / onbase / any workflow adopt this)
 *
 *   1. **Gate:** at the point the workflow resolves an identity, compare the
 *      resolved person's name against the input record's name with
 *      `classifyNameSimilarity` (`src/services/matching/match.ts`). A `different`
 *      tier (or an outright EID mismatch) is the pause trigger — `same`/`similar`
 *      proceed as today. Gate this on a re-run marker so an approved re-run does
 *      NOT re-pause (read `ctx.data.eidApproved`; skip the gate when it is a
 *      valid EID — see separations' `eidPreApproved` and onboarding's mirror).
 *   2. **Pause:** `ctx.updateData(buildIdentityApprovalPauseData({ original, proposed }))`,
 *      skip/return from the remaining steps, and `return` (end `done`).
 *   3. **Status:** add `statusExtensions: identityApprovalStatusExtensions` to the
 *      workflow's `defineWorkflow`, and `registerWorkflowStatusExtensions(<name>, …)`
 *      in `queue-row-status-index.ts`.
 *   4. **Control:** add the workflow name to `EID_APPROVAL_WORKFLOWS` in
 *      `src/control/ops/eid-approval.ts` so approve/dismiss accept it.
 *   5. **Re-run:** read `ctx.data.eidApproved` at the top of the handler; when it
 *      is a valid EID, force it over extraction and skip the gate.
 *
 * The dashboard `EidApprovalBanner` + the generic `/api/eid-approval/{approve,
 * dismiss}` routes are already workflow-agnostic — no per-workflow UI or route
 * work is needed to adopt.
 */
import type { WorkflowStatusExtensions } from "./queue-row-status.js";

/** Default status label shown while a row is paused awaiting approval. */
export const IDENTITY_APPROVAL_PENDING_STATUS = "Awaiting EID Approval";

/** One candidate identity in the review (the input record's, or the resolved one). */
export interface IdentityApprovalCandidate {
  /** The candidate's EID (`""` when the candidate has no UCPath EID, e.g. a new hire). */
  eid: string;
  /** The candidate's display name. */
  name: string;
  /** Optional department description (blank if unknown). */
  department?: string;
  /** Optional payroll/job title (blank if unknown). */
  payrollTitle?: string;
}

export interface IdentityApprovalPauseInput {
  /** The identity on the input record (Kuali form / CRM record). */
  original: IdentityApprovalCandidate & {
    /** Whether the original EID resolved a UCPath record (drives whether its name shows). */
    found: boolean;
  };
  /** The identity the workflow resolved by name (the "proposed" different person). */
  proposed: IdentityApprovalCandidate;
  /** Overrides the pending status label (default `IDENTITY_APPROVAL_PENDING_STATUS`). */
  statusLabel?: string;
}

/**
 * Build the `data` stamp that pauses a run into the identity-approval review.
 * The keys are exactly what `EidApprovalBanner` reads — do not rename them
 * without updating the banner. Values are all strings so the stamp survives the
 * tracker's stringified-data channel.
 */
export function buildIdentityApprovalPauseData(
  input: IdentityApprovalPauseInput,
): Record<string, string> {
  const { original, proposed } = input;
  return {
    eidApproval: "pending",
    status: input.statusLabel ?? IDENTITY_APPROVAL_PENDING_STATUS,
    // Original (the identity on the input record).
    originalEid: original.eid,
    originalEidName: original.found ? original.name : "",
    originalEidDepartment: original.department ?? "",
    originalEidPayrollTitle: original.payrollTitle ?? "",
    originalEidFound: String(original.found),
    // Proposed (the identity resolved by name).
    proposedEid: proposed.eid,
    proposedEidName: proposed.name,
    proposedEidDepartment: proposed.department ?? "",
    proposedEidPayrollTitle: proposed.payrollTitle ?? "",
  };
}

/** The raw identity-approval state stamped on a row (`""` when none). */
export function identityApprovalState(entry: { data?: Record<string, string> }): string {
  return typeof entry.data?.eidApproval === "string" ? entry.data.eidApproval : "";
}

/**
 * Queue-row status rule shared by every identity-approval-gated workflow.
 *
 *   - `"pending"`   → awaiting operator approval → derived `awaitingApproval`.
 *   - `"dismissed"` → operator reviewed and chose not to re-queue → `dismissed`.
 *
 * Lives in the domain layer (not `src/workflows/*`) so the dashboard can resolve
 * it without importing a workflow module; declared as each workflow's
 * `statusExtensions` and registered in `queue-row-status-index.ts` for the
 * client.
 */
export const identityApprovalStatusExtensions: WorkflowStatusExtensions = {
  derivedStatus: (entry) => {
    const state = identityApprovalState(entry);
    if (state === "pending") return "awaitingApproval";
    if (state === "dismissed") return "dismissed";
    return null;
  },
};
