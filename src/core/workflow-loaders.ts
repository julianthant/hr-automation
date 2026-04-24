/**
 * Workflow name → lazy loader map. Shared between the daemon entry
 * (`src/cli-daemon.ts`) and the dashboard's `/api/enqueue` endpoint
 * (`src/tracker/dashboard.ts`). Lazy imports keep unrelated workflows out
 * of any given consumer's bundle.
 *
 * To register a new workflow: add one entry here. Both daemon spawn and
 * dashboard enqueue pick it up automatically.
 */
import type { RegisteredWorkflow } from "./types.js";

export type AnyRegisteredWorkflow = RegisteredWorkflow<unknown, readonly string[]>;

export const WORKFLOW_LOADERS: Record<string, () => Promise<AnyRegisteredWorkflow>> = {
  separations: async () => {
    const mod = await import("../workflows/separations/index.js");
    return mod.separationsWorkflow as unknown as AnyRegisteredWorkflow;
  },
  "work-study": async () => {
    const mod = await import("../workflows/work-study/index.js");
    return mod.workStudyWorkflow as unknown as AnyRegisteredWorkflow;
  },
  // EID Lookup loader returns the CRM-on variant (UCPath + CRM, no I-9) — the
  // default flag combo. --no-crm / --i9 paths don't share a long-lived daemon
  // and aren't reachable from the dashboard enqueue UI.
  "eid-lookup": async () => {
    const mod = await import("../workflows/eid-lookup/index.js");
    return mod.eidLookupCrmWorkflow as unknown as AnyRegisteredWorkflow;
  },
  onboarding: async () => {
    const mod = await import("../workflows/onboarding/index.js");
    return mod.onboardingWorkflow as unknown as AnyRegisteredWorkflow;
  },
  "oath-signature": async () => {
    const mod = await import("../workflows/oath-signature/index.js");
    return mod.oathSignatureWorkflow as unknown as AnyRegisteredWorkflow;
  },
  "emergency-contact": async () => {
    const mod = await import("../workflows/emergency-contact/index.js");
    return mod.emergencyContactWorkflow as unknown as AnyRegisteredWorkflow;
  },
};

/**
 * Resolve a workflow name to its registered kernel workflow. Returns
 * `null` for unknown names — callers decide whether to surface a 400 or
 * a CLI exit 1.
 */
export async function loadWorkflow(name: string): Promise<AnyRegisteredWorkflow | null> {
  const loader = WORKFLOW_LOADERS[name];
  if (!loader) return null;
  return loader();
}

export function listWorkflowNames(): string[] {
  return Object.keys(WORKFLOW_LOADERS);
}
