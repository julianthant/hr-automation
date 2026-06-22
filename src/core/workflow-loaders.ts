/**
 * Workflow name → lazy loader map. Shared between the daemon entry
 * (`src/cli-daemon.ts`) and the dashboard's `/api/enqueue` endpoint
 * (`src/tracker/dashboard.ts`). Lazy imports keep unrelated workflows out
 * of any given consumer's bundle.
 *
 * To register a new workflow: add one entry here. Both daemon spawn and
 * dashboard enqueue pick it up automatically.
 */
import type { RegisteredWorkflow } from "./kernel/types.js";

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
  // Person Lookup (UCPath + CRM) resolves an employee by name or EID and
  // derives active / HDH status. Merges the former EID Lookup + Active Check.
  "person-lookup": async () => {
    const mod = await import("../workflows/person-lookup/index.js");
    return mod.personLookupWorkflow as unknown as AnyRegisteredWorkflow;
  },
  onboarding: async () => {
    const mod = await import("../workflows/onboarding/index.js");
    return mod.onboardingWorkflow as unknown as AnyRegisteredWorkflow;
  },
  "crm-doc-download": async () => {
    const mod = await import("../workflows/crm-doc-download/index.js");
    return mod.crmDocDownloadWorkflow as unknown as AnyRegisteredWorkflow;
  },
  "oath-signature": async () => {
    const mod = await import("../workflows/oath-signature/index.js");
    return mod.oathSignatureWorkflow as unknown as AnyRegisteredWorkflow;
  },
  "emergency-contact": async () => {
    const mod = await import("../workflows/emergency-contact/index.js");
    return mod.emergencyContactWorkflow as unknown as AnyRegisteredWorkflow;
  },
  "oath-upload": async () => {
    const mod = await import("../workflows/oath-upload/index.js");
    return mod.oathUploadWorkflow as unknown as AnyRegisteredWorkflow;
  },
  // OnBase imports HR documents one-per-person. Fanned out from OCR approval as
  // operation-member rows; no typed dashboard start surface (upload run only).
  onbase: async () => {
    const mod = await import("../workflows/onbase/index.js");
    return mod.onbaseWorkflow as unknown as AnyRegisteredWorkflow;
  },
  // I9 Lookup resolves who signed Section 2 of an employee's I-9 form.
  // Delegated-only subworkflow — no dashboard start surface.
  "i9-lookup": async () => {
    const mod = await import("../workflows/i9-lookup/index.js");
    return mod.i9LookupWorkflow as unknown as AnyRegisteredWorkflow;
  },
};

/**
 * Resolve a workflow name to its registered kernel workflow. Returns
 * `null` for unknown names — callers decide whether to surface a 400 or
 * an internal dispatch error.
 *
 * With `HRAUTO_E2E_STUBS=1` (AI e2e test, mode C) the loaded workflow is
 * wrapped with a scripted stub handler — `src/core/e2e/stub-workflows.ts` —
 * so daemons exercise queue/cancel/parallel machinery without touching real
 * systems. The import stays lazy so normal runs never load the stub module.
 */
export async function loadWorkflow(name: string): Promise<AnyRegisteredWorkflow | null> {
  const loader = WORKFLOW_LOADERS[name];
  if (!loader) return null;
  const wf = await loader();
  if (process.env.HRAUTO_E2E_STUBS === "1") {
    const { maybeWrapE2EStub } = await import("./e2e/stub-workflows.js");
    return maybeWrapE2EStub(name, wf);
  }
  return wf;
}

export function listWorkflowNames(): string[] {
  return Object.keys(WORKFLOW_LOADERS);
}
