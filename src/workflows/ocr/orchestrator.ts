/**
 * OCR orchestrator. Generic over form-type via OcrFormSpec. Replaces the
 * duplicated runPaperOathPrepare + runPrepare in oath-signature/prepare.ts
 * and emergency-contact/prepare.ts.
 *
 * Phases (each emits a tracker `running` event with `step` set):
 *   loading-roster → ocr (read + match + disambiguate) → person-lookup → awaiting-approval
 *
 * Returns when the row reaches `awaiting-approval`. The OCR row stays
 * `running step=awaiting-approval` (not `done`) — the row only becomes
 * terminal when the operator approves (via the approve route or via the
 * kernel handler's approval-signal wait) or discards.
 *
 * The user's approve / discard / reupload click is handled via separate
 * HTTP endpoints; see `src/tracker/dashboard/ocr/approve.ts` and
 * `src/control/ocr/discard.ts`.
 */
import { basename, join } from "node:path";
import type { ZodType } from "zod/v4";
import { loadRoster as realLoadRoster, precomputeRoster } from "../../services/matching/index.js";
import type { RosterRow as MatchRosterRow } from "../../services/matching/match.js";
import { watchChildRuns as realWatchChildRuns, type ChildOutcome, type WatchChildRunsOpts } from "../../tracker/delegation/watch-child-runs.js";
import { emitTrackerRow, dateLocal, type TrackerEntry, type TrackerRowEmission } from "../../tracker/jsonl.js";
import { findLatestEntryForPredicate } from "../../tracker/find-latest-entry.js";
import { errorMessage } from "../../utils/errors.js";
import { log } from "../../utils/log.js";
import { createOcrEidLookupDependencyBatch } from "../../tracker/tasks/store.js";
import { runDependencySchedulerTickForTrackerDir } from "../../tracker/tasks/scheduler.js";
import { getFormSpec } from "../../services/ocr/forms/registry.js";
import { applyCarryForward } from "./carry-forward.js";
import {
  patchOcrRecordFromEidLookupOutcome,
  patchOcrRecordUnresolved,
  type OcrLookupKind,
} from "../../services/ocr/eid-lookup-results.js";
import { flattenForData } from "../../services/ocr/tracker-data.js";
import { countVerified } from "../../services/ocr/records-stats.js";
import type { AnyOcrFormSpec, RosterRow as OcrRosterRow } from "./types.js";
import { extractOcrRecordEid, extractOcrRecordName } from "./record-helpers.js";
import type { OcrInput } from "./schema.js";
import { runOcrPipeline } from "../../services/ocr/pipeline.js";
import type { LookupSuggestion } from "../../services/ocr/lookup-suggestions.js";
import { normalizeUcpathEmployeeId } from "../../domain/identity/eid.js";
import { buildTraceId, tracePrefix } from "../../domain/queue-trace-id.js";
import { runOptionsToDaemonFlags, serializeRunOptionsForData } from "../../domain/run-options.js";
import { toLastFirstSearchName } from "../../domain/identity/person-name.js";
import { buildHttpPendingData } from "../../core/daemon/enqueue-dispatch.js";
import {
  clearOcrPrepareAbort,
  createOperatorDiscardError,
  isOcrPrepareAbortRequested,
  isOperatorDiscardAbortError,
  raceOcrPrepWithDiscard,
} from "./prepare-abort.js";

const WORKFLOW = "ocr";

// Local result type for the OCR pipeline step (simpler than the full OcrResult).
interface OcrPipelineResult {
  data: unknown[];
  provider: string;
  attempts: number;
  cached: boolean;
  pages?: Array<{
    page: number;
    success: boolean;
    error?: string;
    attemptedKeys: string[];
    poolKeyId?: string;
    attempts?: number;
  }>;
}

export interface OcrOrchestratorOpts {
  /** runId for this execution. Required — caller (HTTP or kernel handler) supplies. */
  runId: string;
  /**
   * Tracker directory override. Supplied by the caller (HTTP or kernel
   * handler); the orchestrator reads NO env directly. When unset, downstream
   * tracker writes fall back to `.tracker`. (The daemon-spawner env is named
   * `HRAUTO_TRACKER_DIR` and is consumed only by `config.ts` — this opt is the
   * explicit thread-through for the OCR path.)
   */
  trackerDir?: string;
  /** Date override (YYYY-MM-DD). Default: today. */
  date?: string;
  /** Hard timeout for eid-lookup phase. Default 1h. */
  eidLookupTimeoutMs?: number;
  /**
   * Optional per-run AbortSignal. Kernel-path callers thread `ctx.signal`
   * through so an operator cancel propagates without waiting on the
   * existing OCR-discard polling loop. Today this is informational only
   * (the orchestrator's internal raceOcrPrepWithDiscard already covers
   * its own polling); the field is reserved for future cancel paths.
   */
  signal?: AbortSignal;

  /**
   * Phase callback. Invoked with the row's `step` on every non-terminal
   * (`running`) emission so the kernel can mirror OCR's progress into the
   * session-drawer timeline (`ctx.reportPhase`). OCR owns its own queue-row
   * emission and bypasses `ctx.step`, so without this its session row would
   * never advance through the timeline. Optional — HTTP callers omit it.
   */
  onPhase?: (step: string) => void;

  /**
   * Review-data callback. Invoked at each `emitSnapshot` with the row's rich
   * preview payload (records + page metadata, sans kernel-owned stamps). Lets
   * the kernel handler capture the last-known extracted records so that on
   * FAILURE its terminal `failed` row — auto-emitted from accumulated `ctx`
   * data, which bypasses the orchestrator's direct emissions — still carries
   * the OCR prep identity (`mode: "prepare"`) + records. Otherwise the sparse
   * kernel row clobbers the orchestrator's rich `failed` row in the dashboard's
   * latest-wins dedupe, stripping the Preview tab off a failed prep row.
   * Optional — HTTP callers omit it.
   */
  onReviewData?: (data: Record<string, unknown>) => void;

  // ─── Test escape hatches ──────────────────────────────
  _emitOverride?: (entry: TrackerEntry) => void;
  _ocrPipelineOverride?: (opts: {
    pdfPath: string;
    formType: string;
    spec: AnyOcrFormSpec;
    sessionId: string;
  }) => Promise<OcrPipelineResult>;
  _loadRosterOverride?: (path: string) => Promise<MatchRosterRow[]>;
  _watchChildRunsOverride?: (opts: WatchChildRunsOpts) => Promise<ChildOutcome[]>;
  _enqueueEidLookupOverride?: (
    items: Array<{
      name?: string;
      emplId?: string;
      itemId: string;
      taskRole?: string;
      taskGroupId?: string;
      parentSubject?: string;
    }>,
  ) => Promise<void>;
  _lookupSuggestionOverride?: (input: {
    formType: string;
    record: unknown;
    recordIndex: number;
  }) => Promise<LookupSuggestion[]>;
  _createDependencyBatchOverride?: (input: {
    parent: { workflow: "ocr"; itemId: string; runId: string; formType: string };
    children: Array<{
      workflow: "person-lookup";
      itemId: string;
      runId: string;
      recordIndex: number;
      lookupKind: OcrLookupKind;
      formType: string;
    }>;
  }) => Promise<void>;
  _scheduleDependencyTickOverride?: () => Promise<{ ok: true } | { ok: false; error: string }>;
  _disableSqliteDependencies?: boolean;
  /** Skip the actual runWorkflow(sharepointDownload...) call (tests only). */
  _skipSharepointDispatch?: boolean;
}

/**
 * Outcome of `runOcrOrchestrator`. `"awaiting-approval"` means the row
 * is in `running step=awaiting-approval` and a downstream consumer (the
 * kernel handler or an HTTP poll) should wait on the approval signal.
 * `"complete"` is a STANDALONE review run that finished after person-lookup —
 * the orchestrator emitted its terminal `done` row and there is no approval
 * gate to wait on; the handler just lets the kernel finalize.
 * `"discarded"` means the operator discarded mid-run; the orchestrator
 * already stopped emitting and the discard route owns the terminal row.
 */
export type OcrOrchestratorOutcome =
  | { status: "awaiting-approval" }
  | { status: "complete" }
  | { status: "discarded" };

export async function runOcrOrchestrator(
  input: OcrInput,
  opts: OcrOrchestratorOpts,
): Promise<OcrOrchestratorOutcome> {
  const spec = getFormSpec(input.formType);
  if (!spec) {
    throw new Error(`OCR: unknown formType "${input.formType}"`);
  }
  const trackerDir = opts.trackerDir;
  const date = opts.date ?? dateLocal();
  const id = input.sessionId;
  const runId = opts.runId;
  // OCR prep is emitted directly (not via the kernel pre-emit), so the trace id
  // + queue-row kind the kernel would normally stamp are stamped here instead.
  // Without them the row has no `data.__traceId`/`data.queueRowKind`, so
  // `resolveQueueRowPresentation` returns undefined and the footer subtitle
  // falls back to the literal workflow name ("OCR"). Built once from the
  // run-start clock + runId so it's frozen-identical across every re-emit.
  // The trace-id code is derived first from the target-workflow OPERATION intent
  // (`operationTraceCode`: oath-signature → "os", oath-upload → "ou",
  // emergency-contact → "ec") so the prefix tells the operations apart — an
  // oath-signature run reads `os-…`, an oath-upload run `ou-…`, instead of both
  // branding `ou-…` off the shared oath form spec. With no operation it falls
  // back to the form spec's `traceCode` (oath standalone → "ou", verify → "vf")
  // and finally "oc" (the ocr `defineWorkflow` code) for a bare OCR run. OCR is
  // the physical root of the prep tree; root trace-id propagation then carries
  // this exact id to every fan-out descendant (person-lookups, signer rows,
  // oath-upload ticket) so they all DISPLAY the same operation prefix.
  const traceId = buildTraceId({
    code: operationTraceCode(input.operationWorkflow) ?? spec.traceCode ?? "oc",
    runId,
    at: new Date(),
  });
  const baseEmit =
    opts._emitOverride ??
    ((entry: TrackerEntry) => emitTrackerRow(entry as TrackerRowEmission, trackerDir));
  // Mirror each non-terminal phase into the session-drawer timeline. The queue
  // row is still owned by `baseEmit`; `onPhase` only drives the WorkflowBox.
  const emit = (entry: TrackerEntry): void => {
    baseEmit(entry);
    if (opts.onPhase && entry.status === "running" && entry.step) {
      opts.onPhase(entry.step);
    }
  };
  const loadRosterFn = opts._loadRosterOverride ?? realLoadRoster;
  const watchChildren = opts._watchChildRunsOverride ?? realWatchChildRuns;
  const trackerBaseDir = trackerDir ?? ".tracker";
  if (!input.pdfFileId) {
    throw new Error("OCR: pdfFileId is required (legacy page-images path removed)");
  }
  const pageImagesDir = join(trackerBaseDir, "pdf-cache", input.pdfFileId);

  const runOcr = opts._ocrPipelineOverride ?? (async ({ pdfPath, spec: s, preRenderedPages }: { pdfPath: string; formType: string; spec: AnyOcrFormSpec; sessionId: string; preRenderedPages?: string[] }) => {
    const result = await runOcrPipeline({
      pdfPath,
      pageImagesDir,
      recordSchema: s.ocrRecordSchema as ZodType<unknown>,
      schemaName: s.schemaName,
      prompt: s.prompt,
      // Skip re-rendering when we already rendered to seed placeholders.
      ...(preRenderedPages
        ? { _renderOverride: async () => preRenderedPages }
        : {}),
    });
    return {
      data: result.data as unknown[],
      provider: result.provider,
      attempts: result.attempts,
      cached: result.cached,
      pages: result.pages,
    };
  });

  const cachedParentSubject =
    typeof input.parentSubject === "string" && input.parentSubject.trim()
      ? input.parentSubject.trim()
      : undefined;

  // Operator's Automation-workers setting. `lookupDaemonFlags` raises the
  // alive-daemon target for the person-lookup fan-out below (and is forwarded to
  // `enrichRecords`); `serializedWorkerData` stamps `data.parallelWorkers` onto
  // EVERY OCR row (via writeTracker's re-stamp set) so the approve route can read
  // the worker count back at approve time — the OCR row is the durable bridge
  // across the upload → approve boundary. Auto → {} flags / no stamp.
  const lookupDaemonFlags = runOptionsToDaemonFlags(input.runOptions);
  const serializedWorkerData = serializeRunOptionsForData(input.runOptions);

  // A run COMPLETES `done` right after person-lookup (no parked review) only when
  // there is nothing a downstream step could ever consume: it is STANDALONE (no
  // `parentRunId` — approval ≡ delegation) AND the form has no approve fan-out
  // (`verify` and any future read-only form). A standalone form WITH approve
  // targets (oath / emergency-contact) still parks at `awaiting-approval` — its
  // approve route is the production fan-out path (driven via a delegated
  // operation) and the Tier-1 projection tests exercise it; only DELEGATED runs
  // expose Approve in the UI. See the terminal-phase branch near the end.
  const hasApproveTargets = Boolean(spec.approveTo || spec.approveDocumentTo);
  const completesAfterLookup = !input.parentRunId && !hasApproveTargets;

  let lastAnnouncedPhase: string | undefined;
  // Latest rich preview payload (records + page metadata) emitted via
  // `emitSnapshot`. Hoisted above the try so the failure path can re-stamp it
  // onto the terminal `failed` row (and surface it to the kernel handler via
  // `onReviewData`) — see the `onReviewData` opt doc.
  let lastReviewData: Record<string, unknown> | undefined;
  const writeTracker = (
    status: TrackerEntry["status"],
    data: Record<string, unknown>,
    step?: string,
    error?: string,
  ): void => {
    if (isOcrPrepareAbortRequested(id, runId)) {
      throw createOperatorDiscardError();
    }
    if (status === "running" && step && step !== lastAnnouncedPhase) {
      lastAnnouncedPhase = step;
      // The phase log mirrors the tracker step verbatim — the old standalone
      // "review" relabel for `awaiting-approval` is gone (a parked run logs
      // `Phase: awaiting-approval`; the pipeline hides that chip for standalone).
      log.step(`Phase: ${step}`);
    }
    // Stamp __id so the dashboard's resolveEntryId surfaces a stable handle
    // on every row. Kernel runWorkflow computes this via getId; this
    // orchestrator writes via trackEvent directly so we replicate it here.
    // Stamp __name = "OCR" too, because cross-workflow injection now
    // surfaces these rows in oath-signature / emergency-contact queues
    // where the workflow-label fallback in `buildDisplayNameMap` would
    // otherwise label them with the downstream workflow's name. Hardcoding
    // "OCR" keeps the row labeled "OCR" no matter which queue surfaces it
    // (OCR rows now resolve their title from queue row kind anyway).
    // mode: "prepare" makes the dashboard render this row with the
    // preview-tab affordance (gated on workflow === "ocr").
    const flat = flattenForData({
      ...data,
      ...(input.pdfFileId ? { pdfFileId: input.pdfFileId } : {}),
      mode: "prepare",
    });
    flat.__id = input.sessionId ?? "";
    flat.__name = cachedParentSubject ?? "OCR";
    flat.archetype = "preview";
    // OCR inputSubject is "pdf" → queue-row kind "file": title resolves to the
    // PDF filename, subtitle to the trace id (not the literal "OCR").
    flat.queueRowKind = "file";
    flat.__traceId = traceId;
    // Carry the target-workflow operation intent so the approve route can route
    // the fan-out (e.g. an oath-signature PDF run fans signers but no ticket).
    if (input.operationWorkflow) flat.operationWorkflow = input.operationWorkflow;
    // Carry the operator's worker count so the approve route can apply the same
    // setting to its signer/contact fan-out (read back via shared.ts). Rides
    // every row in the re-stamp set, surviving the dashboard's latest-wins dedupe.
    if (serializedWorkerData.parallelWorkers) flat.parallelWorkers = serializedWorkerData.parallelWorkers;
    if (cachedParentSubject) flat.parentSubject = cachedParentSubject;
    emit({
      workflow: WORKFLOW,
      timestamp: new Date().toISOString(),
      id,
      runId,
      ...(input.parentRunId ? { parentRunId: input.parentRunId } : {}),
      status,
      ...(step ? { step } : {}),
      data: flat,
      ...(error ? { error } : {}),
    });
  };

  // 0. Pending row
  writeTracker("pending", {
    formType: input.formType,
    pdfPath: input.pdfPath,
    pdfOriginalName: input.pdfOriginalName,
    sessionId: input.sessionId,
    ...(input.previousRunId ? { previousRunId: input.previousRunId } : {}),
    rosterMode: input.rosterMode,
  });

  try {
    log.step(`[ocr] starting prep (formType=${input.formType}, rosterMode=${input.rosterMode}, sessionId=${id})`);
    // 1. Loading-roster (supports rosterMode=download via SharePoint delegation)
    writeTracker("running", { formType: input.formType, rosterMode: input.rosterMode }, "loading-roster");

    let resolvedRosterPath = input.rosterPath;

    if (input.rosterMode === "download") {
      const { runWorkflow } = await import("../../core/index.js");
      const { sharepointDownloadWorkflow, _setPendingLandingUrl } = await import("../sharepoint-download/index.js");
      const { SHAREPOINT_DOWNLOADS } = await import("../sharepoint-download/registry.js");
      const spec0 = SHAREPOINT_DOWNLOADS[0];
      if (!spec0) throw new Error("OCR: no SharePoint download spec registered");
      const url = (process.env[spec0.envVar] ?? "").trim();
      if (!url && !opts._skipSharepointDispatch) {
        throw new Error(`OCR rosterMode=download but ${spec0.envVar} env var is unset`);
      }
      // Unique itemId per OCR run so watchChildren doesn't pick up a stale
      // sharepoint-download `done` row from earlier in the day, and so the
      // dashboard nests this child run cleanly under the parent OCR row.
      const childItemId = `ocr-sp-${runId}`;
      if (!opts._skipSharepointDispatch) {
        log.step(`[ocr] delegating sharepoint-download for "${spec0.label}" (childItemId=${childItemId})`);
        // sharepoint-download's kernel `systems[].login` reads the URL from a
        // module-level mutable because the kernel's SystemConfig.login signature
        // can't pass `input` through. Seed it before firing runWorkflow.
        _setPendingLandingUrl(url);
        void runWorkflow(
          sharepointDownloadWorkflow,
          {
            id: spec0.id,
            label: spec0.label,
            url,
            ...(spec0.filenameBase ? { filenameBase: spec0.filenameBase } : {}),
            parentRunId: runId,
          },
          { itemId: childItemId, trackerDir },
        )
          .catch((err) => log.warn(`[ocr] sharepoint download crashed: ${errorMessage(err)}`))
          .finally(() => _setPendingLandingUrl(null));
      }

      const outcomes = await watchChildren({
        workflow: "sharepoint-download",
        expectedItemIds: [childItemId],
        trackerDir,
        date,
        timeoutMs: 5 * 60_000,
        shouldAbort: () => isOcrPrepareAbortRequested(id, runId),
      });
      const result = outcomes[0];
      if (!result || result.status !== "done") {
        throw new Error(`SharePoint download failed: ${result?.error ?? "unknown error"}`);
      }
      resolvedRosterPath = (result.data?.path ?? "").trim();
      if (!resolvedRosterPath) throw new Error("SharePoint download finished without saving a path");
      log.success(`[ocr] roster downloaded: ${resolvedRosterPath}`);
    }

    // Forms that declare `rosterMode: "optional"` (e.g. `verify`, which does no
    // roster matching — it resolves identities via person-lookup in
    // `enrichRecords`) may run with no roster at all. Roster-`required` forms
    // (oath / emergency-contact) still throw if no path resolved.
    if (!resolvedRosterPath && spec.rosterMode !== "optional") {
      throw new Error("OCR: no roster path resolved");
    }
    const roster = resolvedRosterPath
      ? (precomputeRoster((await loadRosterFn(resolvedRosterPath)) as MatchRosterRow[]) as OcrRosterRow[])
      : [];

    // 1b. Pre-render PDF pages so we know page count + can show the page
    // image in the Preview tab before OCR finishes.
    log.step(`[ocr] pre-rendering PDF pages so the Preview tab populates immediately`);
    const pdfFileId = input.pdfFileId;
    const preRenderedPages = await raceOcrPrepWithDiscard(
      id,
      runId,
      (async () => {
        const { openStateDb } = await import("../../tracker/state/db.js");
        const { ensurePdfPageCache } = await import("../../tracker/files/pdf-cache.js");
        const cachedPages = await ensurePdfPageCache(openStateDb(trackerBaseDir), {
          trackerDir: trackerBaseDir,
          fileId: pdfFileId,
          pdfPath: input.pdfPath,
        });
        return cachedPages
          .filter((page) => page.status === "ready" && page.imagePath)
          .map((page) => basename(page.imagePath!));
      })(),
    );
    const knownPageCount = preRenderedPages.length;
    log.success(`[ocr] rendered ${knownPageCount} page(s) — Preview tab now shows blank inputs ready to fill in`);

    // Snapshot helper: emits an awaiting-approval-shape entry with the
    // current `records` array. Called at every phase transition so the
    // Preview tab updates progressively as OCR / matching / disambig /
    // eid-lookup / verification each complete.
    // Running-status emits are deduplicated by a fingerprint over every
    // record's (matchState, verification.state, resolved eid, selected)
    // so any per-record progression triggers a new emit while truly
    // unchanged back-to-back calls skip work before writeTracker.
    let lastSnapshotKey = "";
    const emitSnapshot = (
      records: unknown[],
      step: string,
      status: TrackerEntry["status"],
      extras: Record<string, unknown> = {},
    ): void => {
      if (status === "running") {
        const recList = records as Record<string, unknown>[];
        const stateVec = recList
          .map((r) => {
            const ms = String((r?.matchState as string | undefined) ?? "");
            const ver = (r?.verification as { state?: string } | undefined)?.state ?? "";
            const eid = String(((r?.employeeId ?? r?.eid) as string | undefined) ?? "");
            const sel = r?.selected === true ? "1" : "0";
            return `${ms}:${ver}:${eid}:${sel}`;
          })
          .join("|");
        const key = `${step}|${recList.length}|${stateVec}`;
        if (key === lastSnapshotKey) return;
        lastSnapshotKey = key;
      }
      const verifiedCount = countVerified(records);
      const snapshotData: Record<string, unknown> = {
        formType: input.formType,
        pdfOriginalName: input.pdfOriginalName,
        sessionId: input.sessionId,
        pageImagesDir,
        ...(input.parentRunId ? { parentRunId: input.parentRunId } : {}),
        recordCount: records.length,
        verifiedCount,
        records,
        ...extras,
      };
      // Remember the latest rich payload so a later failure can re-stamp it,
      // and surface it to the kernel handler for its terminal-row seed.
      lastReviewData = snapshotData;
      opts.onReviewData?.(snapshotData);
      writeTracker(status, snapshotData, step);
    };

    // Seed the Preview tab with one blank record per page so the operator
    // sees the page image + empty inputs immediately. As OCR finishes,
    // these are replaced with real extracted records.
    const placeholderRecords: unknown[] = Array.from({ length: knownPageCount }, (_, i) => ({
      formKind: input.formType,
      sourcePage: i + 1,
      rowIndex: 0,
      printedName: "",
      employeeId: "",
      employeeSigned: true,
      officerSigned: null,
      dateSigned: null,
      notes: [],
      documentType: "expected",
      originallyMissing: [],
      matchState: "lookup-pending",
      matchSource: "manual",
      selected: false,
      warnings: ["Loading… OCR running"],
    }));
    emitSnapshot(placeholderRecords, "ocr", "running", { rosterPath: resolvedRosterPath });

    // 2. OCR
    log.step(`[ocr] running OCR pipeline against ${input.pdfOriginalName}`);
    const ocrResult = await raceOcrPrepWithDiscard(
      id,
      runId,
      runOcr({
        pdfPath: input.pdfPath,
        formType: input.formType,
        spec,
        sessionId: input.sessionId,
        preRenderedPages,
      }),
    );
    log.success(`[ocr] OCR complete (provider=${ocrResult.provider}, attempts=${ocrResult.attempts}, records=${(ocrResult.data as unknown[]).length})`);
    // Per-record extraction summary so operator can see exactly what came
    // out of the LLM before any matching/disambiguation runs on top.
    (ocrResult.data as Array<Record<string, unknown>>).forEach((rec, i) => {
      const name = String(rec.printedName ?? "").trim() || "(empty)";
      const eid = String(rec.employeeId ?? "").trim() || "(none)";
      const date = String(rec.dateSigned ?? "").trim() || "(none)";
      const signed = rec.employeeSigned === true ? "✓" : rec.employeeSigned === false ? "✗" : "?";
      const docType = String(rec.documentType ?? "expected");
      const missing = Array.isArray(rec.originallyMissing) && rec.originallyMissing.length > 0
        ? ` missing=[${(rec.originallyMissing as string[]).join(",")}]`
        : "";
      log.step(`[ocr] record ${i + 1}/${(ocrResult.data as unknown[]).length}: name="${name}" eid=${eid} date=${date} signed=${signed} type=${docType}${missing}`);
    });

    // Build per-page status summary from OCR result
    const pages = ocrResult.pages ?? [];
    const failedPages = pages
      .filter((p) => !p.success)
      .map((p) => ({
        page: p.page,
        error: p.error ?? "unknown error",
        attemptedKeys: p.attemptedKeys,
        pageImagePath: join(pageImagesDir, `page-${String(p.page).padStart(3, "0")}.png`),
        attempts: p.attempts ?? p.attemptedKeys?.length ?? 1,
      }));
    const pageStatusSummary = {
      total: pages.length,
      succeeded: pages.filter((p) => p.success).length,
      failed: failedPages.length,
    };

    // Compute empty pages: pages OCR succeeded on but produced zero records.
    // The dashboard's OcrReviewPane renders an EmptyPagePlaceholder for each
    // (page image visible on the left, "Add row manually" button on the right).
    const recordsByPage = new Set<number>();
    for (const r of (ocrResult.data as Array<{ sourcePage?: number }>)) {
      if (typeof r.sourcePage === "number") recordsByPage.add(r.sourcePage);
    }
    const emptyPages = pages
      .filter((p) => p.success && !recordsByPage.has(p.page))
      .map((p) => p.page)
      .sort((a, b) => a - b);

    // Snapshot the OCR-extracted records → Preview shows extracted
    // names/dates BEFORE matching runs.
    emitSnapshot(ocrResult.data as unknown[], "ocr", "running", {
      rosterPath: resolvedRosterPath,
      ocrProvider: ocrResult.provider,
      ocrAttempts: ocrResult.attempts,
      ocrCached: ocrResult.cached,
      failedPages,
      emptyPages,
      pageStatusSummary,
    });

    // 3. Match
    log.step(`[ocr] matching ${(ocrResult.data as unknown[]).length} OCR record(s) against roster`);
    log.step(`[ocr] roster has ${roster.length} row(s)${resolvedRosterPath ? ` loaded from ${resolvedRosterPath.split("/").pop()}` : " (no roster — rosterMode optional)"}`);
    let records = await raceOcrPrepWithDiscard(
      id,
      runId,
      Promise.all(
        (ocrResult.data as unknown[]).map((r) =>
          spec.matchRecord({ record: r, roster }),
        ),
      ),
    );
    // Per-record match outcome summary.
    records.forEach((r, i) => {
      const rec = r as { matchState?: string; matchSource?: string; employeeId?: string; printedName?: string; matchConfidence?: number; rosterCandidates?: Array<{ score: number }> };
      const conf = typeof rec.matchConfidence === "number" ? ` conf=${rec.matchConfidence.toFixed(2)}` : "";
      const candCount = rec.rosterCandidates?.length ?? 0;
      log.step(`[ocr] match ${i + 1}/${records.length}: state=${rec.matchState} source=${rec.matchSource ?? "(none)"} eid=${rec.employeeId || "(none)"}${conf} candidates=${candCount}`);
    });
    // Snapshot post-matching: badges + EIDs (where roster auto-accepted)
    // appear in the Preview tab.
    emitSnapshot(records, "ocr", "running", {
      failedPages,
      emptyPages,
      pageStatusSummary,
    });

    // 3b. Carry-forward (if reupload)
    if (input.previousRunId) {
      const v1Records = readPreviousRecords(input.sessionId, input.previousRunId, trackerDir, date);
      if (v1Records.length > 0) {
        records = applyCarryForward({ v2Records: records, v1Records, spec });
      }
    }

    // 3c. Disambiguating — for each record left as lookup-pending with
    // disambiguation-eligible candidates, run the LLM disambiguator.
    // Records flagged matchSource form-eid or manual skip this phase
    // (form-eid → eid-lookup-by-EID; manual → eid-lookup-by-name backstop).
    const disambigTargets: Array<{ index: number; rec: { rosterCandidates?: Array<{ eid: string; name: string; score: number }>; printedName?: string; matchState?: string; matchSource?: string } }> = [];
    records.forEach((rec, index) => {
      const r = rec as { matchState?: string; matchSource?: string; rosterCandidates?: Array<{ eid: string; name: string; score: number }>; printedName?: string };
      if (r.matchState !== "lookup-pending") return;
      if (r.matchSource === "form-eid" || r.matchSource === "manual") return;
      if (!r.rosterCandidates || r.rosterCandidates.length === 0) return;
      disambigTargets.push({ index, rec: r });
    });

    if (disambigTargets.length > 0) {
      log.step(`[ocr] disambiguating ${disambigTargets.length} ambiguous record(s) via LLM (others: ${records.length - disambigTargets.length} skipped — already matched, manual, or no candidates)`);
      // Snapshot WITH records so the Preview tab keeps showing them
      // while disambiguation runs in the background.
      emitSnapshot(records, "ocr", "running", { failedPages, emptyPages, pageStatusSummary });

      const { disambiguateMatch } = await import("../../services/ocr/disambiguate.js");
      const concurrencyEnv = Number.parseInt(process.env.OCR_DISAMBIG_CONCURRENCY ?? "", 10);
      const concurrency = Number.isFinite(concurrencyEnv) && concurrencyEnv > 0 ? concurrencyEnv : 4;

      const results: Array<{ eid: string | null; confidence: number }> = new Array(disambigTargets.length);
      let nextIdx = 0;
      const workers = Array.from({ length: Math.min(concurrency, disambigTargets.length) }, async () => {
        while (true) {
          const i = nextIdx++;
          if (i >= disambigTargets.length) return;
          const t = disambigTargets[i];
          try {
            results[i] = await disambiguateMatch({
              query: disambigQueryFromRecord(records[t.index]),
              candidates: t.rec.rosterCandidates!.slice(0, 5),
            });
          } catch (err) {
            log.warn(`[ocr] disambiguate failed for record ${t.index}: ${errorMessage(err)}`);
            results[i] = { eid: null, confidence: 0 };
          }
        }
      });
      await raceOcrPrepWithDiscard(id, runId, Promise.all(workers));

      disambigTargets.forEach((t, i) => {
        records[t.index] = spec.applyDisambiguation({
          record: records[t.index],
          result: results[i],
        });
      });
    } else {
      log.step(`[ocr] disambiguating skipped — 0 ambiguous records (all ${records.length} either matched, manual, or no candidates above 0.40)`);
      emitSnapshot(records, "ocr", "running", { failedPages, emptyPages, pageStatusSummary });
    }

    const suggestionTargets: Array<{ index: number; rec: unknown }> = [];
    records.forEach((rec, index) => {
      const kind = spec.needsLookup(rec);
      if (kind !== "name") return;
      const r = rec as { rosterCandidates?: unknown[] };
      if (Array.isArray(r.rosterCandidates) && r.rosterCandidates.length > 0) return;
      if (!extractOcrRecordName(rec, spec).trim()) return;
      suggestionTargets.push({ index, rec });
    });

    const lookupSuggestionsByIndex = new Map<number, LookupSuggestion[]>();
    if (suggestionTargets.length > 0) {
      log.step(`[ocr] asking LLM for lookup suggestions for ${suggestionTargets.length} record(s) with no fuzzy roster candidates`);
      const { suggestLookupCandidates } = await import("../../services/ocr/lookup-suggestions.js");
      const suggestConcurrencyEnv = Number.parseInt(process.env.OCR_SUGGEST_CONCURRENCY ?? "", 10);
      const suggestConcurrency = Number.isFinite(suggestConcurrencyEnv) && suggestConcurrencyEnv > 0
        ? suggestConcurrencyEnv
        : 4;
      let suggestNextIdx = 0;
      const suggestWorkers = Array.from(
        { length: Math.min(suggestConcurrency, suggestionTargets.length) },
        async () => {
          while (true) {
            const i = suggestNextIdx++;
            if (i >= suggestionTargets.length) return;
            const target = suggestionTargets[i];
            try {
              const suggestions = opts._lookupSuggestionOverride
                ? await opts._lookupSuggestionOverride({
                    formType: spec.formType,
                    record: target.rec,
                    recordIndex: target.index,
                  })
                : await suggestLookupCandidates({
                    formType: spec.formType,
                    record: target.rec,
                  });
              if (suggestions.length > 0) {
                lookupSuggestionsByIndex.set(target.index, suggestions);
                const rendered = suggestions.map((s) => s.emplId ? `eid=${s.emplId}` : `name="${s.name}"`).join(", ");
                log.step(`[ocr] lookup suggestions for rec ${target.index + 1}: ${rendered}`);
              } else {
                log.step(`[ocr] lookup suggestions for rec ${target.index + 1}: none; falling back to extracted name`);
              }
            } catch (err) {
              log.warn(`[ocr] lookup suggestions failed for record ${target.index + 1}: ${errorMessage(err)}`);
            }
          }
        },
      );
      await raceOcrPrepWithDiscard(id, runId, Promise.all(suggestWorkers));
    }

    // 4. EID lookup fan-out — UCPath + CRM name resolution and active / HDH disposition.
    // "name"        → lookup by OCR-printed name only (LLM name suggestions are logged for ops context, not enqueued)
    // "verify"      → roster-derived EID
    // "verify-only" → form-extracted EID or LLM suggestion EID
    const lookupTargets: Array<{
      rec: unknown;
      index: number;
      kind: OcrLookupKind;
      name?: string;
      eid?: string;
    }> = [];
    records.forEach((rec, index) => {
      const kind = spec.needsLookup(rec);
      if (kind === "name" || kind === "verify" || kind === "verify-only") {
        if (kind === "name" && !extractOcrRecordName(rec, spec).trim()) return;
        if ((kind === "verify" || kind === "verify-only") && !extractOcrRecordEid(rec).trim()) return;
        if (kind === "name") {
          const suggestions = lookupSuggestionsByIndex.get(index) ?? [];
          for (const suggestion of suggestions) {
            const suggestionEid = normalizeUcpathEmployeeId(suggestion.emplId);
            if (suggestionEid) {
              lookupTargets.push({ rec, index, kind: "verify-only", eid: suggestionEid });
            }
          }
          const primaryName = selectLookupName(extractOcrRecordName(rec, spec), suggestions).trim();
          if (primaryName) {
            lookupTargets.push({ rec, index, kind, name: primaryName });
          }
        } else {
          lookupTargets.push({ rec, index, kind });
        }
      }
    });

    if (lookupTargets.length > 0) {
      log.step(`[ocr] enqueuing ${lookupTargets.length} eid-lookup(s) for unmatched/verify-needed records (skipped ${records.length - countTargetRecords(lookupTargets)} record(s) — already resolved, no name/EID, or manual)`);
      lookupTargets.forEach((t) => {
        const inputDesc =
          t.kind === "name" ? `name="${targetName(t, spec)}"` : `eid=${t.eid ?? extractOcrRecordEid(t.rec)}`;
        log.step(`[ocr] lookup target rec ${t.index + 1}: kind=${t.kind} ${inputDesc}`);
      });
      // Snapshot WITH records so the Preview keeps showing the matched
      // rows while the person-lookup fan-out runs in the background.
      emitSnapshot(records, "person-lookup", "running", { failedPages, emptyPages, pageStatusSummary });

      const lookupTargetsByRecord = countTargetsByRecord(lookupTargets);
      const eidLookupEnqueueItems = lookupTargets.map((t, ordinal) => {
        const baseItemId = `ocr-${spec.formType === "oath" ? "oath" : "ec"}-${runId}-r${t.index}`;
        const itemId = lookupTargetsByRecord.get(t.index)! > 1 ? `${baseItemId}-n${ordinal}` : baseItemId;
        return { record: t.rec, index: t.index, kind: t.kind, name: t.name, eid: t.eid, itemId };
      });
      const eidLookupSqliteDepsEnabled =
        process.env.OCR_SQLITE_DEPENDENCIES !== "0" && !opts._disableSqliteDependencies;

      await runFanOutPhase({
        kind: "person-lookup",
        enqueueItems: eidLookupEnqueueItems,
        createDependencyBatch: async (children) => {
          const parent = { workflow: "ocr" as const, itemId: id, runId, formType: spec.formType };
          if (opts._createDependencyBatchOverride) {
            await opts._createDependencyBatchOverride({ parent, children });
          } else {
            createOcrEidLookupDependencyBatch({ trackerDir, parent, children });
          }
        },
        buildChild: (itemId, childRunId, item) => ({
          workflow: "person-lookup",
          itemId,
          runId: childRunId,
          recordIndex: item.index,
          lookupKind: item.kind,
          formType: spec.formType,
        }),
        hasDependencyBatchOverride: opts._createDependencyBatchOverride !== undefined,
        enqueueOverrideFn: opts._enqueueEidLookupOverride
          ? async () => {
              await opts._enqueueEidLookupOverride!(
                eidLookupEnqueueItems.map((e) => ({
                  ...(e.kind === "name"
                    ? { name: targetName(e, spec) }
                    : { emplId: lookupEnqueueEmplId(e) }),
                  itemId: e.itemId,
                  taskGroupId: input.sessionId,
                  ...(cachedParentSubject ? { parentSubject: cachedParentSubject } : {}),
                })),
              );
            }
          : undefined,
        preEmitPendingForOverride: async () => {
          const { personLookupWorkflow } = await import("../person-lookup/index.js");
          for (const e of eidLookupEnqueueItems) {
            const item = e.kind === "name"
              ? {
                  name: targetName(e, spec),
                  taskGroupId: input.sessionId,
                  ...(cachedParentSubject ? { parentSubject: cachedParentSubject } : {}),
                }
              : {
                  emplId: lookupEnqueueEmplId(e),
                  keepNonHdh: true,
                  taskGroupId: input.sessionId,
                  ...(cachedParentSubject ? { parentSubject: cachedParentSubject } : {}),
                };
            // Keep the override branch on the same write path shape as the
            // real fan-out below: eid-lookup children are `single` rows and
            // delegated scope is represented by parentRunId.
            const overrideData = buildHttpPendingData(personLookupWorkflow, item, runId);
            emitTrackerRow({
              workflow: personLookupWorkflow.config.name,
              timestamp: new Date().toISOString(),
              id: e.itemId,
              runId: `override-${e.itemId}`,
              status: "pending",
              data: overrideData,
              parentRunId: runId,
              input: item,
            }, trackerDir);
          }
        },
        realEnqueue: async (onPreparedItems) => {
          // Contract 3: route the eid-lookup fan-out through the kernel's
          // delegateToAllImpl primitive so parentRunId stamping, canonical
          // archetype derivation, and pending-row pre-emit share one code path with
          // every other delegation site. Behavioural equivalence vs the
          // pre-Contract-3 ensureDaemonsAndEnqueue call:
          //   - `renderAs: "flat"` remains a projection hint; the child row
          //     stamp is `single`, parentRunId marks it as delegated, and
          //     one vs many children controls single vs batch grouping.
          //   - `onPreparedItems` is forwarded verbatim so the SQLite task
          //     dependency batch is still created in the same lifecycle slot.
          //   - `fireAndForget: true` because the orchestrator's own
          //     `watchChildRuns` call below (waitForChildRuns) handles the
          //     await — wrapping a second wait inside delegateToAllImpl
          //     would double-count and re-watch the same children.
          const { delegateToAllImpl } = await import("../../core/delegate.js");
          const { personLookupWorkflow } = await import("../person-lookup/index.js");
          const inputs = eidLookupEnqueueItems.map((e) =>
            e.kind === "name"
              ? {
                  name: targetName(e, spec),
                  taskGroupId: input.sessionId,
                  ...(cachedParentSubject ? { parentSubject: cachedParentSubject } : {}),
                }
              : {
                  emplId: lookupEnqueueEmplId(e),
                  keepNonHdh: true,
                  taskGroupId: input.sessionId,
                  ...(cachedParentSubject ? { parentSubject: cachedParentSubject } : {}),
                },
          );
          const deriveChildItemId = (inp: { name?: string; emplId?: string }): string => {
            const matched = eidLookupEnqueueItems.find((e) => {
              if ("name" in inp && inp.name) return targetName(e, spec) === inp.name;
              if ("emplId" in inp && inp.emplId) return lookupEnqueueEmplId(e) === inp.emplId;
              return false;
            });
            return matched?.itemId ?? `ocr-fallback-${runId}-r0`;
          };
          type EidLookupChildInput = (typeof inputs)[number];
          await delegateToAllImpl<EidLookupChildInput, readonly string[]>({
            parentRunId: runId,
            trackerDir,
            // personLookupWorkflow's exact generic param doesn't line up
            // with the union type of `inputs` (name-only vs emplId-only
            // variants), so cast through unknown — the runtime schema
            // validates both shapes.
            child: personLookupWorkflow as unknown as Parameters<typeof delegateToAllImpl<EidLookupChildInput, readonly string[]>>[0]["child"],
            inputs,
            renderAs: "flat",
            fireAndForget: true,
            // Root trace-id propagation (trace/span model): pass the OCR root's
            // trace PREFIX (`ou-<HHMMSS>` for oath, `oc-<HHMMSS>` otherwise) so
            // every person-lookup child COMPOSES `<prefix>-<ownRunId4>` —
            // visibly one operation, each child individually greppable.
            rootTracePrefix: tracePrefix(traceId),
            // Operator's Automation-workers setting raises the person-lookup
            // daemon target for the lookup fan-out. Auto → {} (default reuse-or-
            // spawn-one), so only spread when an explicit N>1 was chosen.
            ...(lookupDaemonFlags.parallel ? { daemonFlags: lookupDaemonFlags } : {}),
            deriveItemId: deriveChildItemId,
            // The OCR pending row carries pdfFileId / sessionId / parent
            // subject context — re-emit those onto each child pending row
            // so the dashboard's queue-surface dispatcher has everything it
            // needs to title/group the rows.
            buildPendingExtras: (childItem, _itemId) => {
              const base = buildHttpPendingData(personLookupWorkflow, childItem, runId);
              // buildPendingTrackerData stamps __name/__id + parentSubject
              // again, so strip ours to avoid duplicate keys winning the
              // wrong write order. The remaining buildHttpPendingData fields
              // are the ones that aren't part of the pending-data seed.
              const { __name: _n, __id: _i, archetype: _a, ...extras } = base as Record<string, unknown> & { __name?: string; __id?: string; archetype?: string };
              return extras as Record<string, unknown>;
            },
            ...(onPreparedItems
              ? {
                  onPreparedItems: async (prepared) =>
                    onPreparedItems(prepared.map((p) => ({ itemId: p.itemId, runId: p.runId }))),
                }
              : {}),
          });
        },
        patchRecord: (recs, index, outcome, kind) => patchOcrRecordFromEidLookupOutcome(recs, index, outcome, kind),
        scheduleDependencyTickOverride: opts._scheduleDependencyTickOverride,
        records,
        spec,
        watchChildren,
        trackerDir,
        date,
        eidLookupTimeoutMs: opts.eidLookupTimeoutMs,
        emitSnapshot,
        failedPages,
        emptyPages,
        pageStatusSummary,
        sqliteDependenciesEnabled: eidLookupSqliteDepsEnabled,
        id,
        runId,
      });
    }

    // 4b. Form-specific enrichment (generic hook; most forms omit it). The
    // `verify` form uses this to delegate each person to person-lookup (CRM
    // employment + oath dates, active status) and oath records with a blank
    // authorized-official signature to i9-lookup, then patch the found values
    // onto each record. Awaited on purpose — the completeness report needs the
    // looked-up data before the operator reviews. Forms whose `needsLookup`
    // drives the eid-lookup fan-out above (oath / emergency-contact) omit this.
    if (spec.enrichRecords) {
      log.step(`[ocr] enrichRecords: running form-specific enrichment for ${records.length} record(s)`);
      emitSnapshot(records, "person-lookup", "running", { failedPages, emptyPages, pageStatusSummary });
      const enriched = await raceOcrPrepWithDiscard(
        id,
        runId,
        spec.enrichRecords({
          records,
          runId,
          sessionId: input.sessionId,
          trackerDir,
          date,
          parentSubject: cachedParentSubject,
          rootTracePrefix: tracePrefix(traceId),
          runOptions: input.runOptions,
          emitProgress: (recs: unknown[]) =>
            emitSnapshot(recs, "person-lookup", "running", { failedPages, emptyPages, pageStatusSummary }),
        }) as Promise<unknown[]>,
      );
      enriched.forEach((r, i) => {
        records[i] = r;
      });
    }

    // 5. Terminal phase. There is no longer a synthetic `verification` marker
    // step — person-lookup OWNS verification now (it runs the enrichment/lookups
    // whose outcomes patch each record), so the pipeline ends at person-lookup.
    const verifiedCount = countVerified(records);

    // COMPLETES `done` after person-lookup — no parked review. A standalone run
    // of a no-fan-out form (verify) has nothing to approve, so the run completes
    // and the operator reads the read-only completeness card on a terminal `done`
    // row. A failed lookup's per-record ↻ re-opens this done row (see
    // verify-relookup.ts). The handler seeds this payload onto the kernel's
    // terminal `done` so it stays a preview row.
    if (completesAfterLookup) {
      log.success({
        message: `[ocr] review complete — ${records.length} record(s), ${verifiedCount} verified`,
        event: "ocr:review-complete",
        category: "ocr",
        occasion: "completed",
        step: "person-lookup",
        count: records.length,
      });
      emitSnapshot(records, "person-lookup", "done", {
        failedPages,
        emptyPages,
        pageStatusSummary,
      });
      return { status: "complete" };
    }

    // DELEGATED run → Awaiting-approval. The workflow returns here even if a
    // background lookup is still running; the operator can start reviewing
    // immediately and lookup outcomes patch records into this row as they arrive.
    //
    // Status is `running` (not `done`): the OCR row becomes terminal ONLY when
    // the operator approves (→ `done step=approved` via the approve route, or the
    // kernel-emitted `done` after the handler's approval-signal resolves) or
    // discards (→ `failed step=discarded`). See `src/services/ocr/approval-signal.ts`.
    // Annotated with the stable `ocr:awaiting-approval` event so the Tier-1
    // harness can `waitForEvent("ocr:awaiting-approval", { runId })`. Run-scope
    // log → logs/ocr-<date>.jsonl; see docs/engineering/structured-log-events.md.
    log.success({
      message: `[ocr] preparation complete — awaiting operator approval (${records.length} record(s), ${verifiedCount} verified now)`,
      event: "ocr:awaiting-approval",
      category: "ocr",
      occasion: "waiting",
      step: "awaiting-approval",
      count: records.length,
    });
    emitSnapshot(records, "awaiting-approval", "running", {
      failedPages,
      emptyPages,
      pageStatusSummary,
    });
    return { status: "awaiting-approval" };
  } catch (err) {
    if (isOperatorDiscardAbortError(err)) {
      log.step(`[ocr] preparation stopped (${input.sessionId}) — operator discarded while prep was running`);
      return { status: "discarded" };
    }
    try {
      // Carry the last rich preview payload onto the failed row so it stays a
      // recognizable preview row (records + page metadata survive for the
      // Preview tab even on failure). `writeTracker` re-stamps mode/archetype.
      writeTracker(
        "failed",
        { ...(lastReviewData ?? {}), formType: input.formType, sessionId: input.sessionId },
        undefined,
        errorMessage(err),
      );
    } catch (innerE) {
      if (isOperatorDiscardAbortError(innerE)) {
        // Discard fired while recording failure — both unwind to finally below.
        return { status: "discarded" };
      }
      throw innerE;
    }
    throw err;
  } finally {
    clearOcrPrepareAbort(id, runId);
  }
}

// ─── Helpers (private) ──────────────────────────────────────

/**
 * The trace-id code for an OCR run, derived from the target-workflow operation
 * intent so the trace PREFIX disambiguates the operation that owns the run
 * (oath-signature `os-…` vs oath-upload `ou-…` — previously both branded `ou-…`
 * off the shared oath form spec, the operator-confusing collision). Each value
 * MUST match that operation workflow's own `defineWorkflow` code; the
 * `workflow codes are unique` architecture guard keeps those collision-free.
 * Returns undefined for a standalone OCR-hub run (no `operationWorkflow`) so the
 * caller falls back to the form spec's `traceCode` (oath → "ou", verify → "vf")
 * or the OCR default "oc".
 */
export function operationTraceCode(operationWorkflow: string | undefined): string | undefined {
  switch (operationWorkflow) {
    case "oath-signature": return "os";
    case "oath-upload": return "ou";
    case "emergency-contact": return "ec";
    default: return undefined;
  }
}

interface FanOutChildSpec {
  workflow: "person-lookup";
  itemId: string;
  runId: string;
  recordIndex: number;
  lookupKind: OcrLookupKind;
  formType: string;
}

interface FanOutItem {
  itemId: string;
  index: number;
  kind: OcrLookupKind;
  record: unknown;
  name?: string;
  eid?: string;
}

interface FanOutOpts {
  /**
   * Phase label for tracker `step` + logs (the OCR pipeline stage). This is a
   * DISPLAY value only — it is NOT the workflow whose child rows we watch.
   * The watch key is hardcoded to `person-lookup` below; keeping them separate
   * is deliberate (the 2026-05-28 eid-lookup→person-lookup rename conflated the
   * two and stranded `watchChildRuns` on a dead `eid-lookup` key for 1h).
   */
  kind: "person-lookup";
  enqueueItems: FanOutItem[];
  createDependencyBatch: (children: FanOutChildSpec[]) => Promise<void>;
  buildChild: (itemId: string, runId: string, item: FanOutItem) => FanOutChildSpec;
  hasDependencyBatchOverride: boolean;
  enqueueOverrideFn?: () => Promise<void>;
  preEmitPendingForOverride?: () => Promise<void>;
  realEnqueue: (onPreparedItems?: (prepared: Array<{ itemId: string; runId: string }>) => Promise<void>) => Promise<void>;
  patchRecord: (records: unknown[], index: number, outcome: ChildOutcome, kind: OcrLookupKind) => void;
  scheduleDependencyTickOverride?: () => Promise<{ ok: true } | { ok: false; error: string }>;
  records: unknown[];
  spec: AnyOcrFormSpec;
  watchChildren: (opts: WatchChildRunsOpts) => Promise<ChildOutcome[]>;
  trackerDir: string | undefined;
  date: string;
  eidLookupTimeoutMs: number | undefined;
  emitSnapshot: (records: unknown[], step: string, status: TrackerEntry["status"], extras?: Record<string, unknown>) => void;
  failedPages: unknown[];
  emptyPages: number[];
  pageStatusSummary: unknown;
  sqliteDependenciesEnabled: boolean;
  id: string;
  runId: string;
}

async function runFanOutPhase(fanOpts: FanOutOpts): Promise<void> {
  const {
    kind,
    enqueueItems,
    createDependencyBatch,
    buildChild,
    hasDependencyBatchOverride,
    enqueueOverrideFn,
    preEmitPendingForOverride,
    realEnqueue,
    patchRecord,
    scheduleDependencyTickOverride,
    records,
    watchChildren,
    trackerDir,
    date,
    eidLookupTimeoutMs,
    emitSnapshot,
    failedPages,
    emptyPages,
    pageStatusSummary,
    sqliteDependenciesEnabled,
    id,
    runId,
  } = fanOpts;

  let sqliteDependencyMode = false;

  const createAndRecordDependencyBatch = async (children: FanOutChildSpec[]): Promise<void> => {
    await createDependencyBatch(children);
    sqliteDependencyMode = true;
  };

  const wakeDependencyScheduler = async (): Promise<void> => {
    if (scheduleDependencyTickOverride) {
      const outcome = await scheduleDependencyTickOverride();
      if (!outcome.ok) throw new Error(outcome.error);
      return;
    }
    await runDependencySchedulerTickForTrackerDir(trackerDir);
  };

  // Debounce per-outcome snapshots — batches rapid eid-lookup completions into
  // a single JSONL write instead of one write per outcome.
  let progressDebounceTimer: ReturnType<typeof setTimeout> | null = null;

  const waitForChildRuns = async (): Promise<void> => {
    const progressed = new Set<string>();
    const outcomes = await watchChildren({
      // The workflow whose child rows we watch is `person-lookup` — the actual
      // workflow the eid-lookup fan-out delegates to (see realEnqueue →
      // delegateToAllImpl({ child: personLookupWorkflow })). This MUST be the
      // child workflow name, NOT the `kind` phase label. watchChildRuns keys on
      // this name for both its SQLite (`listTasksForWorkflow`) and JSONL
      // (`rowFilePath`) paths, so a stale name resolves NOTHING and the watcher
      // hangs the full `timeoutMs` (1h). The 2026-05-28 eid-lookup→person-lookup
      // rename fixed force-research.ts / retry-page.ts but missed this site.
      workflow: "person-lookup",
      expectedItemIds: enqueueItems.map((e) => e.itemId),
      trackerDir,
      date,
      timeoutMs: eidLookupTimeoutMs ?? 60 * 60_000,
      shouldAbort: () => isOcrPrepareAbortRequested(id, runId),
      onProgress: (outcome, remaining) => {
        const enq = enqueueItems.find((e) => e.itemId === outcome.itemId);
        if (!enq) return;
        progressed.add(outcome.itemId);
        patchRecord(records, enq.index, outcome, enq.kind);
        log.step(`[ocr] ${kind} outcome for rec ${enq.index + 1}: kind=${enq.kind} status=${outcome.status} → record patched (${remaining} remaining)`);
        if (progressDebounceTimer !== null) clearTimeout(progressDebounceTimer);
        progressDebounceTimer = setTimeout(() => {
          progressDebounceTimer = null;
          emitSnapshot(records, kind, "running", { failedPages, emptyPages, pageStatusSummary });
        }, 250);
      },
    });
    for (const outcome of outcomes) {
      if (progressed.has(outcome.itemId)) continue;
      const enq = enqueueItems.find((e) => e.itemId === outcome.itemId);
      if (!enq) continue;
      patchRecord(records, enq.index, outcome, enq.kind);
    }
    const seen = new Set(outcomes.map((o) => o.itemId));
    for (const enq of enqueueItems) {
      if (!seen.has(enq.itemId)) {
        patchOcrRecordUnresolved(records, enq.index, `${kind} did not return within timeout`);
      }
    }
    const verifiedCount = countVerified(records);
    log.success(`[ocr] ${kind} complete — ${outcomes.length}/${enqueueItems.length} records resolved, ${verifiedCount} verified`);
    if (progressDebounceTimer !== null) { clearTimeout(progressDebounceTimer); progressDebounceTimer = null; }
    emitSnapshot(records, kind, "running", {
      failedPages,
      emptyPages,
      pageStatusSummary,
    });
  };

  if (enqueueOverrideFn) {
    if (sqliteDependenciesEnabled && hasDependencyBatchOverride) {
      try {
        await createAndRecordDependencyBatch(enqueueItems.map((child) => buildChild(child.itemId, "", child)));
      } catch (err) {
        sqliteDependencyMode = false;
        log.warn(`[ocr] SQLite dependency setup failed; falling back to watchChildRuns: ${errorMessage(err)}`);
      }
    }
    await preEmitPendingForOverride?.();
    await enqueueOverrideFn();
  } else {
    let dependencySetupError: unknown;
    const enqueueWithDependencies = async (withDependencies: boolean): Promise<void> => {
      await realEnqueue(
        withDependencies
          ? async (prepared) => {
              if (!sqliteDependenciesEnabled) return;
              try {
                await createAndRecordDependencyBatch(prepared.map((preparedItem) => {
                  const enqueued = enqueueItems.find((item) => item.itemId === preparedItem.itemId);
                  if (!enqueued) {
                    throw new Error(`No OCR ${kind} metadata for prepared item ${preparedItem.itemId}`);
                  }
                  return buildChild(preparedItem.itemId, preparedItem.runId, enqueued);
                }));
              } catch (err) {
                dependencySetupError = err;
                throw err;
              }
            }
          : undefined,
      );
    };
    try {
      await enqueueWithDependencies(true);
    } catch (err) {
      if (!dependencySetupError) throw err;
      sqliteDependencyMode = false;
      log.warn(`[ocr] SQLite dependency setup failed; falling back to watchChildRuns: ${errorMessage(dependencySetupError)}`);
      await enqueueWithDependencies(false);
    }
  }

  const dispatchSuffix = "waiting for results before approval";
  log.success(`[ocr] ${kind} dispatched to daemon — ${dispatchSuffix}`);
  emitSnapshot(records, kind, "running", {
    failedPages,
    emptyPages,
    pageStatusSummary,
  });

  if (sqliteDependencyMode) {
    log.success(`[ocr] ${kind} dependencies recorded in SQLite; waiting for child tasks to finish`);
    try {
      await wakeDependencyScheduler();
    } catch (err) {
      log.warn(`[ocr] dependency scheduler wake failed for sessionId=${id} runId=${runId} childCount=${enqueueItems.length}; continuing with direct child watch: ${errorMessage(err)}`);
    }
  }
  await waitForChildRuns();
}

const OCR_READER_LOOKBACK_DAYS = 7;

function readPreviousRecords(
  sessionId: string,
  previousRunId: string,
  trackerDir: string | undefined,
  date: string,
): unknown[] {
  const [yStr, mStr, dStr] = date.split("-");
  const anchor = new Date(Number(yStr), Number(mStr) - 1, Number(dStr));
  const latest = findLatestEntryForPredicate({
    workflow: WORKFLOW,
    trackerDir,
    lookbackDays: OCR_READER_LOOKBACK_DAYS,
    ...(Number.isNaN(anchor.getTime()) ? {} : { now: anchor }),
    predicate: (e) => e.id === sessionId && e.runId === previousRunId,
  });
  if (!latest?.data?.records) return [];
  try {
    const parsed = JSON.parse(latest.data.records as unknown as string);
    if (Array.isArray(parsed)) return parsed;
  } catch { /* tolerate */ }
  return [];
}

function lookupEnqueueEmplId(target: { record: unknown; eid?: string }): string {
  return target.eid ?? extractOcrRecordEid(target.record);
}

function targetName(target: { record?: unknown; rec?: unknown; name?: string }, spec: AnyOcrFormSpec): string {
  return target.name ?? extractOcrRecordName(target.record ?? target.rec, spec);
}

function formatLookupName(raw: string): string {
  return toLastFirstSearchName(raw) || raw.trim();
}

function selectLookupName(rawPrimary: string, suggestions: LookupSuggestion[]): string {
  const primary = rawPrimary.trim();
  const suggestedNames = suggestions
    .map((suggestion) => suggestion.name?.trim() ?? "")
    .filter((name) => name.length > 0);
  const options = uniqueStrings([primary, ...suggestedNames].filter((name) => name.length > 0));
  if (options.length > 1 && areLookupNameVariants(options)) {
    return formatLookupName(
      [...options].sort((a, b) => {
        const tokenDelta = nameTokens(b).length - nameTokens(a).length;
        if (tokenDelta !== 0) return tokenDelta;
        return b.length - a.length;
      })[0],
    );
  }
  return formatLookupName(primary);
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const key = nameTokens(value).join(" ");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

function areLookupNameVariants(names: string[]): boolean {
  const tokenSets = names.map((name) => new Set(nameTokens(name))).filter((tokens) => tokens.size > 0);
  if (tokenSets.length < 2) return false;
  const common = [...tokenSets[0]].filter((token) => tokenSets.every((tokens) => tokens.has(token)));
  const shortest = Math.min(...tokenSets.map((tokens) => tokens.size));
  if (common.length < Math.min(2, shortest)) return false;
  return tokenSets.every((tokens) => common.length / tokens.size >= 0.5);
}

function nameTokens(name: string): string[] {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

function countTargetsByRecord(targets: Array<{ index: number }>): Map<number, number> {
  const counts = new Map<number, number>();
  for (const target of targets) {
    counts.set(target.index, (counts.get(target.index) ?? 0) + 1);
  }
  return counts;
}

function countTargetRecords(targets: Array<{ index: number }>): number {
  return new Set(targets.map((target) => target.index)).size;
}

/** Name string fed to LLM roster disambiguation (oath: printedName; EC: employee.name). */
function disambigQueryFromRecord(record: unknown): string {
  const r = record as Record<string, unknown>;
  if (typeof r.printedName === "string" && r.printedName.trim()) return r.printedName.trim();
  const employee = r.employee as Record<string, unknown> | undefined;
  if (employee && typeof employee.name === "string") return employee.name.trim();
  return "";
}
