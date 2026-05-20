/**
 * Per-workflow runtime policy registry.
 *
 * Phase 4 of the workflow runtime migration. Each workflow's `workflow.ts`
 * calls {@link setWorkflowRuntimePolicy} once at load time to declare how
 * its rows should project, what cancel/retry/delete scopes apply, and how
 * delegation children should surface. Dashboard projections and the
 * central action engine read from this registry via
 * {@link getWorkflowRuntimePolicy} instead of pattern-matching on
 * workflow ids.
 *
 * The registry is intentionally a runtime singleton (not a static import
 * graph) so `src/domain/workflow-runtime/projection.ts` can stay free of
 * `src/workflows/*` imports — the dashboard would otherwise pull every
 * workflow's module into the queue-panel bundle.
 */
import { DEFAULT_WORKFLOW_RUNTIME_POLICY } from "./default-policy.js";
import type { WorkflowRuntimePolicy } from "./types.js";

const POLICIES = new Map<string, WorkflowRuntimePolicy>();

export type WorkflowRuntimePolicyLookup =
  | ReadonlyMap<string, WorkflowRuntimePolicy>
  | Record<string, WorkflowRuntimePolicy | undefined>;

/** Register (or replace) a workflow's runtime policy. Idempotent. */
export function setWorkflowRuntimePolicy(workflowId: string, policy: WorkflowRuntimePolicy): void {
  POLICIES.set(workflowId, policy);
}

/** Look up a workflow's runtime policy; falls back to the default policy. */
export function getWorkflowRuntimePolicy(
  workflowId: string,
  lookup?: WorkflowRuntimePolicyLookup,
): WorkflowRuntimePolicy {
  if (lookup) {
    if (typeof (lookup as ReadonlyMap<string, WorkflowRuntimePolicy>).get === "function") {
      return (lookup as ReadonlyMap<string, WorkflowRuntimePolicy>).get(workflowId)
        ?? POLICIES.get(workflowId)
        ?? DEFAULT_WORKFLOW_RUNTIME_POLICY;
    }
    return (lookup as Record<string, WorkflowRuntimePolicy | undefined>)[workflowId]
      ?? POLICIES.get(workflowId)
      ?? DEFAULT_WORKFLOW_RUNTIME_POLICY;
  }
  return POLICIES.get(workflowId) ?? DEFAULT_WORKFLOW_RUNTIME_POLICY;
}

/** Return every workflow id that has registered a non-default policy. */
export function listRegisteredWorkflowRuntimePolicyIds(): string[] {
  return [...POLICIES.keys()];
}

/** Test-only: wipe the registry between cases. */
export function __resetWorkflowRuntimePoliciesForTests(): void {
  POLICIES.clear();
}
