import type { TrackerEntry } from "@/components/shared/types";
import {
  buildWorkflowActionRequest,
  type BuildWorkflowActionRequestArgs,
  type WorkflowActionHttpRequest,
} from "@/components/hooks/useWorkflowActionDispatcher";
import type { WorkflowActionDescriptor } from "../../domain/workflow-runtime/types.js";
import { findEnabledAction } from "@/lib/workflow-action-utils";

export interface RowCancelRequestArgs {
  workflow: string;
  id: string;
  runId?: string;
  date?: string;
  /**
   * Tracker entry — used to detect OCR-prep proxy rows that must route through
   * discard, and to read the row status when no explicit `status`/descriptor
   * target is available.
   */
  entry?: TrackerEntry;
  actions?: WorkflowActionDescriptor[];
  /** Explicit row status; defaults to the cancel descriptor target, then entry. */
  status?: string;
}

interface OcrPrepContext {
  ocrSessionId: string;
  ocrRunId: string;
  formType?: string;
}

function ocrPrepContext(entry: TrackerEntry | undefined): OcrPrepContext | null {
  const data = entry?.data;
  if (
    data?.mode === "prepare" &&
    typeof data.ocrSessionId === "string" &&
    typeof data.ocrRunId === "string"
  ) {
    return {
      ocrSessionId: data.ocrSessionId,
      ocrRunId: data.ocrRunId,
      formType: typeof data.formType === "string" ? data.formType : undefined,
    };
  }
  return null;
}

/**
 * Resolve the row status a cancel should act on: explicit override → cancel
 * descriptor's target status → tracker entry status.
 */
export function resolveRowCancelStatus(args: RowCancelRequestArgs): string | undefined {
  const cancelAction = findEnabledAction(args.actions, "cancel");
  return args.status ?? cancelAction?.targets[0]?.status ?? args.entry?.status;
}

/**
 * Build the dispatch args for a single-row cancel. One route
 * (`/api/cancel-queued`); the body shape is decided by the row, not a prop:
 *
 *   - OCR-prep proxy → queued cancel + OCR context (→ discard handler)
 *   - running row    → `status: "running"` (→ buildCancelRunningHandler)
 *   - queued row     → no status (backend defaults to the queued handler)
 *
 * Scope (`tree` etc.) rides along from the policy descriptor via the dispatcher.
 */
export function buildRowCancelDispatchArgs(args: RowCancelRequestArgs): BuildWorkflowActionRequestArgs {
  const { workflow, id, runId, date, entry, actions } = args;
  const cancelAction = findEnabledAction(actions, "cancel");
  const ocrPrep = ocrPrepContext(entry);

  if (ocrPrep) {
    return {
      transport: "cancel-queued",
      kind: "cancel",
      action: cancelAction,
      fallbackTarget: { workflowId: workflow, id, runId: ocrPrep.ocrRunId },
      ocrSessionId: ocrPrep.ocrSessionId,
      reason: `Cancelled from ${workflow} queue`,
      parentWorkflow: workflow,
      parentRunId: runId,
      parentItemId: id,
      formType: ocrPrep.formType,
    };
  }

  const isRunning = resolveRowCancelStatus(args) === "running";
  return {
    transport: "cancel-queued",
    kind: "cancel",
    action: cancelAction,
    fallbackTarget: { workflowId: workflow, id, runId, date },
    ...(isRunning ? { status: "running" as const } : {}),
  };
}

/** Build the `{ path, body }` HTTP request for a single-row cancel. */
export function buildRowCancelRequest(args: RowCancelRequestArgs): WorkflowActionHttpRequest {
  return buildWorkflowActionRequest(buildRowCancelDispatchArgs(args));
}
