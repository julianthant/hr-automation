import type {
  WorkflowActionPolicy,
  WorkflowRuntimePolicy,
} from "./types.js";

export function workflowAction(
  kind: WorkflowActionPolicy["kind"],
  scope: WorkflowActionPolicy["scope"],
  source: WorkflowActionPolicy["source"],
  label: string,
  extra: Partial<WorkflowActionPolicy> = {},
): WorkflowActionPolicy {
  return {
    kind,
    scope,
    source,
    label,
    enabled: true,
    ...extra,
  };
}

/**
 * Row-scoped action set. Every flat queue row carries all four; the projection
 * then sets each descriptor's `enabled` from the row's status
 * (`rowActionEnabledForStatus` in projection.ts). The footer renders one button
 * per kind, each self-hiding when its descriptor is disabled, so the visible
 * cluster is purely status-driven:
 *
 *   running → ×            (cancel)
 *   queued  → ▲ ×          (bump, cancel — delete only after cancel → terminal)
 *   done    → ↻ 🗑         (retry, delete)
 *   failed  → ↻ 🗑         (retry, delete)
 */
export const DEFAULT_ROW_BUMP_ACTION = workflowAction(
  "bump",
  "row",
  "queue-panel",
  "Move up in queue",
);

export const DEFAULT_ROW_RETRY_ACTION = workflowAction(
  "retry",
  "row",
  "queue-panel",
  "Retry run",
);

export const DEFAULT_ROW_CANCEL_ACTION = workflowAction(
  "cancel",
  "row",
  "queue-panel",
  "Cancel row",
);

export const DEFAULT_ROW_DELETE_ACTION = workflowAction(
  "delete",
  "row",
  "queue-panel",
  "Delete row",
);

export const DEFAULT_ROW_ACTIONS: WorkflowActionPolicy[] = [
  DEFAULT_ROW_BUMP_ACTION,
  DEFAULT_ROW_RETRY_ACTION,
  DEFAULT_ROW_CANCEL_ACTION,
  DEFAULT_ROW_DELETE_ACTION,
];

export const DEFAULT_GROUP_RETRY_ACTION = workflowAction(
  "retry",
  "group",
  "queue-panel",
  "Retry group",
);

export const DEFAULT_GROUP_DELETE_ACTION = workflowAction(
  "delete",
  "group",
  "queue-panel",
  "Delete group",
);

export const DEFAULT_BATCH_VIEW_TOOLBAR_ACTIONS: WorkflowActionPolicy[] = [
  workflowAction("retry", "visible-view", "operation-view", "Retry visible rows"),
  workflowAction("delete", "visible-view", "operation-view", "Delete visible rows"),
  workflowAction("cancel", "visible-view", "operation-view", "Cancel visible rows"),
];

export const DEFAULT_DAEMON_STOP_ACTION = workflowAction(
  "stop-daemon",
  "daemon",
  "daemon",
  "Stop daemon",
  { operational: true },
);

export const DEFAULT_WORKFLOW_RUNTIME_POLICY: WorkflowRuntimePolicy = {
  rowActions: DEFAULT_ROW_ACTIONS,
  groupActions: [DEFAULT_GROUP_RETRY_ACTION, DEFAULT_GROUP_DELETE_ACTION],
  operationViewToolbarActions: DEFAULT_BATCH_VIEW_TOOLBAR_ACTIONS,
  daemonActions: [DEFAULT_DAEMON_STOP_ACTION],
};
