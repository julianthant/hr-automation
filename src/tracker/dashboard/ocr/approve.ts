import { emitTrackerRow, appendLogEntry } from "../../jsonl.js";
import { log } from "../../../utils/log.js";
import { errorMessage } from "../../../utils/errors.js";
import { getFormSpec } from "../../../services/ocr/forms/registry.js";
import { openControlDb } from "../../../core/control-db.js";
import { createTaskStore } from "../../../core/task-store/index.js";
import { buildHttpPendingData } from "../../../core/daemon/enqueue-dispatch.js";
import { readQueueTitle, rootQueueTitleData } from "../../../domain/queue-title.js";
import { findLatestEntryForPredicate } from "../../find-latest-entry.js";
import { deriveRowArchetype, resolveArchetype } from "../../../domain/row-archetype.js";
import { readFormType, readParentRunId, readDryRun, readOriginWorkflow } from "./shared.js";
import { emitApproved } from "../../../services/ocr/approval-signal.js";

const WORKFLOW = "ocr";
const SESSION_LOOKBACK_DAYS = 7;

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

    const approveTo = spec.approveTo;
    const parentRunId = readParentRunId(input.sessionId, trackerDir);
    const originWorkflow = readOriginWorkflow(input.sessionId, trackerDir);
    const dryRun = readDryRun(input.sessionId, trackerDir);
    const latestReviewData = readLatestOcrReviewData(input.sessionId, input.runId, trackerDir);
    const parentSubject = parentRunId && approveTo
      ? readParentSubjectFromParentRow(
          originWorkflow ?? approveTo.workflow,
          originWorkflow ? undefined : `ocr-prep-${input.sessionId}`,
          parentRunId,
          trackerDir,
        )
      : undefined;

    const selectedRecords = input.records.filter(isSelectedRecord);
    if (selectedRecords.length === 0) {
      return {
        status: 400,
        body: { ok: false, error: "No selected records to approve" },
      };
    }

    const fannedOut: Array<{ workflow: string; itemId: string }> = [];
    const enqueueInputs: unknown[] = [];
    const itemIds: string[] = [];
    if (approveTo) {
      // Only fan out records the operator selected in the preview pane.
      // Unsigned rows / unverified rows / unknown-doc rows are kept in the
      // tracker payload for context but should never become daemon work.
      input.records.forEach((rec, index) => {
        if (!isSelectedRecord(rec)) return;
        const baseFanInput = approveTo.deriveInput(rec as never);
        const fanInput =
          baseFanInput && typeof baseFanInput === "object"
            ? {
                ...(baseFanInput as Record<string, unknown>),
                ...(dryRun ? { dryRun: true } : {}),
                ...(parentSubject ? { parentSubject } : {}),
              }
            : baseFanInput;
        const itemId = approveTo.deriveItemId(rec as never, input.runId, index);
        enqueueInputs.push(fanInput);
        itemIds.push(itemId);
        fannedOut.push({ workflow: approveTo.workflow, itemId });
      });
    }

    // Approval finalization runs in the background. For specs with approveTo,
    // write the terminal row after enqueue succeeds so fannedOutItemIds only
    // names task_store-backed children. Specs without approveTo simply write
    // the terminal OCR row and wake the owning workflow to fan out itself.
    // Failures surface as `failed step=approve-failed`.
    void (async () => {
      try {
        let dispatchResult: void | { enqueued?: Array<{ id: string; taskId?: string; runId?: string }> } = undefined;
        if (approveTo) {
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
            emitTrackerRow(
              {
                workflow: approveTo.workflow,
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
              approveTo.workflow,
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
            const childWf = await loadWorkflow(approveTo.workflow);
            if (!childWf) {
              log.error(
                `[ocr-http] approve-batch: unknown approveTo workflow "${approveTo.workflow}" — items not enqueued`,
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
                  emitTrackerRow(
                    {
                      workflow: childWf.config.name,
                      timestamp: new Date().toISOString(),
                      id: itemId,
                      runId: childRunId,
                      status: "pending",
                      data: {
                        ...buildHttpPendingData(childWf, item, passedParentRunId ?? parentRunId),
                        ...rootQueueTitleData(readParentSubjectFromInput(item)),
                        archetype: deriveRowArchetype(
                          resolveArchetype(childWf.config, item),
                          passedParentRunId ?? parentRunId,
                        ),
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
        }
        // Capture the actually-enqueued item ids from the dispatch result.
        const enqueuedIds: string[] =
          approveTo && dispatchResult && "enqueued" in dispatchResult && Array.isArray(dispatchResult.enqueued)
            ? (dispatchResult.enqueued as Array<{ id: string }>).map((e) => e.id)
            : approveTo
              ? itemIds
              : [];

        // Under the new approval contract this row IS the OCR row's
        // terminal `done`: the orchestrator now emits `running
        // step=awaiting-approval` (not `done`) and the kernel-path handler
        // suspends on `subscribeToApproval` until the matching
        // `emitApproved` call below wakes it. Dashboard path has no
        // kernel wrapping — this row is the only `done` emit.
        emitTrackerRow(
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
        // Wake any kernel-path handler subscribed via
        // `subscribeToApproval`. Dashboard-path runs (no kernel wrapping)
        // have no subscriber — emitApproved silently no-ops when the
        // listener registry is empty for this sessionId.
        emitApproved(
          { workflow: WORKFLOW, sessionId: input.sessionId },
          { records: input.records, fannedOutItemIds: enqueuedIds },
        );
        if (approveTo && parentRunId) {
          writeOriginParentApproved({
            originWorkflow: originWorkflow ?? approveTo.workflow,
            parentItemId: originWorkflow ? undefined : `ocr-prep-${input.sessionId}`,
            parentRunId,
            fannedOutCount: enqueuedIds.length,
            trackerDir,
          });
        }

        if (approveTo && parentRunId && dispatchResult?.enqueued) {
          createApprovalDependencyRows({
            trackerDir,
            parentRunId,
            childWorkflow: approveTo.workflow,
            children: dispatchResult.enqueued,
          });
        }
      } catch (err) {
        const msg = errorMessage(err);
        log.error(`[ocr-http] approve-batch dispatch failed: ${msg}`);
        // Surface the failure on both rows so the operator notices.
        emitTrackerRow(
          {
            workflow: WORKFLOW,
            timestamp: new Date().toISOString(),
            id: input.sessionId,
            runId: input.runId,
            ...(parentRunId ? { parentRunId } : {}),
            status: "failed",
            step: "approve-failed",
            // OCR prep parent is always batch-parent.
            data: { archetype: "batch-parent" },
            error: msg,
          },
          trackerDir,
        );
        if (approveTo && parentRunId) {
          const ts = new Date().toISOString();
          const parentItemId = `ocr-prep-${input.sessionId}`;
          emitTrackerRow(
            {
              workflow: approveTo.workflow,
              timestamp: ts,
              id: parentItemId,
              runId: parentRunId,
              status: "failed",
              step: "approve-failed",
              // Origin parent row is batch-parent (oath-upload root, or
              // synthetic ocr-prep-* anchor row).
              data: { archetype: "batch-parent" },
              error: msg,
            },
            trackerDir,
          );
          appendLogEntry(
            {
              workflow: approveTo.workflow,
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

function readLatestEntryDataWithLookback(
  workflow: string,
  matchId: string,
  matchRunId: string,
  trackerDir?: string,
): Record<string, string> {
  // Walk today + past N days, newest-first, returning the first match.
  // Cross-day case: session started yesterday, approved today — yesterday's
  // JSONL holds the actual data. Today-only `readEntries(...)` returned {}.
  const entry = findLatestEntryForPredicate({
    workflow,
    ...(trackerDir !== undefined ? { trackerDir } : {}),
    lookbackDays: SESSION_LOOKBACK_DAYS,
    predicate: (row) => row.id === matchId && row.runId === matchRunId && Boolean(row.data),
  });
  return entry?.data ? { ...entry.data } : {};
}

function readLatestOcrReviewData(
  sessionId: string,
  runId: string,
  trackerDir?: string,
): Record<string, string> {
  return readLatestEntryDataWithLookback(WORKFLOW, sessionId, runId, trackerDir);
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
  // For prep-anchor rows (ocr-prep-* in approveTo.workflow) mark done/approved.
  // For kernel-daemon origin rows (e.g. oath-upload) emit a running status update so
  // the daemon's in-progress row shows OCR approval progress without prematurely
  // flipping to "done".
  const isKernelDaemonParent = args.parentItemId === undefined;
  // Both branches are batch-parent rows: the synthetic ocr-prep-* anchor
  // is the OCR batch row; the kernel-daemon origin (oath-upload) is also
  // a batch-parent at the top level of its tree.
  emitTrackerRow(
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
        archetype: "batch-parent",
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
  return readLatestEntryDataWithLookback(workflow, id, runId, trackerDir);
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
