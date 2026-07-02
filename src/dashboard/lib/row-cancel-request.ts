import type { TrackerEntry } from "@/components/shared/types";
import {
  buildWorkflowActionRequest,
  type BuildWorkflowActionRequestArgs,
  type WorkflowActionHttpRequest,
} from "@/components/hooks/useWorkflowActionDispatcher";
import type { WorkflowActionDescriptor } from "../../domain/workflow-runtime/types.js";
import { readOcrPrepCancelContext } from "../../domain/ocr-prep-cancel.js";
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

function ocrPrepContext(entry: TrackerEntry | undefined) {
  return readOcrPrepCancelContext(entry?.data ?? undefined);
}

/** True when the row's × routes through the OCR prep discard handler. */
export function isOcrPrepProxyEntry(entry: TrackerEntry | undefined): boolean {
  return ocrPrepContext(entry) !== null;
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
    // The discard handler needs the OCR RUN's identity, not the clicked row's.
    // The action descriptor's targets carry the clicked row (for an operation
    // coordinator, the operation runId) and `buildWorkflowActionRequest`
    // prefers them over `fallbackTarget`, so override the targets too —
    // keeping the descriptor's scope/source intact.
    const ocrTarget = { workflowId: "ocr", id: ocrPrep.ocrSessionId, runId: ocrPrep.ocrRunId };
    // Parent context describes the clicked row only when it IS the OCR run's
    // parent (an operation coordinator / target-panel proxy). For the OCR
    // row's own panel the server derives the real parent from the tracker
    // (`readParentRunId` / `readOperationWorkflow`) — sending the OCR row's
    // own identity here would make the discard mirror onto itself and leave
    // the operation row stale.
    const isParentRow = workflow !== "ocr";
    return {
      transport: "cancel-queued",
      kind: "cancel",
      action: cancelAction ? { ...cancelAction, targets: [ocrTarget] } : cancelAction,
      fallbackTarget: ocrTarget,
      ocrSessionId: ocrPrep.ocrSessionId,
      reason: `Cancelled from ${workflow} queue`,
      ...(isParentRow
        ? { parentWorkflow: workflow, parentRunId: runId, parentItemId: id }
        : {}),
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

export interface OperationTreeCancelArgs {
  /** The coordinator's own workflow id (e.g. "oath-signature", "emergency-contact"). */
  workflow: string;
  /** The coordinator's item id. */
  id: string;
  /** The coordinator's runId — the BFS root for resolve-targets `scope:"tree"`. */
  runId?: string;
}

/**
 * Build the HTTP request for the "Cancel remaining" action on an operation
 * coordinator (E2E-102). Posts to `/api/cancel-queued` with `scope: "tree"`
 * so the backend's `collectDescendants` BFS cancels every non-terminal member
 * whose `parent_run_id` chains to this coordinator's runId — no sibling bleed.
 *
 * The coordinator itself is a display row (no daemon task); the cancel touches
 * only the fanned-out member tasks. Members already terminal are skipped by
 * the BFS (they have `latest_status` done/failed/skipped in SQLite).
 */
export function buildOperationTreeCancelRequest(
  args: OperationTreeCancelArgs,
): WorkflowActionHttpRequest {
  const { workflow, id, runId } = args;
  return {
    path: "/api/cancel-queued",
    body: {
      workflow,
      id,
      ...(runId !== undefined ? { runId } : {}),
      scope: "tree",
      treeExcludeRoots: true,
    },
  };
}
