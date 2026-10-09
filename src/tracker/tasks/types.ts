export type TaskStatus =
  | "pending"
  | "queued"
  | "running"
  | "waiting_on_children"
  | "awaiting_child_results"
  | "done"
  | "failed"
  | "cancelled";

export type TaskAttemptStatus = "queued" | "running" | "done" | "failed" | "cancelled";

export type TaskKind = "workflow_item" | "ocr";

export type TaskDependencyStatus = "pending" | "satisfied" | "failed" | "cancelled";

export type TaskDependencyKind = "ocr-eid-lookup" | "ocr-active-check";

export type TaskDependencyFailurePolicy = "record_unresolved" | "fail_parent" | "ignore";

export type OcrLookupKind = "name" | "verify" | "verify-only";

export interface OcrEidLookupDependencyMetadata {
  recordIndex: number;
  lookupKind: OcrLookupKind;
  formType: string;
}

export interface OcrActiveCheckDependencyMetadata {
  recordIndex: number;
  lookupKind: Exclude<OcrLookupKind, "name">;
  formType: string;
}

export interface TaskRow {
  id: string;
  workflow: string;
  itemId: string;
  runId?: string;
  taskKind: TaskKind;
  status: TaskStatus;
  parentTaskId?: string;
  data: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  terminalAt?: string;
}

export interface TaskDependencySummary {
  total: number;
  pending: number;
  satisfied: number;
  failed: number;
  cancelled: number;
}
