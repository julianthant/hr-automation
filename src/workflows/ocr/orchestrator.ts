/**
 * OCR orchestrator. Generic over form-type via OcrFormSpec. Replaces the
 * duplicated runPaperOathPrepare + runPrepare in oath-signature/prepare.ts
 * and emergency-contact/prepare.ts.
 *
 * Phases (each emits a tracker `running` event with `step` set):
 *   loading-roster → ocr → matching → disambiguating → eid-lookup → verification → awaiting-approval
 *
 * Returns when the row reaches `awaiting-approval`. The user's approve /
 * discard / reupload click is handled via separate HTTP endpoints.
 */
import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { ZodType } from "zod/v4";
import { loadRoster as realLoadRoster } from "../../services/matching/index.js";
import type { RosterRow as MatchRosterRow } from "../../services/matching/match.js";
import { watchChildRuns as realWatchChildRuns, type ChildOutcome, type WatchChildRunsOpts } from "../../tracker/delegation/watch-child-runs.js";
import { trackEvent, dateLocal, type TrackerEntry } from "../../tracker/jsonl.js";
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
} from "./eid-lookup-results.js";
import type { AnyOcrFormSpec, RosterRow as OcrRosterRow } from "./types.js";
import type { OcrInput } from "./schema.js";
import { runOcrPipeline } from "../../services/ocr/pipeline.js";
import type { LookupSuggestion } from "../../services/ocr/lookup-suggestions.js";
import { normalizeUcpathEmployeeId } from "../../domain/identity/eid.js";
import { toLastFirstSearchName } from "../../domain/identity/person-name.js";
import { buildHttpPendingData } from "../../core/daemon/enqueue-dispatch.js";

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
  }>;
}

export interface OcrOrchestratorOpts {
  /** runId for this execution. Required — caller (HTTP or kernel handler) supplies. */
  runId: string;
  /** Tracker directory override. Default: process.env.TRACKER_DIR or .tracker. */
  trackerDir?: string;
  /** Date override (YYYY-MM-DD). Default: today. */
  date?: string;
  /** Hard timeout for eid-lookup phase. Default 1h. */
  eidLookupTimeoutMs?: number;

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
      originWorkflow?: string;
      taskGroupId?: string;
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
      workflow: "eid-lookup";
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

export async function runOcrOrchestrator(
  input: OcrInput,
  opts: OcrOrchestratorOpts,
): Promise<void> {
  const spec = getFormSpec(input.formType);
  if (!spec) {
    throw new Error(`OCR: unknown formType "${input.formType}"`);
  }
  const trackerDir = opts.trackerDir;
  const date = opts.date ?? dateLocal();
  const id = input.sessionId;
  const runId = opts.runId;
  const emit =
    opts._emitOverride ??
    ((entry: TrackerEntry) => trackEvent(entry, trackerDir));
  const loadRosterFn = opts._loadRosterOverride ?? realLoadRoster;
  const watchChildren = opts._watchChildRunsOverride ?? realWatchChildRuns;
  const trackerBaseDir = trackerDir ?? ".tracker";
  const legacyPageImagesDir = join(trackerBaseDir, "page-images", input.sessionId);
  let pageImagesDir = legacyPageImagesDir;
  let pageImagePad = 2;

  if (input.pdfFileId) {
    try {
      const { isStateDbReady } = await import("../../tracker/state/db.js");
      if (isStateDbReady(trackerBaseDir)) {
        pageImagesDir = join(trackerBaseDir, "pdf-cache", input.pdfFileId);
        pageImagePad = 3;
      }
    } catch {
      pageImagesDir = legacyPageImagesDir;
      pageImagePad = 2;
    }
  }

  const runOcr = opts._ocrPipelineOverride ?? (async ({ pdfPath, spec: s, preRenderedPages }: { pdfPath: string; formType: string; spec: AnyOcrFormSpec; sessionId: string; preRenderedPages?: string[] }) => {
    const result = await runOcrPipeline({
      pdfPath,
      pageImagesDir,
      recordSchema: s.ocrRecordSchema as ZodType<unknown>,
      arraySchema: s.ocrArraySchema as ZodType<unknown[]>,
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

  const writeTracker = (
    status: TrackerEntry["status"],
    data: Record<string, unknown>,
    step?: string,
    error?: string,
  ): void => {
    // Stamp __id so the dashboard's resolveEntryId surfaces a stable handle
    // on every row. Kernel runWorkflow computes this via getId; this
    // orchestrator writes via trackEvent directly so we replicate it here.
    // Stamp __name = "OCR" too, because cross-workflow injection now
    // surfaces these rows in oath-signature / emergency-contact queues
    // where the workflow-label fallback in `buildDisplayNameMap` would
    // otherwise label them with the downstream workflow's name. Hardcoding
    // "OCR" keeps the row labeled "OCR 1" / "OCR 2" no matter which queue
    // surfaces it.
    // mode: "prepare" makes the dashboard render this row with the
    // preview-tab affordance (gated on workflow === "ocr").
    const flat = flattenForData({
      ...data,
      ...(input.pdfFileId ? { pdfFileId: input.pdfFileId } : {}),
      mode: "prepare",
    });
    flat.__id = input.sessionId ?? "";
    flat.__name = "OCR";
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
          { itemId: childItemId },
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
      });
      const result = outcomes[0];
      if (!result || result.status !== "done") {
        throw new Error(`SharePoint download failed: ${result?.error ?? "unknown error"}`);
      }
      resolvedRosterPath = (result.data?.path ?? "").trim();
      if (!resolvedRosterPath) throw new Error("SharePoint download finished without saving a path");
      log.success(`[ocr] roster downloaded: ${resolvedRosterPath}`);
    }

    if (!resolvedRosterPath) {
      throw new Error("OCR: no roster path resolved");
    }
    const roster = (await loadRosterFn(resolvedRosterPath)) as OcrRosterRow[];

    // 1b. Pre-render PDF pages so we know page count + can show the page
    // image in the Preview tab before OCR finishes.
    log.step(`[ocr] pre-rendering PDF pages so the Preview tab populates immediately`);
    const { renderPdfPagesToPngs } = await import("../../services/ocr/render-pages.js");
    let preRenderedPages: string[];
    if (input.pdfFileId && pageImagePad === 3) {
      try {
        const { openStateDb } = await import("../../tracker/state/db.js");
        const { ensurePdfPageCache } = await import("../../tracker/files/pdf-cache.js");
        const cachedPages = await ensurePdfPageCache(openStateDb(trackerBaseDir), {
          trackerDir: trackerBaseDir,
          fileId: input.pdfFileId,
          pdfPath: input.pdfPath,
        });
        preRenderedPages = cachedPages
          .filter((page) => page.status === "ready" && page.imagePath)
          .map((page) => basename(page.imagePath!));
      } catch (err) {
        log.warn(`[ocr] PDF file cache unavailable, falling back to legacy page images: ${errorMessage(err)}`);
        pageImagesDir = legacyPageImagesDir;
        pageImagePad = 2;
        preRenderedPages = await renderPdfPagesToPngs(input.pdfPath, pageImagesDir);
      }
    } else {
      preRenderedPages = await renderPdfPagesToPngs(input.pdfPath, pageImagesDir);
    }
    const knownPageCount = preRenderedPages.length;
    log.success(`[ocr] rendered ${knownPageCount} page(s) — Preview tab now shows blank inputs ready to fill in`);

    // Snapshot helper: emits an awaiting-approval-shape entry with the
    // current `records` array. Called at every phase transition so the
    // Preview tab updates progressively as OCR / matching / disambig /
    // eid-lookup / verification each complete.
    const emitSnapshot = (
      records: unknown[],
      step: string,
      status: TrackerEntry["status"],
      extras: Record<string, unknown> = {},
    ): void => {
      const verifiedCount = countVerified(records);
      writeTracker(status, {
        formType: input.formType,
        pdfOriginalName: input.pdfOriginalName,
        sessionId: input.sessionId,
        pageImagesDir,
        ...(input.parentRunId ? { parentRunId: input.parentRunId } : {}),
        recordCount: records.length,
        verifiedCount,
        records,
        ...extras,
      }, step);
    };

    // Seed the Preview tab with one blank record per page so the operator
    // sees the page image + empty inputs immediately. As OCR finishes,
    // these are replaced with real extracted records.
    const placeholderRecords: unknown[] = Array.from({ length: knownPageCount }, (_, i) => ({
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
    const ocrResult = await runOcr({
      pdfPath: input.pdfPath,
      formType: input.formType,
      spec,
      sessionId: input.sessionId,
      preRenderedPages,
    });
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
        pageImagePath: join(pageImagesDir, `page-${String(p.page).padStart(pageImagePad, "0")}.png`),
        attempts: 1,
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
    emitSnapshot(ocrResult.data as unknown[], "matching", "running", {
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
    log.step(`[ocr] roster has ${roster.length} row(s) loaded from ${resolvedRosterPath.split("/").pop()}`);
    let records = await Promise.all(
      (ocrResult.data as unknown[]).map((r) =>
        spec.matchRecord({ record: r, roster }),
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
    emitSnapshot(records, "disambiguating", "running", {
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
      emitSnapshot(records, "disambiguating", "running", { failedPages, emptyPages, pageStatusSummary });

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
              query: t.rec.printedName ?? "",
              candidates: t.rec.rosterCandidates!.slice(0, 5),
            });
          } catch (err) {
            log.warn(`[ocr] disambiguate failed for record ${t.index}: ${errorMessage(err)}`);
            results[i] = { eid: null, confidence: 0 };
          }
        }
      });
      await Promise.all(workers);

      disambigTargets.forEach((t, i) => {
        records[t.index] = spec.applyDisambiguation({
          record: records[t.index] as never,
          result: results[i],
        });
      });
    } else {
      log.step(`[ocr] disambiguating skipped — 0 ambiguous records (all ${records.length} either matched, manual, or no candidates above 0.40)`);
      emitSnapshot(records, "disambiguating", "running", { failedPages, emptyPages, pageStatusSummary });
    }

    const suggestionTargets: Array<{ index: number; rec: unknown }> = [];
    records.forEach((rec, index) => {
      const kind = spec.needsLookup(rec as never);
      if (kind !== "name") return;
      const r = rec as { rosterCandidates?: unknown[] };
      if (Array.isArray(r.rosterCandidates) && r.rosterCandidates.length > 0) return;
      if (!extractName(rec, spec).trim()) return;
      suggestionTargets.push({ index, rec });
    });

    const lookupSuggestionsByIndex = new Map<number, LookupSuggestion[]>();
    if (suggestionTargets.length > 0) {
      log.step(`[ocr] asking LLM for lookup suggestions for ${suggestionTargets.length} record(s) with no fuzzy roster candidates`);
      const { suggestLookupCandidates } = await import("../../services/ocr/lookup-suggestions.js");
      await Promise.all(suggestionTargets.map(async (target) => {
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
      }));
    }

    // 4. EID lookup fan-out — UCPath + CRM name resolution and active / HDH disposition.
    // "name"        → lookup by printed name (CRM cross-verify path)
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
        if (kind === "name" && !extractName(rec, spec).trim()) return;
        if ((kind === "verify" || kind === "verify-only") && !extractEid(rec).trim()) return;
        if (kind === "name") {
          const suggestions = lookupSuggestionsByIndex.get(index) ?? [];
          const seenNames = new Set<string>();
          const addNameTarget = (name: string): void => {
            const normalized = name.trim();
            if (!normalized) return;
            const key = normalized.toLowerCase();
            if (seenNames.has(key)) return;
            seenNames.add(key);
            lookupTargets.push({ rec, index, kind, name: normalized });
          };
          for (const suggestion of suggestions) {
            if (suggestion.name) addNameTarget(formatLookupName(suggestion.name));
            const suggestionEid = normalizeUcpathEmployeeId(suggestion.emplId);
            if (suggestionEid) {
              lookupTargets.push({ rec, index, kind: "verify-only", eid: suggestionEid });
            }
          }
          addNameTarget(formatLookupName(extractName(rec, spec)));
        } else {
          lookupTargets.push({ rec, index, kind });
        }
      }
    });

    if (lookupTargets.length > 0) {
      log.step(`[ocr] enqueuing ${lookupTargets.length} eid-lookup(s) for unmatched/verify-needed records (skipped ${records.length - countTargetRecords(lookupTargets)} record(s) — already resolved, no name/EID, or manual)`);
      lookupTargets.forEach((t) => {
        const inputDesc =
          t.kind === "name" ? `name="${targetName(t, spec)}"` : `eid=${t.eid ?? extractEid(t.rec)}`;
        log.step(`[ocr] lookup target rec ${t.index + 1}: kind=${t.kind} ${inputDesc}`);
      });
      // Snapshot WITH records so the Preview keeps showing the matched
      // rows while eid-lookup fans out in the background.
      emitSnapshot(records, "eid-lookup", "running", { failedPages, emptyPages, pageStatusSummary });

      const lookupTargetsByRecord = countTargetsByRecord(lookupTargets);
      const eidLookupEnqueueItems = lookupTargets.map((t, ordinal) => {
        const baseItemId = `ocr-${spec.formType === "oath" ? "oath" : "ec"}-${runId}-r${t.index}`;
        const itemId = lookupTargetsByRecord.get(t.index)! > 1 ? `${baseItemId}-n${ordinal}` : baseItemId;
        return { record: t.rec, index: t.index, kind: t.kind, name: t.name, eid: t.eid, itemId };
      });
      const eidLookupSqliteDepsEnabled =
        process.env.OCR_SQLITE_DEPENDENCIES !== "0" && !opts._disableSqliteDependencies;

      await runFanOutPhase({
        kind: "eid-lookup",
        enqueueItems: eidLookupEnqueueItems,
        createDependencyBatch: async (children) => {
          const parent = { workflow: "ocr" as const, itemId: id, runId, formType: spec.formType };
          if (opts._createDependencyBatchOverride) {
            await opts._createDependencyBatchOverride({ parent, children: children as never });
          } else {
            createOcrEidLookupDependencyBatch({ trackerDir, parent, children: children as never });
          }
        },
        buildChild: (itemId, childRunId, item) => ({
          workflow: "eid-lookup",
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
                  taskRole: "child",
                  originWorkflow: "ocr",
                  taskGroupId: input.sessionId,
                })),
              );
            }
          : undefined,
        preEmitPendingForOverride: async () => {
          const { eidLookupCrmWorkflow } = await import("../eid-lookup/index.js");
          for (const e of eidLookupEnqueueItems) {
            const item = e.kind === "name"
              ? {
                  name: targetName(e, spec),
                  taskRole: "child",
                  originWorkflow: "ocr",
                  taskGroupId: input.sessionId,
                }
              : {
                  emplId: lookupEnqueueEmplId(e),
                  keepNonHdh: true,
                  taskRole: "child",
                  originWorkflow: "ocr",
                  taskGroupId: input.sessionId,
                };
            trackEvent({
              workflow: eidLookupCrmWorkflow.config.name,
              timestamp: new Date().toISOString(),
              id: e.itemId,
              runId: `override-${e.itemId}`,
              status: "pending",
              data: buildHttpPendingData(eidLookupCrmWorkflow, item),
              parentRunId: runId,
              input: item,
            }, trackerDir);
          }
        },
        realEnqueue: async (onPreparedItems) => {
          const { ensureDaemonsAndEnqueue } = await import("../../core/daemon/client.js");
          const { eidLookupCrmWorkflow } = await import("../eid-lookup/index.js");
          const inputs = eidLookupEnqueueItems.map((e) =>
            e.kind === "name"
              ? {
                  name: targetName(e, spec),
                  taskRole: "child",
                  originWorkflow: "ocr",
                  taskGroupId: input.sessionId,
                }
              : {
                  emplId: lookupEnqueueEmplId(e),
                  keepNonHdh: true,
                  taskRole: "child",
                  originWorkflow: "ocr",
                  taskGroupId: input.sessionId,
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
          await ensureDaemonsAndEnqueue(
            eidLookupCrmWorkflow,
            inputs as never,
            {},
            {
              deriveItemId: deriveChildItemId,
              parentRunId: runId,
              onPreparedItems,
              onPreEmitPending: (item, childRunId, passedParentRunId, itemId) => {
                trackEvent({
                  workflow: eidLookupCrmWorkflow.config.name,
                  timestamp: new Date().toISOString(),
                  id: itemId,
                  runId: childRunId,
                  status: "pending",
                  data: buildHttpPendingData(eidLookupCrmWorkflow, item),
                  ...(passedParentRunId ? { parentRunId: passedParentRunId } : {}),
                  input: item as Record<string, unknown>,
                }, trackerDir);
              },
            },
          );
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

    // 5. Verification marker (synthetic — actual verification happens
    // asynchronously inside the eid-lookup daemon). We emit the breakdown
    // of currently-known verifications so the operator can see what state
    // each record is in right now (more rows may verify in the background
    // as eid-lookup outcomes arrive).
    const verifiedCount = countVerified(records);
    const verifiedBreakdown: Record<string, number> = {};
    records.forEach((r) => {
      const v = (r as { verification?: { state?: string } }).verification;
      const state = v?.state ?? "unverified";
      verifiedBreakdown[state] = (verifiedBreakdown[state] ?? 0) + 1;
    });
    const breakdownStr = Object.entries(verifiedBreakdown).map(([k, n]) => `${k}=${n}`).join(" ");
    log.step(`[ocr] verification: ${verifiedCount}/${records.length} records verified now — breakdown: ${breakdownStr} (more may verify in background as eid-lookup completes)`);
    emitSnapshot(records, "verification", "running", {
      failedPages,
      emptyPages,
      pageStatusSummary,
    });

    // 6. Awaiting-approval — workflow returns here even if eid-lookup is
    // still running in the background. The operator can start reviewing
    // immediately; lookup outcomes will patch records into this row's
    // tracker entries as they arrive.
    log.success(`[ocr] preparation complete — awaiting operator approval (${records.length} record(s), ${verifiedCount} verified now)`);
    emitSnapshot(records, "awaiting-approval", "running", {
      failedPages,
      emptyPages,
      pageStatusSummary,
    });
    emitSnapshot(records, "awaiting-approval", "done", {
      failedPages,
      emptyPages,
      pageStatusSummary,
    });
  } catch (err) {
    writeTracker("failed", { formType: input.formType, sessionId: input.sessionId }, undefined, errorMessage(err));
    throw err;
  }
}

// ─── Helpers (private) ──────────────────────────────────────

interface FanOutChildSpec {
  workflow: "eid-lookup";
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
  kind: "eid-lookup";
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

  const waitForChildRuns = async (): Promise<void> => {
    const progressed = new Set<string>();
    const outcomes = await watchChildren({
      workflow: kind,
      expectedItemIds: enqueueItems.map((e) => e.itemId),
      trackerDir,
      date,
      timeoutMs: eidLookupTimeoutMs ?? 60 * 60_000,
      onProgress: (outcome, remaining) => {
        const enq = enqueueItems.find((e) => e.itemId === outcome.itemId);
        if (!enq) return;
        progressed.add(outcome.itemId);
        patchRecord(records, enq.index, outcome, enq.kind);
        log.step(`[ocr] ${kind} outcome for rec ${enq.index + 1}: kind=${enq.kind} status=${outcome.status} → record patched (${remaining} remaining)`);
        emitSnapshot(records, kind, "running", {
          failedPages,
          emptyPages,
          pageStatusSummary,
        });
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

function flattenForData(d: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(d)) {
    if (v === undefined || v === null) continue;
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
      out[k] = String(v);
    } else {
      try { out[k] = JSON.stringify(v); } catch { out[k] = String(v); }
    }
  }
  return out;
}

function readPreviousRecords(
  sessionId: string,
  previousRunId: string,
  trackerDir: string | undefined,
  date: string,
): unknown[] {
  const file = join(trackerDir ?? ".tracker", `ocr-${date}.jsonl`);
  if (!existsSync(file)) return [];
  const raw = readFileSync(file, "utf-8");
  const lines = raw.split("\n").filter(Boolean);
  let latest: TrackerEntry | undefined;
  for (const line of lines) {
    try {
      const entry: TrackerEntry = JSON.parse(line);
      if (entry.id === sessionId && entry.runId === previousRunId) {
        latest = entry;
      }
    } catch { /* tolerate */ }
  }
  if (!latest?.data?.records) return [];
  try {
    const parsed = JSON.parse(latest.data.records as unknown as string);
    if (Array.isArray(parsed)) return parsed;
  } catch { /* tolerate */ }
  return [];
}

function lookupEnqueueEmplId(target: { record: unknown; eid?: string }): string {
  return target.eid ?? extractEid(target.record);
}

function targetName(target: { record?: unknown; rec?: unknown; name?: string }, spec: AnyOcrFormSpec): string {
  return target.name ?? extractName(target.record ?? target.rec, spec);
}

function formatLookupName(raw: string): string {
  return toLastFirstSearchName(raw) || raw.trim();
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

function extractName(record: unknown, spec: AnyOcrFormSpec): string {
  return spec.carryForwardKey(record as never);
}

function extractEid(record: unknown): string {
  const r = record as Record<string, unknown>;
  if (typeof r.employeeId === "string") return normalizeUcpathEmployeeId(r.employeeId);
  const employee = r.employee as Record<string, unknown> | undefined;
  if (employee && typeof employee.employeeId === "string") return normalizeUcpathEmployeeId(employee.employeeId);
  return "";
}

function countVerified(records: unknown[]): number {
  let n = 0;
  for (const r of records) {
    const v = (r as Record<string, unknown>).verification as { state?: string } | undefined;
    if (v?.state === "verified") n++;
  }
  return n;
}
