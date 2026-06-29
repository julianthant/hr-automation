/**
 * Separations' queue-row status extensions — the EID-approval review state.
 *
 * When the `identity-check` step resolves a DIFFERENT EID by name (the Kuali
 * EID and the name-resolved EID disagree), separations no longer silently
 * overrides the EID and submits the termination. Instead it PAUSES: it stamps
 * `data.eidApproval = "pending"` (plus both candidate identities) and returns
 * cleanly so the run ends `done` — the 3 browsers release and the daemon
 * proceeds to the next queued doc. The row then displays "Awaiting Approval"
 * until the operator approves a chosen EID (re-queues the doc) or dismisses it.
 *
 * `data.eidApproval` values:
 *   - `"pending"`   → awaiting operator approval → derived `awaitingApproval`.
 *   - `"dismissed"` → operator reviewed and chose not to re-queue → `dismissed`.
 *
 * Lives in the domain layer (not `src/workflows/separations/`) so the dashboard
 * can resolve it without importing a `src/workflows/*` module — the separations
 * `defineWorkflow` call re-exports this object as its `statusExtensions`
 * declaration, and `queue-row-status-index.ts` registers it for the client.
 */
import type { WorkflowStatusExtensions } from "./queue-row-status.js";

/** The raw EID-approval state stamped on a separations row (`""` when none). */
export function separationEidApprovalState(entry: { data?: Record<string, string> }): string {
  return typeof entry.data?.eidApproval === "string" ? entry.data.eidApproval : "";
}

export const separationsStatusExtensions: WorkflowStatusExtensions = {
  derivedStatus: (entry) => {
    const state = separationEidApprovalState(entry);
    if (state === "pending") return "awaitingApproval";
    if (state === "dismissed") return "dismissed";
    return null;
  },
};
