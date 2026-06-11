import { randomUUID } from "node:crypto";
import { emitTrackerRow } from "../../jsonl.js";
import { findLatestEntryForPredicate } from "../../find-latest-entry.js";
import { resolveRowArchetype } from "../../../domain/row-archetype.js";
import { buildTraceId } from "../../../domain/queue-trace-id.js";
import { serializeRunOptionsForData, type RunOptions } from "../../../domain/run-options.js";
import { log, withLogContext, setLogRunId } from "../../../utils/log.js";
import { getFormSpec } from "../../../services/ocr/forms/registry.js";
import { operationTraceCode, runOcrOrchestrator, type OcrOrchestratorOpts } from "../../../workflows/ocr/orchestrator.js";
import { errorMessage } from "../../../utils/errors.js";
import { hasSessionLock, acquireSessionLock, releaseSessionLock } from "./lock.js";
import { OPERATION_COORDINATOR_WORKFLOWS } from "./shared.js";
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
  /**
   * The dashboard workflow the operator clicked Run on. PDF runs for
   * oath-signature / emergency-contact get an `operation` coordinator row first;
   * the OCR run is then delegated under it. Both oath-signature PDF runs and
   * oath-upload full mode arrive with `formType="oath"`, so this field is what
   * distinguishes them. Absent → standalone OCR-hub upload (current behavior).
   */
  targetWorkflow?: string;
  /**
   * Operator-chosen Automation-workers setting. Threaded into the OCR
   * orchestrator (which stamps it on every OCR row + raises the lookup fan-out
   * daemon target) and stamped on the operation / oath-upload coordinator rows
   * for display. Absent → Auto. See `src/domain/run-options.ts`.
   */
  runOptions?: RunOptions;
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
  /**
   * Test seam for the oath-upload (full mode) born-at-upload enqueue. The real
   * implementation enqueues the oath-upload daemon task and pre-emits its
   * `single` row; it returns the task's runId so the OCR run can be delegated
   * under it. Tests stub this to capture the call and return a fixed runId.
   */
  enqueueOathUploadAtPrepare?: (args: OathUploadPrepareEnqueueArgs) => Promise<string | undefined>;
}

export interface OathUploadPrepareEnqueueArgs {
  sessionId: string;
  pdfOriginalName: string;
  pdfFileId?: string;
  dryRun?: boolean;
  trackerDir?: string;
  /** Operator's Automation-workers setting — stamped on the born-at-upload row (display). */
  runOptions?: RunOptions;
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

    // ─── Target-workflow operation coordinator row ──────────────────────────
    // For an oath-signature / emergency-contact PDF run, create the operation
    // coordinator row in the TARGET workflow's panel first, then delegate the
    // OCR run under it (parentRunId). The row carries denormalized OCR status
    // for display; the OCR review row stays in the OCR panel. Skipped on
    // reupload (the prior operation row persists) and for standalone OCR runs.
    const wantsOperationRow =
      !input.isReupload &&
      input.targetWorkflow !== undefined &&
      OPERATION_COORDINATOR_WORKFLOWS.has(input.targetWorkflow);
    // Oath Upload (full mode) is born here as a REAL daemon task (a `single`
    // row), not a display coordinator. The task's leading `wait-approval` phase
    // waits for the OCR prep to be approved; the OCR run is delegated under it.
    const isOathUploadTarget = !input.isReupload && input.targetWorkflow === "oath-upload";
    let operationRunId: string | undefined;
    let operationRef: { workflow: string; id: string; runId: string; baseData: Record<string, string> } | undefined;
    if (wantsOperationRow) {
      operationRunId = randomUUID();
      const operationItemId = `ocr-prep-${sessionId}`;
      const operationTraceId = buildTraceId({
        code: operationTraceCode(input.targetWorkflow) ?? spec.traceCode ?? "oc",
        runId: operationRunId,
        at: new Date(),
      });
      const baseData: Record<string, string> = {
        archetype: "operation",
        mode: "prepare",
        formType: input.formType,
        queueRowKind: "file",
        pdfOriginalName: input.pdfOriginalName,
        ...(input.pdfFileId ? { pdfFileId: input.pdfFileId } : {}),
        ocrRunId: runId,
        ocrSessionId: sessionId,
        operationWorkflow: input.targetWorkflow!,
        operationKind: input.formType,
        operationRunId,
        __id: operationItemId,
        __traceId: operationTraceId,
        // Surface the operator's worker count on the coordinator row (display);
        // the approve fan-out reads it back off the OCR row, not this one.
        ...serializeRunOptionsForData(input.runOptions),
        ...(input.dryRun ? { dryRun: "true" } : {}),
      };
      operationRef = {
        workflow: input.targetWorkflow!,
        id: operationItemId,
        runId: operationRunId,
        baseData,
      };
    }
    const emitOperationRow = (
      ocrStatus: string,
      ocrStep: string,
      rowStatus: "running" | "failed" = "running",
      rowStep = "ocr-prep",
    ): void => {
      if (!operationRef) return;
      emitTrackerRow(
        {
          workflow: operationRef.workflow,
          timestamp: new Date().toISOString(),
          id: operationRef.id,
          runId: operationRef.runId,
          status: rowStatus,
          step: rowStep,
          data: { ...operationRef.baseData, archetype: "operation", ocrStatus, ocrStep },
        },
        trackerDir,
      );
    };
    emitOperationRow("running", "preparing");

    if (input.isReupload && input.previousRunId) {
      // The supersede marker rides on the previous run's row; inherit its
      // archetype so the cancelled-by-reupload row keeps the OCR preview
      // shape.
      const supersededRow = findLatestEntryForPredicate({
        workflow: WORKFLOW,
        trackerDir,
        lookbackDays: 7,
        predicate: (e) => e.id === sessionId && e.runId === input.previousRunId,
      });
      const supersededArchetype = supersededRow ? resolveRowArchetype(supersededRow) : "batch";
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
      // The OCR run is delegated under the operation coordinator row (display
      // targets) or under the oath-upload daemon task (born here). For
      // oath-upload, enqueue the task FIRST (in the background, off the 202 path)
      // so we can capture its runId and delegate the OCR run under it.
      let delegationParentRunId = operationRunId;
      try {
        if (isOathUploadTarget) {
          const enqueueOathUpload =
            opts.enqueueOathUploadAtPrepare ?? defaultEnqueueOathUploadAtPrepare;
          delegationParentRunId = await enqueueOathUpload({
            sessionId,
            pdfOriginalName: input.pdfOriginalName,
            ...(input.pdfFileId ? { pdfFileId: input.pdfFileId } : {}),
            ...(input.dryRun ? { dryRun: input.dryRun } : {}),
            ...(trackerDir !== undefined ? { trackerDir } : {}),
            ...(input.runOptions ? { runOptions: input.runOptions } : {}),
          });
          if (!delegationParentRunId) {
            // Fail loud, don't run orphaned. The oath-upload approve path SKIPS
            // the ServiceNow ticket fan-out for an oath-upload operation (the
            // born-at-upload task is supposed to file it). If that task was
            // never created, running the OCR anyway would sign the oaths but
            // file NO ticket — a silent upload gap. Surface a failed oath-upload
            // row and abort the OCR run so the operator re-uploads.
            log.error(
              `[ocr-http] prepare: oath-upload task was not created for session ${sessionId} — aborting OCR (nothing would consume the approval / file the ticket)`,
            );
            emitTrackerRow(
              {
                workflow: "oath-upload",
                timestamp: new Date().toISOString(),
                id: sessionId,
                runId,
                status: "failed",
                step: "ocr-prep-failed",
                data: {
                  archetype: "single",
                  queueRowKind: "file",
                  pdfOriginalName: input.pdfOriginalName,
                  ...(input.pdfFileId ? { pdfFileId: input.pdfFileId } : {}),
                  sessionId,
                  ocrSessionId: sessionId,
                  uploadMode: "full",
                  __id: sessionId,
                  __traceId: buildTraceId({ code: "ou", runId, at: new Date() }),
                  ...(input.dryRun ? { dryRun: "true" } : {}),
                },
                error:
                  "Oath Upload task could not be created at upload — OCR prep aborted (no downstream task to file the ServiceNow ticket). Re-upload to retry.",
              },
              trackerDir,
            );
            return;
          }
        }
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
              ...(delegationParentRunId ? { parentRunId: delegationParentRunId } : {}),
              ...(wantsOperationRow || isOathUploadTarget ? { operationWorkflow: input.targetWorkflow } : {}),
              ...(input.runOptions ? { runOptions: input.runOptions } : {}),
            },
            {
              runId,
              trackerDir,
              // Mirror the OCR's awaiting-approval transition onto the operation
              // row's denormalized status so it reads "awaiting review" before
              // the operator approves.
              ...(operationRef
                ? {
                    onPhase: (step: string) => {
                      if (step === "awaiting-approval") {
                        emitOperationRow("awaiting-review", "awaiting-approval");
                      }
                    },
                  }
                : {}),
            },
          );
        }, trackerDir);
      } catch (err) {
        log.error(`[ocr-http] orchestrator threw: ${errorMessage(err)}`);
        // Orchestrator emits the OCR-side `failed` row before rethrow;
        // discard-prepare owns operator-discard terminal rows (including the
        // operation row, mirrored via the discard parent path).
        if (isOperatorDiscardAbortError(err)) {
          /* discard handler already emitted */
        } else {
          // Non-discard failure: drive the operation row terminal too, so it
          // doesn't sit "running" forever after the OCR run failed.
          emitOperationRow("failed", "failed", "failed", "ocr-failed");
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
        ...(operationRunId ? { parentRunId: operationRunId } : {}),
      },
    };
  };
}

/**
 * Born-at-upload oath-upload enqueue (option A). Enqueues the real oath-upload
 * daemon task (a `single` row) WITHOUT `signerItemIds`, so the handler's leading
 * `wait-approval` phase blocks until the operator approves the OCR prep and then
 * learns the signer set. Pre-emits the rich `single` pending row and returns the
 * task's runId so the OCR run can be delegated under it.
 */
async function defaultEnqueueOathUploadAtPrepare(
  args: OathUploadPrepareEnqueueArgs,
): Promise<string | undefined> {
  const { ensureDaemonsAndEnqueue } = await import("../../../core/daemon/client.js");
  const { loadWorkflow } = await import("../../../core/workflow-loaders.js");
  const wf = await loadWorkflow("oath-upload");
  if (!wf) {
    log.error("[ocr-http] prepare: oath-upload workflow not loadable — cannot create the upload row");
    return undefined;
  }
  const itemId = args.sessionId;
  const oathUploadInput: Record<string, unknown> = {
    sessionId: args.sessionId,
    pdfOriginalName: args.pdfOriginalName,
    ...(args.pdfFileId ? { pdfFileId: args.pdfFileId } : {}),
    mode: "full",
    rosterMode: "download",
    ...(args.dryRun ? { dryRun: true } : {}),
  };
  let capturedRunId: string | undefined;
  await ensureDaemonsAndEnqueue(
    wf,
    [oathUploadInput] as never,
    {},
    {
      trackerDir: args.trackerDir,
      deriveItemId: () => itemId,
      onPreEmitPending: (
        _item: unknown,
        childRunId: string,
        _parentRunId: string | undefined,
        emittedItemId: string,
      ) => {
        capturedRunId = childRunId;
        emitTrackerRow(
          {
            workflow: "oath-upload",
            timestamp: new Date().toISOString(),
            id: emittedItemId,
            runId: childRunId,
            status: "running",
            step: "ocr-prep",
            data: {
              archetype: "single",
              queueRowKind: "file",
              pdfOriginalName: args.pdfOriginalName,
              ...(args.pdfFileId ? { pdfFileId: args.pdfFileId } : {}),
              sessionId: args.sessionId,
              ocrSessionId: args.sessionId,
              uploadMode: "full",
              status: "ocr-prep",
              __id: emittedItemId,
              __traceId: buildTraceId({ code: "ou", runId: childRunId, at: new Date() }),
              ...serializeRunOptionsForData(args.runOptions),
              ...(args.dryRun ? { dryRun: "true" } : {}),
            },
            input: oathUploadInput,
          },
          args.trackerDir,
        );
      },
    },
  );
  return capturedRunId;
}
