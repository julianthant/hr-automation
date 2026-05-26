import { appendLogEntry } from "../../tracker/jsonl.js";
import { getFormSpec } from "../../services/ocr/forms/registry.js";
import {
  requestOcrPrepareAbort,
} from "../../tracker/ocr-prepare-abort.js";
import { deleteDelegatedChildrenForRun } from "../ops/delete.js";
import { emitInheritedRow } from "../ops/emit-inherited.js";
import { openControlStores } from "../ops/shared.js";
import { readFormType, readParentRunId } from "../../tracker/dashboard/ocr/shared.js";
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
    requestOcrPrepareAbort(input.sessionId, input.runId);
    // Wake any kernel-path handler suspended in `subscribeToApproval`.
    // Dashboard-path runs (no kernel wrapping) have no subscriber —
    // emitDiscarded silently no-ops when the listener registry is empty.
    // Fires BEFORE the JSONL discard row is written so kernel handlers
    // unwind via OcrDiscardedError immediately, and the orchestrator's
    // own raceOcrPrepWithDiscard polling loop sees the abort flag set
    // above and stops emitting.
    emitDiscarded(
      { workflow: WORKFLOW, sessionId: input.sessionId },
      input.reason ?? "operator discarded OCR prep",
    );
    deleteDelegatedChildrenForRun(opts.trackerDir ?? ".tracker", input.runId);
    // OCR prep parent is always batch-parent. We still resolve from the
    // prior row so this code never has to know about per-workflow archetype
    // declarations beyond what the row itself already carries.
    const trackerDir = opts.trackerDir;
    // SQLite db handle for fast prior-row lookup inside emitInheritedRow —
    // OCR discard typically targets a recent session, so the JSONL fallback
    // would still work, but the indexed lookup avoids the lookbackDays scan
    // (Finding #13). `openControlStores` uses the shared process DB; close()
    // is a no-op for the shared connection.
    const stores = openControlStores(trackerDir ?? ".tracker");
    emitInheritedRow({
      workflow: WORKFLOW,
      trackerDir,
      id: input.sessionId,
      runId: input.runId,
      status: "failed",
      step: "discarded",
      fallbackArchetype: "batch-parent",
      db: stores.taskStore.db,
      ...(input.reason ? { error: input.reason } : {}),
    });
    // If this OCR session was started from a downstream workflow's run
    // modal, mirror the discard onto the parent row so it doesn't sit at
    // "delegated-to-ocr running" indefinitely. Parent's downstream
    // workflow is derived from formType → spec.approveTo.workflow when the
    // form delegates from the approve route.
    const parentRunId = input.parentRunId || readParentRunId(input.sessionId, opts.trackerDir);
    if (parentRunId) {
      const formType = input.formType || readFormType(input.sessionId, opts.trackerDir);
      const spec = formType ? getFormSpec(formType) : null;
      const parentWorkflow = input.parentWorkflow || spec?.approveTo?.workflow;
      if (parentWorkflow) {
        const ts = new Date().toISOString();
        const parentItemId = input.parentItemId || `ocr-prep-${input.sessionId}`;
        // Route through emitInheritedRow so the discard row inherits the
        // parent's prior `parentRunId` (Bug #6 — when the OCR-parent is
        // itself a delegation child, omitting parentRunId orphans the
        // discard row from the batch orchestrator's group card).
        emitInheritedRow({
          workflow: parentWorkflow,
          trackerDir,
          id: parentItemId,
          runId: parentRunId,
          status: "failed",
          step: "discarded",
          fallbackArchetype: "batch-parent",
          db: stores.taskStore.db,
          ...(input.reason ? { error: input.reason } : {}),
        });
        appendLogEntry(
          {
            workflow: parentWorkflow,
            itemId: parentItemId,
            runId: parentRunId,
            level: "error",
            message: `Discarded · ${input.reason ?? "operator discarded the OCR prep row"}`,
            ts,
          },
          opts.trackerDir,
        );
      }
    }
    return { status: 200, body: { ok: true } };
  };
}
