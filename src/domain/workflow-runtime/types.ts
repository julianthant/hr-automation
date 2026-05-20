export type WorkflowSurfaceType =
  | "normal"
  | "approval-delegation"
  | "batch-delegation"
  | "passive-delegation"
  | "delegation-member";

export type WorkflowActionKind =
  | "cancel"
  | "retry"
  | "delete"
  | "bump"
  | "stop-daemon";

export type WorkflowActionScope =
  | "row"
  | "group"
  | "visible-view"
  | "tree"
  | "daemon";

export type WorkflowActionSource =
  | "queue-panel"
  | "batch-view"
  | "log-panel"
  | "daemon";

export interface WorkflowActionDescriptor {
  kind: WorkflowActionKind;
  scope: WorkflowActionScope;
  source: WorkflowActionSource;
  label: string;
  targetRunIds: string[];
  enabled: boolean;
  operational?: boolean;
  reason?: string;
}

export interface WorkflowRunProjection {
  runId: string;
  workflowId: string;
  itemId: string;
  parentRunId?: string;
  title: string;
  subtitle?: string;
  status: string;
  step?: string;
  surfaceType: WorkflowSurfaceType;
  rowTypeLabel: string;
  actions: WorkflowActionDescriptor[];
  batchMembers: WorkflowRunProjection[];
}

export interface WorkflowRuntimePolicy {
  rowActions: WorkflowActionDescriptor[];
  groupActions: WorkflowActionDescriptor[];
  batchViewToolbarActions: WorkflowActionDescriptor[];
  daemonActions: WorkflowActionDescriptor[];
  daemonStopIsWorkflowCancel: boolean;
  unknownTitleFallback: "entry-title-resolution";
}
