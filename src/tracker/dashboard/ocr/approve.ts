import { trackEvent, appendLogEntry } from "../../jsonl.js";
import { log } from "../../../utils/log.js";
import { errorMessage } from "../../../utils/errors.js";
import { getFormSpec } from "../../../ocr/forms/registry.js";
import { openControlDb } from "../../../core/control-db.js";
import { createTaskStore } from "../../../core/task-store.js";
import { readFormType, readParentRunId, readDryRun } from "./shared.js";

const WORKFLOW = "ocr";

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
          const { ensureDaemonsAndEnqueue } = await import("../../../core/daemon-client.js");
          const { loadWorkflow } = await import("../../../core/workflow-loaders.js");
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

function isSelectedRecord(record: unknown): boolean {
  if (!record || typeof record !== "object") return false;
  return (record as { selected?: unknown }).selected === true;
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
