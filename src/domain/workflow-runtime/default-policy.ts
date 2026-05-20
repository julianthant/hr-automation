import type {
  WorkflowActionDescriptor,
  WorkflowRuntimePolicy,
} from "./types.js";

export function workflowAction(
  kind: WorkflowActionDescriptor["kind"],
  scope: WorkflowActionDescriptor["scope"],
  source: WorkflowActionDescriptor["source"],
  label: string,
  extra: Partial<WorkflowActionDescriptor> = {},
): WorkflowActionDescriptor {
  return {
    kind,
    scope,
    source,
    label,
    targetRunIds: [],
    enabled: true,
    ...extra,
  };
}

export const DEFAULT_ROW_CANCEL_ACTION = workflowAction(
  "cancel",
  "row",
  "queue-panel",
  "Cancel row",
);

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

export const DEFAULT_BATCH_VIEW_TOOLBAR_ACTIONS: WorkflowActionDescriptor[] = [
  workflowAction("retry", "visible-view", "batch-view", "Retry visible rows"),
  workflowAction("delete", "visible-view", "batch-view", "Delete visible rows"),
  workflowAction("cancel", "visible-view", "batch-view", "Cancel visible rows"),
];

export const DEFAULT_DAEMON_STOP_ACTION = workflowAction(
  "stop-daemon",
  "daemon",
  "daemon",
  "Stop daemon",
  { operational: true },
);

export const DEFAULT_WORKFLOW_RUNTIME_POLICY: WorkflowRuntimePolicy = {
  rowActions: [DEFAULT_ROW_CANCEL_ACTION],
  groupActions: [DEFAULT_GROUP_RETRY_ACTION, DEFAULT_GROUP_DELETE_ACTION],
  batchViewToolbarActions: DEFAULT_BATCH_VIEW_TOOLBAR_ACTIONS,
  daemonActions: [DEFAULT_DAEMON_STOP_ACTION],
  daemonStopIsWorkflowCancel: false,
  unknownTitleFallback: "entry-title-resolution",
};
