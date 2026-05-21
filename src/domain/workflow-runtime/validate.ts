import type {
  WorkflowActionKind,
  WorkflowActionPolicy,
  WorkflowActionScope,
  WorkflowActionSource,
  WorkflowRunProjection,
  WorkflowRuntimePolicy,
} from "./types.js";

export const WORKFLOW_ACTION_KINDS = [
  "cancel",
  "retry",
  "delete",
  "bump",
  "stop-daemon",
] as const satisfies readonly WorkflowActionKind[];

export const WORKFLOW_ACTION_SCOPES = [
  "row",
  "group",
  "visible-view",
  "tree",
  "daemon",
] as const satisfies readonly WorkflowActionScope[];

export const WORKFLOW_ACTION_SOURCES = [
  "queue-panel",
  "batch-view",
  "log-panel",
  "daemon",
] as const satisfies readonly WorkflowActionSource[];

const KIND_SET = new Set<string>(WORKFLOW_ACTION_KINDS);
const SCOPE_SET = new Set<string>(WORKFLOW_ACTION_SCOPES);
const SOURCE_SET = new Set<string>(WORKFLOW_ACTION_SOURCES);

export function isValidWorkflowActionKind(kind: string): kind is WorkflowActionKind {
  return KIND_SET.has(kind);
}

export function isValidWorkflowActionScope(scope: string): scope is WorkflowActionScope {
  return SCOPE_SET.has(scope);
}

export function isValidWorkflowActionSource(source: string): source is WorkflowActionSource {
  return SOURCE_SET.has(source);
}

export function validateWorkflowActionPolicy(
  action: WorkflowActionPolicy,
  label: string,
): string[] {
  const errors: string[] = [];
  if (!isValidWorkflowActionKind(action.kind)) {
    errors.push(`${label}: invalid kind "${action.kind}"`);
  }
  if (!isValidWorkflowActionScope(action.scope)) {
    errors.push(`${label}: invalid scope "${action.scope}"`);
  }
  if (!isValidWorkflowActionSource(action.source)) {
    errors.push(`${label}: invalid source "${action.source}"`);
  }
  if (typeof action.enabled !== "boolean") {
    errors.push(`${label}: enabled must be boolean`);
  }
  return errors;
}

export function validateWorkflowRuntimePolicy(
  policy: WorkflowRuntimePolicy,
  workflowId: string,
): string[] {
  const errors: string[] = [];
  const buckets: Array<[string, WorkflowActionPolicy[]]> = [
    ["rowActions", policy.rowActions],
    ["groupActions", policy.groupActions],
    ["batchViewToolbarActions", policy.batchViewToolbarActions],
    ["daemonActions", policy.daemonActions],
  ];
  for (const [bucket, actions] of buckets) {
    for (const [index, action] of actions.entries()) {
      errors.push(
        ...validateWorkflowActionPolicy(action, `${workflowId}.${bucket}[${index}]`),
      );
    }
  }
  return errors;
}

/** Batch-view toolbar actions must not target run ids outside the opened batch members. */
export function batchViewActionsWithinMembers(
  projection: WorkflowRunProjection,
  memberRunIds: readonly string[],
): string[] {
  const allowed = new Set(memberRunIds);
  const errors: string[] = [];
  for (const action of projection.actions) {
    if (action.source !== "batch-view") continue;
    for (const target of action.targets) {
      const runId = target.runId ?? target.id;
      if (!allowed.has(runId)) {
        errors.push(
          `action ${action.kind} targets runId "${runId}" outside batch members [${[...allowed].join(", ")}]`,
        );
      }
    }
  }
  return errors;
}
