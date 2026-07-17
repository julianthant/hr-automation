/**
 * Separations' queue-row status extensions — two independent rules on the same
 * workflow:
 *
 *   1. **EID-approval review** (`derivedStatus`) — the workflow-agnostic
 *      pause-on-identity-mismatch gate (`src/domain/identity-approval.ts`).
 *      Separations was its first adopter; the separations-named exports are
 *      preserved so existing imports + tests keep working unchanged.
 *      `data.eidApproval`: `"pending"` → `awaitingApproval`, `"dismissed"` →
 *      `dismissed`.
 *
 *   2. **I-9 check result** (`secondaryTag`) — LEGACY display only. The I-9
 *      check split into its own `i9-check` workflow (2026-07-17, see
 *      `src/workflows/i9-check/`), which owns `i9CheckStatusExtensions`
 *      (`src/domain/i9-check-status.ts`). The tag stays registered here so
 *      pre-split separations member rows still on disk keep rendering their
 *      found / not-found chip.
 */
import {
  identityApprovalState,
  identityApprovalStatusExtensions,
} from "./identity-approval.js";
import { i9CheckResultTag } from "./i9-check-status.js";
import type { WorkflowStatusExtensions } from "./queue-row-status.js";

/** The raw EID-approval state stamped on a separations row (`""` when none). */
export const separationEidApprovalState = identityApprovalState;

export { i9CheckResultTag };

export const separationsStatusExtensions: WorkflowStatusExtensions = {
  derivedStatus: identityApprovalStatusExtensions.derivedStatus,
  secondaryTag: (entry) => i9CheckResultTag(entry),
};
