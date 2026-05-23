import { emitTrackerRow, appendLogEntry } from "../../tracker/jsonl.js";
import { getFormSpec } from "../../services/ocr/forms/registry.js";
import {
  requestOcrPrepareAbort,
} from "../../tracker/ocr-prepare-abort.js";
import { deleteDelegatedChildrenForRun } from "../ops/delete.js";
import { readFormType, readParentRunId } from "../../tracker/dashboard/ocr/shared.js";
import { findLatestEntryForPredicate } from "../../tracker/find-latest-entry.js";
import { resolveRowArchetype } from "../../domain/row-archetype.js";

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
    deleteDelegatedChildrenForRun(opts.trackerDir ?? ".tracker", input.runId);
    // OCR prep parent is always batch-parent. We still resolve from the
    // prior row so this code never has to know about per-workflow archetype
    // declarations beyond what the row itself already carries.
    const trackerDir = opts.trackerDir;
    const ocrPriorEntry = findLatestEntryForPredicate({
      workflow: WORKFLOW,
      trackerDir,
      lookbackDays: 7,
      predicate: (e) => e.id === input.sessionId && e.runId === input.runId,
    });
    const ocrArchetype = ocrPriorEntry ? resolveRowArchetype(ocrPriorEntry) : "batch-parent";
    emitTrackerRow(
      {
        workflow: WORKFLOW,
        timestamp: new Date().toISOString(),
        id: input.sessionId,
        runId: input.runId,
        status: "failed",
        step: "discarded",
        data: { archetype: ocrArchetype },
        ...(input.reason ? { error: input.reason } : {}),
      },
      trackerDir,
    );
    // If this OCR session was started from a downstream workflow's run
    // modal, mirror the discard onto the parent row so it doesn't sit at
    // "delegated-to-ocr running" indefinitely. Parent's downstream
    // workflow is derived from formType → spec.approveTo.workflow.
    const parentRunId = input.parentRunId || readParentRunId(input.sessionId, opts.trackerDir);
    if (parentRunId) {
      const formType = input.formType || readFormType(input.sessionId, opts.trackerDir);
      const spec = formType ? getFormSpec(formType) : null;
      const parentWorkflow = input.parentWorkflow || spec?.approveTo.workflow;
      if (parentWorkflow) {
        const ts = new Date().toISOString();
        const parentItemId = input.parentItemId || `ocr-prep-${input.sessionId}`;
        const parentPriorEntry = findLatestEntryForPredicate({
          workflow: parentWorkflow,
          trackerDir,
          lookbackDays: 7,
          predicate: (e) => e.id === parentItemId && e.runId === parentRunId,
        });
        const parentArchetype = parentPriorEntry
          ? resolveRowArchetype(parentPriorEntry)
          : "batch-parent";
        emitTrackerRow(
          {
            workflow: parentWorkflow,
            timestamp: ts,
            id: parentItemId,
            runId: parentRunId,
            status: "failed",
            step: "discarded",
            data: { archetype: parentArchetype },
            ...(input.reason ? { error: input.reason } : {}),
          },
          trackerDir,
        );
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
