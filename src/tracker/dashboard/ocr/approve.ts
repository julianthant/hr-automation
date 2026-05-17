import { trackEvent, appendLogEntry, readEntries } from "../../jsonl.js";
import { log } from "../../../utils/log.js";
import { errorMessage } from "../../../utils/errors.js";
import { getFormSpec } from "../../../services/ocr/forms/registry.js";
import { openControlDb } from "../../../core/control-db.js";
import { createTaskStore } from "../../../core/task-store/index.js";
import { buildHttpPendingData } from "../../../core/daemon/enqueue-dispatch.js";
import { readQueueTitle, rootQueueTitleData } from "../../../domain/queue-title.js";
import { findLatestEntryForPredicate } from "../../find-latest-entry.js";
import { deriveRowArchetype } from "../../../domain/row-archetype.js";
import { readFormType, readParentRunId, readDryRun, readOriginWorkflow } from "./shared.js";

const WORKFLOW = "ocr";

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
    opts?: {
      parentRunId?: string;
      onPreEmitPending?: (
        item: unknown,
        runId: string,
        parentRunId: string | undefined,
        itemId: string,
      ) => void;
    },
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
    const formType = readFormType(input.sessionId, trackerDir);
    if (!formType) {
      return { status: 400, body: { ok: false, error: "Could not resolve formType for session" } };
    }
    const spec = getFormSpec(formType);
    if (!spec) {
      return { status: 400, body: { ok: false, error: `Unknown formType "${formType}"` } };
    }

    const parentRunId = readParentRunId(input.sessionId, trackerDir);
    const originWorkflow = readOriginWorkflow(input.sessionId, trackerDir);
    const dryRun = readDryRun(input.sessionId, trackerDir);
    const latestReviewData = readLatestOcrReviewData(input.sessionId, input.runId, trackerDir);
    const parentSubject = parentRunId
      ? readParentSubjectFromParentRow(
          originWorkflow ?? spec.approveTo.workflow,
          originWorkflow ? undefined : `ocr-prep-${input.sessionId}`,
          parentRunId,
          trackerDir,
        )
      : undefined;

    // Only fan out records the operator selected in the preview pane.
    // Unsigned rows / unverified rows / unknown-doc rows are kept in the
    // tracker payload for context but should never become daemon work.
    const fannedOut: Array<{ workflow: string; itemId: string }> = [];
    const enqueueInputs: unknown[] = [];
    const itemIds: string[] = [];
    input.records.forEach((rec, index) => {
      if (!isSelectedRecord(rec)) return;
      const baseFanInput = spec.approveTo.deriveInput(rec as never);
      const fanInput =
        baseFanInput && typeof baseFanInput === "object"
          ? {
              ...(baseFanInput as Record<string, unknown>),
              ...(dryRun ? { dryRun: true } : {}),
              ...(parentSubject ? { parentSubject } : {}),
            }
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

    // Dispatch runs in the background. The "approved" JSONL row is written
    // AFTER the enqueue succeeds so that the restart-recovery path in
    // oath-upload only trusts fannedOutItemIds that are actually in task_store.
    // Failures during dispatch surface as `failed step=approve-failed`.
    void (async () => {
      try {
        let dispatchResult: void | { enqueued?: Array<{ id: string; taskId?: string; runId?: string }> };
        const emitFallbackChildPending = (
          item: unknown,
          childRunId: string,
          passedParentRunId: string | undefined,
          itemId: string,
        ): void => {
          const childInput =
            item && typeof item === "object" && !Array.isArray(item)
              ? (item as Record<string, unknown>)
              : undefined;
          trackEvent(
            {
              workflow: spec.approveTo.workflow,
              timestamp: new Date().toISOString(),
              id: itemId,
              runId: childRunId,
              status: "pending",
              data: {
                ...buildFallbackPendingData(item),
                ...rootQueueTitleData(readParentSubjectFromInput(item)),
                archetype: "delegate-child",
              },
              ...(passedParentRunId ? { parentRunId: passedParentRunId } : {}),
              ...(childInput ? { input: childInput } : {}),
            },
            trackerDir,
          );
        };
        if (opts.ensureDaemonsAndEnqueueOverride) {
          dispatchResult = await opts.ensureDaemonsAndEnqueueOverride(
            spec.approveTo.workflow,
            enqueueInputs,
            (_inp, idx) => itemIds[idx],
            {
              ...(parentRunId ? { parentRunId } : {}),
              onPreEmitPending: emitFallbackChildPending,
            },
          );
        } else {
          const { ensureDaemonsAndEnqueue } = await import("../../../core/daemon/client.js");
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
              trackerDir,
              deriveItemId: (inp: unknown) => inputToItemId.get(JSON.stringify(inp)) ?? `ocr-fallback-${input.runId}-r0`,
              ...(parentRunId ? { parentRunId } : {}),
              onPreEmitPending: (item, childRunId, passedParentRunId, itemId) => {
                const childInput =
                  item && typeof item === "object" && !Array.isArray(item)
                    ? (item as Record<string, unknown>)
                    : undefined;
                trackEvent(
                  {
                    workflow: childWf.config.name,
                    timestamp: new Date().toISOString(),
                    id: itemId,
                    runId: childRunId,
                    status: "pending",
                    data: {
                      ...buildHttpPendingData(childWf, item),
                      ...rootQueueTitleData(readParentSubjectFromInput(item)),
                      archetype: deriveRowArchetype(childWf.archetype, passedParentRunId ?? parentRunId),
                    },
                    ...(passedParentRunId ? { parentRunId: passedParentRunId } : {}),
                    ...(childInput ? { input: childInput } : {}),
                  },
                  trackerDir,
                );
              },
            },
          );
        }
        // Capture the actually-enqueued item ids from the dispatch result.
        const enqueuedIds: string[] =
          dispatchResult && "enqueued" in dispatchResult && Array.isArray(dispatchResult.enqueued)
            ? (dispatchResult.enqueued as Array<{ id: string }>).map((e) => e.id)
            : itemIds;

        // Write approved row AFTER successful enqueue so restart recovery
        // can trust that fannedOutItemIds are all present in task_store.
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
              ...latestReviewData,
              archetype: "batch-parent",
              mode: "prepare",
              formType,
              sessionId: input.sessionId,
              records: JSON.stringify(input.records),
              recordCount: String(input.records.length),
              fannedOutCount: String(enqueuedIds.length),
              fannedOutItemIds: JSON.stringify(enqueuedIds),
              ...(dryRun ? { dryRun: "true" } : {}),
            },
          },
          trackerDir,
        );
        if (parentRunId) {
          writeOriginParentApproved({
            originWorkflow: originWorkflow ?? spec.approveTo.workflow,
            parentItemId: originWorkflow ? undefined : `ocr-prep-${input.sessionId}`,
            parentRunId,
            fannedOutCount: enqueuedIds.length,
            trackerDir,
          });
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

function readLatestOcrReviewData(
  sessionId: string,
  runId: string,
  trackerDir?: string,
): Record<string, string> {
  const rows = readEntries(WORKFLOW, trackerDir);
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i];
    if (row.id !== sessionId || row.runId !== runId || !row.data) continue;
    return { ...row.data };
  }
  return {};
}

function buildFallbackPendingData(input: unknown): Record<string, string> {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {};
  const data: Record<string, string> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (value === undefined || value === null) continue;
    if (typeof value === "object") {
      try {
        data[key] = JSON.stringify(value);
      } catch {
        data[key] = String(value);
      }
      continue;
    }
    data[key] = String(value);
  }
  return data;
}

function readParentSubjectFromInput(input: unknown): string | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  const value = (input as Record<string, unknown>).parentSubject;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/**
 * Emit the terminal step transition on the origin parent row when OCR is
 * approved. Keep the parent tagged as `mode=prepare` so the dashboard can
 * fold it together with delegated daemon children under one queue row.
 */
function writeOriginParentApproved(args: {
  originWorkflow: string;
  /** When set, used directly. When absent, look up the item id via parentRunId. */
  parentItemId: string | undefined;
  parentRunId: string;
  fannedOutCount: number;
  trackerDir?: string;
}): void {
  const ts = new Date().toISOString();
  // Resolve the parent's item id. When `originWorkflow` is a kernel-managed
  // daemon workflow (e.g. "oath-upload"), the item id is on the tracker row
  // not predictable from the OCR session id — look it up by runId.
  let parentItemId = args.parentItemId;
  if (!parentItemId) {
    const originEntry = findLatestEntryForPredicate({
      workflow: args.originWorkflow,
      trackerDir: args.trackerDir,
      lookbackDays: 7,
      predicate: (e) => e.runId === args.parentRunId,
    });
    parentItemId = originEntry?.id ?? args.parentRunId;
  }
  const latestParentData = readLatestEntryData(args.originWorkflow, parentItemId, args.parentRunId, args.trackerDir);
  // For prep-anchor rows (ocr-prep-* in spec.approveTo.workflow) mark done/approved.
  // For kernel-daemon origin rows (e.g. oath-upload) emit a running status update so
  // the daemon's in-progress row shows OCR approval progress without prematurely
  // flipping to "done".
  const isKernelDaemonParent = args.parentItemId === undefined;
  trackEvent(
    {
      workflow: args.originWorkflow,
      timestamp: ts,
      id: parentItemId,
      runId: args.parentRunId,
      status: isKernelDaemonParent ? "running" : "done",
      step: isKernelDaemonParent ? "wait-ocr-approval" : "approved",
      data: {
        ...latestParentData,
        ...(isKernelDaemonParent ? { approvedOcr: "true" } : { mode: "prepare" }),
        fannedOutCount: String(args.fannedOutCount),
      },
    },
    args.trackerDir,
  );
  appendLogEntry(
    {
      workflow: args.originWorkflow,
      itemId: parentItemId,
      runId: args.parentRunId,
      level: "success",
      message: `OCR approved · ${args.fannedOutCount} record${args.fannedOutCount === 1 ? "" : "s"} fanned out to the daemon.`,
      ts,
    },
    args.trackerDir,
  );
}

function readLatestEntryData(
  workflow: string,
  id: string,
  runId: string,
  trackerDir?: string,
): Record<string, string> {
  const rows = readEntries(workflow, trackerDir);
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i];
    if (row.id !== id || row.runId !== runId || !row.data) continue;
    return { ...row.data };
  }
  return {};
}

function readParentSubjectFromParentRow(
  workflow: string,
  parentItemId: string | undefined,
  parentRunId: string,
  trackerDir?: string,
): string | undefined {
  let data: Record<string, string>;
  if (parentItemId) {
    data = readLatestEntryData(workflow, parentItemId, parentRunId, trackerDir);
  } else {
    const entry = findLatestEntryForPredicate({
      workflow,
      trackerDir,
      lookbackDays: 7,
      predicate: (e) => e.runId === parentRunId,
    });
    data = entry?.data ? { ...entry.data } : {};
  }
  const name = readQueueTitle(data) ?? data.__name;
  return typeof name === "string" && name.length > 0 ? name : undefined;
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
