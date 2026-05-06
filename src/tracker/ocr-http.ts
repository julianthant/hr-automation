/**
 * HTTP handlers for /api/ocr/* endpoints. All factories return either a
 * synchronous handler (forms, discard, force-research) or an async one
 * (prepare/reupload — fire-and-forget the orchestrator).
 *
 * Per-sessionId in-memory lock guards against double-launch races. Lock is
 * released after the orchestrator completes.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { trackEvent, dateLocal, appendLogEntry, type TrackerEntry } from "./jsonl.js";
import { errorMessage } from "../utils/errors.js";
import { log, withLogContext, setLogRunId } from "../utils/log.js";
import { listFormTypes, getFormSpec, type FormTypeListing } from "../ocr/forms/registry.js";
import { runOcrOrchestrator, type OcrOrchestratorOpts } from "../workflows/ocr/orchestrator.js";
import { runOcrRetryPage, RetryPageError } from "../workflows/ocr/retry-page.js";
import { isAcceptedHdhDepartment } from "../domain/hdh/departments.js";
import type { ChildOutcome, WatchChildRunsOpts } from "./watch-child-runs.js";
import type { OcrRequest, OcrResult } from "../ocr/index.js";
import { openControlDb } from "../core/control-db.js";
import { createTaskStore } from "../core/task-store/index.js";

const WORKFLOW = "ocr";

// ─── Per-sessionId lock ──────────────────────────────────────

const activeSessionIds = new Set<string>();

// ─── Per-row mutex (sessionId:runId) ─────────────────────────

const activeRowKeys = new Set<string>();

function rowKey(sessionId: string, runId: string): string {
  return `${sessionId}:${runId}`;
}

export function _resetSessionLockForTests(): void {
  activeSessionIds.clear();
  activeRowKeys.clear();
}

// ─── GET /api/ocr/forms ──────────────────────────────────────

export function buildOcrFormsHandler(): () => FormTypeListing[] {
  return () => listFormTypes();
}

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
   * Workflow that originated this OCR upload. When set to a non-`"ocr"`
   * value (e.g. `"oath-signature"`, `"emergency-contact"`), the prepare
   * handler synthesizes a parent tracker row in that workflow + appends
   * a few high-level log lines so the operator sees prep work in their
   * own queue. The OCR row gets `parentRunId` set to the parent row's
   * runId, so post-approval fan-out items inherit the same parentRunId
   * and nest under the parent in the dashboard.
   *
   * When `"ocr"` (or omitted) the OCR row is standalone — running OCR
   * just to inspect the result, no downstream side effects.
   */
  originWorkflow?: string;
}

export interface PrepareResponse {
  status: 202 | 400 | 409 | 500;
  body:
    | { ok: true; sessionId: string; runId: string; parentRunId?: string }
    | { ok: false; error: string };
}

export interface PrepareHandlerOpts {
  trackerDir?: string;
  runOrchestrator?: (input: import("../workflows/ocr/schema.js").OcrInput, opts: OcrOrchestratorOpts) => Promise<void>;
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
    if (activeSessionIds.has(sessionId)) {
      return {
        status: 409,
        body: { ok: false, error: `Session ${sessionId} already has a prepare in flight` },
      };
    }
    activeSessionIds.add(sessionId);

    const runId = randomUUID();

    // Synthesize a parent row in the origin workflow when the upload came
    // from a downstream workflow's run modal (oath-signature /
    // emergency-contact). Operator sees the row in their own queue with the
    // standard LogPanel UI and a few simple log entries. The OCR row links
    // back via parentRunId, and post-approval fan-out items inherit the
    // same parentRunId so they nest under this parent automatically.
    const origin = input.originWorkflow && input.originWorkflow !== WORKFLOW
      ? input.originWorkflow
      : null;
    let parentRunId: string | undefined;
    if (origin) {
      parentRunId = randomUUID();
      const parentItemId = `ocr-prep-${sessionId}`;
      writeOriginParentPending({
        originWorkflow: origin,
        parentItemId,
        parentRunId,
        pdfOriginalName: input.pdfOriginalName,
        ocrSessionId: sessionId,
        ocrRunId: runId,
        pdfFileId: input.pdfFileId,
        dryRun: input.dryRun,
        trackerDir,
      });
    }

    if (input.isReupload && input.previousRunId) {
      trackEvent(
        {
          workflow: WORKFLOW,
          timestamp: new Date().toISOString(),
          id: sessionId,
          runId: input.previousRunId,
          status: "failed",
          step: "superseded",
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
              ...(parentRunId ? { parentRunId } : {}),
            },
            { runId, trackerDir },
          );
        }, trackerDir);
      } catch (err) {
        log.error(`[ocr-http] orchestrator threw: ${errorMessage(err)}`);
      } finally {
        activeSessionIds.delete(sessionId);
      }
    })();

    return {
      status: 202,
      body: { ok: true, sessionId, runId, ...(parentRunId ? { parentRunId } : {}) },
    };
  };
}

/**
 * Emit the initial parent-row tracker entry + 2 log lines for an upload
 * originating from a downstream workflow's run modal. Two-event chain
 * (`pending` → `running`) is what `withTrackedWorkflow` would emit for a
 * kernel item; we synthesize the same shape so the dashboard's enrichment +
 * step-duration computation works on this row identically.
 */
function writeOriginParentPending(args: {
  originWorkflow: string;
  parentItemId: string;
  parentRunId: string;
  pdfOriginalName: string;
  ocrSessionId: string;
  ocrRunId: string;
  pdfFileId?: string;
  trackerDir?: string;
  dryRun?: boolean;
}): void {
  const ts = new Date().toISOString();
  // mode: "prepare" hooks the parent into the existing prep-row machinery
  // so post-approval the row is auto-extracted from the regular queue and
  // folded into a ParentChildRow with its kernel children (which inherit
  // parentRunId from the OCR fan-out path). Pre-approval the row renders
  // as a standard EntryItem in the queue.
  const baseData: Record<string, string> = {
    __name: `OCR Prep · ${args.pdfOriginalName}`,
    __id: args.parentItemId,
    mode: "prepare",
    pdfOriginalName: args.pdfOriginalName,
    ...(args.pdfFileId ? { pdfFileId: args.pdfFileId } : {}),
    ...(args.dryRun ? { dryRun: "true" } : {}),
    ocrSessionId: args.ocrSessionId,
    ocrRunId: args.ocrRunId,
  };
  trackEvent(
    {
      workflow: args.originWorkflow,
      timestamp: ts,
      id: args.parentItemId,
      runId: args.parentRunId,
      status: "pending",
      data: baseData,
    },
    args.trackerDir,
  );
  trackEvent(
    {
      workflow: args.originWorkflow,
      timestamp: ts,
      id: args.parentItemId,
      runId: args.parentRunId,
      status: "running",
      // Step name aligns with `oath-signature` workflow's first declared
      // step ("ocr") so the StepPipeline highlights it as the live step on
      // the parent row. Kernel daemon items emit `markStep("ocr")` at the
      // top of their handler so they show OCR as completed.
      step: "ocr",
      data: baseData,
    },
    args.trackerDir,
  );
  appendLogEntry(
    {
      workflow: args.originWorkflow,
      itemId: args.parentItemId,
      runId: args.parentRunId,
      level: "step",
      message: `Uploaded "${args.pdfOriginalName}" — preparing for OCR.`,
      ts,
    },
    args.trackerDir,
  );
  appendLogEntry(
    {
      workflow: args.originWorkflow,
      itemId: args.parentItemId,
      runId: args.parentRunId,
      level: "step",
      message: `Delegated to OCR (sessionId=${args.ocrSessionId.slice(0, 8)}…). Open the OCR queue to follow live progress.`,
      ts,
    },
    args.trackerDir,
  );
  appendLogEntry(
    {
      workflow: args.originWorkflow,
      itemId: args.parentItemId,
      runId: args.parentRunId,
      level: "waiting",
      message: "Awaiting OCR approval. Once approved in the OCR queue, this row will fan out automatically.",
      ts,
    },
    args.trackerDir,
  );
}

/**
 * Emit the terminal step transition on the origin parent row when OCR is
 * approved. After this fires, the kernel daemon items (children with the
 * same parentRunId) take over and surface as their own queue rows.
 */
function writeOriginParentApproved(args: {
  originWorkflow: string;
  parentItemId: string;
  parentRunId: string;
  fannedOutCount: number;
  trackerDir?: string;
}): void {
  const ts = new Date().toISOString();
  trackEvent(
    {
      workflow: args.originWorkflow,
      timestamp: ts,
      id: args.parentItemId,
      runId: args.parentRunId,
      status: "done",
      step: "approved",
      data: { fannedOutCount: String(args.fannedOutCount) },
    },
    args.trackerDir,
  );
  appendLogEntry(
    {
      workflow: args.originWorkflow,
      itemId: args.parentItemId,
      runId: args.parentRunId,
      level: "success",
      message: `Approved · ${args.fannedOutCount} record${args.fannedOutCount === 1 ? "" : "s"} fanned out to the daemon.`,
      ts,
    },
    args.trackerDir,
  );
}

// ─── POST /api/ocr/approve-batch ─────────────────────────────

export interface ApproveInput {
  sessionId: string;
  runId: string;
  records: unknown[];
  previewReady?: boolean;
  previewPageCount?: number;
}
export interface ApproveResponse {
  status: 200 | 400 | 500;
  body:
    | { ok: true; fannedOut: Array<{ workflow: string; itemId: string }> }
    | { ok: false; error: string };
}
export interface ApproveHandlerOpts {
  trackerDir?: string;
  ensureDaemonsAndEnqueueOverride?: (
    workflow: string,
    inputs: unknown[],
    deriveItemId: (input: unknown, idx: number) => string,
    opts?: { parentRunId?: string },
  ) => Promise<void | { enqueued?: Array<{ id: string; taskId?: string; runId?: string }> }>;
}

export function buildOcrApproveHandler(
  opts: ApproveHandlerOpts = {},
): (input: ApproveInput) => Promise<ApproveResponse> {
  const trackerDir = opts.trackerDir;
  return async (input) => {
    if (!input.sessionId || !input.runId || !Array.isArray(input.records)) {
      return { status: 400, body: { ok: false, error: "Missing sessionId/runId/records" } };
    }
    if (input.previewReady !== true || !Number.isFinite(input.previewPageCount) || Number(input.previewPageCount) <= 0) {
      return {
        status: 400,
        body: { ok: false, error: "Source preview is not available yet; reopen the Preview tab or retry OCR before approving." },
      };
    }
    const formType = readFormType(input.sessionId, trackerDir);
    if (!formType) {
      return { status: 400, body: { ok: false, error: "Could not resolve formType for session" } };
    }
    const spec = getFormSpec(formType);
    if (!spec) {
      return { status: 400, body: { ok: false, error: `Unknown formType "${formType}"` } };
    }

    const parentRunId = readParentRunId(input.sessionId, trackerDir);
    const dryRun = readDryRun(input.sessionId, trackerDir);

    // Only fan out records the operator selected in the preview pane.
    // Unsigned rows / unverified rows / unknown-doc rows are kept in the
    // tracker payload for context but should never become daemon work.
    const fannedOut: Array<{ workflow: string; itemId: string }> = [];
    const enqueueInputs: unknown[] = [];
    const itemIds: string[] = [];
    input.records.forEach((rec, index) => {
      if (!isSelectedRecord(rec)) return;
      const baseFanInput = spec.approveTo.deriveInput(rec as never);
      const fanInput = dryRun && baseFanInput && typeof baseFanInput === "object"
        ? { ...(baseFanInput as Record<string, unknown>), dryRun: true }
        : baseFanInput;
      const itemId = spec.approveTo.deriveItemId(rec as never, input.runId, index);
      enqueueInputs.push(fanInput);
      itemIds.push(itemId);
      fannedOut.push({ workflow: spec.approveTo.workflow, itemId });
    });

    if (enqueueInputs.length === 0) {
      return {
        status: 400,
        body: { ok: false, error: "No selected records to approve" },
      };
    }

    // Mark the OCR row + parent row "approved" SYNCHRONOUSLY before kicking
    // off the daemon dispatch. The dispatch can take minutes (cold-start
    // daemon spawn = up to 5min for Duo + browser launch); blocking the
    // approve POST on it caused the dashboard's loading toast to spin
    // forever. Now the operator sees instant confirmation that the records
    // were accepted, and the daemon spawn / enqueue runs in the background.
    // Failures during dispatch surface as `failed step=approve-failed` on
    // the OCR row + a fresh log line on the parent.
    trackEvent(
      {
        workflow: WORKFLOW,
        timestamp: new Date().toISOString(),
        id: input.sessionId,
        runId: input.runId,
        ...(parentRunId ? { parentRunId } : {}),
        status: "done",
        step: "approved",
        data: {
          fannedOutCount: String(fannedOut.length),
          fannedOutItemIds: JSON.stringify(itemIds),
          ...(dryRun ? { dryRun: "true" } : {}),
        },
      },
      trackerDir,
    );
    if (parentRunId) {
      writeOriginParentApproved({
        originWorkflow: spec.approveTo.workflow,
        parentItemId: `ocr-prep-${input.sessionId}`,
        parentRunId,
        fannedOutCount: fannedOut.length,
        trackerDir,
      });
    }

    void (async () => {
      try {
        let dispatchResult: void | { enqueued?: Array<{ id: string; taskId?: string; runId?: string }> };
        if (opts.ensureDaemonsAndEnqueueOverride) {
          dispatchResult = await opts.ensureDaemonsAndEnqueueOverride(
            spec.approveTo.workflow,
            enqueueInputs,
            (_inp, idx) => itemIds[idx],
            parentRunId ? { parentRunId } : undefined,
          );
        } else {
          const { ensureDaemonsAndEnqueue } = await import("../core/daemon-client.js");
          const { loadWorkflow } = await import("../core/workflow-loaders.js");
          const childWf = await loadWorkflow(spec.approveTo.workflow);
          if (!childWf) {
            log.error(
              `[ocr-http] approve-batch: unknown approveTo workflow "${spec.approveTo.workflow}" — items not enqueued`,
            );
            return;
          }
          const inputToItemId = new Map(
            enqueueInputs.map((inp, idx) => [JSON.stringify(inp), itemIds[idx] ?? `ocr-fallback-${input.runId}-r${idx}`])
          );
          dispatchResult = await ensureDaemonsAndEnqueue(
            childWf,
            enqueueInputs as never,
            {},
            {
              deriveItemId: (inp: unknown) => inputToItemId.get(JSON.stringify(inp)) ?? `ocr-fallback-${input.runId}-r0`,
              ...(parentRunId ? { parentRunId } : {}),
            },
          );
        }
        if (parentRunId && dispatchResult?.enqueued) {
          createApprovalDependencyRows({
            trackerDir,
            parentRunId,
            childWorkflow: spec.approveTo.workflow,
            children: dispatchResult.enqueued,
          });
        }
      } catch (err) {
        const msg = errorMessage(err);
        log.error(`[ocr-http] approve-batch dispatch failed: ${msg}`);
        // Surface the failure on both rows so the operator notices.
        trackEvent(
          {
            workflow: WORKFLOW,
            timestamp: new Date().toISOString(),
            id: input.sessionId,
            runId: input.runId,
            ...(parentRunId ? { parentRunId } : {}),
            status: "failed",
            step: "approve-failed",
            error: msg,
          },
          trackerDir,
        );
        if (parentRunId) {
          const ts = new Date().toISOString();
          const parentItemId = `ocr-prep-${input.sessionId}`;
          trackEvent(
            {
              workflow: spec.approveTo.workflow,
              timestamp: ts,
              id: parentItemId,
              runId: parentRunId,
              status: "failed",
              step: "approve-failed",
              error: msg,
            },
            trackerDir,
          );
          appendLogEntry(
            {
              workflow: spec.approveTo.workflow,
              itemId: parentItemId,
              runId: parentRunId,
              level: "error",
              message: `Approve dispatch failed — daemon spawn or enqueue errored: ${msg}`,
              ts,
            },
            trackerDir,
          );
        }
      }
    })();

    return { status: 200, body: { ok: true, fannedOut } };
  };
}

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

// ─── POST /api/ocr/force-research ────────────────────────────

export interface ForceResearchInput {
  sessionId: string;
  runId: string;
  recordIndices: number[];
}
export interface ForceResearchResponse {
  status: 200 | 400;
  body: { ok: boolean; error?: string };
}
export interface ForceResearchHandlerOpts {
  trackerDir?: string;
  triggerForceResearch?: (input: ForceResearchInput) => Promise<void>;
}
export function buildOcrForceResearchHandler(opts: ForceResearchHandlerOpts = {}) {
  return async (input: ForceResearchInput): Promise<ForceResearchResponse> => {
    if (!input.sessionId || !input.runId || !Array.isArray(input.recordIndices)) {
      return { status: 400, body: { ok: false, error: "Missing fields" } };
    }
    if (opts.triggerForceResearch) {
      try {
        await opts.triggerForceResearch(input);
      } catch (err) {
        return { status: 400, body: { ok: false, error: errorMessage(err) } };
      }
    } else {
      const { runForceResearch } = await import("../workflows/ocr/force-research.js");
      try {
        await runForceResearch(input, opts.trackerDir);
      } catch (err) {
        return { status: 400, body: { ok: false, error: errorMessage(err) } };
      }
    }
    return { status: 200, body: { ok: true } };
  };
}

// ─── POST /api/ocr/retry-page ─────────────────────────────────

export interface RetryPageBody {
  sessionId: string;
  runId: string;
  pageNum: number;
}
export interface RetryPageHttpResponse {
  status: 200 | 400 | 404 | 409 | 410;
  body: { ok: true; page: number; recordsAdded: number; stillFailed: boolean } | { ok: false; error: string };
}
export interface RetryPageHandlerOpts {
  trackerDir?: string;
  runRetryPageOverride?: (input: RetryPageBody, opts: { trackerDir?: string }) => Promise<{
    ok: true; page: number; recordsAdded: number; stillFailed: boolean;
  }>;
}

export function buildOcrRetryPageHandler(opts: RetryPageHandlerOpts = {}) {
  const trackerDir = opts.trackerDir;
  return async (input: RetryPageBody): Promise<RetryPageHttpResponse> => {
    if (!input.sessionId || !input.runId || typeof input.pageNum !== "number" || input.pageNum < 1) {
      return { status: 400, body: { ok: false, error: "Missing or invalid sessionId/runId/pageNum" } };
    }
    const key = rowKey(input.sessionId, input.runId);
    if (activeRowKeys.has(key)) {
      return { status: 409, body: { ok: false, error: "Retry already in progress for this row" } };
    }
    activeRowKeys.add(key);
    try {
      const fn = opts.runRetryPageOverride ?? (async (i, o) => {
        return runOcrRetryPage(i, { trackerDir: o.trackerDir });
      });
      const result = await fn(input, { trackerDir });
      return { status: 200, body: { ok: true, page: result.page, recordsAdded: result.recordsAdded, stillFailed: result.stillFailed } };
    } catch (err) {
      if (err instanceof RetryPageError) {
        const status: 400 | 404 | 409 | 410 =
          err.code === "row-not-found" ? 404 :
          err.code === "row-not-mutable" ? 409 :
          err.code === "image-missing" ? 410 :
          400; // spec-missing
        return { status, body: { ok: false, error: err.message } };
      }
      log.error(`[ocr-http] retry-page threw: ${errorMessage(err)}`);
      return { status: 400, body: { ok: false, error: errorMessage(err) } };
    } finally {
      activeRowKeys.delete(key);
    }
  };
}

// ─── POST /api/ocr/reocr-whole-pdf ────────────────────────────

export interface ReocrWholePdfBody {
  sessionId: string;
  runId: string;
}
export interface ReocrWholePdfHttpResponse {
  status: 200 | 400 | 404 | 409;
  body: { ok: true; recordCount: number; verifiedCount: number } | { ok: false; error: string };
}
export interface ReocrWholePdfHandlerOpts {
  trackerDir?: string;
  date?: string;
  _emitOverride?: (entry: TrackerEntry) => void;
  _wholePdfOverride?: <U>(req: OcrRequest<U>) => Promise<OcrResult<U>>;
  _loadRosterOverride?: (path: string) => Promise<unknown>;
  _watchChildRunsOverride?: (opts: WatchChildRunsOpts) => Promise<ChildOutcome[]>;
  _enqueueEidLookupOverride?: (
    items: Array<{ name?: string; emplId?: string; itemId: string }>,
  ) => Promise<void>;
}

export function buildOcrReocrWholePdfHandler(opts: ReocrWholePdfHandlerOpts = {}) {
  const trackerDir = opts.trackerDir;
  return async (input: ReocrWholePdfBody): Promise<ReocrWholePdfHttpResponse> => {
    if (!input.sessionId || !input.runId) {
      return { status: 400, body: { ok: false, error: "Missing sessionId/runId" } };
    }
    const key = rowKey(input.sessionId, input.runId);
    if (activeRowKeys.has(key)) {
      return { status: 409, body: { ok: false, error: "Operation already in progress for this row" } };
    }
    activeRowKeys.add(key);
    try {
      const date = opts.date ?? dateLocal();
      const file = join(trackerDir ?? ".tracker", `ocr-${date}.jsonl`);
      if (!existsSync(file)) return { status: 404, body: { ok: false, error: "OCR row not found" } };
      const lines = readFileSync(file, "utf-8").split("\n").filter(Boolean);
      let row: TrackerEntry | null = null;
      for (const line of lines) {
        try {
          const e: TrackerEntry = JSON.parse(line);
          if (e.id === input.sessionId && e.runId === input.runId) row = e;
        } catch { /* tolerate */ }
      }
      if (!row) return { status: 404, body: { ok: false, error: "OCR row not found" } };
      const formType = row.data?.formType as unknown as string | undefined;
      if (!formType) return { status: 400, body: { ok: false, error: "Row missing formType" } };
      const spec = getFormSpec(formType);
      if (!spec) return { status: 400, body: { ok: false, error: `Unknown formType "${formType}"` } };

      const pdfPath = row.data?.pdfPath as unknown as string | undefined;
      if (!pdfPath) return { status: 400, body: { ok: false, error: "Row missing pdfPath" } };
      const rosterPath = (row.data?.rosterPath as unknown as string | undefined) ?? "";

      const { runOcrWholePdf } = await import("../ocr/pipeline.js");
      const ocrResult = await runOcrWholePdf({
        pdfPath,
        arraySchema: spec.ocrArraySchema as never,
        prompt: spec.prompt,
        schemaName: spec.schemaName,
        _override: opts._wholePdfOverride,
      });

      const { loadRoster: realLoadRoster } = await import("../match/index.js");
      const loadRosterFn = opts._loadRosterOverride ?? realLoadRoster;
      const roster = rosterPath ? (await loadRosterFn(rosterPath) as unknown[]) : [];

      let records = await Promise.all(
        (ocrResult.data as unknown[]).map((r) => spec.matchRecord({ record: r, roster: roster as never })),
      );

      // Eid-lookup fan-out (mirror the orchestrator's lookup phase)
      const lookupTargets: Array<{ rec: unknown; index: number; kind: "name" | "verify" }> = [];
      records.forEach((rec, index) => {
        const kind = spec.needsLookup(rec);
        if (kind === "name" || kind === "verify") lookupTargets.push({ rec, index, kind });
      });

      if (lookupTargets.length > 0) {
        const enqueueItems = lookupTargets.map((t) => ({
          record: t.rec,
          index: t.index,
          kind: t.kind,
          itemId: `ocr-whole-${input.runId}-r${t.index}`,
        }));
        if (opts._enqueueEidLookupOverride) {
          await opts._enqueueEidLookupOverride(
            enqueueItems.map((e) => ({
              ...(e.kind === "name"
                ? { name: spec.carryForwardKey(e.record as never) }
                : { emplId: extractEidLocal(e.record) }),
              itemId: e.itemId,
            })),
          );
        } else {
          const { ensureDaemonsAndEnqueue } = await import("../core/daemon-client.js");
          const { eidLookupCrmWorkflow } = await import("../workflows/eid-lookup/index.js");
          const inputs = enqueueItems.map((e) =>
            e.kind === "name"
              ? { name: spec.carryForwardKey(e.record as never) }
              : { emplId: extractEidLocal(e.record), keepNonHdh: true },
          );
          await ensureDaemonsAndEnqueue(eidLookupCrmWorkflow, inputs as never, {}, {
            deriveItemId: (inp: { name?: string; emplId?: string }) => {
              const matched = enqueueItems.find((e) => {
                if ("name" in inp && inp.name)
                  return spec.carryForwardKey(e.record as never) === inp.name;
                if ("emplId" in inp && inp.emplId)
                  return extractEidLocal(e.record) === inp.emplId;
                return false;
              });
              return matched?.itemId ?? `ocr-whole-fallback-${input.runId}`;
            },
          });
        }

        const { watchChildRuns: realWatchChildRuns } = await import("./watch-child-runs.js");
        const watchChildren = opts._watchChildRunsOverride ?? realWatchChildRuns;
        const outcomes = await watchChildren({
          workflow: "eid-lookup",
          expectedItemIds: enqueueItems.map((e) => e.itemId),
          trackerDir,
          date,
          timeoutMs: 60 * 60_000,
        }).catch(() => [] as ChildOutcome[]);

        const outcomesByItemId = new Map(outcomes.map((o) => [o.itemId, o]));
        for (const enq of enqueueItems) {
          const outcome = outcomesByItemId.get(enq.itemId);
          const idx = enq.index;
          const rec = records[idx] as Record<string, unknown>;
          if (!outcome) {
            if (rec.matchState === "lookup-pending" || rec.matchState === "lookup-running") rec.matchState = "unresolved";
            continue;
          }
          if (enq.kind === "name") {
            const eid = (outcome.data?.emplId ?? "").trim();
            if (outcome.status === "done" && /^\d{5,}$/.test(eid)) {
              if ("employee" in rec) (rec.employee as Record<string, unknown>).employeeId = eid;
              else rec.employeeId = eid;
              rec.matchState = "resolved";
              rec.matchSource = "eid-lookup";
            } else {
              rec.matchState = "unresolved";
            }
          }
          const v = computeVerificationLocal({
            hrStatus: outcome.data?.hrStatus,
            department: outcome.data?.department,
            personOrgScreenshot: outcome.data?.personOrgScreenshot,
          });
          rec.verification = v;
          // Match `isApprovable` in OcrReviewPane: only auto-deselect on a
          // hard "don't process" verification. Soft `lookup-failed` keeps
          // selection — operator decides from the warning banner.
          if (v.state === "inactive" || v.state === "non-hdh") {
            rec.selected = false;
          }
        }
      }

      const verifiedCount = records.filter((r) => {
        const v = (r as Record<string, unknown>).verification as { state?: string } | undefined;
        return v?.state === "verified";
      }).length;

      const emit = opts._emitOverride ?? ((e: TrackerEntry) => trackEvent(e, trackerDir));
      const data = {
        formType,
        pdfOriginalName: (row.data?.pdfOriginalName as unknown as string) ?? "",
        sessionId: input.sessionId,
        ...(row.parentRunId ? { parentRunId: row.parentRunId } : {}),
        recordCount: String(records.length),
        verifiedCount: String(verifiedCount),
        records: JSON.stringify(records),
        failedPages: JSON.stringify([]),
        pageStatusSummary: JSON.stringify({ total: 0, succeeded: 0, failed: 0 }),
      };
      emit({
        workflow: WORKFLOW,
        timestamp: new Date().toISOString(),
        id: input.sessionId,
        runId: input.runId,
        ...(row.parentRunId ? { parentRunId: row.parentRunId } : {}),
        status: "running",
        step: "awaiting-approval",
        data,
      });
      emit({
        workflow: WORKFLOW,
        timestamp: new Date().toISOString(),
        id: input.sessionId,
        runId: input.runId,
        ...(row.parentRunId ? { parentRunId: row.parentRunId } : {}),
        status: "done",
        step: "awaiting-approval",
        data,
      });

      return { status: 200, body: { ok: true, recordCount: records.length, verifiedCount } };
    } catch (err) {
      log.error(`[ocr-http] reocr-whole-pdf threw: ${errorMessage(err)}`);
      return { status: 400, body: { ok: false, error: errorMessage(err) } };
    } finally {
      activeRowKeys.delete(key);
    }
  };
}

// ─── Restart sweep ───────────────────────────────────────────

export function sweepStuckOcrRows(trackerDir: string): void {
  const date = dateLocal();
  const file = join(trackerDir, `ocr-${date}.jsonl`);
  if (!existsSync(file)) return;
  const lines = readFileSync(file, "utf-8").split("\n").filter(Boolean);
  const latestById = new Map<string, TrackerEntry>();
  for (const line of lines) {
    try {
      const e: TrackerEntry = JSON.parse(line);
      const key = `${e.id}#${e.runId}`;
      latestById.set(key, e);
    } catch { /* tolerate */ }
  }
  for (const e of latestById.values()) {
    if (e.status === "pending" || e.status === "running") {
      trackEvent(
        {
          workflow: WORKFLOW,
          timestamp: new Date().toISOString(),
          id: e.id,
          runId: e.runId,
          ...(e.parentRunId ? { parentRunId: e.parentRunId } : {}),
          status: "failed",
          error: "Dashboard restarted while OCR was in progress — please re-upload",
        },
        trackerDir,
      );
    }
  }
}

// ─── Helpers ─────────────────────────────────────────────────

function readFormType(sessionId: string, trackerDir: string | undefined): string | null {
  const date = dateLocal();
  const file = join(trackerDir ?? ".tracker", `ocr-${date}.jsonl`);
  if (!existsSync(file)) return null;
  const lines = readFileSync(file, "utf-8").split("\n").filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const e: TrackerEntry = JSON.parse(lines[i]);
      if (e.id === sessionId && e.data?.formType) {
        return e.data.formType as unknown as string;
      }
    } catch { /* tolerate */ }
  }
  return null;
}

function readParentRunId(sessionId: string, trackerDir: string | undefined): string | undefined {
  const date = dateLocal();
  const file = join(trackerDir ?? ".tracker", `ocr-${date}.jsonl`);
  if (!existsSync(file)) return undefined;
  const lines = readFileSync(file, "utf-8").split("\n").filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const e = JSON.parse(lines[i]) as TrackerEntry;
      if (e.id === sessionId && typeof e.parentRunId === "string" && e.parentRunId.length > 0) {
        return e.parentRunId;
      }
    } catch { /* tolerate malformed lines */ }
  }
  return undefined;
}

function readDryRun(sessionId: string, trackerDir: string | undefined): boolean {
  const date = dateLocal();
  const file = join(trackerDir ?? ".tracker", `ocr-${date}.jsonl`);
  if (!existsSync(file)) return false;
  const lines = readFileSync(file, "utf-8").split("\n").filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const e = JSON.parse(lines[i]) as TrackerEntry;
      if (e.id !== sessionId) continue;
      const value = e.data?.dryRun as unknown;
      if (value === true || value === "true" || value === "1") return true;
    } catch { /* tolerate malformed lines */ }
  }
  return false;
}

function createApprovalDependencyRows(args: {
  trackerDir?: string;
  parentRunId: string;
  childWorkflow: string;
  children: Array<{ id: string; taskId?: string; runId?: string }>;
}): void {
  try {
    const taskStore = createTaskStore(openControlDb({ trackerDir: args.trackerDir }));
    const parent = taskStore.getTaskByRunId(args.parentRunId);
    if (!parent) return;
    for (const child of args.children) {
      const childTask = child.taskId
        ? taskStore.getTask(child.taskId)
        : taskStore.findTaskByIdentity({
            workflow: args.childWorkflow,
            itemId: child.id,
            ...(child.runId ? { runId: child.runId } : {}),
          });
      if (!childTask) continue;
      taskStore.createDependency({
        parentTaskId: parent.taskId,
        childTaskId: childTask.taskId,
        onChildFailed: "block_parent",
        cascadeCancel: true,
        resumeParentAfterChildRetry: true,
      });
    }
  } catch (err) {
    log.warn(`[ocr-http] approve-batch dependency rows skipped: ${errorMessage(err)}`);
  }
}

function isSelectedRecord(record: unknown): boolean {
  if (!record || typeof record !== "object") return false;
  return (record as { selected?: unknown }).selected === true;
}

function extractEidLocal(record: unknown): string {
  const r = record as Record<string, unknown>;
  if (typeof r.employeeId === "string") return r.employeeId;
  const employee = r.employee as Record<string, unknown> | undefined;
  if (employee && typeof employee.employeeId === "string") return employee.employeeId;
  return "";
}

function computeVerificationLocal(d: { hrStatus?: string; department?: string; personOrgScreenshot?: string }): {
  state: "verified" | "inactive" | "non-hdh" | "lookup-failed";
  hrStatus?: string;
  department?: string;
  screenshotFilename: string;
  checkedAt: string;
  error?: string;
} {
  const checkedAt = new Date().toISOString();
  const screenshotFilename = d.personOrgScreenshot ?? "";
  if (!d.hrStatus) return { state: "lookup-failed", error: "no result", checkedAt, screenshotFilename };
  const active = d.hrStatus === "Active";
  const hdh = isAcceptedHdhDepartment(d.department ?? null);
  if (!active) return { state: "inactive", hrStatus: d.hrStatus, department: d.department, screenshotFilename, checkedAt };
  if (!hdh) return { state: "non-hdh", hrStatus: d.hrStatus, department: d.department ?? "", screenshotFilename, checkedAt };
  return { state: "verified", hrStatus: d.hrStatus, department: d.department ?? "", screenshotFilename, checkedAt };
}
