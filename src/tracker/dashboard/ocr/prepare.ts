import { randomUUID } from "node:crypto";
import { emitTrackerRow } from "../../jsonl.js";
import { findLatestEntryForPredicate } from "../../find-latest-entry.js";
import { resolveRowArchetype } from "../../../domain/row-archetype.js";
import { log, withLogContext, setLogRunId } from "../../../utils/log.js";
import { getFormSpec } from "../../../services/ocr/forms/registry.js";
import { runOcrOrchestrator, type OcrOrchestratorOpts } from "../../../workflows/ocr/orchestrator.js";
import { errorMessage } from "../../../utils/errors.js";
import { hasSessionLock, acquireSessionLock, releaseSessionLock } from "./lock.js";
import { clearOcrPrepareAbort, isOperatorDiscardAbortError } from "../../ocr-prepare-abort.js";

const WORKFLOW = "ocr";

// ─── POST /api/ocr/prepare + /reupload ───────────────────────

export interface PrepareInput {
  pdfPath: string;
  pdfOriginalName: string;
  pdfFileId?: string;
  formType: string;
  rosterMode: "existing" | "download";
  rosterPath?: string;
  sessionId?: string;
  previousRunId?: string;
  isReupload?: boolean;
  dryRun?: boolean;
}

export interface PrepareResponse {
  status: 202 | 400 | 409 | 500;
  body:
    | { ok: true; sessionId: string; runId: string; parentRunId?: string }
    | { ok: false; error: string };
}

export interface PrepareHandlerOpts {
  trackerDir?: string;
  runOrchestrator?: (input: import("../../../workflows/ocr/schema.js").OcrInput, opts: OcrOrchestratorOpts) => Promise<void>;
}

export function buildOcrPrepareHandler(
  opts: PrepareHandlerOpts = {},
): (input: PrepareInput) => Promise<PrepareResponse> {
  const trackerDir = opts.trackerDir;
  const runOrch = opts.runOrchestrator ?? runOcrOrchestrator;

  return async (input) => {
    const spec = getFormSpec(input.formType);
    if (!spec) {
      return { status: 400, body: { ok: false, error: `Unknown formType "${input.formType}"` } };
    }
    if (input.isReupload && (!input.sessionId || !input.previousRunId)) {
      return {
        status: 400,
        body: { ok: false, error: "Reupload requires sessionId and previousRunId" },
      };
    }
    if (input.rosterMode === "existing" && !input.rosterPath) {
      return {
        status: 400,
        body: { ok: false, error: 'rosterMode="existing" requires rosterPath' },
      };
    }
    if (spec.rosterMode === "required" && input.rosterMode === "existing" && !input.rosterPath) {
      return {
        status: 400,
        body: { ok: false, error: "Form requires a roster" },
      };
    }

    const sessionId = input.sessionId ?? randomUUID();
    if (hasSessionLock(sessionId)) {
      return {
        status: 409,
        body: { ok: false, error: `Session ${sessionId} already has a prepare in flight` },
      };
    }
    acquireSessionLock(sessionId);

    const runId = randomUUID();

    if (input.isReupload && input.previousRunId) {
      // The supersede marker rides on the previous run's row; inherit its
      // archetype so the cancelled-by-reupload row keeps the OCR batch
      // shape.
      const supersededRow = findLatestEntryForPredicate({
        workflow: WORKFLOW,
        trackerDir,
        lookbackDays: 7,
        predicate: (e) => e.id === sessionId && e.runId === input.previousRunId,
      });
      const supersededArchetype = supersededRow ? resolveRowArchetype(supersededRow) : "batch-parent";
      emitTrackerRow(
        {
          workflow: WORKFLOW,
          timestamp: new Date().toISOString(),
          id: sessionId,
          runId: input.previousRunId,
          status: "failed",
          step: "superseded",
          data: { archetype: supersededArchetype },
        },
        trackerDir,
      );
    }

    void (async () => {
      try {
        // Wrap in withLogContext so log.* calls inside the orchestrator land
        // in `.tracker/ocr-{date}-logs.jsonl` with workflow/itemId/runId set.
        // setLogRunId stamps runId into the AsyncLocalStorage context the same
        // way withTrackedWorkflow does for kernel workflows.
        await withLogContext(WORKFLOW, sessionId, async () => {
          setLogRunId(runId);
          await runOrch(
            {
              pdfPath: input.pdfPath,
              pdfOriginalName: input.pdfOriginalName,
              pdfFileId: input.pdfFileId,
              formType: input.formType,
              sessionId,
              rosterPath: input.rosterPath,
              rosterMode: input.rosterMode,
              previousRunId: input.previousRunId,
              dryRun: input.dryRun,
            },
            { runId, trackerDir },
          );
        }, trackerDir);
      } catch (err) {
        log.error(`[ocr-http] orchestrator threw: ${errorMessage(err)}`);
        // Orchestrator emits the OCR-side `failed` row before rethrow;
        // discard-prepare owns operator-discard terminal rows.
        if (isOperatorDiscardAbortError(err)) {
          /* discard handler already emitted */
        }
      } finally {
        clearOcrPrepareAbort(sessionId, runId);
        releaseSessionLock(sessionId);
      }
    })();

    return {
      status: 202,
      body: {
        ok: true,
        sessionId,
        runId,
      },
    };
  };
}
