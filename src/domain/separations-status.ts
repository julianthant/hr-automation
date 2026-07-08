/**
 * Separations' queue-row status extensions — the EID-approval review state.
 *
 * This is now a thin re-export of the workflow-agnostic identity-approval rule
 * (`src/domain/identity-approval.ts`). Separations was the first adopter of the
 * pause-on-identity-mismatch gate; the mechanism was extracted so onboarding
 * (and later emergency-contact / onbase) can share it. The separations-named
 * exports are preserved so existing imports + tests keep working unchanged.
 *
 * `data.eidApproval` values:
 *   - `"pending"`   → awaiting operator approval → derived `awaitingApproval`.
 *   - `"dismissed"` → operator reviewed and chose not to re-queue → `dismissed`.
 */
import {
  identityApprovalState,
  identityApprovalStatusExtensions,
} from "./identity-approval.js";

/** The raw EID-approval state stamped on a separations row (`""` when none). */
export const separationEidApprovalState = identityApprovalState;

export const separationsStatusExtensions = identityApprovalStatusExtensions;
