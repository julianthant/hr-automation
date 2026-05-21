/**
 * Central workflow action engine — shared request/result contracts.
 *
 * Phase 2 of the workflow runtime migration. Every operator-triggered
 * cancel / retry / delete / bump funnels through `performWorkflowAction`
 * (see `perform-workflow-action.ts`), which normalizes scope + source,
 * resolves the blast radius (`resolve-targets.ts`), then routes to the
 * existing low-level ops handlers (`ops/cancel.ts`, `ops/retry.ts`,
 * `ops/delete.ts`, `ops/queue.ts`, `ocr/discard.ts`).
 *
 * The Phase 1 unions (`WorkflowActionKind` / `Scope` / `Source`) are the
 * single source of truth for the vocabulary; this module re-exports them so
 * dashboard route code has one import surface.
 */
import type {
  WorkflowActionKind,
  WorkflowActionScope,
  WorkflowActionSource,
} from "../../../domain/workflow-runtime/types.js";

export type {
  WorkflowActionKind,
  WorkflowActionScope,
  WorkflowActionSource,
} from "../../../domain/workflow-runtime/types.js";

/** Cooperative = step-boundary cancel; force = interrupt the in-flight run. */
export type CancelMode = "cooperative" | "force";

/**
 * One row an action applies to.
 *
 * Identified primarily by `runId`, but `id` (the tracker item id) is
 * required: every low-level ops handler keys on it, and resolving `id` from
 * `runId` alone would require the SQLite `runs` projection — which is not
 * populated for freshly-queued tasks (nor in hermetic tests). Callers always
 * have the item id at hand, so the request carries both. Each target also
 * carries `workflowId` because resolved dashboard actions can cross workflow
 * boundaries even when the request has a source/default workflow.
 */
export interface WorkflowActionTarget {
  workflowId: string;
  id: string;
  runId?: string;
  /** Tracker date (YYYY-MM-DD). Required for delete; optional elsewhere. */
  date?: string;
  /** Lets a cooperative cancel pick the queued vs running path. */
  status?: "pending" | "running";
}

export interface WorkflowActionRequest {
  action: WorkflowActionKind;
  scope: WorkflowActionScope;
  source: WorkflowActionSource;
  workflowId: string;
  targets: WorkflowActionTarget[];
  /** Applied to any target that does not carry its own `date`. */
  date?: string;
  /** Stamps re-enqueued runs under this batch / delegation parent (retry). */
  parentRunId?: string;
  /** When set on a `cancel`, routes to OCR file-scope discard. */
  ocrSessionId?: string;
  /** Cancel only — cooperative (default) vs force interrupt. */
  cancelMode?: CancelMode;
}

export interface WorkflowActionTargetResult {
  id: string;
  runId?: string;
  ok: boolean;
  error?: string;
  /** HTTP-shaped status from the underlying handler (404 / 409 / 410 / …). */
  status?: number;
  /** Handler-specific payload kept for thin route wrappers (e.g. `commandId`). */
  detail?: Record<string, unknown>;
}

export interface WorkflowActionResult {
  ok: boolean;
  action: WorkflowActionKind;
  scope: WorkflowActionScope;
  /** Number of targets that succeeded. */
  count: number;
  results: WorkflowActionTargetResult[];
  errors: Array<{ id: string; error: string }>;
  /** Request-level rejection reason (invalid scope / source / action combo). */
  error?: string;
}
