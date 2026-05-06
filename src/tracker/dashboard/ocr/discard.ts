import { trackEvent, appendLogEntry } from "../../jsonl.js";
import { getFormSpec } from "../../../ocr/forms/registry.js";
import { readFormType, readParentRunId } from "./shared.js";

const WORKFLOW = "ocr";

// ─── POST /api/ocr/discard-prepare ───────────────────────────

export interface DiscardInput {
  sessionId: string;
  runId: string;
  reason?: string;
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
    trackEvent(
      {
        workflow: WORKFLOW,
        timestamp: new Date().toISOString(),
        id: input.sessionId,
        runId: input.runId,
        status: "failed",
        step: "discarded",
        ...(input.reason ? { error: input.reason } : {}),
      },
      opts.trackerDir,
    );
    // If this OCR session was started from a downstream workflow's run
    // modal, mirror the discard onto the parent row so it doesn't sit at
    // "delegated-to-ocr running" indefinitely. Parent's downstream
    // workflow is derived from formType → spec.approveTo.workflow.
    const parentRunId = readParentRunId(input.sessionId, opts.trackerDir);
    if (parentRunId) {
      const formType = readFormType(input.sessionId, opts.trackerDir);
      const spec = formType ? getFormSpec(formType) : null;
      if (spec) {
        const ts = new Date().toISOString();
        const parentItemId = `ocr-prep-${input.sessionId}`;
        trackEvent(
          {
            workflow: spec.approveTo.workflow,
            timestamp: ts,
            id: parentItemId,
            runId: parentRunId,
            status: "failed",
            step: "discarded",
            ...(input.reason ? { error: input.reason } : {}),
          },
          opts.trackerDir,
        );
        appendLogEntry(
          {
            workflow: spec.approveTo.workflow,
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
