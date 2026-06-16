import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { defineWorkflow } from "../../../src/core/index.js";
import { buildOcrPrepareHandler } from "../../../src/tracker/dashboard/ocr/prepare.js";
import { runOcrOrchestrator } from "../../../src/workflows/ocr/orchestrator.js";
import { emitTrackerRow } from "../../../src/tracker/jsonl.js";
import { buildTraceId } from "../../../src/domain/queue-trace-id.js";
import {
  subscribeToApproval,
  OcrDiscardedError,
  OcrApprovalFailedError,
} from "../../../src/services/ocr/approval-signal.js";
import { OATH_UPLOAD_WORKFLOW_RUNTIME_POLICY } from "../../../src/workflows/oath-upload/workflow.js";
import { oathUploadSteps } from "../../../src/workflows/oath-upload/handler.js";
import { OathUploadInputSchema } from "../../../src/workflows/oath-upload/schema.js";
import { log } from "../../../src/utils/log.js";
import type { OcrInput } from "../../../src/workflows/ocr/schema.js";

import {
  registerOcrPdf,
  rawRecordEid,
  deriveRosterFromRawRecords,
  type StubRosterRow,
} from "./ocr-stub.js";
import type { DelegationRuntime, DelegationWorkflow } from "./runtime.js";

/**
 * Drive the REAL born-at-upload (option A) oath-upload FULL-RUN lifecycle through
 * the run-modal seam, browserlessly, against the harness's temp tracker + a gated
 * oath-upload daemon.
 *
 * SHAPE — DIFFERENT from the operation-coordinator drivers (`operation.ts`).
 * oath-upload is NOT a display coordinator: a FULL run is born at upload as a
 * REAL daemon `single` TICKET task that walks
 * `wait-approval → wait-signatures → servicenow-auth → open-hr-form → fill-form →
 * submit` as ONE row, with the OCR prep DELEGATED UNDER the ticket
 * (`parentRunId = ticketRunId`) and the ticket filing its own ServiceNow ticket
 * (so a full run SKIPS the once-per-document `approveDocumentTo` ticket fan-out).
 *
 * SEAM (real handler, no fallback). `prepareOathUploadFull` drives the REAL
 * `buildOcrPrepareHandler` with `targetWorkflow:"oath-upload"`, so the real
 * born-at-upload code path runs: the `enqueueOathUploadAtPrepare` seam creates
 * the ticket task + pre-emits its `single` row, the OCR run is delegated UNDER
 * the ticket (`parentRunId = ticketRunId`), and the OCR prep COMPOSES the
 * ticket's `ou-<HHMMSS>` trace PREFIX (VQ-1). The ONLY substitutions are:
 *   1. the born-task ENQUEUE is redirected onto the runtime's gated oath-upload
 *      daemon (via `rt.enqueue`) instead of `ensureDaemonsAndEnqueue` (which
 *      would spawn a real `tsx` daemon subprocess that crashes headless), and
 *   2. the OCR orchestrator's PDF/LLM/roster/SQLite IO is stubbed with the SAME
 *      escape hatches the OCR stub daemon uses (`ocr-stub.ts`).
 * Every born-at-upload + delegation + trace-composition code path in `prepare.ts`
 * is the real one.
 *
 * The gated oath-upload daemon runs `buildGatedOathUploadStub` — a faithful clone
 * of the real `defineWorkflow` config (`inputSubject:"pdf"`, `code:"ou"`,
 * `archetype:"single"`, the real `OATH_UPLOAD_WORKFLOW_RUNTIME_POLICY`, the real
 * step list) whose handler walks the REAL step sequence: `wait-approval` parks on
 * the REAL `subscribeToApproval` (so it learns its `signerItemIds` from the
 * operator's approve fan-out exactly as production does), `wait-signatures` is
 * GATED (so the test can hold/release/cancel it), and the ServiceNow legs are
 * stubbed to a fixed ticket number (a gated stub files no real ServiceNow
 * ticket — that stays covered by `oath-upload-smoke`/`-extended`).
 */

export interface PrepareOathUploadFullOpts {
  /** OCR form type. Always `"oath"` for oath-upload. Defaults to the runtime's `ocr.formType`, else `"oath"`. */
  formType?: string;
  /** Path to a renderable fixture PDF (falls back to a synthetic one-pager). */
  fixturePath: string;
  /** Original filename the ticket/OCR file title resolves to. Defaults to basename. */
  originalName?: string;
  /**
   * Raw, oath-shaped OCR records the stub pipeline returns VERBATIM (build via
   * `rawOathRecordFromStub`). The REAL `spec.matchRecord` runs on them. PII-FREE
   * — fake names + UCPath-shaped `10######` EIDs.
   */
  seededRecords: ReadonlyArray<Record<string, unknown>>;
  /**
   * Roster rows the stub `_loadRosterOverride` returns. When omitted, one row
   * per seeded record is derived (EID short-circuit → matched).
   */
  roster?: ReadonlyArray<StubRosterRow>;
  /** Pre-assign the OCR session id (the OCR row `id` AND the ticket's sessionId). Else a fresh id. */
  sessionId?: string;
  /** Dry-run flag threaded to the ticket row + OCR run. */
  dryRun?: boolean;
}

export interface PrepareOathUploadFullResult {
  /** The born-at-upload oath-upload TICKET run id (= the OCR run's `parentRunId`, the ROOT). */
  ticketRunId: string;
  /** The ticket's item id (= the OCR session id). */
  ticketItemId: string;
  /** The delegated OCR run id. */
  ocrRunId: string;
  /** The OCR session id (the OCR row `id`). */
  ocrSessionId: string;
}

/**
 * Drive the REAL `/api/ocr/prepare` handler with `targetWorkflow:"oath-upload"`.
 * Returns the born ticket run id (the ROOT), the delegated OCR run id, and the
 * OCR session id.
 *
 * After this resolves the born ticket `single` row + the delegated OCR review row
 * are in the temp tracker; the gated oath-upload daemon has claimed the ticket and
 * parked it in `wait-approval` (sync via
 * `rt.waitForEvent("step:start", { step: "wait-approval", runId: ticketRunId })`),
 * and the OCR orchestrator runs to its `awaiting-approval` park (sync via
 * `rt.waitForEvent("ocr:awaiting-approval", { runId: ocrRunId })`).
 */
export async function prepareOathUploadFull(
  rt: DelegationRuntime,
  opts: PrepareOathUploadFullOpts,
): Promise<PrepareOathUploadFullResult> {
  const trackerDir = rt.trackerDir;
  const formType = opts.formType ?? "oath";
  const originalName = opts.originalName ?? opts.fixturePath.split("/").pop() ?? "oath-upload.pdf";
  const sessionId = opts.sessionId ?? `ocr-sess-${randomUUID().slice(0, 8)}`;

  // Register a renderable PDF in the temp file store (prefers the real fixture;
  // synthetic one-pager fallback). The records come from the override either way.
  const { pdfFileId, pdfPath } = await registerOcrPdf({ trackerDir, fixturePath: opts.fixturePath, originalName });

  // The orchestrator's `_loadRosterOverride` bypasses real parsing, but the path
  // must resolve to a non-empty string so the "no roster path" guard doesn't trip.
  const uploadsDir = join(trackerDir, "uploads");
  if (!existsSync(uploadsDir)) mkdirSync(uploadsDir, { recursive: true });
  const rosterPath = join(uploadsDir, "roster.xlsx");
  writeFileSync(rosterPath, "");

  const seededRecords = opts.seededRecords.map((r) => ({ ...r }));
  const roster: StubRosterRow[] = opts.roster
    ? opts.roster.map((r) => ({ ...r }))
    : deriveRosterFromRawRecords(seededRecords);

  // Captured by the `enqueueOathUploadAtPrepare` seam so the caller can address
  // the born ticket row + its run.
  let ticketRunId: string | undefined;
  let ticketTraceId: string | undefined;

  // Drive the REAL prepare handler. Two seams:
  //   1. `runOrchestrator` — a wrapper over the REAL `runOcrOrchestrator` with
  //      the OCR stub's escape hatches, so the delegation + trace composition all
  //      run for real, browserlessly.
  //   2. `enqueueOathUploadAtPrepare` — the born-at-upload seam. The REAL
  //      `defaultEnqueueOathUploadAtPrepare` calls `ensureDaemonsAndEnqueue`
  //      (spawns a `tsx` daemon subprocess); we redirect the enqueue onto the
  //      runtime's gated oath-upload daemon via `rt.enqueue` and pre-emit the
  //      SAME rich `single` pending row the real seam emits (so the born-ticket
  //      PROJECTION matches production), returning the ticket runId + composed
  //      `ou-` trace id so the OCR run delegates under the ticket.
  const handler = buildOcrPrepareHandler({
    trackerDir,
    runOrchestrator: async (input: OcrInput, orchOpts) =>
      void (await runOcrOrchestrator(input, {
        ...orchOpts,
        _ocrPipelineOverride: async () => ({
          data: seededRecords.map((r) => ({ ...r })),
          provider: "stub",
          attempts: 1,
          cached: false,
        }),
        _loadRosterOverride: async () => roster.map((r) => ({ eid: r.eid, name: r.name })),
        _enqueueEidLookupOverride: async () => {
          /* no-op: no person-lookup daemon in this runtime */
        },
        _disableSqliteDependencies: true,
        _watchChildRunsOverride: async (watchOpts) =>
          watchOpts.expectedItemIds.map((itemId, i) => ({
            workflow: "person-lookup",
            itemId,
            runId: `stub-ou-verify-${i}`,
            status: "done" as const,
            data: {
              emplId: rawRecordEid(seededRecords[i]),
              hrStatus: "Active",
              department: "HDH",
              personOrgScreenshot: "x.png",
            },
          })),
      })),
    enqueueOathUploadAtPrepare: async (args) => {
      // Mirror `defaultEnqueueOathUploadAtPrepare` exactly, but route the enqueue
      // onto the runtime's gated oath-upload daemon (a real daemon already alive
      // for this runtime) so the born task is CLAIMED and walks its lifecycle —
      // instead of `ensureDaemonsAndEnqueue` spawning a `tsx` subprocess.
      //
      // Pre-assign the runId so the rich `single` pending pre-emit lands BEFORE
      // the enqueue (and thus before the daemon's claim) — matching production's
      // `onPreEmitPending` ordering. A post-enqueue pre-emit would race the
      // daemon's own pending re-emit and land last, making the latest-row
      // projection read a step-less pending row.
      const itemId = args.sessionId;
      const bornRunId = randomUUID();
      ticketRunId = bornRunId;
      ticketTraceId = buildTraceId({ code: "ou", runId: bornRunId, at: new Date() });
      // Pre-emit the SAME rich `single` pending row the real seam emits, so the
      // born ticket PROJECTION (file-kind, pdf title, trace id) matches production
      // BEFORE the daemon claims it. (The daemon's own claim then emits the live
      // running rows.)
      emitTrackerRow(
        {
          workflow: "oath-upload",
          timestamp: new Date().toISOString(),
          id: itemId,
          runId: bornRunId,
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
            __id: itemId,
            __traceId: ticketTraceId,
            ...(args.dryRun ? { dryRun: "true" } : {}),
          },
          input: {
            sessionId: args.sessionId,
            pdfOriginalName: args.pdfOriginalName,
            ...(args.pdfFileId ? { pdfFileId: args.pdfFileId } : {}),
            mode: "full",
            ...(args.dryRun ? { dryRun: true } : {}),
          },
        },
        trackerDir,
      );
      await rt.enqueue(
        "oath-upload",
        {
          id: itemId,
          sessionId: args.sessionId,
          pdfOriginalName: args.pdfOriginalName,
          ...(args.pdfFileId ? { pdfFileId: args.pdfFileId } : {}),
          mode: "full",
          ...(args.dryRun ? { dryRun: true } : {}),
        } as never,
        { itemId, runId: bornRunId },
      );
      return { runId: bornRunId, traceId: ticketTraceId };
    },
  });

  const res = await handler({
    pdfPath,
    pdfOriginalName: originalName,
    pdfFileId,
    formType,
    rosterMode: "existing",
    rosterPath,
    sessionId,
    targetWorkflow: "oath-upload",
    ...(opts.dryRun ? { dryRun: true } : {}),
  });

  if (res.status !== 202 || !res.body.ok) {
    throw new Error(
      `prepareOathUploadFull: prepare route returned ${res.status}: ${JSON.stringify(res.body)}`,
    );
  }
  const { runId: ocrRunId } = res.body;
  // oath-upload is NOT an operation coordinator, so the 202 body carries NO
  // `parentRunId` (that field is operation-coordinator-only). The born ticket's
  // runId is captured off the `enqueueOathUploadAtPrepare` seam, which runs in the
  // prepare route's BACKGROUND dispatch IIFE (off the 202 path, before the OCR
  // orchestrator starts). Poll until the seam fires — no sleeps.
  const start = Date.now();
  while (!ticketRunId) {
    if (Date.now() - start > 10_000) {
      throw new Error(
        "prepareOathUploadFull: the born-at-upload seam never fired within 10s — " +
          "did `targetWorkflow:\"oath-upload\"` reach the isOathUploadTarget branch?",
      );
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  return { ticketRunId, ticketItemId: sessionId, ocrRunId, ocrSessionId: sessionId };
}

/** A faithful gated oath-upload stub workflow + the run-time gate it parks on. */
export interface GatedOathUploadStub {
  workflow: DelegationWorkflow;
  /** Hold every oath-upload run reaching `wait-signatures` until released/cancelled. */
  holdWaitSignatures(): void;
  /** Release a specific held `wait-signatures` for one run (lets it proceed to submit/done). */
  releaseWaitSignatures(runId: string): void;
}

const STUB_TICKET_NUMBER = "HRC0099999";

/**
 * Build a faithful gated oath-upload stub workflow that mirrors the REAL
 * `defineWorkflow` config + step sequence. Pass `.workflow` into
 * `createDelegationRuntime({ workflows: [...] })`. The hold is keyed by runId
 * directly on the stub object (`holdWaitSignatures`/`releaseWaitSignatures`),
 * NOT through the runtime's `GateCoordinator` — the stub owns its own
 * signal-aware latch so the parked step rejects on `ctx.signal` abort (cancel).
 *
 * The handler walks the REAL step list:
 *  - `wait-approval` — parks on the REAL `subscribeToApproval({ workflow:"ocr",
 *    sessionId })`, learning `signerItemIds` from the operator's approve fan-out
 *    (the cross-process JSONL backstop + in-memory `emitApproved`), exactly as the
 *    real handler does. Discard/hard-fail rejections throw (NOT filing the
 *    ticket), mirroring the real handler.
 *  - `wait-signatures` — GATED via the coordinator, so the test can hold the
 *    ticket here (waiting on the signer rows), then release or cancel it.
 *  - `servicenow-auth` / `open-hr-form` / `fill-form` — no-op stubs (no browser).
 *  - `submit` — stamps a fixed ticket number + terminal `filed` status (a gated
 *    stub files no REAL ServiceNow ticket — the real ticket logic stays covered
 *    by `oath-upload-smoke`/`oath-upload-extended`).
 */
export function buildGatedOathUploadStub(): GatedOathUploadStub {
  const HELD_STAGE = "wait-signatures";
  let holdActive = false;
  const heldResolvers = new Map<string, () => void>();

  const holdWaitSignatures = (): void => {
    holdActive = true;
  };
  const releaseWaitSignatures = (runId: string): void => {
    const resolve = heldResolvers.get(runId);
    if (resolve) {
      heldResolvers.delete(runId);
      resolve();
    }
  };

  // A signal-aware hold keyed by runId so the test holds/releases the SAME run.
  const holdAt = (runId: string, signal: AbortSignal): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      if (signal.aborted) {
        reject(new Error("cancelled before hold"));
        return;
      }
      heldResolvers.set(runId, resolve);
      signal.addEventListener(
        "abort",
        () => {
          heldResolvers.delete(runId);
          reject(new Error(`cancelled during hold(${HELD_STAGE})`));
        },
        { once: true },
      );
    });

  const workflow = defineWorkflow({
    name: "oath-upload",
    label: "Oath Upload",
    archetype: "single",
    inputSubject: "pdf",
    code: "ou",
    systems: [],
    authSteps: false,
    steps: oathUploadSteps,
    schema: OathUploadInputSchema,
    runtimePolicy: OATH_UPLOAD_WORKFLOW_RUNTIME_POLICY,
    getName: (d) => d.pdfOriginalName ?? "",
    getId: (d) => d.sessionId ?? "",
    handler: async (ctx, input) => {
      const trackerDir = ctx.trackerDir;
      // Mirror the real handler's leading `ctx.updateData` so the running rows
      // carry the file-kind identity fields.
      ctx.updateData({
        pdfOriginalName: input.pdfOriginalName,
        ...(input.pdfFileId ? { pdfFileId: input.pdfFileId } : {}),
        sessionId: input.sessionId,
        uploadMode: input.mode,
        status: "running",
        ...(input.dryRun ? { dryRun: true } : {}),
      });

      // ─── wait-approval ── learn the signer set from the operator's approve.
      let signerItemIds = input.signerItemIds ?? [];
      const needsApprovalWait = input.mode === "full" && signerItemIds.length === 0;
      if (needsApprovalWait) {
        await ctx.step("wait-approval", async () => {
          ctx.updateData({ status: "awaiting-approval" });
          try {
            const payload = await subscribeToApproval(
              { workflow: "ocr", sessionId: input.sessionId },
              { signal: ctx.signal, ...(trackerDir !== undefined ? { trackerDir } : {}) },
            );
            signerItemIds = [...(payload.fannedOutItemIds ?? [])];
            ctx.updateData({ status: "approved", signerCount: String(signerItemIds.length) });
          } catch (err) {
            if (err instanceof OcrDiscardedError) {
              throw new Error(
                `oath-upload: OCR prep was discarded — NOT filing the HR ticket (${err.reason})`,
                { cause: err },
              );
            }
            if (err instanceof OcrApprovalFailedError) {
              throw new Error(
                `oath-upload: OCR prep failed — NOT filing the HR ticket (${err.reason})`,
                { cause: err },
              );
            }
            throw err;
          }
        });
      } else {
        ctx.skipStep("wait-approval");
      }

      if (needsApprovalWait && signerItemIds.length === 0) {
        ctx.updateData({ status: "approval-empty", signerCount: "0" });
        throw new Error(
          "oath-upload: OCR prep was approved but produced zero signer row(s) — NOT filing the HR ticket",
        );
      }

      // ─── wait-signatures ── GATED (waiting on the signer rows).
      if (input.mode === "upload-only" || signerItemIds.length === 0) {
        ctx.skipStep("wait-signatures");
        ctx.updateData({ signerCount: "skipped" });
      } else {
        await ctx.step("wait-signatures", async () => {
          ctx.updateData({
            status: "waiting-signatures",
            signerCount: String(signerItemIds.length),
          });
          if (holdActive) {
            await holdAt(ctx.runId, ctx.signal);
          }
          ctx.updateData({ status: "signatures-complete" });
        });
      }

      // ─── ServiceNow legs (stubbed — no browser, no real ticket). ───────────
      await ctx.step("servicenow-auth", async () => {
        /* no-op: gated stub authenticates nothing */
      });
      await ctx.step("open-hr-form", async () => {
        /* no-op: gated stub opens no browser */
      });
      await ctx.step("fill-form", async () => {
        /* no-op: gated stub fills no form */
      });
      await ctx.step("submit", async () => {
        if (input.dryRun) {
          ctx.updateData({ ticketNumber: "DRY RUN - not submitted", status: "dry-run-complete" });
          return;
        }
        ctx.updateData({
          ticketNumber: STUB_TICKET_NUMBER,
          submittedAt: new Date().toISOString(),
          status: "filed",
        });
      });
      log.success(`[oath-upload stub] filed ${STUB_TICKET_NUMBER} for session ${input.sessionId}`);
    },
  }) as unknown as DelegationWorkflow;

  return { workflow, holdWaitSignatures, releaseWaitSignatures };
}

export { STUB_TICKET_NUMBER };
