import { emitTrackerRow } from "../../jsonl.js";
import { log, withLogContext, setLogRunId } from "../../../utils/log.js";
import { errorMessage } from "../../../utils/errors.js";
import { getFormSpec } from "../../../services/ocr/forms/registry.js";
import { openControlDb } from "../../../core/control-db.js";
import { createTaskStore } from "../../../core/task-store/index.js";
import { buildHttpPendingData } from "../../../core/daemon/enqueue-dispatch.js";
import { rootQueueTitleData } from "../../../domain/queue-title.js";
import { findLatestEntryForPredicate, findFrozenTraceId } from "../../find-latest-entry.js";
import { tracePrefix } from "../../../domain/queue-trace-id.js";
import { deriveRowArchetype, resolveArchetype } from "../../../domain/row-archetype.js";
import {
  readFormType,
  readParentRunId,
  readDryRun,
  readOperationWorkflow,
  readParallelWorkers,
  isOperationCoordinatorWorkflow,
} from "./shared.js";
import { runOptionsToDaemonFlags } from "../../../domain/run-options.js";
import type { DaemonFlags } from "../../../core/daemon/types.js";
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
      /**
       * Daemon spawn flags applied to the per-record `approveTo` fan-out from the
       * operator's saved worker count (real path passes them as the 3rd
       * positional arg to `ensureDaemonsAndEnqueue`; the override receives them
       * here so tests can assert). Absent → default reuse-or-spawn-one.
       */
      flags?: DaemonFlags;
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
    const operationWorkflow = readOperationWorkflow(input.sessionId, trackerDir);
    const parentRunId = readParentRunId(input.sessionId, trackerDir);
    // Approval ≡ delegation: only a DELEGATED OCR run (parentRunId set — OCR
    // as a sub-step of oath-signature / oath-upload / emergency-contact) has a
    // downstream consumer for the approved data. A standalone run completes
    // `done` as a read-only completeness card and the UI never offers Approve.
    // The legacy standalone both-targets fan-out was REMOVED 2026-06-11 (user
    // policy: no legacy support) — a direct route call now fails loud instead
    // of silently fanning out rows nobody asked for.
    if (!parentRunId) {
      return {
        status: 400,
        body: {
          ok: false,
          error:
            "Standalone OCR runs have no approve flow (approval ≡ delegation; the run already completed as a read-only review)",
        },
      };
    }
    // Fanned-out children nest under the run that owns approval: the
    // delegating parent run (operation coordinator / oath-upload born task).
    const childParentRunId = parentRunId;
    // Root trace-id propagation (DISPLAY-only, trace/span model): the OCR root
    // row carries the operation's frozen trace id (`ou-...` after the oath form
    // branded it via `traceCode`, else `oc-...`). This fan-out runs OUTSIDE any
    // kernel ctx (HTTP path), so we read that id back off the OCR row and stamp
    // its PREFIX (`<code>-<HHMMSS>`) as `rootTracePrefix` on every enqueued
    // child's `__runtimeOptions` — the daemon worker's `run-one-item` re-emit
    // then COMPOSES `<prefix>-<ownRunId4>` on each signer row + oath-upload
    // ticket, so they share the operation prefix while staying greppable.
    const ocrRootFrozenId = findFrozenTraceId({
      workflow: WORKFLOW,
      runId: input.runId,
      ...(trackerDir !== undefined ? { trackerDir } : {}),
    });
    const ocrRootTracePrefix = ocrRootFrozenId ? tracePrefix(ocrRootFrozenId) : undefined;
    const dryRun = readDryRun(input.sessionId, trackerDir);
    // Operator's saved Automation-workers count → daemon flags for the per-record
    // signer/contact fan-out (the durable bridge: stamped on the OCR row at prep,
    // read back here at approve). The once-per-document oath-upload ticket stays
    // at default — it is a single row that waits for the signers, not parallel
    // work. Auto → {} (default reuse-or-spawn-one).
    const approveDaemonFlags = runOptionsToDaemonFlags(
      ((): { parallelWorkers?: number } | undefined => {
        const n = readParallelWorkers(input.sessionId, trackerDir);
        return n !== undefined ? { parallelWorkers: n } : undefined;
      })(),
    );
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

    // Route the document (ticket) fan-out by operation intent:
    //   - oath-signature PDF run → signs oaths only, files NO ServiceNow ticket.
    //   - oath-upload full run → the oath-upload task already exists (born at
    //     upload, option A) and files the ticket itself; do NOT create a second
    //     ticket row — it learns its signer set from this approval's
    //     `fannedOutItemIds` via subscribeToApproval.
    //   - delegated run with NO operation intent (no live producer today —
    //     every delegating parent stamps `operationWorkflow`) → the spec's
    //     `approveDocumentTo` contract stands as declared. The standalone
    //     reach of this branch was removed 2026-06-11 (guard above).
    const approveDocumentTo =
      operationWorkflow === "oath-signature" || operationWorkflow === "oath-upload"
        ? undefined
        : spec.approveDocumentTo;

    // When this OCR run belongs to a target-workflow OPERATION coordinator
    // (oath-signature / emergency-contact PDF upload), its per-record fan-out
    // rows are the coordinator's members — stamp them `operation-member` (the
    // operation analogue of `batch-member`) so they nest inside the operation
    // card, not as a standalone batch. A standalone OCR run (no operationWorkflow)
    // and oath-upload (a real `single` ticket task, not a coordinator) keep the
    // natural archetype. See `src/services/ocr/forms/shared.ts`.
    const fanOutAsOperationMember = isOperationCoordinatorWorkflow(operationWorkflow);
    const fanMemberShape: "operation-member" | undefined = fanOutAsOperationMember
      ? "operation-member"
      : undefined;

    const fannedOut: Array<{ workflow: string; itemId: string }> = [];
    const enqueueInputs: unknown[] = [];
    // The LOGICAL (pre-`__runtimeOptions`) shape of each enqueue input —
    // `ensureDaemonsAndEnqueue`'s idFn strips the runtime-options channel via
    // `splitPrefilled` before calling `deriveItemId`, so the itemId lookup must
    // key on this shape, not the wrapped one (BM-1 family; E2E-015).
    const logicalEnqueueInputs: unknown[] = [];
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
        const logicalFanInput =
          baseFanInput && typeof baseFanInput === "object"
            ? {
                ...(baseFanInput as Record<string, unknown>),
                ...(dryRun ? { dryRun: true } : {}),
                ...(parentSubject ? { parentSubject } : {}),
              }
            : baseFanInput;
        const fanInput =
          logicalFanInput && typeof logicalFanInput === "object"
            ? withMemberShapeRuntimeOption(
                withRootTracePrefixRuntimeOption(logicalFanInput, ocrRootTracePrefix),
                fanMemberShape,
              )
            : logicalFanInput;
        const itemId = approveTo.deriveItemId(rec as never, input.runId, index);
        enqueueInputs.push(fanInput);
        logicalEnqueueInputs.push(logicalFanInput);
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
          // Loaded on BOTH paths so the test-seam fallback derives its row
          // archetype the same way the prod path does (F-A) — hand-stamped
          // literals drifted from `deriveRowArchetype` once already.
          const { loadWorkflow } = await import("../../../core/workflow-loaders.js");
          const childWfForArchetype = await loadWorkflow(approveTo.workflow);
          if (!childWfForArchetype) {
            log.error(
              `[ocr-http] approve-batch: unknown approveTo workflow "${approveTo.workflow}" — items not enqueued`,
            );
            return;
          }
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
                  archetype: deriveRowArchetype(
                    resolveArchetype(childWfForArchetype.config, item),
                    passedParentRunId ?? childParentRunId,
                    fanMemberShape ? { memberShape: fanMemberShape } : undefined,
                  ),
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
                ...(approveDaemonFlags.parallel ? { flags: approveDaemonFlags } : {}),
                onPreEmitPending: emitFallbackChildPending,
              },
            );
          } else {
            const { ensureDaemonsAndEnqueue } = await import("../../../core/daemon/client.js");
            const childWf = childWfForArchetype;
            const resolveFanOutItemId = buildFanOutItemIdResolver(
              logicalEnqueueInputs,
              itemIds,
              approveTo.workflow,
            );
            dispatchResult = await ensureDaemonsAndEnqueue(
              childWf,
              enqueueInputs as never,
              approveDaemonFlags,
              {
                trackerDir,
                deriveItemId: resolveFanOutItemId,
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
                          fanMemberShape ? { memberShape: fanMemberShape } : undefined,
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
          const docInput = withRootTracePrefixRuntimeOption(
            approveDocumentTo.deriveInput(doc as never),
            ocrRootTracePrefix,
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
        // Mirror "approved" onto the operation coordinator row (oath-signature /
        // emergency-contact) so its denormalized OCR status doesn't sit stale at
        // "awaiting review" in the transient window after approve and before the
        // fanned-out member rows materialize. Parallels the discard/failure
        // mirrors; no-ops for oath-upload (a real task, not a coordinator row)
        // and standalone OCR runs (no coordinator row).
        mirrorOperationApproved({
          operationWorkflow,
          sessionId: input.sessionId,
          parentRunId,
          trackerDir,
          fannedOutCount: enqueuedIds.length,
          childWorkflow: approveTo?.workflow,
        });
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
  // Loaded for BOTH paths so the test-seam fallback derives its archetype the
  // same way the prod path does (F-A) instead of hand-stamping "single".
  const { loadWorkflow } = await import("../../../core/workflow-loaders.js");
  const childWf = await loadWorkflow(workflow);
  if (!childWf) {
    log.error(
      `[ocr-http] approve-batch: unknown approveDocumentTo workflow "${workflow}" — doc row not enqueued`,
    );
    return undefined;
  }
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
  const { ensureDaemonsAndEnqueue } = await import("../../../core/daemon/client.js");
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

/**
 * Mirror an approved OCR prep onto its `operation` coordinator row so the
 * coordinator's denormalized OCR status reads "approved" during the transient
 * window after approve and before the fanned-out member rows materialize (once
 * members exist, `OperationRow` hides the OCR status line). Parallels the
 * discard/failure mirrors.
 *
 * Only oath-signature / emergency-contact runs have a coordinator row
 * (`OPERATION_COORDINATOR_WORKFLOWS`); an oath-upload full run's "operation" is
 * a real daemon task (not a display row) and a standalone OCR run has none —
 * both no-op here. The prior row is re-read so its display metadata + `operation`
 * archetype survive; only the OCR status fields flip.
 */
function mirrorOperationApproved(args: {
  operationWorkflow: string | undefined;
  sessionId: string;
  parentRunId: string | undefined;
  trackerDir: string | undefined;
  fannedOutCount: number;
  childWorkflow: string | undefined;
}): void {
  const { operationWorkflow, sessionId, parentRunId, trackerDir, fannedOutCount, childWorkflow } = args;
  if (parentRunId === undefined || operationWorkflow === undefined) return;
  if (!isOperationCoordinatorWorkflow(operationWorkflow)) return;
  const operationItemId = `ocr-prep-${sessionId}`;
  const prior = findLatestEntryForPredicate({
    workflow: operationWorkflow,
    ...(trackerDir !== undefined ? { trackerDir } : {}),
    lookbackDays: SESSION_LOOKBACK_DAYS,
    predicate: (row) => row.id === operationItemId && row.runId === parentRunId && Boolean(row.data),
  });
  if (!prior?.data) return;
  emitTrackerRow(
    {
      workflow: operationWorkflow,
      timestamp: new Date().toISOString(),
      id: operationItemId,
      runId: parentRunId,
      ...(prior.parentRunId ? { parentRunId: prior.parentRunId } : {}),
      status: "running",
      step: "approved",
      data: { ...prior.data, archetype: "operation", ocrStatus: "approved", ocrStep: "approved" },
    },
    trackerDir,
  );
  // Sparse EVENT-level lifecycle log on the COORDINATOR's runId so the
  // operation row's Logs panel records the approval transition (the fan-out
  // children run on their own runIds). Bound to the coordinator's
  // (workflow, itemId, runId) so the strict per-run logs filter picks it up.
  const childLabel = childWorkflow ?? "downstream";
  void withLogContext(operationWorkflow, operationItemId, async () => {
    setLogRunId(parentRunId);
    log.step({
      message: `Approved ${fannedOutCount} record(s) — fanning out ${childLabel}`,
      event: "operation:approved",
      category: "operator",
      occasion: "started",
      ...(childWorkflow ? { childWorkflow } : {}),
      count: fannedOutCount,
    });
  }, trackerDir);
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
 * Merge the OCR root's trace PREFIX onto an enqueued child's `__runtimeOptions`
 * channel (root trace-id propagation, trace/span model). The daemon worker reads
 * `runtimeOptions.rootTracePrefix` in `run-one-item.ts` and COMPOSES
 * `<prefix>-<ownRunId4>` as the child's `data.__traceId`, so every fan-out
 * descendant shares the OCR root's operation prefix while keeping its own
 * greppable tail/runId/itemId. No-op when the prefix is absent (the OCR row had
 * no trace id) or the input isn't a plain object.
 */
/**
 * Build the `deriveItemId` resolver for the approve per-record fan-out.
 *
 * Keyed by the JSON of each LOGICAL (pre-`__runtimeOptions`) input:
 * `ensureDaemonsAndEnqueue`'s idFn strips the kernel runtime-options channel
 * via `splitPrefilled` BEFORE invoking `deriveItemId`, so the resolver sees a
 * cleaned structural clone that round-trips to the logical input's JSON —
 * never the wrapped object this route enqueues (the BM-1 footgun). Values are
 * QUEUES so two records with identical logical JSON still receive their own
 * itemIds (`deriveItemId` runs once per input, in enqueue order).
 *
 * A miss FAILS LOUD. The old `?? ocr-fallback-<runId>-r0` fallback handed
 * every member the SAME id, collapsing N people into one queue row and making
 * per-signer outcomes unrecoverable (E2E-015/E2E-018) — a thrown error
 * surfaces as `failed step=approve-failed` instead.
 */
export function buildFanOutItemIdResolver(
  logicalInputs: readonly unknown[],
  itemIds: readonly string[],
  fanOutWorkflow: string,
): (input: unknown) => string {
  const queueByInputJson = new Map<string, string[]>();
  logicalInputs.forEach((inp, idx) => {
    const key = JSON.stringify(inp);
    const queue = queueByInputJson.get(key);
    if (queue) queue.push(itemIds[idx]!);
    else queueByInputJson.set(key, [itemIds[idx]!]);
  });
  return (input: unknown): string => {
    const itemId = queueByInputJson.get(JSON.stringify(input))?.shift();
    if (!itemId) {
      throw new Error(
        `approve-batch fan-out: deriveItemId lookup missed for a ${fanOutWorkflow} input — ` +
          `the enqueue path no longer hands deriveItemId the logical input shape ` +
          `(${logicalInputs.length} inputs were keyed)`,
      );
    }
    return itemId;
  };
}

function withRootTracePrefixRuntimeOption<TInput>(input: TInput, rootTracePrefix: string | undefined): TInput {
  if (!rootTracePrefix || !input || typeof input !== "object" || Array.isArray(input)) {
    return input;
  }
  const current = (input as Record<string, unknown>).__runtimeOptions;
  return {
    ...(input as Record<string, unknown>),
    __runtimeOptions: {
      ...(current && typeof current === "object" && !Array.isArray(current) ? current : {}),
      rootTracePrefix,
    },
  } as TInput;
}

/**
 * Merge a member `rowShape` onto a fan-out child's `__runtimeOptions` so the
 * stamped archetype survives the SQLite task store to the daemon worker's
 * `run-one-item` re-emit (mirrors `rowShape: "batch-member"` for delegated
 * batches; `normalizeRuntimeOptions` carries it through). No-op when the shape
 * is absent (standalone OCR / oath-upload) or the input isn't a plain object.
 */
function withMemberShapeRuntimeOption<TInput>(
  input: TInput,
  rowShape: "operation-member" | undefined,
): TInput {
  if (!rowShape || !input || typeof input !== "object" || Array.isArray(input)) {
    return input;
  }
  const current = (input as Record<string, unknown>).__runtimeOptions;
  return {
    ...(input as Record<string, unknown>),
    __runtimeOptions: {
      ...(current && typeof current === "object" && !Array.isArray(current) ? current : {}),
      rowShape,
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
