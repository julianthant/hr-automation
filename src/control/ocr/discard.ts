import { appendLogEntry } from "../../tracker/jsonl.js";
import { getFormSpec } from "../../services/ocr/forms/registry.js";
import {
  requestOcrPrepareAbort,
} from "../../tracker/ocr-prepare-abort.js";
import { deleteDelegatedChildrenForRun } from "../ops/delete.js";
import {
  emitInheritedRow,
  findInheritedPriorEntry,
  PriorTrackerRowNotFoundError,
} from "../ops/emit-inherited.js";
import { openControlStores } from "../ops/shared.js";
import { isTerminalTaskState } from "../../core/task-store/types.js";
import { openTaskStore, cancelQueuedChildTasksForParentRun } from "../../tracker/tasks/store.js";
import { readFormType, readParentRunId, readOperationWorkflow } from "../../tracker/dashboard/ocr/shared.js";
import { emitDiscarded } from "../../services/ocr/approval-signal.js";

const WORKFLOW = "ocr";

// ─── POST /api/ocr/discard-prepare ───────────────────────────

export interface DiscardInput {
  sessionId: string;
  runId: string;
  reason?: string;
  parentWorkflow?: string;
  parentRunId?: string;
  parentItemId?: string;
  formType?: string;
}
export interface DiscardResponse {
  status: 200 | 400;
  body: { ok: boolean; error?: string };
}
export interface DiscardHandlerOpts {
  trackerDir?: string;
}
export function buildOcrDiscardHandler(opts: DiscardHandlerOpts = {}) {
  return async (input: DiscardInput): Promise<DiscardResponse> => {
    if (!input.sessionId || !input.runId) {
      return { status: 400, body: { ok: false, error: "Missing sessionId/runId" } };
    }
    const trackerDir = opts.trackerDir;
    // SQLite db handle for fast prior-row lookup inside emitInheritedRow —
    // OCR discard typically targets a recent session, so the JSONL fallback
    // would still work, but the indexed lookup avoids the lookbackDays scan
    // (Finding #13). `openControlStores` uses the shared process DB; close()
    // is a no-op for the shared connection.
    const stores = openControlStores(trackerDir ?? ".tracker");
    const ocrPriorEntry = findInheritedPriorEntry({
      workflow: WORKFLOW,
      trackerDir,
      id: input.sessionId,
      runId: input.runId,
      db: stores.taskStore.db,
    });
    if (!ocrPriorEntry) {
      return {
        status: 400,
        body: {
          ok: false,
          error: `cannot discard OCR prep: prior tracker row is missing for sessionId=${input.sessionId} runId=${input.runId}`,
        },
      };
    }
    const parentRunId = input.parentRunId || readParentRunId(input.sessionId, opts.trackerDir);
    const formType = input.formType || readFormType(input.sessionId, opts.trackerDir);
    const spec = formType ? getFormSpec(formType) : null;
    const operationWorkflow = readOperationWorkflow(input.sessionId, opts.trackerDir);
    // For an oath-upload operation the "parent" is a REAL daemon task, not a
    // display coordinator row, and it self-aborts via the discard signal +
    // the JSONL approval backstop (subscribeToApproval → OcrDiscardedError). Do
    // NOT mirror a discard onto an oath-signature row that doesn't exist. For
    // oath-signature / emergency-contact the operation workflow equals
    // `spec.approveTo.workflow`, so the existing mirror finds the operation row.
    const parentWorkflow =
      operationWorkflow === "oath-upload"
        ? undefined
        : input.parentWorkflow || operationWorkflow || spec?.approveTo?.workflow;
    const parentItemId = input.parentItemId || `ocr-prep-${input.sessionId}`;
    if (parentRunId && parentWorkflow) {
      const parentPriorEntry = findInheritedPriorEntry({
        workflow: parentWorkflow,
        trackerDir,
        id: parentItemId,
        runId: parentRunId,
        db: stores.taskStore.db,
      });
      if (!parentPriorEntry) {
        return {
          status: 400,
          body: {
            ok: false,
            error: `cannot discard parent row: prior tracker row is missing for workflow=${parentWorkflow} id=${parentItemId} runId=${parentRunId}`,
          },
        };
      }
    }
    requestOcrPrepareAbort(input.sessionId, input.runId);
    // Wake any kernel-path handler suspended in `subscribeToApproval`.
    // Dashboard-path runs (no kernel wrapping) have no subscriber —
    // emitDiscarded silently no-ops when the listener registry is empty.
    // Fires BEFORE the JSONL discard row is written so kernel handlers
    // unwind via OcrDiscardedError immediately, and the orchestrator's
    // own raceOcrPrepWithDiscard polling loop sees the abort flag set
    // above and stops emitting.
    emitDiscarded(
      { workflow: WORKFLOW, sessionId: input.sessionId, runId: input.runId },
      input.reason ?? "operator discarded OCR prep",
    );
    // Cancel the prep's still-queued delegated child TASKS (person-lookup
    // verifies) and its dependency anchor — `deleteDelegatedChildrenForRun`
    // below only removes the display ROWS, so without this a daemon claimed
    // and ran orphan lookups for a discarded prep, and the anchor task sat
    // waiting forever (E2E-010).
    cancelQueuedChildTasksForParentRun(openTaskStore(opts.trackerDir), {
      parentRunId: input.runId,
      reason: input.reason ?? "OCR prep discarded",
    });
    const anchorTask = stores.taskStore.findTaskByIdentity({
      workflow: WORKFLOW,
      itemId: input.sessionId,
      runId: input.runId,
    });
    if (anchorTask && !isTerminalTaskState(anchorTask.state)) {
      stores.taskStore.markTaskCancelled({
        taskId: anchorTask.taskId,
        reason: input.reason ?? "OCR prep discarded",
      });
    }
    deleteDelegatedChildrenForRun(opts.trackerDir ?? ".tracker", input.runId);
    // OCR prep parent is batch-shaped. We still resolve from the
    // prior row so this code never has to know about per-workflow archetype
    // declarations beyond what the row itself already carries.
    try {
      emitInheritedRow({
        workflow: WORKFLOW,
        trackerDir,
        id: input.sessionId,
        runId: input.runId,
        status: "failed",
        step: "discarded",
        db: stores.taskStore.db,
        ...(input.reason ? { error: input.reason } : {}),
      });
    } catch (err) {
      if (err instanceof PriorTrackerRowNotFoundError) {
        return {
          status: 400,
          body: {
            ok: false,
            error: `cannot discard OCR prep: prior tracker row is missing for sessionId=${input.sessionId} runId=${input.runId}`,
          },
        };
      }
      throw err;
    }
    // If this OCR session was started from a downstream workflow's run
    // modal, mirror the discard onto the parent row so it doesn't sit at
    // "delegated-to-ocr running" indefinitely. Parent's downstream
    // workflow is derived from formType → spec.approveTo.workflow when the
    // form delegates from the approve route.
    if (parentRunId) {
      if (parentWorkflow) {
        const ts = new Date().toISOString();
        // Route through emitInheritedRow so the discard row inherits the
        // parent's prior `parentRunId` (Bug #6 — when the OCR-parent is
        // itself a delegation child, omitting parentRunId orphans the
        // discard row from the batch orchestrator's group card).
        try {
          emitInheritedRow({
            workflow: parentWorkflow,
            trackerDir,
            id: parentItemId,
            runId: parentRunId,
            status: "failed",
            step: "discarded",
            db: stores.taskStore.db,
            // Keep the denormalized OCR status on an operation coordinator row in
            // sync so its surface reads "discarded" (the row's own ocr* fields,
            // since the OCR review row is in a different panel).
            data: { ocrStatus: "discarded", ocrStep: "discarded" },
            ...(input.reason ? { error: input.reason } : {}),
          });
        } catch (err) {
          if (err instanceof PriorTrackerRowNotFoundError) {
            return {
              status: 400,
              body: {
                ok: false,
                error: `cannot discard parent row: prior tracker row is missing for workflow=${parentWorkflow} id=${parentItemId} runId=${parentRunId}`,
              },
            };
          }
          throw err;
        }
        // Sparse EVENT-level lifecycle log on the operation COORDINATOR's runId
        // (parentWorkflow is the coordinator for oath-signature / emergency-contact;
        // undefined → skipped for oath-upload, which is a real task, not a
        // coordinator row). Records the discard on the coordinator's own Logs
        // timeline. `event: "operation:discarded"` is part of the closed set.
        appendLogEntry(
          {
            workflow: parentWorkflow,
            itemId: parentItemId,
            runId: parentRunId,
            level: "error",
            message: `Operator discarded OCR preparation · ${input.reason ?? "operator discarded the OCR prep row"}`,
            event: "operation:discarded",
            category: "operator",
            occasion: "cancelled",
            ts,
          },
          opts.trackerDir,
        );
      }
    }
    return { status: 200, body: { ok: true } };
  };
}
