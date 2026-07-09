/**
 * OCR orchestrator. Generic over form-type via OcrFormSpec. Replaces the
 * duplicated runPaperOathPrepare + runPrepare in oath-signature/prepare.ts
 * and emergency-contact/prepare.ts.
 *
 * Phases (each emits a tracker `running` event with `step` set):
 *   loading-roster → ocr (read + match + disambiguate) → person-lookup
 *   → [DELEGATED] awaiting-approval  |  [STANDALONE] done
 *
 * **Delegated run** (`parentRunId` set — OCR as a sub-step of a target
 * workflow such as oath-signature or emergency-contact): parks at
 * `running step=awaiting-approval` after person-lookup and waits for the
 * operator to approve / discard / reupload. The OCR row only becomes
 * terminal when the operator approves (via the approve route or the kernel
 * handler's approval-signal wait) or discards. Emits `ocr:awaiting-approval`.
 *
 * **Standalone run** (no `parentRunId` — operator uploaded directly to the
 * OCR panel): has no downstream consumer, so it completes terminal `done`
 * immediately after person-lookup. No parked "review" step; the operator
 * reads a read-only completeness card. The Approve button is UI-gated on
 * `parentRunId`, so a standalone run can never be approved. Emits
 * `ocr:review-complete`.
 *
 * The user's approve / discard / reupload click is handled via separate
 * HTTP endpoints; see `src/tracker/dashboard/ocr/approve.ts` and
 * `src/control/ocr/discard.ts`.
 */
import { basename, join } from "node:path";
import { loadRoster as realLoadRoster, precomputeRoster } from "../../services/matching/index.js";
import type { RosterRow as MatchRosterRow } from "../../services/matching/match.js";
import { watchChildRuns as realWatchChildRuns, type ChildOutcome, type WatchChildRunsOpts } from "../../tracker/delegation/watch-child-runs.js";
import { emitTrackerRow, dateLocal, type TrackerEntry, type TrackerRowEmission } from "../../tracker/jsonl.js";
import { findLatestEntryForPredicate } from "../../tracker/find-latest-entry.js";
import { errorMessage } from "../../utils/errors.js";
import { log } from "../../utils/log.js";
import { withTimeout } from "../../utils/with-timeout.js";
import { createOcrEidLookupDependencyBatch } from "../../tracker/tasks/store.js";
import { runDependencySchedulerTickForTrackerDir } from "../../tracker/tasks/scheduler.js";
import { getFormSpec } from "../../services/ocr/forms/registry.js";
import { ocrChildItemIdPrefix } from "../../services/ocr/forms/shared.js";
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
import type {
  SharePointDownloadRequest,
  SharePointDownloadResult,
} from "../sharepoint-download/handler.js";
import { runOcrPipeline, runOcrSecondOpinionPage } from "../../services/ocr/pipeline.js";
import type { LookupSuggestion } from "../../services/ocr/lookup-suggestions.js";
import {
  normalizeEmergencyContactRecord,
  summarizeNormalizationChanges,
  type NormalizableEcRecord,
} from "../../services/llm/normalize-contact.js";
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
  requestOcrPrepareAbort,
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

// ─── Second-opinion helpers (suspect-name re-OCR) ─────────────────────────
// A record whose extracted name matches NOTHING in the roster AND that has no
// usable EID is the signature of a weak-vision-model misread (one random pool
// cell reads each page). The roster is the oracle: re-read the page on a
// tier-1 model and adopt the new reading only when it ranks strictly better.

const SECOND_OPINION_MAX_DEFAULT = 5;

function secondOpinionCap(): number {
  const env = Number.parseInt(process.env.OCR_SECOND_OPINION_MAX ?? "", 10);
  return Number.isFinite(env) && env >= 0 ? env : SECOND_OPINION_MAX_DEFAULT;
}

/** Extracted name across form shapes (oath/verify flat, EC nested). */
function readOcrRecordName(rec: unknown): string {
  const r = rec as {
    printedName?: unknown;
    employee?: { name?: unknown };
    emergencyContact?: { name?: unknown };
  };
  const flat = typeof r.printedName === "string" ? r.printedName.trim() : "";
  if (flat) return flat;
  const employeeName = typeof r.employee?.name === "string" ? r.employee.name.trim() : "";
  if (employeeName) return employeeName;
  return typeof r.emergencyContact?.name === "string" ? r.emergencyContact.name.trim() : "";
}

/** EID across form shapes; usable = ≥5 digits after stripping separators. */
function readUsableEid(rec: unknown): string | null {
  const normalized = extractOcrRecordEid(rec);
  if (normalized) return normalized;
  const r = rec as { employeeId?: unknown; employee?: { employeeId?: unknown } };
  const raw =
    typeof r.employeeId === "string"
      ? r.employeeId
      : typeof r.employee?.employeeId === "string"
        ? r.employee.employeeId
        : "";
  const digits = raw.replace(/\D/g, "");
  return /^\d{5,}$/.test(digits) ? digits : null;
}

/** EID for operator-facing logs — normalized UCPath when valid, else raw extracted text. */
function readOcrRecordEidForLog(rec: unknown): string {
  const normalized = extractOcrRecordEid(rec);
  if (normalized) return normalized;
  const r = rec as { employeeId?: unknown; employee?: { employeeId?: unknown } };
  const raw =
    typeof r.employeeId === "string"
      ? r.employeeId.trim()
      : typeof r.employee?.employeeId === "string"
        ? r.employee.employeeId.trim()
        : "";
  return raw;
}

/**
 * Rank a POST-match record: 3 = match resolved, 2 = roster candidates or a
 * usable EID to look up, 1 = nothing to anchor the identity (suspect).
 */
function matchOutcomeRank(rec: unknown): number {
  const r = rec as { matchState?: string; rosterCandidates?: unknown[] };
  if (r.matchState && r.matchState !== "lookup-pending") return 3;
  if ((r.rosterCandidates?.length ?? 0) > 0) return 2;
  if (readUsableEid(rec)) return 2;
  return 1;
}

/** EC-only second-opinion triggers beyond the generic no-roster/no-EID suspect. */
function isEcSecondOpinionSuspect(rec: unknown): boolean {
  const r = rec as {
    formKind?: string;
    matchState?: string;
    matchSource?: string;
    warnings?: string[];
    employee?: { name?: unknown };
    emergencyContact?: {
      sameAddressAsEmployee?: boolean;
      address?: { street?: unknown } | null;
      cellPhone?: unknown;
      homePhone?: unknown;
      workPhone?: unknown;
    };
  };
  if (r.formKind !== "emergency-contact") return false;

  // Form EID present but absent from roster — often a transposed digit (10843962 vs 10883962).
  if (
    r.matchState === "lookup-pending" &&
    r.matchSource === "form" &&
    readUsableEid(rec) &&
    r.warnings?.some((w) => w.includes("not in roster"))
  ) {
    return true;
  }

  // Employee block present but emergency contact has no phone AND no street — incomplete extraction.
  const employeeName = typeof r.employee?.name === "string" ? r.employee.name.trim() : "";
  if (!employeeName || !r.emergencyContact) return false;
  const hasPhone = [r.emergencyContact.cellPhone, r.emergencyContact.homePhone, r.emergencyContact.workPhone]
    .some((p) => typeof p === "string" && p.replace(/\D/g, "").length >= 7);
  const hasStreet =
    typeof r.emergencyContact.address?.street === "string" &&
    r.emergencyContact.address.street.trim().length > 0;
  return !hasPhone && !hasStreet;
}

function isSecondOpinionSuspect(rec: unknown): boolean {
  if (readOcrRecordName(rec) === "") return false;
  if (matchOutcomeRank(rec) === 1) return true;
  return isEcSecondOpinionSuspect(rec);
}

function secondOpinionSuspectReason(rec: unknown): string {
  if (matchOutcomeRank(rec) === 1) {
    return "matched 0 roster rows and has no EID";
  }
  if (isEcSecondOpinionSuspect(rec)) {
    const r = rec as { matchState?: string; warnings?: string[] };
    if (r.warnings?.some((w) => w.includes("not in roster"))) {
      return "form EID not on roster (possible digit misread)";
    }
    return "emergency contact block missing phone and address";
  }
  return "low-confidence extraction";
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
   * Root trace PREFIX (`<code>-<HHMMSS>`) of the delegating coordinator —
   * the operation row or the oath-upload born-at-upload task. When set, the
   * OCR run COMPOSES `<prefix>-<ownRunId4>` instead of minting its own
   * `HHMMSS`, so the delegated prep EXACTLY shares the coordinator's prefix
   * (VQ-1: the oath-upload child previously stamped its own start second,
   * +2s off the ticket's, breaking grep-by-prefix lineage; operation rows
   * only matched by same-second luck). Absent for standalone runs.
   */
  rootTracePrefix?: string;

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
  /**
   * Test escape: override the second-opinion tier-1 re-read of a suspect
   * page (production default: `runOcrSecondOpinionPage`). Return `null` to
   * simulate a failed re-read (original record kept).
   */
  _secondOpinionOverride?: (args: {
    pageNum: number;
    excludeModels: string[];
  }) => Promise<{ records: unknown[]; poolKeyId?: string } | null>;
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
  _requestSharePointDownloadOverride?: (
    request: SharePointDownloadRequest,
  ) => Promise<SharePointDownloadResult>;
  /**
   * Test-only tripwire for the `rosterMode: "download" | "wait"` path: when set,
   * reaching the SharePoint dispatch site THROWS instead of dispatching. The
   * name reflects the THROW semantics — this is NOT a silent skip. It is used by
   * the discard-cleanup tests, which trip the prepare-abort flag BEFORE roster
   * resolution and assert the run unwound before it ever reached the SharePoint
   * dispatch (if the abort failed to short-circuit, the throw makes the test
   * fail loudly instead of silently downloading). A non-download run never
   * reaches the guarded site, so the flag is inert for those.
   */
  _assertSharepointDispatchUnreached?: boolean;
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
  // A generic run cancel (dashboard per-row ×, daemon stop, browser disconnect)
  // aborts the run's `ctx.signal` but does NOT set the in-process prepare-abort
  // flag that EVERY prep-phase interruption polls (`raceOcrPrepWithDiscard`, the
  // `shouldAbort` callbacks) — only the OCR discard route sets it. Bridge the two:
  // when the signal aborts, trip the same flag so a RUNNING prep unwinds. This is
  // load-bearing for a STANDALONE verify run, which blocks in `enrichRecords` →
  // `watchChildRuns` and never reaches the signal-aware `subscribeToApproval` wait
  // the delegated path relies on; without the bridge such a run ignored a cancel
  // until `watchChildRuns`' multi-hour timeout. The catch below distinguishes a
  // signal-cancel from a UI discard (the discard route leaves `ctx.signal`
  // un-aborted) so each lands its correct terminal (cancelled vs discarded).
  if (opts.signal) {
    if (opts.signal.aborted) requestOcrPrepareAbort(id, runId);
    else opts.signal.addEventListener("abort", () => requestOcrPrepareAbort(id, runId), { once: true });
  }
  // OCR prep is emitted directly (not via the kernel pre-emit), so the trace id
  // + queue-row kind the kernel would normally stamp are stamped here instead.
  // Without them the row has no `data.__traceId`/`data.queueRowKind`, so
  // `resolveQueueRowPresentation` returns undefined and the footer subtitle
  // falls back to the literal workflow name ("OCR"). Built once from the
  // run-start clock + runId so it's frozen-identical across every re-emit.
  // The trace-id code is derived first from the target-workflow OPERATION intent
  // (`operationTraceCode`: oath-signature → "os", oath-upload → "ou",
  // emergency-contact → "ec") so the prefix tells the operations apart. With no
  // operation it falls back to the form spec's `traceCode` (only verify sets
  // one, "vf") and finally "oc" (the ocr `defineWorkflow` code) — standalone
  // oath/EC uploads brand `oc-…`, never an operation/workflow code (E2E-007).
  // A DELEGATED run composes the coordinator's prefix instead of minting its
  // own HHMMSS (`opts.rootTracePrefix`, VQ-1). OCR is the physical root of the
  // prep tree; root trace-id propagation then carries this exact id to every
  // fan-out descendant (person-lookups, signer rows, oath-upload ticket) so
  // they all DISPLAY the same operation prefix.
  const traceId = buildTraceId({
    code: operationTraceCode(input.operationWorkflow) ?? spec.traceCode ?? "oc",
    runId,
    at: new Date(),
    ...(opts.rootTracePrefix ? { rootPrefix: opts.rootTracePrefix } : {}),
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
      recordSchema: s.ocrRecordSchema,
      schemaName: s.schemaName,
      prompt: s.prompt,
      // Skip re-rendering when we already rendered to seed placeholders.
      ...(preRenderedPages
        ? { _renderOverride: async () => preRenderedPages }
        : {}),
    });
    return {
      data: result.data,
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

  // ALL standalone runs (no `parentRunId`) complete terminal `done` right after
  // person-lookup — this applies to oath, emergency-contact, and verify alike.
  // A standalone run has no downstream consumer (approval ≡ delegation): the
  // Approve button is only shown for DELEGATED runs in the UI, so a standalone
  // oath/EC run can never be approved anyway. Only a DELEGATED run (`parentRunId`
  // set, OCR-as-a-sub-step of a target workflow) parks at `awaiting-approval`
  // until the operator approves/discards. See the terminal-phase branch near the
  // end and the 2026-06-06 lesson in `src/workflows/ocr/CLAUDE.md`.
  const completesAfterLookup = !input.parentRunId;

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
    // Mirror the row's own identity into the `ocrSessionId`/`ocrRunId` fields
    // the dashboard's row-cancel proxy reads: the queue-row × on an OCR review
    // row then routes through the DISCARD handler (which unwinds the prep AND
    // mirrors the parent operation row) instead of a generic running-cancel
    // that left the coordinator parked at "awaiting review" forever (E2E-012).
    flat.ocrSessionId = id;
    flat.ocrRunId = runId;
    // OCR inputSubject is "pdf" → queue-row kind "file": title resolves to the
    // PDF filename, subtitle to the trace id (not the literal "OCR").
    flat.queueRowKind = "file";
    flat.__traceId = traceId;
    // Carry the target-workflow operation intent so the approve route can route
    // the fan-out (e.g. an oath-signature PDF run fans signers but no ticket).
    if (input.operationWorkflow) flat.operationWorkflow = input.operationWorkflow;
    // Carry the operator's dry-run choice onto every OCR row — the durable
    // bridge to the approve fan-out: `readDryRun` walks the OCR session's rows
    // (not the operation coordinator's), so without this stamp a dry-run
    // operation fanned out members that performed REAL UCPath saves (E2E-016).
    if (input.dryRun) flat.dryRun = "true";
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

    if (input.rosterMode === "download" || input.rosterMode === "wait") {
      const { requestSharePointDownload } = await import("../sharepoint-download/index.js");
      const { SHAREPOINT_DOWNLOADS } = await import("../sharepoint-download/registry.js");
      const spec0 = SHAREPOINT_DOWNLOADS[0];
      if (!spec0) throw new Error("OCR: no SharePoint download spec registered");
      const childItemId = `ocr-sp-${runId}`;

      if (opts._assertSharepointDispatchUnreached) {
        // Tripwire (tests only): a discard/cancel was supposed to unwind the run
        // BEFORE roster resolution. Reaching here means it didn't — fail loud.
        throw new Error(
          "OCR SharePoint dispatch reached while _assertSharepointDispatchUnreached was set — the run should have unwound before roster resolution",
        );
      }

      log.step(
        `[ocr] ${input.rosterMode === "wait" ? "waiting for queued" : "queueing"} sharepoint-download for "${spec0.label}" (childItemId=${childItemId})`,
      );
      const runSharePoint = opts._requestSharePointDownloadOverride ?? requestSharePointDownload;
      const result = await runSharePoint({
        id: spec0.id,
        mode: input.rosterMode === "wait" ? "wait" : "fresh",
        parentRunId: runId,
        rootTracePrefix: tracePrefix(traceId),
        trackerDir,
        itemId: childItemId,
      });
      resolvedRosterPath = (result.path ?? "").trim();
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
      ? (precomputeRoster(await loadRosterWithRetry(loadRosterFn, resolvedRosterPath)) as OcrRosterRow[])
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
    // these are replaced with real extracted records. The form-specific
    // field skeleton comes from the spec (record shape is set by the RUN,
    // so an EC run must seed EC-shaped placeholders, not oath-shaped ones);
    // specs without the hook keep the oath-shaped default.
    const placeholderRecords: unknown[] = Array.from({ length: knownPageCount }, (_, i) => ({
      formKind: input.formType,
      sourcePage: i + 1,
      notes: [],
      documentType: "expected",
      originallyMissing: [],
      matchState: "lookup-pending",
      matchSource: "manual",
      selected: false,
      warnings: ["Loading… OCR running"],
      ...(spec.placeholderFields?.() ?? {
        rowIndex: 0,
        printedName: "",
        employeeId: "",
        employeeSigned: true,
        officerSigned: null,
        dateSigned: null,
      }),
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
    log.success(`[ocr] OCR complete (provider=${ocrResult.provider}, attempts=${ocrResult.attempts}, records=${(ocrResult.data).length})`);
    // Per-record extraction summary so operator can see exactly what came
    // out of the LLM before any matching/disambiguation runs on top.
    (ocrResult.data as Array<Record<string, unknown>>).forEach((rec, i) => {
      const name = readOcrRecordName(rec) || "(empty)";
      const eid = readOcrRecordEidForLog(rec) || "(none)";
      const date = String(rec.dateSigned ?? "").trim() || "(none)";
      const signed = rec.employeeSigned === true ? "✓" : rec.employeeSigned === false ? "✗" : "?";
      const docType = String(rec.documentType ?? "expected");
      const missing = Array.isArray(rec.originallyMissing) && rec.originallyMissing.length > 0
        ? ` missing=[${(rec.originallyMissing as string[]).join(",")}]`
        : "";
      log.step(`[ocr] record ${i + 1}/${(ocrResult.data).length}: name="${name}" eid=${eid} date=${date} signed=${signed} type=${docType}${missing}`);
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
    emitSnapshot(ocrResult.data, "ocr", "running", {
      rosterPath: resolvedRosterPath,
      ocrProvider: ocrResult.provider,
      ocrAttempts: ocrResult.attempts,
      ocrCached: ocrResult.cached,
      failedPages,
      emptyPages,
      pageStatusSummary,
    });

    // 3. Match
    log.step(`[ocr] matching ${(ocrResult.data).length} OCR record(s) against roster`);
    log.step(`[ocr] roster has ${roster.length} row(s)${resolvedRosterPath ? ` loaded from ${resolvedRosterPath.split("/").pop()}` : " (no roster — rosterMode optional)"}`);
    let records = await raceOcrPrepWithDiscard(
      id,
      runId,
      Promise.all(
        (ocrResult.data).map((r) =>
          spec.matchRecord({ record: r, roster }),
        ),
      ),
    );
    // Per-record match outcome summary.
    records.forEach((r, i) => {
      const rec = r as { matchState?: string; matchSource?: string; matchConfidence?: number; rosterCandidates?: Array<{ score: number }> };
      const conf = typeof rec.matchConfidence === "number" ? ` conf=${rec.matchConfidence.toFixed(2)}` : "";
      const candCount = rec.rosterCandidates?.length ?? 0;
      log.step(`[ocr] match ${i + 1}/${records.length}: state=${rec.matchState} source=${rec.matchSource ?? "(none)"} eid=${readOcrRecordEidForLog(r) || "(none)"}${conf} candidates=${candCount}`);
    });

    // 3a. Second opinion: re-read suspect pages on accuracy-tier models.
    // Suspect = matched nothing in the roster AND no usable EID (see the
    // module helpers above). Roster is the oracle — skipped when none loaded.
    const secondOpinionFn =
      opts._secondOpinionOverride ??
      (async (args: { pageNum: number; excludeModels: string[] }) =>
        runOcrSecondOpinionPage({
          pageImagesDir,
          pageFilename: `page-${String(args.pageNum).padStart(3, "0")}.png`,
          recordSchema: spec.ocrRecordSchema,
          prompt: spec.prompt,
          excludeModels: args.excludeModels,
        }));
    if (roster.length > 0) {
      const suspects = records
        .map((rec, index) => ({ rec, index }))
        .filter(({ rec }) => isSecondOpinionSuspect(rec));
      const cap = secondOpinionCap();
      if (suspects.length > cap) {
        log.warn(`[ocr/second-opinion] ${suspects.length} suspect record(s); re-reading only the first ${cap} (OCR_SECOND_OPINION_MAX)`);
      }
      for (const { rec, index } of suspects.slice(0, cap)) {
        const r = rec as { sourcePage?: number; rowIndex?: number };
        const pageNum = r.sourcePage;
        if (typeof pageNum !== "number") continue;
        const pageInfo = pages.find((p) => p.page === pageNum);
        // poolKeyId is `<provider>-<keyIndex>:<model>`; model ids may contain ":".
        const firstModel = pageInfo?.poolKeyId?.split(":").slice(1).join(":") ?? "";
        const oldName = readOcrRecordName(rec);
        log.step(
          `[ocr/second-opinion] page ${pageNum}: "${oldName}" ${secondOpinionSuspectReason(rec)} — re-reading on a tier-1 model${firstModel ? ` (first read: ${firstModel})` : ""}`,
        );
        const second = await raceOcrPrepWithDiscard(
          id,
          runId,
          secondOpinionFn({ pageNum, excludeModels: firstModel ? [firstModel] : [] }),
        );
        if (!second) continue;
        // Re-anchor the re-read record to this one: same rowIndex when
        // stamped, else only an unambiguous single-record page qualifies.
        const pageRecords = second.records as Array<Record<string, unknown>>;
        const sameRow = pageRecords.filter((c) => (c.rowIndex ?? 0) === (r.rowIndex ?? 0));
        const candidate = sameRow.length === 1 ? sameRow[0] : pageRecords.length === 1 ? pageRecords[0] : undefined;
        if (!candidate) continue;
        const rematched = await spec.matchRecord({ record: { ...candidate, sourcePage: pageNum }, roster });
        const newName = readOcrRecordName(rematched);
        const oldRank = matchOutcomeRank(records[index]);
        if (matchOutcomeRank(rematched) > oldRank) {
          // Positive-identity gate: a rank improvement alone does not prove the
          // re-read is the SAME PERSON. When the ORIGINAL reading still had a
          // usable identity anchor (rank ≥ 2 — roster candidates or a usable
          // EID, e.g. the EC form-EID-off-roster suspect), adopting a re-read
          // whose name shares NO tokens with the original could swap in a
          // DIFFERENT person from the same page (roster-matched ≠ same person).
          // Require name-token overlap in that case; without it, KEEP the
          // original and surface the conflict as a review warning. A rank-1
          // original (matched nothing, no usable EID) has no trustworthy
          // identity to preserve — the roster-anchored re-read IS the identity
          // oracle there — so it adopts on rank alone, still flagged below for
          // operator confirmation.
          if (oldRank >= 2 && !namesShareIdentityToken(oldName, newName)) {
            log.warn(
              `[ocr/second-opinion] page ${pageNum}: re-read "${newName}" ranks better but shares no name tokens with "${oldName}" — NOT adopting (possible different person); flagged for review`,
            );
            pushRecordWarning(
              records[index],
              `Second-opinion re-read of this page produced a different person ("${newName}" vs extracted "${oldName}") — kept the original reading; verify the identity manually.`,
            );
            continue;
          }
          log.success(`[ocr/second-opinion] page ${pageNum}: "${oldName}" → "${newName}" (${second.poolKeyId ?? "tier-1"}) — adopted (roster-anchored)`);
          records[index] = rematched;
          // Make the adoption visible at the review gate — the operator
          // confirms the corrected reading against the page image instead of
          // the substitution happening silently.
          pushRecordWarning(
            records[index],
            `Second-opinion re-read adopted for this page: "${oldName}" → "${newName}" — confirm against the page image.`,
          );
        } else {
          log.step(`[ocr/second-opinion] page ${pageNum}: re-read "${newName}" ranks no better than "${oldName}" — keeping the original`);
        }
      }
    }

    // 3a-bis. Normalize EC contact fields — phones / US state / ZIP by rule, and
    // (only when the rule table misses) relationship + one-line addresses via the
    // shared free-tier LLM pool. Surfaced as review WARNINGS so the operator
    // confirms at the approval gate — never a silent rewrite of UCPath-bound
    // data. EC forms only (oath carries no contact fields). The common case makes
    // rule-only changes and never touches an API key; the pool falls through
    // providers on any rate-limit and degrades to "no change" on exhaustion.
    if (spec.formType === "emergency-contact" || spec.formType === "onbase-emergency-contact") {
      let normalizedCount = 0;
      await raceOcrPrepWithDiscard(
        id,
        runId,
        (async () => {
          for (const rec of records) {
            const changes = await normalizeEmergencyContactRecord(rec as NormalizableEcRecord);
            if (changes.length === 0) continue;
            normalizedCount += 1;
            const warn = summarizeNormalizationChanges(changes);
            if (warn) {
              const r = rec as { warnings?: string[] };
              r.warnings = [...(r.warnings ?? []), warn];
            }
          }
        })(),
      );
      if (normalizedCount > 0) {
        log.step(`[ocr] normalized contact fields on ${normalizedCount}/${records.length} record(s)`);
      }
    }

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
            // A disambiguation FAILURE (LLM/transport error) is NOT the same as
            // "the disambiguator found no confident match" — surface it on the
            // record so the review card shows the identity was NOT auto-resolved
            // due to an error, instead of looking cleanly unresolved. The record
            // still falls through to the name person-lookup below (eid:null keeps
            // it lookup-pending); it just carries a visible warning now (fail
            // loud: the swallowed error is now distinguishable to the operator).
            log.warn(`[ocr] disambiguate failed for record ${t.index}: ${errorMessage(err)}`);
            pushRecordWarning(
              records[t.index],
              `Auto-disambiguation failed (${errorMessage(err)}) — identity not auto-resolved; verify manually.`,
            );
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
              // A suggestion-LLM failure previously left the record with NO
              // lookup hint and NO trace on the record itself. Suggestions are
              // advisory (the extracted name is still used for the name lookup),
              // but a FAILED call must be distinguishable from "no suggestions"
              // — flag it on the record so the reviewer knows the enrichment
              // degraded rather than seeing a cleanly-empty result.
              log.warn(`[ocr] lookup suggestions failed for record ${target.index + 1}: ${errorMessage(err)}`);
              pushRecordWarning(
                records[target.index],
                `Lookup-suggestion enrichment failed (${errorMessage(err)}) — using the extracted name only.`,
              );
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
        const baseItemId = `${ocrChildItemIdPrefix(spec.formType)}-${runId}-r${t.index}`;
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
          //   - Each child is a delegated single row (the default — no
          //     `renderAs`): the child row stamp is `single`, parentRunId marks
          //     it delegated, and one vs many children controls single vs batch
          //     grouping.
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
          // Collision-safe, fail-loud itemId resolution — mirrors the fixed
          // sibling `buildFanOutItemIdResolver` (src/tracker/dashboard/ocr/approve.ts).
          // `inputs` is built in the SAME order as `eidLookupEnqueueItems`, so
          // this keys each logical input's JSON to a FIFO queue of itemIds:
          // two records that share an extracted name/EID keep DISTINCT itemIds
          // (positional, not first-match-wins) instead of collapsing onto one
          // queue row, and a genuine miss throws instead of handing the
          // unmatched record the same fabricated `ocr-fallback-…-r0` id (which
          // silently hung the OTHER row to its watch timeout).
          const deriveChildItemId = buildEidLookupItemIdResolver(
            inputs,
            eidLookupEnqueueItems.map((e) => e.itemId),
          );
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
              return extras;
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
        }),
      );
      enriched.forEach((r, i) => {
        records[i] = r;
      });
    }

    // 5. Terminal phase. There is no longer a synthetic `verification` marker
    // step — person-lookup OWNS verification now (it runs the enrichment/lookups
    // whose outcomes patch each record), so the pipeline ends at person-lookup.
    const verifiedCount = countVerified(records);

    // COMPLETES `done` after person-lookup — no parked review. ALL standalone
    // runs (oath / emergency-contact / verify) complete here; only DELEGATED
    // runs (parentRunId set) reach the awaiting-approval branch below. The
    // Approve button is UI-gated on parentRunId, so a standalone run can never
    // be approved. The operator reads a read-only completeness card on the
    // terminal `done` row. A failed lookup's per-record ↻ re-opens this done
    // row (see verify-relookup.ts). The handler seeds this payload onto the
    // kernel's terminal `done` so it stays a preview row.
    // Fail loud on a zero-record extraction rather than emitting a terminal
    // SUCCESS the operator can't act on. A STANDALONE run completes `done` with
    // a READ-ONLY card (no manual-fill / per-page retry / discard affordances —
    // those are delegated-run only), so a `done` card with zero records is a
    // misleading "success" that hides an extraction which produced nothing
    // (wrong file, total OCR failure, blank scan). A DELEGATED run is NOT failed
    // here: it parks at awaiting-approval where per-page retry / manual-fill /
    // discard let the operator recover.
    if (completesAfterLookup && records.length === 0) {
      throw new Error(
        `[ocr] extraction produced zero records for "${input.pdfOriginalName}" (formType=${input.formType}, sessionId=${id}) — refusing to complete a standalone prep with nothing to review`,
      );
    }

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
      // The prepare-abort flag was tripped by a generic run cancel (`ctx.signal`)
      // via the entry bridge, NOT by an operator discard. Let it propagate so the
      // daemon's cancel machinery (`mapEscapedHandlerError`, on a cancel-requested
      // run) maps it to a `CancelledError` + `step:"cancelled"` terminal row — the
      // standalone-prep analogue of the delegated path's `subscribeToApproval`
      // cancel. A real UI discard leaves `ctx.signal` un-aborted and still returns
      // `discarded` (its own route owns the terminal `failed step=discarded` row).
      if (opts.signal?.aborted) throw err;
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

const ROSTER_LOAD_MAX_ATTEMPTS = 3;
const ROSTER_LOAD_TIMEOUT_MS = 60_000;
const ROSTER_LOAD_RETRY_BACKOFF_MS = 500;

/**
 * Load the roster with a bounded retry + per-attempt timeout. The roster xlsx
 * can be TRANSIENTLY unreadable (a SharePoint download still flushing to disk,
 * a filesystem hiccup) — RETRYING the SAME read is not a silent fallback (no
 * value is substituted), so it is allowed under the fail-loud rule. `withTimeout`
 * bounds a hung read so it can never block the prep forever, and after every
 * attempt fails we THROW loud naming the roster path — matching against an
 * empty/partial roster (silently returning `[]`) would mis-classify every
 * record as unmatched, so we never continue on failure.
 */
async function loadRosterWithRetry(
  loadRosterFn: (path: string) => Promise<MatchRosterRow[]>,
  rosterPath: string,
): Promise<MatchRosterRow[]> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= ROSTER_LOAD_MAX_ATTEMPTS; attempt++) {
    try {
      return await withTimeout(
        loadRosterFn(rosterPath),
        ROSTER_LOAD_TIMEOUT_MS,
        `ocr roster load (${rosterPath})`,
      );
    } catch (err) {
      lastErr = err;
      log.warn(
        `[ocr] roster load attempt ${attempt}/${ROSTER_LOAD_MAX_ATTEMPTS} failed for ${rosterPath}: ${errorMessage(err)}`,
      );
      if (attempt < ROSTER_LOAD_MAX_ATTEMPTS) {
        await new Promise((resolve) => setTimeout(resolve, ROSTER_LOAD_RETRY_BACKOFF_MS * attempt));
      }
    }
  }
  throw new Error(
    `[ocr] failed to load roster from ${rosterPath} after ${ROSTER_LOAD_MAX_ATTEMPTS} attempts — refusing to run matching against a missing/partial roster: ${errorMessage(lastErr)}`,
  );
}

/** Append an operator-facing warning to a record's `warnings[]` (creates it if absent). */
function pushRecordWarning(rec: unknown, warning: string): void {
  const r = rec as { warnings?: string[] };
  r.warnings = [...(r.warnings ?? []), warning];
}


/**
 * The trace-id code for an OCR run, derived from the target-workflow operation
 * intent so the trace PREFIX disambiguates the operation that owns the run
 * (oath-signature `os-…` vs oath-upload `ou-…` — previously both branded `ou-…`
 * off the shared oath form spec, the operator-confusing collision). Each value
 * MUST match that operation workflow's own `defineWorkflow` code; the
 * `workflow codes are unique` architecture guard keeps those collision-free.
 * Returns undefined for a standalone OCR-hub run (no `operationWorkflow`) so the
 * caller falls back to the form spec's `traceCode` (only verify sets one, "vf")
 * or the OCR default "oc" — standalone oath/EC brand `oc-…` (E2E-007).
 */
export function operationTraceCode(operationWorkflow: string | undefined): string | undefined {
  switch (operationWorkflow) {
    case "oath-signature": return "os";
    case "oath-upload": return "ou";
    case "emergency-contact": return "ec";
    case "onbase": return "ob";
    default: return undefined;
  }
}

/**
 * Build the `deriveItemId` resolver for the OCR eid-lookup (person-lookup)
 * fan-out. Mirrors `buildFanOutItemIdResolver`
 * (src/tracker/dashboard/ocr/approve.ts): keyed by the JSON of each LOGICAL
 * input, in the SAME order as the `itemIds` it was built from — two records
 * with identical logical input (a shared extracted name/EID) still receive
 * their OWN itemId (a per-key FIFO queue, consumed in enqueue order) instead
 * of collapsing onto the first match. A miss THROWS instead of returning a
 * fabricated `ocr-fallback-…` id — the old fallback handed every unmatched
 * record the SAME id, collapsing distinct people into one queue row and
 * hanging the other row to its watch timeout.
 */
export function buildEidLookupItemIdResolver(
  logicalInputs: readonly unknown[],
  itemIds: readonly string[],
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
        `ocr eid-lookup fan-out: deriveItemId lookup missed for a person-lookup input — ` +
          `${logicalInputs.length} inputs were keyed`,
      );
    }
    return itemId;
  };
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
          // This runs OFF the awaited stack (a timer callback). `emitSnapshot`
          // → `writeTracker` THROWS `createOperatorDiscardError()` when a
          // discard was requested — an off-stack throw here becomes an unhandled
          // rejection that vanishes (or crashes the process) instead of
          // unwinding the prep. The main awaited path already polls the abort
          // flag on every `raceOcrPrepWithDiscard` / on-stack `writeTracker` and
          // owns the discard unwind, so here we just SKIP the best-effort
          // progress emit when an abort is pending, and never let any other emit
          // error escape the timer (the authoritative emit follows on-stack).
          if (isOcrPrepareAbortRequested(id, runId)) return;
          try {
            emitSnapshot(records, kind, "running", { failedPages, emptyPages, pageStatusSummary });
          } catch (err) {
            log.warn(
              `[ocr] debounced progress snapshot failed (non-fatal; authoritative emit follows on the awaited path): ${errorMessage(err)}`,
            );
          }
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
  let parsed: unknown;
  try {
    parsed = JSON.parse(latest.data.records);
  } catch (err) {
    // A present-but-unparseable carry-forward payload is NOT the same as "no
    // prior run" — silently falling back to [] here would discard every prior
    // human OCR correction with no trace. Fail loud so it gets fixed at the
    // source instead of the operator losing their edits unknowingly.
    throw new Error(
      `[ocr] carry-forward: previous run (sessionId=${sessionId} previousRunId=${previousRunId}) has unparseable data.records — refusing to silently drop prior human corrections: ${errorMessage(err)}`,
    );
  }
  if (!Array.isArray(parsed)) {
    throw new Error(
      `[ocr] carry-forward: previous run (sessionId=${sessionId} previousRunId=${previousRunId}) data.records is not an array (got ${typeof parsed}) — refusing to silently drop prior human corrections`,
    );
  }
  return parsed;
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

/**
 * Positive-identity check for second-opinion adoption: true when the two name
 * readings share at least one substantive token (length ≥ 2 — single-letter
 * initials are too weak to anchor identity). Both readings come off the SAME
 * page/row, so a genuine re-read of the same person virtually always keeps
 * some name part ("Merrell, Carlos D" ↔ "Barahona Martell, Carlos D" share
 * "carlos"); zero overlap is the signature of the model reading a DIFFERENT
 * person/row. Exported for the orchestrator unit tests.
 */
export function namesShareIdentityToken(a: string, b: string): boolean {
  const tokensA = new Set(nameTokens(a).filter((t) => t.length >= 2));
  if (tokensA.size === 0) return false;
  return nameTokens(b).some((t) => t.length >= 2 && tokensA.has(t));
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
