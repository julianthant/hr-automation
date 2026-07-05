import { randomUUID } from "node:crypto";
import { emitTrackerRow } from "../../jsonl.js";
import { findLatestEntryForPredicate } from "../../find-latest-entry.js";
import { resolveRowArchetype } from "../../../domain/row-archetype.js";
import { buildTraceId, tracePrefix } from "../../../domain/queue-trace-id.js";
import { serializeRunOptionsForData, type RunOptions } from "../../../domain/run-options.js";
import { log, withLogContext, setLogRunId } from "../../../utils/log.js";
import { getFormSpec } from "../../../services/ocr/forms/registry.js";
import { operationTraceCode, runOcrOrchestrator, type OcrOrchestratorOpts } from "../../../workflows/ocr/orchestrator.js";
import { errorMessage } from "../../../utils/errors.js";
import { hasSessionLock, acquireSessionLock, releaseSessionLock } from "./lock.js";
import { OPERATION_COORDINATOR_WORKFLOWS } from "./shared.js";
import { clearOcrPrepareAbort, isOperatorDiscardAbortError } from "../../ocr-prepare-abort.js";
import { runRegistry, type RunHandle } from "../../../core/run-registry.js";
import { openControlDb } from "../../../core/control-db.js";
import { getRegisteredFile } from "../../files/files.js";
import { findPriorRunsForHash } from "../../../workflows/oath-upload/duplicate-check.js";

const WORKFLOW = "ocr";

// ─── POST /api/ocr/prepare + /reupload ───────────────────────

export interface PrepareInput {
  pdfPath: string;
  pdfOriginalName: string;
  pdfFileId?: string;
  formType: string;
  // "wait" joins the newest queued/running SharePoint job instead of starting a
  // fresh download; the Zod schema + orchestrator already handle it (the run
  // modal offers it only while a SharePoint job is current/queued).
  rosterMode: "existing" | "download" | "wait";
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
    // Structured duplicate refusal (ISS-001): a prior FILED oath-upload ticket
    // already exists for this PDF's content. The RunModal surfaces `error` +
    // `priorTicket` instead of reading a bare 202 as "started" — so a
    // re-uploaded duplicate is never a silent success that files a 2nd ticket.
    | { ok: false; duplicate: true; priorTicket: string; error: string }
    | { ok: false; error: string };
}

/** Summary of a prior FILED oath-upload ticket for the duplicate refusal (ISS-001). */
export interface PriorOathUploadTicket {
  ticketNumber: string;
  sessionId: string;
  pdfOriginalName: string;
}

export interface PrepareHandlerOpts {
  trackerDir?: string;
  runOrchestrator?: (input: import("../../../workflows/ocr/schema.js").OcrInput, opts: OcrOrchestratorOpts) => Promise<void>;
  /**
   * Test seam for the oath-upload (full mode) born-at-upload enqueue. The real
   * implementation enqueues the oath-upload daemon task and pre-emits its
   * `single` row; it returns the task's runId (and the born row's trace id so
   * the delegated OCR run can inherit the ticket's trace PREFIX — VQ-1). Tests
   * stub this to capture the call and return a fixed identity.
   */
  enqueueOathUploadAtPrepare?: (
    args: OathUploadPrepareEnqueueArgs,
  ) => Promise<{ runId: string; traceId?: string } | undefined>;
  /**
   * Duplicate probe for the oath-upload (full mode) born-at-upload path (ISS-001).
   * Given the upload's `pdfFileId`, returns a prior FILED oath-upload ticket for
   * the SAME PDF content, or undefined. The default resolves the file's content
   * hash from the registered-file store and queries the oath-upload tracker for a
   * filed ticket; tests stub it. When a prior ticket is found, prepare refuses the
   * upload with a structured `duplicate` response and does NOT enqueue a second
   * ticket.
   */
  findPriorOathUploadTicket?: (
    args: { pdfFileId?: string; trackerDir?: string },
  ) => PriorOathUploadTicket | undefined;
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

    // ─── Oath-upload duplicate refusal (ISS-001) ────────────────────────────
    // A full oath-upload run is born here (option A) and files a ServiceNow
    // ticket. Re-uploading the SAME PDF used to silently succeed (a fresh
    // sessionId dodges the handler's session-keyed idempotency probe), so the
    // operator got NO feedback and a 2nd ticket could be filed. Refuse a
    // duplicate UP FRONT — before the session lock / enqueue — with a
    // structured response the RunModal surfaces (fail loud, no silent success).
    // Skipped on reupload (an explicit operator re-prepare of the same session).
    const isOathUploadTargetUp = !input.isReupload && input.targetWorkflow === "oath-upload";
    if (isOathUploadTargetUp) {
      const findPrior = opts.findPriorOathUploadTicket ?? defaultFindPriorOathUploadTicket;
      const prior = findPrior({ pdfFileId: input.pdfFileId, trackerDir });
      if (prior) {
        log.warn(
          `[ocr-http] prepare: refusing duplicate oath-upload — PDF already filed ticket ${prior.ticketNumber} (session ${prior.sessionId})`,
        );
        return {
          status: 409,
          body: {
            ok: false,
            duplicate: true,
            priorTicket: prior.ticketNumber,
            error: `This PDF was already filed under ticket ${prior.ticketNumber}. Re-uploading would file a duplicate — no new ticket was created.`,
          },
        };
      }
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
    // Emit a sparse, EVENT-level lifecycle log on the COORDINATOR's runId so
    // its Logs panel shows a real timeline (preparing → awaiting-review →
    // approved/failed/cancelled). The OCR run + fanned-out members live on
    // OTHER runIds, so without these the coordinator row has almost no log
    // activity of its own and the panel falls back to a synthetic line. Bound
    // to the coordinator's (workflow, itemId, runId) so the strict per-run logs
    // filter picks them up. Kept to one line per lifecycle transition.
    const logOnCoordinator = (
      message: string,
      event: "operation:created" | "operation:ocr-status" | "operation:approved" | "operation:discarded",
    ): void => {
      if (!operationRef) return;
      const ref = operationRef;
      void withLogContext(ref.workflow, ref.id, async () => {
        setLogRunId(ref.runId);
        log.step({ message, event, category: "operator" });
      }, trackerDir);
    };
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
      logOnCoordinator(`OCR ${ocrStatus} · ${ocrStep}`, "operation:ocr-status");
    };
    if (operationRef) {
      logOnCoordinator(
        `Operation created — OCR delegated (target: ${operationRef.workflow})`,
        "operation:created",
      );
    }
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
      const supersededArchetype = supersededRow ? resolveRowArchetype(supersededRow) : "operation";
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

    // Register the prep run on the unified run registry (Contract 5) so the
    // queue-row Cancel × reaches it. `/api/ocr/prepare` runs the orchestrator in
    // this process with NO daemon and NO browser Session, so without a registered
    // handle `buildCancelRunningHandler` finds neither a SQLite worker nor an
    // in-process run and falls into its stale-tracker branch — which writes a
    // cosmetic cancelled row but aborts NOTHING, so the live orchestrator's next
    // emit overwrites it and prep keeps running. A browserless handle (no
    // `session`) skips the chromium watchdog; cancel is delivered by aborting the
    // controller, which the orchestrator bridges to its prepare-abort flag (every
    // prep-phase poll observes it within ~500ms). Keyed by the OCR run's
    // (workflow=ocr, itemId=sessionId, runId) so it matches the cancel request.
    const controller = new AbortController();
    const runHandle: RunHandle = {
      runId,
      itemId: sessionId,
      workflow: WORKFLOW,
      controller,
      startedAt: Date.now(),
      source: "in-process",
    };
    runRegistry.register(runHandle);

    void (async () => {
      // The OCR run is delegated under the operation coordinator row (display
      // targets) or under the oath-upload daemon task (born here). For
      // oath-upload, enqueue the task FIRST (in the background, off the 202 path)
      // so we can capture its runId and delegate the OCR run under it.
      let delegationParentRunId = operationRunId;
      // The coordinator's trace PREFIX — operation row or born oath-upload
      // ticket — threaded into the orchestrator so the delegated OCR run
      // COMPOSES it instead of minting its own HHMMSS (VQ-1).
      let delegationRootTracePrefix = operationRef
        ? tracePrefix(operationRef.baseData.__traceId)
        : undefined;
      try {
        if (isOathUploadTarget) {
          const enqueueOathUpload =
            opts.enqueueOathUploadAtPrepare ?? defaultEnqueueOathUploadAtPrepare;
          const born = await enqueueOathUpload({
            sessionId,
            pdfOriginalName: input.pdfOriginalName,
            ...(input.pdfFileId ? { pdfFileId: input.pdfFileId } : {}),
            ...(input.dryRun ? { dryRun: input.dryRun } : {}),
            ...(trackerDir !== undefined ? { trackerDir } : {}),
            ...(input.runOptions ? { runOptions: input.runOptions } : {}),
          });
          delegationParentRunId = born?.runId;
          delegationRootTracePrefix = born?.traceId ? tracePrefix(born.traceId) : undefined;
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
              ...(delegationRootTracePrefix ? { rootTracePrefix: delegationRootTracePrefix } : {}),
              // The orchestrator bridges this signal to its in-process
              // prepare-abort flag, so a queue-row Cancel (which aborts the
              // controller via runRegistry.cancel) unwinds a RUNNING prep.
              signal: controller.signal,
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
        if (isOperatorDiscardAbortError(err)) {
          // The orchestrator's prepare-abort flag was tripped. Two triggers
          // share this error: a real operator discard (`/api/ocr/discard-prepare`,
          // which leaves `controller.signal` un-aborted) and a queue-row Cancel ×
          // (which routes through `runRegistry.cancel` → aborts the controller →
          // the orchestrator's entry bridge sets the flag). They diverge on who
          // owns the terminal row:
          if (controller.signal.aborted) {
            // Queue-row Cancel: nothing else writes the terminal row in this
            // process (cancel.ts returns early on the in-process registry hit and
            // does NOT touch the tracker). The orchestrator rethrew BEFORE writing
            // its `failed` row, so write the terminal cancelled row here — inherit
            // the preview shape so the row keeps its Preview tab + PDF title.
            emitOcrCancelledRow(sessionId, runId, trackerDir);
            emitOperationRow("cancelled", "cancelled", "failed", "ocr-cancelled");
          }
          // Real operator discard: discard-prepare owns the OCR terminal row AND
          // mirrors the operation row, so emit nothing here.
        } else {
          // Non-discard failure: orchestrator already emitted the OCR-side `failed`
          // row before rethrow. Drive the operation row terminal too, so it
          // doesn't sit "running" forever after the OCR run failed.
          emitOperationRow("failed", "failed", "failed", "ocr-failed");
        }
      } finally {
        runRegistry.unregister(runId);
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

/** A filed (non-dry-run) oath-upload ServiceNow ticket reads `HRC…`. */
function isFiledOathUploadTicket(ticketNumber: string | undefined): ticketNumber is string {
  return typeof ticketNumber === "string" && /^HRC\d/i.test(ticketNumber);
}

/**
 * Default oath-upload duplicate probe (ISS-001). Resolves the upload's full
 * content hash from the registered-file store (the `pdfFileId` is only the
 * first 32 hex of the sha256; the dup index keys on the full 64-hex `pdfHash`),
 * then looks for a prior oath-upload run that already FILED a ServiceNow ticket
 * for that same content. Returns undefined on any miss (no fileId, unregistered,
 * no prior filed ticket) so prepare proceeds normally — fail-safe, never blocks
 * a genuinely new upload.
 */
function defaultFindPriorOathUploadTicket(args: {
  pdfFileId?: string;
  trackerDir?: string;
}): PriorOathUploadTicket | undefined {
  if (!args.pdfFileId) return undefined;
  let sha256: string | undefined;
  let controlDb: ReturnType<typeof openControlDb> | undefined;
  try {
    controlDb = openControlDb({ trackerDir: args.trackerDir });
    const registered = getRegisteredFile(controlDb.db, args.pdfFileId);
    sha256 = registered?.sha256;
  } catch {
    // Registered-file store unavailable — can't resolve the hash, so we can't
    // prove a duplicate. Let the upload proceed.
    return undefined;
  } finally {
    controlDb?.close();
  }
  if (!sha256) return undefined;
  const priors = findPriorRunsForHash({ hash: sha256, trackerDir: args.trackerDir });
  const filed = priors.find((p) => isFiledOathUploadTicket(p.ticketNumber));
  if (!filed) return undefined;
  return {
    ticketNumber: filed.ticketNumber!,
    sessionId: filed.sessionId,
    pdfOriginalName: filed.pdfOriginalName,
  };
}

/**
 * Write the terminal `failed step=cancelled` OCR row after a queue-row Cancel ×
 * unwound a RUNNING prep. Inherits the latest OCR row's data so the cancelled row
 * keeps its preview shape (Preview tab, PDF-filename title, records). The unified
 * cancel route (`runRegistry.cancel`) only aborts the controller — it deliberately
 * does NOT touch the tracker for an in-process run, so this is the row's owner.
 */
function emitOcrCancelledRow(sessionId: string, runId: string, trackerDir: string | undefined): void {
  const prior = findLatestEntryForPredicate({
    workflow: WORKFLOW,
    trackerDir,
    lookbackDays: 7,
    predicate: (e) => e.id === sessionId && e.runId === runId,
  });
  emitTrackerRow(
    {
      workflow: WORKFLOW,
      timestamp: new Date().toISOString(),
      id: sessionId,
      runId,
      ...(prior?.parentRunId ? { parentRunId: prior.parentRunId } : {}),
      status: "failed",
      step: "cancelled",
      data: { ...(prior?.data ?? {}), archetype: prior ? resolveRowArchetype(prior) : "preview" },
      error: "Cancelled by user",
    },
    trackerDir,
  );
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
): Promise<{ runId: string; traceId?: string } | undefined> {
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
    ...(args.dryRun ? { dryRun: true } : {}),
  };
  let capturedRunId: string | undefined;
  let capturedTraceId: string | undefined;
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
        capturedTraceId = buildTraceId({ code: "ou", runId: childRunId, at: new Date() });
        // The born task is merely ENQUEUED here — pre-emit `pending` like every
        // other pre-emit so the row reads "Queued" until a daemon claims it.
        // Stamping `running`/`ocr-prep` made queued runs lie ("Running / Ocr
        // Prep…") and broke the row × (cancel forwarded the stale running
        // status → 409 on the queued task). The daemon's claim emits the real
        // running rows.
        emitTrackerRow(
          {
            workflow: "oath-upload",
            timestamp: new Date().toISOString(),
            id: emittedItemId,
            runId: childRunId,
            status: "pending",
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
              __traceId: capturedTraceId,
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
  return capturedRunId ? { runId: capturedRunId, traceId: capturedTraceId } : undefined;
}
