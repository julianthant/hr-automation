/**
 * Oath-signature's queue-row status extensions — the intentional-skip state.
 *
 * Oath-signature verifies onboarding completion in ACT CRM before touching
 * UCPath. When it deliberately records nothing it stamps `data.skipped = "true"`
 * (+ a human `data.skipReason`) and returns cleanly, so the run ends `done`. The
 * row then displays the muted "Skipped" badge instead of a green "Done".
 *
 * Three skip cases, all `data.skipped === "true"`:
 *   - no ACT CRM onboarding record for the EID → "No CRM onboarding record";
 *   - a CRM record exists but the onboarding history has no
 *     "Witness Ceremony Oath New Hire Signed" event → "Oath not signed in onboarding";
 *   - an oath signature row is already on the UCPath profile → "Oath already on file"
 *     (the signature date is still recorded from CRM / the existing row).
 *
 * Lives in the domain layer (not `src/workflows/oath-signature/`) so the
 * dashboard can resolve it without importing a `src/workflows/*` module — the
 * oath-signature `defineWorkflow` call re-exports this object as its
 * `statusExtensions`, and `queue-row-status-index.ts` registers it for the client.
 */
import type { WorkflowStatusExtensions } from "./queue-row-status.js";

/** True when a row was intentionally skipped (any of the three cases above). */
export function isOathSignatureSkipped(entry: { data?: Record<string, string> }): boolean {
  return entry.data?.skipped === "true";
}

export const oathSignatureStatusExtensions: WorkflowStatusExtensions = {
  derivedStatus: (entry) => (isOathSignatureSkipped(entry) ? "skipped" : null),
};
