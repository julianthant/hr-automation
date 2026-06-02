import { emitTrackerRow } from "../../jsonl.js";
import { log } from "../../../utils/log.js";
import { errorMessage } from "../../../utils/errors.js";
import { getFormSpec } from "../../../services/ocr/forms/registry.js";
import { openControlDb } from "../../../core/control-db.js";
import { createTaskStore } from "../../../core/task-store/index.js";
import { buildHttpPendingData } from "../../../core/daemon/enqueue-dispatch.js";
import { rootQueueTitleData } from "../../../domain/queue-title.js";
import { findLatestEntryForPredicate, findFrozenTraceId } from "../../find-latest-entry.js";
import { deriveRowArchetype, resolveArchetype } from "../../../domain/row-archetype.js";
import { readFormType, readParentRunId, readDryRun } from "./shared.js";
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
    // Fanned-out children nest under the run that owns approval: the delegating
    // parent run when OCR was delegated (oath-upload legacy / EC delegation),
    // else the OCR run itself (standalone OCR-hub upload). This keeps the
    // oath-signature signer rows and the oath-upload ticket row grouped under
    // the OCR card instead of appearing as orphaned top-level rows.
    const childParentRunId = parentRunId ?? input.runId;
    // Root trace-id propagation (DISPLAY-only): the OCR root row carries the
    // operation's frozen trace id (`ou-...` after the oath form branded it via
    // `traceCode`, else `oc-...`). This fan-out runs OUTSIDE any kernel ctx
    // (HTTP path), so we read the root id back off the OCR row and stamp it as
    // `rootTraceId` on every enqueued child's `__runtimeOptions` — the daemon
    // worker's `run-one-item` re-emit then displays the OCR root's id on the
    // signer rows + oath-upload ticket while each keeps its own runId/itemId.
    const ocrRootTraceId = findFrozenTraceId({
      workflow: WORKFLOW,
      runId: input.runId,
      ...(trackerDir !== undefined ? { trackerDir } : {}),
    });
    const dryRun = readDryRun(input.sessionId, trackerDir);
    const latestReviewData = readLatestOcrReviewData(input.sessionId, input.runId, trackerDir);
    const parentSubject = parentRunId && approveTo
      ? readParentSubjectFromReviewData(latestReviewData)
      : undefined;

    const selectedRecords = input.records.filter(isSelectedRecord);
    if (selectedRecords.length === 0) {
      return {
        status: 400,
        body: { ok: false, error: "No selected records to approve" },
      };
    }

    const approveDocumentTo = spec.approveDocumentTo;

    const fannedOut: Array<{ workflow: string; itemId: string }> = [];
    const enqueueInputs: unknown[] = [];
    const itemIds: string[] = [];
    if (approveTo) {
      // Only fan out records the operator selected in the preview pane.
      // Unsigned rows / unverified rows / unknown-doc rows are kept in the
      // tracker payload for context but should never become daemon work. A
      // spec-level `canFanOut` guard additionally skips selected-but-incomplete
      // records (oath: a signed row whose EID never resolved) so the
      // per-record itemIds stay in sync with what is actually enqueued.
      input.records.forEach((rec, index) => {
        if (!isSelectedRecord(rec)) return;
        if (approveTo.canFanOut && !approveTo.canFanOut(rec as never)) return;
        const baseFanInput = approveTo.deriveInput(rec as never);
        const fanInput =
          baseFanInput && typeof baseFanInput === "object"
            ? withRootTraceIdRuntimeOption(
                {
                  ...(baseFanInput as Record<string, unknown>),
                  ...(dryRun ? { dryRun: true } : {}),
                  ...(parentSubject ? { parentSubject } : {}),
                },
                ocrRootTraceId,
              )
            : baseFanInput;
        const itemId = approveTo.deriveItemId(rec as never, input.runId, index);
        enqueueInputs.push(fanInput);
        itemIds.push(itemId);
        fannedOut.push({ workflow: approveTo.workflow, itemId });
      });
    }

    // Reflect the once-per-document fan-out target in the HTTP response too —
    // its itemId is deterministic from the OCR run id, so it's known
    // synchronously even though the actual enqueue happens in the background
    // (after the per-record fan-out, so it can pass `perRecordItemIds`).
    if (approveDocumentTo) {
      fannedOut.push({
        workflow: approveDocumentTo.workflow,
        itemId: approveDocumentTo.deriveItemId({
          records: [],
          sessionId: input.sessionId,
          runId: input.runId,
          perRecordItemIds: [],
        } as never),
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
                  archetype: "single",
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
                ...(childParentRunId ? { parentRunId: childParentRunId } : {}),
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
                ...(childParentRunId ? { parentRunId: childParentRunId } : {}),
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
                        ...buildHttpPendingData(childWf, item, passedParentRunId ?? childParentRunId),
                        ...rootQueueTitleData(readParentSubjectFromInput(item)),
                        archetype: deriveRowArchetype(
                          resolveArchetype(childWf.config, item),
                          passedParentRunId ?? childParentRunId,
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

        // ─── Once-per-document fan-out (approveDocumentTo) ───────────────
        // After the per-record fan-out, enqueue exactly ONE downstream row
        // (oath-upload's ServiceNow ticket). It is handed `perRecordItemIds`
        // = the itemIds actually enqueued above, so it can wait on exactly
        // those rows before filing. Runs on a DIFFERENT daemon than the
        // per-record target, so neither waits on its own daemon's children.
        let docDispatchResult: void | { enqueued?: Array<{ id: string; taskId?: string; runId?: string }> } = undefined;
        let docFanItemId: string | undefined;
        if (approveDocumentTo) {
          const doc = {
            records: input.records.filter(isSelectedRecord) as never[],
            sessionId: input.sessionId,
            runId: input.runId,
            perRecordItemIds: enqueuedIds,
            ...(typeof latestReviewData.pdfOriginalName === "string"
              ? { pdfOriginalName: latestReviewData.pdfOriginalName }
              : {}),
            ...(typeof latestReviewData.pdfFileId === "string"
              ? { pdfFileId: latestReviewData.pdfFileId }
              : {}),
            ...(typeof latestReviewData.pdfHash === "string"
              ? { pdfHash: latestReviewData.pdfHash }
              : {}),
            ...(typeof latestReviewData.pdfPath === "string"
              ? { pdfPath: latestReviewData.pdfPath }
              : {}),
            ...(dryRun ? { dryRun: true } : {}),
          };
          const docInput = withRootTraceIdRuntimeOption(
            approveDocumentTo.deriveInput(doc as never),
            ocrRootTraceId,
          );
          docFanItemId = approveDocumentTo.deriveItemId(doc as never);
          docDispatchResult = await enqueueDocFanOut({
            workflow: approveDocumentTo.workflow,
            input: docInput,
            itemId: docFanItemId,
            childParentRunId,
            trackerDir,
            ensureDaemonsAndEnqueueOverride: opts.ensureDaemonsAndEnqueueOverride,
            ocrRunId: input.runId,
          });
          void docFanItemId; // already reflected in the synchronous `fannedOut` response
        }

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
              archetype: "preview",
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
        if (approveTo && childParentRunId && dispatchResult?.enqueued) {
          createApprovalDependencyRows({
            trackerDir,
            parentRunId: childParentRunId,
            childWorkflow: approveTo.workflow,
            children: dispatchResult.enqueued,
          });
        }
        if (approveDocumentTo && childParentRunId && docDispatchResult?.enqueued) {
          createApprovalDependencyRows({
            trackerDir,
            parentRunId: childParentRunId,
            childWorkflow: approveDocumentTo.workflow,
            children: docDispatchResult.enqueued,
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
            // OCR prep parent is preview-shaped.
            data: { archetype: "preview" },
            error: msg,
          },
          trackerDir,
        );
      }
    })();

    return { status: 200, body: { ok: true, fannedOut } };
  };
}

/**
 * Enqueue exactly one once-per-document fan-out row (oath-upload's ticket).
 * Mirrors the per-record dispatch path but for a single input: pre-emits a
 * pending row parented to the OCR run and enqueues the daemon task.
 */
async function enqueueDocFanOut(args: {
  workflow: string;
  input: unknown;
  itemId: string;
  childParentRunId?: string;
  trackerDir?: string;
  ensureDaemonsAndEnqueueOverride?: ApproveHandlerOpts["ensureDaemonsAndEnqueueOverride"];
  ocrRunId: string;
}): Promise<void | { enqueued?: Array<{ id: string; taskId?: string; runId?: string }> }> {
  const { workflow, input, itemId, childParentRunId, trackerDir } = args;
  if (args.ensureDaemonsAndEnqueueOverride) {
    return args.ensureDaemonsAndEnqueueOverride(
      workflow,
      [input],
      () => itemId,
      {
        ...(childParentRunId ? { parentRunId: childParentRunId } : {}),
        onPreEmitPending: (item, childRunId, passedParentRunId, emittedItemId) => {
          const childInput =
            item && typeof item === "object" && !Array.isArray(item)
              ? (item as Record<string, unknown>)
              : undefined;
          emitTrackerRow(
            {
              workflow,
              timestamp: new Date().toISOString(),
              id: emittedItemId,
              runId: childRunId,
              status: "pending",
              data: {
                ...buildFallbackPendingData(item),
                ...rootQueueTitleData(readParentSubjectFromInput(item)),
                archetype: "single",
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
  const { ensureDaemonsAndEnqueue } = await import("../../../core/daemon/client.js");
  const { loadWorkflow } = await import("../../../core/workflow-loaders.js");
  const childWf = await loadWorkflow(workflow);
  if (!childWf) {
    log.error(
      `[ocr-http] approve-batch: unknown approveDocumentTo workflow "${workflow}" — doc row not enqueued`,
    );
    return undefined;
  }
  return ensureDaemonsAndEnqueue(
    childWf,
    [input] as never,
    {},
    {
      trackerDir,
      deriveItemId: () => itemId,
      ...(childParentRunId ? { parentRunId: childParentRunId } : {}),
      onPreEmitPending: (item, childRunId, passedParentRunId, emittedItemId) => {
        const childInput =
          item && typeof item === "object" && !Array.isArray(item)
            ? (item as Record<string, unknown>)
            : undefined;
        emitTrackerRow(
          {
            workflow: childWf.config.name,
            timestamp: new Date().toISOString(),
            id: emittedItemId,
            runId: childRunId,
            status: "pending",
            data: {
              ...buildHttpPendingData(childWf, item, passedParentRunId ?? childParentRunId),
              ...rootQueueTitleData(readParentSubjectFromInput(item)),
              archetype: deriveRowArchetype(
                resolveArchetype(childWf.config, item),
                passedParentRunId ?? childParentRunId,
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

/**
 * Merge the OCR root's trace id onto an enqueued child's `__runtimeOptions`
 * channel (root trace-id propagation). The daemon worker reads
 * `runtimeOptions.rootTraceId` in `run-one-item.ts` and stamps it verbatim as
 * the child's `data.__traceId`, so every fan-out descendant DISPLAYS the OCR
 * root's id while keeping its own runId/itemId. No-op when the id is absent
 * (the OCR row had no trace id) or the input isn't a plain object.
 */
function withRootTraceIdRuntimeOption<TInput>(input: TInput, rootTraceId: string | undefined): TInput {
  if (!rootTraceId || !input || typeof input !== "object" || Array.isArray(input)) {
    return input;
  }
  const current = (input as Record<string, unknown>).__runtimeOptions;
  return {
    ...(input as Record<string, unknown>),
    __runtimeOptions: {
      ...(current && typeof current === "object" && !Array.isArray(current) ? current : {}),
      rootTraceId,
    },
  } as TInput;
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

function readParentSubjectFromReviewData(data: Record<string, string>): string | undefined {
  const value = data.parentSubject ?? data.__queueRootTitle;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
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
