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
import { trackEvent, dateLocal, type TrackerEntry } from "./jsonl.js";
import { errorMessage } from "../utils/errors.js";
import { log } from "../utils/log.js";
import { listFormTypes, getFormSpec, type FormTypeListing } from "../workflows/ocr/form-registry.js";
import { runOcrOrchestrator, type OcrOrchestratorOpts } from "../workflows/ocr/orchestrator.js";

const WORKFLOW = "ocr";

// ─── Per-sessionId lock ──────────────────────────────────────

const activeSessionIds = new Set<string>();

export function _resetSessionLockForTests(): void {
  activeSessionIds.clear();
}

// ─── GET /api/ocr/forms ──────────────────────────────────────

export function buildOcrFormsHandler(): () => FormTypeListing[] {
  return () => listFormTypes();
}

// ─── POST /api/ocr/prepare + /reupload ───────────────────────

export interface PrepareInput {
  pdfPath: string;
  pdfOriginalName: string;
  formType: string;
  rosterMode: "existing" | "download";
  rosterPath?: string;
  sessionId?: string;
  previousRunId?: string;
  isReupload?: boolean;
}

export interface PrepareResponse {
  status: 202 | 400 | 409 | 500;
  body:
    | { ok: true; sessionId: string; runId: string }
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
        await runOrch(
          {
            pdfPath: input.pdfPath,
            pdfOriginalName: input.pdfOriginalName,
            formType: input.formType,
            sessionId,
            rosterPath: input.rosterPath,
            rosterMode: input.rosterMode,
            previousRunId: input.previousRunId,
          },
          { runId, trackerDir },
        );
      } catch (err) {
        log.error(`[ocr-http] orchestrator threw: ${errorMessage(err)}`);
      } finally {
        activeSessionIds.delete(sessionId);
      }
    })();

    return { status: 202, body: { ok: true, sessionId, runId } };
  };
}

// ─── POST /api/ocr/approve-batch ─────────────────────────────

export interface ApproveInput {
  sessionId: string;
  runId: string;
  records: unknown[];
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
  ) => Promise<void>;
}

export function buildOcrApproveHandler(
  opts: ApproveHandlerOpts = {},
): (input: ApproveInput) => Promise<ApproveResponse> {
  const trackerDir = opts.trackerDir;
  return async (input) => {
    if (!input.sessionId || !input.runId || !Array.isArray(input.records)) {
      return { status: 400, body: { ok: false, error: "Missing sessionId/runId/records" } };
    }
    const formType = readFormType(input.sessionId, trackerDir);
    if (!formType) {
      return { status: 400, body: { ok: false, error: "Could not resolve formType for session" } };
    }
    const spec = getFormSpec(formType);
    if (!spec) {
      return { status: 400, body: { ok: false, error: `Unknown formType "${formType}"` } };
    }

    const fannedOut: Array<{ workflow: string; itemId: string }> = [];
    const enqueueInputs: unknown[] = [];
    const itemIds: string[] = [];
    input.records.forEach((rec, index) => {
      const fanInput = spec.approveTo.deriveInput(rec as never);
      const itemId = spec.approveTo.deriveItemId(rec as never, input.runId, index);
      enqueueInputs.push(fanInput);
      itemIds.push(itemId);
      fannedOut.push({ workflow: spec.approveTo.workflow, itemId });
    });

    try {
      if (opts.ensureDaemonsAndEnqueueOverride) {
        await opts.ensureDaemonsAndEnqueueOverride(spec.approveTo.workflow, enqueueInputs, (_inp, idx) => itemIds[idx]);
      } else {
        const { ensureDaemonsAndEnqueue } = await import("../core/daemon-client.js");
        const { loadWorkflow } = await import("../core/workflow-loaders.js");
        const childWf = await loadWorkflow(spec.approveTo.workflow);
        if (!childWf) {
          return { status: 500, body: { ok: false, error: `Unknown approveTo workflow "${spec.approveTo.workflow}"` } };
        }
        const inputToItemId = new Map(
          enqueueInputs.map((inp, idx) => [JSON.stringify(inp), itemIds[idx] ?? `ocr-fallback-${input.runId}-r${idx}`])
        );
        await ensureDaemonsAndEnqueue(
          childWf,
          enqueueInputs as never,
          {},
          {
            deriveItemId: (inp: unknown) => inputToItemId.get(JSON.stringify(inp)) ?? `ocr-fallback-${input.runId}-r0`,
          },
        );
      }
    } catch (err) {
      return { status: 500, body: { ok: false, error: errorMessage(err) } };
    }

    trackEvent(
      {
        workflow: WORKFLOW,
        timestamp: new Date().toISOString(),
        id: input.sessionId,
        runId: input.runId,
        status: "done",
        step: "approved",
        data: { fannedOutCount: String(fannedOut.length) },
      },
      trackerDir,
    );

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
