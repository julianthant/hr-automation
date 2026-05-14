import { randomUUID } from "node:crypto";
import { trackEvent, appendLogEntry } from "../../jsonl.js";
import { log, withLogContext, setLogRunId } from "../../../utils/log.js";
import { getFormSpec } from "../../../services/ocr/forms/registry.js";
import { runOcrOrchestrator, type OcrOrchestratorOpts } from "../../../workflows/ocr/orchestrator.js";
import { errorMessage } from "../../../utils/errors.js";
import { hasSessionLock, acquireSessionLock, releaseSessionLock } from "./lock.js";
import { clearOcrPrepareAbort, isOperatorDiscardAbortError } from "../../ocr-prepare-abort.js";
import { getByName, autoLabel } from "../../../core/index.js";

function workflowDisplayLabel(workflowName: string): string {
  return getByName(workflowName)?.label ?? autoLabel(workflowName);
}

function shortRunIdSuffix(runId: string): string {
  return runId.slice(-4);
}

function batchAnchorName(workflowName: string, runId: string): string {
  return `${workflowDisplayLabel(workflowName)} · #${shortRunIdSuffix(runId)}`;
}

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
  runOrchestrator?: (input: import("../../../workflows/ocr/schema.js").OcrInput, opts: OcrOrchestratorOpts) => Promise<void>;
}

/** Parent row synthesized on `oath-signature` / `emergency-contact` when OCR starts from Run modal. */
interface OriginPrepContext {
  originWorkflow: string;
  parentItemId: string;
  parentRunId: string;
  pdfOriginalName: string;
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

    // Synthesize a parent row in the origin workflow when the upload came
    // from a downstream workflow's run modal (oath-signature /
    // emergency-contact). Operator sees the row in their own queue with the
    // standard LogPanel UI and a few simple log entries. The OCR row links
    // back via parentRunId, and post-approval fan-out items inherit the
    // same parentRunId so they nest under this parent automatically.
    const origin = input.originWorkflow && input.originWorkflow !== WORKFLOW
      ? input.originWorkflow
      : null;
    let originPrep: OriginPrepContext | null = null;
    if (origin) {
      originPrep = {
        originWorkflow: origin,
        parentItemId: `ocr-prep-${sessionId}`,
        parentRunId: randomUUID(),
        pdfOriginalName: input.pdfOriginalName,
      };
      writeOriginParentPending({
        originWorkflow: originPrep.originWorkflow,
        parentItemId: originPrep.parentItemId,
        parentRunId: originPrep.parentRunId,
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
              ...(originPrep ? { parentRunId: originPrep.parentRunId } : {}),
            },
            { runId, trackerDir },
          );
        }, trackerDir);
      } catch (err) {
        log.error(`[ocr-http] orchestrator threw: ${errorMessage(err)}`);
        // Orchestrator emits the OCR-side `failed` row before rethrow;
        // discard-prepare emits both rows synchronously — only sync the origin
        // parent when OCR failed without a mirrored parent update yet.
        if (isOperatorDiscardAbortError(err)) {
          /* discard handler already mirrored */
        } else if (originPrep) {
          writeOriginParentPrepFailed({
            ...originPrep,
            ocrSessionId: sessionId,
            trackerDir,
            detail: errorMessage(err),
          });
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
        ...(originPrep ? { parentRunId: originPrep.parentRunId } : {}),
      },
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
  // folded into a DelegationRow with its kernel children (which inherit
  // parentRunId from the OCR fan-out path). Pre-approval the row renders
  // as a standard EntryItem in the queue.
  const baseData: Record<string, string> = {
    __name: batchAnchorName(args.originWorkflow, args.parentRunId),
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

function writeOriginParentPrepFailed(args: OriginPrepContext & {
  ocrSessionId: string;
  trackerDir?: string;
  detail: string;
}): void {
  const ts = new Date().toISOString();
  const baseData: Record<string, string> = {
    __name: batchAnchorName(args.originWorkflow, args.parentRunId),
    __id: args.parentItemId,
    mode: "prepare",
    pdfOriginalName: args.pdfOriginalName,
    ocrSessionId: args.ocrSessionId,
  };
  trackEvent(
    {
      workflow: args.originWorkflow,
      timestamp: ts,
      id: args.parentItemId,
      runId: args.parentRunId,
      status: "failed",
      error: `OCR prep failed — ${args.detail}`,
      data: baseData,
    },
    args.trackerDir,
  );
  appendLogEntry(
    {
      workflow: args.originWorkflow,
      itemId: args.parentItemId,
      runId: args.parentRunId,
      level: "error",
      message: `OCR prep failed — ${args.detail}`,
      ts,
    },
    args.trackerDir,
  );
}

export const __test_writeOriginParentPending = writeOriginParentPending;
export const __test_writeOriginParentPrepFailed = writeOriginParentPrepFailed;
