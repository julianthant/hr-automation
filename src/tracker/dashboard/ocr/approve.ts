import { randomUUID, type UUID } from "node:crypto";
import { emitTrackerRow } from "../../jsonl.js";
import { emitInheritedRow } from "../../../control/ops/emit-inherited.js";
import { log, withLogContext, setLogRunId } from "../../../utils/log.js";
import { errorMessage } from "../../../utils/errors.js";
import { getFormSpec } from "../../../services/ocr/forms/registry.js";
import { openControlDb } from "../../../core/control-db.js";
import { createTaskStore } from "../../../core/task-store/index.js";
import { buildHttpPendingData } from "../../../core/daemon/enqueue-dispatch.js";
import { splitPrefilled } from "../../../core/kernel/workflow.js";
import { rootQueueTitleData } from "../../../domain/queue-title.js";
import { findLatestEntryForPredicate, findFrozenTraceId } from "../../find-latest-entry.js";
import { tracePrefix, runIdFragment } from "../../../domain/queue-trace-id.js";
import { deriveRowArchetype, resolveArchetype } from "../../../domain/row-archetype.js";
import {
  readFormType,
  readParentRunId,
  readDryRun,
  readOperationWorkflow,
  readParallelWorkers,
  isOperationCoordinatorWorkflow,
} from "./shared.js";
import { parseParallelWorkers, runOptionsToDaemonFlags } from "../../../domain/run-options.js";
import type { DaemonFlags } from "../../../core/daemon/types.js";
import type { OcrApproveRecordContext } from "../../../workflows/ocr/types.js";
import { emitApproved } from "../../../services/ocr/approval-signal.js";
import {
  beginOcrApproval,
  completeOcrApproval,
  failOcrApproval,
  hashOcrApprovalRequest,
  isOcrApprovalPresentationPending,
  listRecoverableOcrApprovals,
  listUnpresentedApprovedOcrApprovals,
  markOcrApprovalPresented,
  readExistingOcrApproval,
  releaseOcrApprovalForRecovery,
  renewOcrApprovalLease,
  type OcrApprovalManifest,
} from "../../state/ocr-approval-store.js";

const WORKFLOW = "ocr";
const SESSION_LOOKBACK_DAYS = 7;

// ─── POST /api/ocr/approve-batch ─────────────────────────────

export interface ApproveInput {
  sessionId: string;
  runId: string;
  records: unknown[];
}

export interface ApproveResponse {
  status: 200 | 400 | 409 | 500;
  body:
    | {
        ok: true;
        state: "pending" | "approved";
        manifestId: string;
        fannedOut: Array<{ workflow: string; itemId: string }>;
      }
    | { ok: false; error: string; state?: "failed" | "conflict"; manifestId?: string };
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
      /** Stable run ids from the durable approval manifest. */
      runIds?: string[];
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
    const requestHash = hashOcrApprovalRequest({ records: input.records });
    const approvalStore = openControlDb({ trackerDir });
    const existingApproval = readExistingOcrApproval(approvalStore, input);
    if (existingApproval && existingApproval.kind !== "awaiting") {
      if (existingApproval.requestHash !== null && existingApproval.requestHash !== requestHash) {
        return {
          status: 409,
          body: {
            ok: false,
            state: "conflict",
            ...(existingApproval.manifest ? { manifestId: existingApproval.manifest.id } : {}),
            error: "This OCR run was already approved with different records",
          },
        };
      }
      if (existingApproval.kind === "failed") {
        return {
          status: 500,
          body: {
            ok: false,
            state: "failed",
            ...(existingApproval.manifest ? { manifestId: existingApproval.manifest.id } : {}),
            error: existingApproval.error,
          },
        };
      }
      if (existingApproval.kind === "approved") {
        repairApprovedPresentationIfMissing(existingApproval.manifest, approvalStore, trackerDir);
      }
      return {
        status: 200,
        body: {
          ok: true,
          state: existingApproval.kind === "approving" ? "pending" : "approved",
          manifestId: existingApproval.manifest.id,
          fannedOut: existingApproval.manifest.children.map(({ workflow, itemId }) => ({ workflow, itemId })),
        },
      };
    }
    const formType = readFormType(input.sessionId, trackerDir, input.runId);
    if (!formType) {
      return { status: 400, body: { ok: false, error: "Could not resolve formType for session" } };
    }
    const spec = getFormSpec(formType);
    if (!spec) {
      return { status: 400, body: { ok: false, error: `Unknown formType "${formType}"` } };
    }

    const approveTo = spec.approveTo;
    const operationWorkflow = readOperationWorkflow(input.sessionId, trackerDir, input.runId);
    const parentRunId = readParentRunId(input.sessionId, trackerDir, input.runId);
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
    const dryRun = readDryRun(input.sessionId, trackerDir, input.runId);
    // Operator's saved Automation-workers count → daemon flags for the per-record
    // signer/contact fan-out (the durable bridge: stamped on the OCR row at prep,
    // read back here at approve). The once-per-document oath-upload ticket stays
    // at default — it is a single row that waits for the signers, not parallel
    // work. Auto → {} (default reuse-or-spawn-one).
    const approveDaemonFlags = runOptionsToDaemonFlags(
      ((): { parallelWorkers?: number } | undefined => {
        const n = readParallelWorkers(input.sessionId, trackerDir, input.runId);
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

    const enqueueInputs: unknown[] = [];
    // The LOGICAL (pre-`__runtimeOptions`) shape of each enqueue input —
    // `ensureDaemonsAndEnqueue`'s idFn strips the runtime-options channel via
    // `splitPrefilled` before calling `deriveItemId`, so the itemId lookup must
    // key on this shape, not the wrapped one (BM-1 family; E2E-015).
    const logicalEnqueueInputs: unknown[] = [];
    const itemIds: string[] = [];
    // Document-level context handed to each per-record `deriveInput` alongside
    // the record. onbase reads `pdfFileId` off it to split each person's page
    // out of the combined PDF; oath/EC ignore it.
    const recordContext: OcrApproveRecordContext = {
      sessionId: input.sessionId,
      runId: input.runId,
      ...(parentRunId ? { parentRunId } : {}),
      ...(typeof latestReviewData.pdfOriginalName === "string"
        ? { pdfOriginalName: latestReviewData.pdfOriginalName }
        : {}),
      ...(typeof latestReviewData.pdfFileId === "string"
        ? { pdfFileId: latestReviewData.pdfFileId }
        : {}),
      ...(typeof latestReviewData.pdfPath === "string"
        ? { pdfPath: latestReviewData.pdfPath }
        : {}),
    };
    if (approveTo) {
      // Only fan out records the operator selected in the preview pane.
      // Unsigned rows / unverified rows / unknown-doc rows are kept in the
      // tracker payload for context but should never become daemon work. A
      // spec-level `canFanOut` guard additionally skips selected-but-incomplete
      // records (oath: a signed row whose EID never resolved) so the
      // per-record itemIds stay in sync with what is actually enqueued.
      input.records.forEach((rec, index) => {
        if (!isSelectedRecord(rec)) return;
        if (approveTo.canFanOut && !approveTo.canFanOut(rec)) return;
        const baseFanInput = approveTo.deriveInput(rec, recordContext);
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
        const itemId = approveTo.deriveItemId(rec, input.runId, index);
        enqueueInputs.push(fanInput);
        logicalEnqueueInputs.push(logicalFanInput);
        itemIds.push(itemId);
      });
    }

    let documentFanOut:
      | { workflow: string; itemId: string; input: unknown; runId: UUID }
      | undefined;
    if (approveDocumentTo) {
      const document = {
        records: input.records.filter(isSelectedRecord) as never[],
        sessionId: input.sessionId,
        runId: input.runId,
        perRecordItemIds: itemIds,
        ...(typeof latestReviewData.pdfOriginalName === "string"
          ? { pdfOriginalName: latestReviewData.pdfOriginalName }
          : {}),
        ...(typeof latestReviewData.pdfFileId === "string" ? { pdfFileId: latestReviewData.pdfFileId } : {}),
        ...(typeof latestReviewData.pdfHash === "string" ? { pdfHash: latestReviewData.pdfHash } : {}),
        ...(typeof latestReviewData.pdfPath === "string" ? { pdfPath: latestReviewData.pdfPath } : {}),
        ...(dryRun ? { dryRun: true } : {}),
      };
      const itemId = approveDocumentTo.deriveItemId(document);
      documentFanOut = {
        workflow: approveDocumentTo.workflow,
        itemId,
        input: withRootTracePrefixRuntimeOption(
          approveDocumentTo.deriveInput(document as never),
          ocrRootTracePrefix,
        ),
        runId: randomUUID(),
      };
    }

    const recordRunIds = enqueueInputs.map(() => randomUUID());
    const manifest: OcrApprovalManifest = {
      version: 1,
      id: randomUUID(),
      sessionId: input.sessionId,
      runId: input.runId,
      formType,
      parentRunId,
      ...(operationWorkflow ? { operationWorkflow } : {}),
      records: input.records,
      reviewData: {
        ...latestReviewData,
        ...(dryRun ? { dryRun: "true" } : {}),
      },
      children: [
        ...enqueueInputs.map((childInput, index) => ({
          kind: "record" as const,
          workflow: approveTo!.workflow,
          itemId: itemIds[index],
          runId: recordRunIds[index],
          input: childInput,
        })),
        ...(documentFanOut
          ? [{ kind: "document" as const, ...documentFanOut }]
          : []),
      ],
    };
    const ownerToken = randomUUID();
    const exactLatestRow = findLatestEntryForPredicate({
      workflow: WORKFLOW,
      ...(trackerDir !== undefined ? { trackerDir } : {}),
      lookbackDays: SESSION_LOOKBACK_DAYS,
      predicate: (entry) => entry.id === input.sessionId && entry.runId === input.runId,
    });
    const allowAwaitingClaim =
      exactLatestRow?.status === "running" && exactLatestRow.step === "awaiting-approval";
    const approvalClaim = beginOcrApproval(approvalStore, {
      sessionId: input.sessionId,
      runId: input.runId,
      requestHash,
      manifest,
      ownerToken,
      allowAwaitingClaim,
    });
    const storedFannedOut = approvalClaim.manifest.children.map(({ workflow, itemId }) => ({ workflow, itemId }));
    if (approvalClaim.kind === "conflict") {
      return {
        status: 409,
        body: {
          ok: false,
          state: "conflict",
          manifestId: approvalClaim.manifest.id,
          error: "This OCR run was already approved with different records",
        },
      };
    }
    if (approvalClaim.kind === "stale") {
      return {
        status: 409,
        body: {
          ok: false,
          state: "conflict",
          manifestId: approvalClaim.manifest.id,
          error: "This OCR run is no longer awaiting approval",
        },
      };
    }
    if (approvalClaim.kind === "failed") {
      return {
        status: 500,
        body: {
          ok: false,
          state: "failed",
          manifestId: approvalClaim.manifest.id,
          error: approvalClaim.error,
        },
      };
    }
    if (approvalClaim.kind === "pending" || approvalClaim.kind === "approved") {
      if (approvalClaim.kind === "approved") {
        repairApprovedPresentationIfMissing(approvalClaim.manifest, approvalStore, trackerDir);
      }
      return {
        status: 200,
        body: {
          ok: true,
          state: approvalClaim.kind,
          manifestId: approvalClaim.manifest.id,
          fannedOut: storedFannedOut,
        },
      };
    }

    // Validate every target workflow and every derived child input before the
    // approval is accepted. A missing loader is a durable failed approval, not
    // a background log line followed by a stuck review.
    const { loadWorkflow } = await import("../../../core/workflow-loaders.js");
    const loadedWorkflows = new Map<string, Awaited<ReturnType<typeof loadWorkflow>>>();
    try {
      for (const child of approvalClaim.manifest.children) {
        let loaded = loadedWorkflows.get(child.workflow);
        if (loaded === undefined) {
          loaded = await loadWorkflow(child.workflow);
          loadedWorkflows.set(child.workflow, loaded);
        }
        if (!loaded) throw new Error(`Unknown OCR approval target workflow "${child.workflow}"`);
        const { cleaned } = splitPrefilled(child.input);
        loaded.config.schema.parse(cleaned);
      }
    } catch (error) {
      const message = errorMessage(error);
      failOcrApproval(approvalStore, {
        sessionId: input.sessionId,
        runId: input.runId,
        requestHash,
        ownerToken,
        generation: approvalClaim.generation,
        error: message,
      });
      emitApprovalFailedRow({ trackerDir, sessionId: input.sessionId, runId: input.runId, parentRunId, error: message });
      return { status: 500, body: { ok: false, error: message } };
    }

    const recordManifestChildren = approvalClaim.manifest.children.filter(
      (child) => child.kind === "record",
    );
    const documentManifestChild = approvalClaim.manifest.children.find(
      (child) => child.kind === "document",
    );

    // Approval finalization runs in the background. For specs with approveTo,
    // write the terminal row after enqueue succeeds so fannedOutItemIds only
    // names task_store-backed children. Specs without approveTo simply write
    // the terminal OCR row and wake the owning workflow to fan out itself.
    // Failures surface as `failed step=approve-failed`.
    let leaseError: Error | undefined;
    const renewLease = (): void => {
      if (leaseError) throw leaseError;
      try {
        renewOcrApprovalLease(approvalStore, {
          sessionId: input.sessionId,
          runId: input.runId,
          requestHash,
          ownerToken,
          generation: approvalClaim.generation,
        });
      } catch (error) {
        leaseError = error instanceof Error ? error : new Error(String(error));
        throw leaseError;
      }
    };
    const leaseHeartbeat = setInterval(() => {
      try {
        renewLease();
      } catch (error) {
        log.error(`[ocr-http] approval lease heartbeat failed: ${errorMessage(error)}`);
      }
    }, 10_000);
    leaseHeartbeat.unref();

    void (async () => {
      try {
        renewLease();
        let dispatchResult: void | { enqueued?: Array<{ id: string; taskId?: string; runId?: string }> } = undefined;
        if (approveTo) {
          // Loaded on BOTH paths so the test-seam fallback derives its row
          // archetype the same way the prod path does (F-A) — hand-stamped
          // literals drifted from `deriveRowArchetype` once already.
          const { loadWorkflow } = await import("../../../core/workflow-loaders.js");
          const childWfForArchetype = await loadWorkflow(approveTo.workflow);
          if (!childWfForArchetype) {
            // Fail loud: a silently-dropped approval (bare `return`, no row) would
            // strand the OCR review with no `approved` NOR `approve-failed` row.
            // Throw so the background catch marks the approval durably `failed` and
            // emits an inherited `approve-failed` row. (Unreachable in practice —
            // the synchronous pre-dispatch validation above already loads every
            // child workflow and 500s a missing loader — but never leave a
            // drop-the-approval path.)
            throw new Error(
              `[ocr-http] approve-batch: unknown approveTo workflow "${approveTo.workflow}" — items not enqueued`,
            );
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
            const memberTraceId = composeFanOutMemberTraceId(ocrRootTracePrefix, childRunId);
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
                  ...(memberTraceId ? { __traceId: memberTraceId } : {}),
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
              recordManifestChildren.map((child) => child.input),
              (_inp, idx) => recordManifestChildren[idx].itemId,
              {
                ...(childParentRunId ? { parentRunId: childParentRunId } : {}),
                ...(approveDaemonFlags.parallel ? { flags: approveDaemonFlags } : {}),
                runIds: recordManifestChildren.map((child) => child.runId),
                onPreEmitPending: emitFallbackChildPending,
              },
            );
            renewLease();
          } else {
            const { ensureDaemonsAndEnqueue } = await import("../../../core/daemon/client.js");
            const childWf = childWfForArchetype;
            const resolveFanOutItemId = buildFanOutItemIdResolver(
              logicalEnqueueInputs,
              recordManifestChildren.map((child) => child.itemId),
              approveTo.workflow,
            );
            dispatchResult = await ensureDaemonsAndEnqueue(
              childWf,
              recordManifestChildren.map((child) => child.input) as never,
              approveDaemonFlags,
              {
                trackerDir,
                deriveItemId: resolveFanOutItemId,
                runIds: recordManifestChildren.map((child) => child.runId as UUID),
                existingTaskPolicy: "idempotent",
                ...(childParentRunId ? { parentRunId: childParentRunId } : {}),
                onPreEmitPending: (item, childRunId, passedParentRunId, itemId) => {
                  const childInput =
                    item && typeof item === "object" && !Array.isArray(item)
                      ? (item as Record<string, unknown>)
                      : undefined;
                  const memberTraceId = composeFanOutMemberTraceId(ocrRootTracePrefix, childRunId);
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
                        ...(memberTraceId ? { __traceId: memberTraceId } : {}),
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
            renewLease();
          }
        }
        // Capture the actually-enqueued item ids from the dispatch result.
        const enqueuedIds: string[] =
          approveTo && dispatchResult && "enqueued" in dispatchResult && Array.isArray(dispatchResult.enqueued)
            ? (dispatchResult.enqueued as Array<{ id: string }>).map((e) => e.id)
            : approveTo
              ? recordManifestChildren.map((child) => child.itemId)
              : [];

        // ─── Once-per-document fan-out (approveDocumentTo) ───────────────
        // After the per-record fan-out, enqueue exactly ONE downstream row
        // (oath-upload's ServiceNow ticket). It is handed `perRecordItemIds`
        // = the itemIds actually enqueued above, so it can wait on exactly
        // those rows before filing. Runs on a DIFFERENT daemon than the
        // per-record target, so neither waits on its own daemon's children.
        let docDispatchResult: void | { enqueued?: Array<{ id: string; taskId?: string; runId?: string }> } = undefined;
        let docFanItemId: string | undefined;
        if (approveDocumentTo && documentManifestChild) {
          const docInput = documentManifestChild.input;
          docFanItemId = documentManifestChild.itemId;
          docDispatchResult = await enqueueDocFanOut({
            workflow: approveDocumentTo.workflow,
            input: docInput,
            itemId: docFanItemId,
            runId: documentManifestChild.runId,
            childParentRunId,
            trackerDir,
            ensureDaemonsAndEnqueueOverride: opts.ensureDaemonsAndEnqueueOverride,
            ocrRunId: input.runId,
          });
          renewLease();
          void docFanItemId; // already reflected in the synchronous `fannedOut` response
        }

        // Dependencies are part of durable approval finalization. Reconcile
        // them before emitting the approved row or waking a waiting parent.
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

        // The SQLite approval state is the authority. Commit it before any
        // JSONL presentation or process-local wake: either of those can fail
        // independently and must never turn already-enqueued child work into a
        // durable `failed` approval.
        completeOcrApproval(approvalStore, {
          sessionId: input.sessionId,
          runId: input.runId,
          requestHash,
          ownerToken,
          generation: approvalClaim.generation,
        });
        try {
          emitApprovedPresentation({
            trackerDir,
            manifest: approvalClaim.manifest,
            fannedOutItemIds: enqueuedIds,
            childWorkflow: approveTo?.workflow,
          });
          markOcrApprovalPresented(approvalStore, {
            sessionId: approvalClaim.manifest.sessionId,
            runId: approvalClaim.manifest.runId,
          });
        } catch (presentationError) {
          log.error(
            `[ocr-http] approval committed but presentation repair failed: ${errorMessage(presentationError)}`,
          );
        }
        try {
          // Dashboard-path runs have no subscriber. This wake is best-effort;
          // JSONL polling and startup presentation repair are the backstops.
          emitApproved(
            { workflow: WORKFLOW, sessionId: input.sessionId, runId: input.runId },
            { records: input.records, fannedOutItemIds: enqueuedIds },
          );
        } catch (wakeError) {
          log.error(`[ocr-http] approval committed but subscriber wake failed: ${errorMessage(wakeError)}`);
        }
      } catch (err) {
        const msg = errorMessage(err);
        log.error(`[ocr-http] approve-batch dispatch failed: ${msg}`);
        try {
          releaseOcrApprovalForRecovery(approvalStore, {
            sessionId: input.sessionId,
            runId: input.runId,
            requestHash,
            ownerToken,
            generation: approvalClaim.generation,
            error: msg,
          });
        } catch (transitionError) {
          log.error(`[ocr-http] approve-batch recovery release failed: ${errorMessage(transitionError)}`);
        }
      } finally {
        clearInterval(leaseHeartbeat);
      }
    })();

    return {
      status: 200,
      body: {
        ok: true,
        state: "pending",
        manifestId: approvalClaim.manifest.id,
        fannedOut: storedFannedOut,
      },
    };
  };
}

export interface ApprovalRecoveryOpts {
  ensureDaemonsAndEnqueueOverride?: ApproveHandlerOpts["ensureDaemonsAndEnqueueOverride"];
  nowMs?: number;
}

/**
 * Resume expired approvals from SQLite alone. In particular, do not route
 * through the HTTP handler: that path reads form/operation state from JSONL,
 * which may be missing after the crash we are recovering from.
 */
export async function resumeRecoverableOcrApprovals(
  trackerDir: string,
  opts: ApprovalRecoveryOpts = {},
): Promise<number> {
  const store = openControlDb({ trackerDir });
  const manifests = listRecoverableOcrApprovals(store, opts.nowMs);
  let resumed = 0;
  for (const manifest of manifests) {
    const requestHash = hashOcrApprovalRequest({ records: manifest.records });
    const ownerToken = randomUUID();
    const claim = beginOcrApproval(store, {
      sessionId: manifest.sessionId,
      runId: manifest.runId,
      requestHash,
      manifest,
      ownerToken,
      ...(opts.nowMs !== undefined ? { nowMs: opts.nowMs } : {}),
    });
    if (claim.kind !== "claimed") continue;
    try {
      await dispatchPersistedApprovalManifest({
        trackerDir,
        store,
        manifest: claim.manifest,
        requestHash,
        ownerToken,
        generation: claim.generation,
        ensureDaemonsAndEnqueueOverride: opts.ensureDaemonsAndEnqueueOverride,
      });
      resumed += 1;
    } catch (error) {
      const message = errorMessage(error);
      log.error(
        `[ocr-http] startup approval recovery failed for ${manifest.sessionId}/${manifest.runId}: ${message}`,
      );
      try {
        // A crashed prior owner may already have committed a child task. No
        // recovery-time error can prove the manifest is side-effect-free, even
        // when the current attempt fails during loader/schema validation.
        releaseOcrApprovalForRecovery(store, {
          sessionId: manifest.sessionId,
          runId: manifest.runId,
          requestHash,
          ownerToken,
          generation: claim.generation,
          error: message,
        });
      } catch (transitionError) {
        log.error(
          `[ocr-http] startup approval recovery lost its lease while recording outcome: ${errorMessage(transitionError)}`,
        );
      }
    }
  }

  // A crash can land after the SQLite `approved` commit and before the JSONL
  // terminal row. Repair that presentation idempotently from the manifest.
  for (const manifest of listUnpresentedApprovedOcrApprovals(store)) {
    repairApprovedPresentationIfMissing(manifest, store, trackerDir);
  }
  return resumed;
}

async function dispatchPersistedApprovalManifest(args: {
  trackerDir: string;
  store: ReturnType<typeof openControlDb>;
  manifest: OcrApprovalManifest;
  requestHash: string;
  ownerToken: string;
  generation: number;
  ensureDaemonsAndEnqueueOverride?: ApproveHandlerOpts["ensureDaemonsAndEnqueueOverride"];
}): Promise<void> {
  const { trackerDir, store, manifest, requestHash, ownerToken, generation } = args;
  const { loadWorkflow } = await import("../../../core/workflow-loaders.js");
  const groups = new Map<string, OcrApprovalManifest["children"]>();
  for (const child of manifest.children) {
    const key = `${child.kind}\0${child.workflow}`;
    const group = groups.get(key);
    if (group) group.push(child);
    else groups.set(key, [child]);
  }
  const workflows = new Map<string, NonNullable<Awaited<ReturnType<typeof loadWorkflow>>>>();
  try {
    // Validate the complete manifest before the first child-task commit. Only
    // these pre-dispatch failures are safe to terminalize as approve-failed.
    for (const children of groups.values()) {
      const workflowName = children[0].workflow;
      let workflow = workflows.get(workflowName);
      if (!workflow) {
        const loaded = await loadWorkflow(workflowName);
        if (!loaded) throw new Error(`Unknown OCR approval target workflow "${workflowName}"`);
        workflow = loaded;
        workflows.set(workflowName, workflow);
      }
      for (const child of children) {
        const { cleaned } = splitPrefilled(child.input);
        workflow.config.schema.parse(cleaned);
      }
    }
  } catch (error) {
    throw new Error(errorMessage(error), { cause: error });
  }

  let leaseError: Error | undefined;
  const renewLease = (): void => {
    if (leaseError) throw leaseError;
    try {
      renewOcrApprovalLease(store, {
        sessionId: manifest.sessionId,
        runId: manifest.runId,
        requestHash,
        ownerToken,
        generation,
      });
    } catch (error) {
      leaseError = error instanceof Error ? error : new Error(String(error));
      throw leaseError;
    }
  };
  const heartbeat = setInterval(() => {
    try {
      renewLease();
    } catch (error) {
      log.error(`[ocr-http] recovered approval lease heartbeat failed: ${errorMessage(error)}`);
    }
  }, 10_000);
  heartbeat.unref();

  const recordItemIds: string[] = [];
  const persistedParallelWorkers = readManifestParallelWorkers(manifest);
  const persistedRecordFlags = runOptionsToDaemonFlags(
    persistedParallelWorkers === undefined ? undefined : { parallelWorkers: persistedParallelWorkers },
  );
  try {
    renewLease();
    for (const children of groups.values()) {
      const first = children[0];
      const workflow = workflows.get(first.workflow);
      if (!workflow) throw new Error(`Validated OCR approval workflow "${first.workflow}" disappeared`);
      const logicalInputs = children.map((child) => splitPrefilled(child.input).cleaned);
      const itemIds = children.map((child) => child.itemId);
      const runIds = children.map((child) => child.runId);
      const isRecordGroup = first.kind === "record";
      const memberShape = isRecordGroup && isOperationCoordinatorWorkflow(manifest.operationWorkflow)
        ? "operation-member" as const
        : undefined;
      const emitPending = (
        item: unknown,
        childRunId: string,
        passedParentRunId: string | undefined,
        itemId: string,
      ): void => {
        const childInput = item && typeof item === "object" && !Array.isArray(item)
          ? item as Record<string, unknown>
          : undefined;
        const rootPrefix = readRootTracePrefixFromInput(item);
        const memberTraceId = composeFanOutMemberTraceId(rootPrefix, childRunId);
        emitTrackerRow(
          {
            workflow: first.workflow,
            timestamp: new Date().toISOString(),
            id: itemId,
            runId: childRunId,
            status: "pending",
            data: {
              ...buildHttpPendingData(workflow, item, passedParentRunId ?? manifest.parentRunId),
              ...rootQueueTitleData(readParentSubjectFromInput(item)),
              ...(memberTraceId ? { __traceId: memberTraceId } : {}),
              archetype: deriveRowArchetype(
                resolveArchetype(workflow.config, item),
                passedParentRunId ?? manifest.parentRunId,
                memberShape ? { memberShape } : undefined,
              ),
            },
            parentRunId: passedParentRunId ?? manifest.parentRunId,
            ...(childInput ? { input: childInput } : {}),
          },
          trackerDir,
        );
      };

      let result: void | { enqueued?: Array<{ id: string; taskId?: string; runId?: string }> };
      if (args.ensureDaemonsAndEnqueueOverride) {
        result = await args.ensureDaemonsAndEnqueueOverride(
          first.workflow,
          children.map((child) => child.input),
          (_input, index) => children[index].itemId,
          {
            parentRunId: manifest.parentRunId,
            ...(isRecordGroup && persistedRecordFlags.parallel ? { flags: persistedRecordFlags } : {}),
            runIds,
            onPreEmitPending: emitPending,
          },
        );
      } else {
        const { ensureDaemonsAndEnqueue } = await import("../../../core/daemon/client.js");
        result = await ensureDaemonsAndEnqueue(
          workflow,
          children.map((child) => child.input) as never,
          isRecordGroup ? persistedRecordFlags : {},
          {
            trackerDir,
            parentRunId: manifest.parentRunId,
            runIds: runIds as UUID[],
            deriveItemId: buildFanOutItemIdResolver(logicalInputs, itemIds, first.workflow),
            existingTaskPolicy: "idempotent",
            onPreEmitPending: emitPending,
          },
        );
      }
      renewLease();
      if (isRecordGroup) {
        recordItemIds.push(...(result?.enqueued?.map((item) => item.id) ?? itemIds));
      }
      if (result?.enqueued) {
        createApprovalDependencyRows({
          trackerDir,
          parentRunId: manifest.parentRunId,
          childWorkflow: first.workflow,
          children: result.enqueued,
        });
      }
    }

    completeOcrApproval(store, {
      sessionId: manifest.sessionId,
      runId: manifest.runId,
      requestHash,
      ownerToken,
      generation,
    });
  } finally {
    clearInterval(heartbeat);
  }

  try {
    emitApprovedPresentation({
      trackerDir,
      manifest,
      fannedOutItemIds: recordItemIds,
      childWorkflow: manifest.children.find((child) => child.kind === "record")?.workflow,
    });
    markOcrApprovalPresented(store, { sessionId: manifest.sessionId, runId: manifest.runId });
  } catch (error) {
    log.error(`[ocr-http] recovered approval committed but presentation failed: ${errorMessage(error)}`);
  }
  try {
    emitApproved(
      { workflow: WORKFLOW, sessionId: manifest.sessionId, runId: manifest.runId },
      { records: manifest.records, fannedOutItemIds: recordItemIds },
    );
  } catch (error) {
    log.error(`[ocr-http] recovered approval committed but subscriber wake failed: ${errorMessage(error)}`);
  }
}

function repairApprovedPresentationIfMissing(
  manifest: OcrApprovalManifest,
  store: ReturnType<typeof openControlDb>,
  trackerDir?: string,
): void {
  if (!isOcrApprovalPresentationPending(store, {
    sessionId: manifest.sessionId,
    runId: manifest.runId,
  })) return;
  try {
    const itemIds = manifest.children
      .filter((child) => child.kind === "record")
      .map((child) => child.itemId);
    emitApprovedPresentation({
      trackerDir,
      manifest,
      fannedOutItemIds: itemIds,
      childWorkflow: manifest.children.find((child) => child.kind === "record")?.workflow,
    });
    markOcrApprovalPresented(store, { sessionId: manifest.sessionId, runId: manifest.runId });
  } catch (error) {
    log.error(
      `[ocr-http] approved presentation repair failed for ${manifest.sessionId}/${manifest.runId}: ${errorMessage(error)}`,
    );
  }
}

function emitApprovalFailedRow(args: {
  trackerDir?: string;
  sessionId: string;
  runId: string;
  parentRunId?: string;
  error: string;
}): void {
  try {
    emitInheritedRow({
      workflow: WORKFLOW,
      trackerDir: args.trackerDir,
      id: args.sessionId,
      runId: args.runId,
      ...(args.parentRunId ? { parentRunId: args.parentRunId } : {}),
      status: "failed",
      step: "approve-failed",
      error: args.error,
    });
  } catch {
    emitTrackerRow(
      {
        workflow: WORKFLOW,
        timestamp: new Date().toISOString(),
        id: args.sessionId,
        runId: args.runId,
        ...(args.parentRunId ? { parentRunId: args.parentRunId } : {}),
        status: "failed",
        step: "approve-failed",
        data: { archetype: "preview" },
        error: args.error,
      },
      args.trackerDir,
    );
  }
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
  runId: string;
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
    throw new Error(`Unknown OCR approval document target workflow "${workflow}"`);
  }
  if (args.ensureDaemonsAndEnqueueOverride) {
    return args.ensureDaemonsAndEnqueueOverride(
      workflow,
      [input],
      () => itemId,
      {
        ...(childParentRunId ? { parentRunId: childParentRunId } : {}),
        runIds: [args.runId],
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
      runIds: [args.runId as UUID],
      existingTaskPolicy: "idempotent",
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
 * Project a durably-approved manifest into JSONL. This is deliberately
 * downstream of `completeOcrApproval`: tracker files are presentation and can
 * be repaired from the immutable SQLite manifest after a crash.
 */
function emitApprovedPresentation(args: {
  trackerDir?: string;
  manifest: OcrApprovalManifest;
  fannedOutItemIds: string[];
  childWorkflow?: string;
}): void {
  const { trackerDir, manifest, fannedOutItemIds, childWorkflow } = args;
  emitTrackerRow(
    {
      workflow: WORKFLOW,
      timestamp: new Date().toISOString(),
      id: manifest.sessionId,
      runId: manifest.runId,
      parentRunId: manifest.parentRunId,
      status: "done",
      step: "approved",
      data: {
        ...manifest.reviewData,
        archetype: "preview",
        mode: "prepare",
        formType: manifest.formType,
        sessionId: manifest.sessionId,
        records: JSON.stringify(manifest.records),
        recordCount: String(manifest.records.length),
        fannedOutCount: String(fannedOutItemIds.length),
        fannedOutItemIds: JSON.stringify(fannedOutItemIds),
      },
    },
    trackerDir,
  );
  mirrorOperationApproved({
    operationWorkflow: manifest.operationWorkflow,
    sessionId: manifest.sessionId,
    parentRunId: manifest.parentRunId,
    trackerDir,
    fannedOutCount: fannedOutItemIds.length,
    childWorkflow,
  });
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
    if (queue) queue.push(itemIds[idx]);
    else queueByInputJson.set(key, [itemIds[idx]]);
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

/**
 * Compose a fan-out member's frozen trace id AT PRE-EMIT (ISS-004). The approve
 * fan-out stamps `rootTracePrefix` on the child INPUT, so the daemon worker
 * composes the member `__traceId` only at CLAIM (`run-one-item` →
 * `buildTraceId({ rootPrefix })`). A member that is never claimed (queued then
 * cancelled-while-queued) therefore carried no trace id. This composes the SAME
 * value the daemon would — byte-identical to `buildTraceId`'s rootPrefix branch
 * (`<rootPrefix>-<runIdFragment(runId)>`, using the shared tail helper) — so
 * `findFrozenTraceId` reuses this at claim (frozen-once) with no drift. Returns
 * undefined when there is no root prefix (the daemon then composes its own
 * standalone id at claim, as before). Display/lineage only.
 */
function composeFanOutMemberTraceId(
  rootTracePrefix: string | undefined,
  childRunId: string,
): string | undefined {
  return rootTracePrefix ? `${rootTracePrefix}-${runIdFragment(childRunId)}` : undefined;
}

function readRootTracePrefixFromInput(input: unknown): string | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  const runtime = (input as Record<string, unknown>).__runtimeOptions;
  if (!runtime || typeof runtime !== "object" || Array.isArray(runtime)) return undefined;
  const value = (runtime as Record<string, unknown>).rootTracePrefix;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readManifestParallelWorkers(manifest: OcrApprovalManifest): number | undefined {
  const raw = manifest.reviewData.parallelWorkers;
  try {
    return parseParallelWorkers(raw);
  } catch (error) {
    throw new Error(`OCR approval ${manifest.sessionId}/${manifest.runId} has invalid persisted worker count`, {
      cause: error,
    });
  }
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
 * `run-one-item` re-emit (mirrors `rowShape: "operation-member"` for delegated
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
  const taskStore = createTaskStore(openControlDb({ trackerDir: args.trackerDir }));
  const parent = taskStore.getTaskByRunId(args.parentRunId);
  // A missing parent TASK is a valid, expected state — not a fault to fail on:
  // an OCR run's delegating parent is often a DISPLAY-ONLY operation coordinator
  // (oath-signature / emergency-contact / onbase / separations), which by design
  // has no daemon task in the store (see `OPERATION_COORDINATOR_WORKFLOWS`). With
  // no parent task there is no dependency EDGE to create, so there is nothing to
  // reconcile — return. (The one parent that MUST be a real task, oath-upload's
  // born-at-upload ticket, always exists by approval time, so this branch never
  // fires for it.) Failing here instead would roll back an already-committed
  // fan-out — the signer/contact children are enqueued and running — into a bogus
  // `approve-failed`, which is the milestone-4 regression this restores.
  if (!parent) return;
  for (const child of args.children) {
    const childTask = child.taskId
      ? taskStore.getTask(child.taskId)
      : taskStore.findTaskByIdentity({
          workflow: args.childWorkflow,
          itemId: child.id,
          ...(child.runId ? { runId: child.runId } : {}),
        });
    if (!childTask) {
      throw new Error(
        `OCR approval child task is missing for ${args.childWorkflow}/${child.id}/${child.runId ?? "unknown-run"}`,
      );
    }
    taskStore.createDependency({
      parentTaskId: parent.taskId,
      childTaskId: childTask.taskId,
      onChildFailed: "block_parent",
      cascadeCancel: true,
      resumeParentAfterChildRetry: true,
      existingPolicy: "idempotent",
    });
  }
}
