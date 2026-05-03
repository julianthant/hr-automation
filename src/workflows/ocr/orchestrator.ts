/**
 * OCR orchestrator. Generic over form-type via OcrFormSpec. Replaces the
 * duplicated runPaperOathPrepare + runPrepare in oath-signature/prepare.ts
 * and emergency-contact/prepare.ts.
 *
 * Phases (each emits a tracker `running` event with `step` set):
 *   loading-roster → ocr → matching → eid-lookup → verification → awaiting-approval
 *
 * Returns when the row reaches `awaiting-approval`. The user's approve /
 * discard / reupload click is handled via separate HTTP endpoints.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ZodType } from "zod/v4";
import { loadRoster as realLoadRoster } from "../../match/index.js";
import type { RosterRow as MatchRosterRow } from "../../match/match.js";
import { watchChildRuns as realWatchChildRuns, type ChildOutcome, type WatchChildRunsOpts } from "../../tracker/watch-child-runs.js";
import { trackEvent, dateLocal, type TrackerEntry } from "../../tracker/jsonl.js";
import { errorMessage } from "../../utils/errors.js";
import { log } from "../../utils/log.js";
import { isAcceptedDept } from "../eid-lookup/search.js";
import { getFormSpec } from "./form-registry.js";
import { applyCarryForward } from "./carry-forward.js";
import type { AnyOcrFormSpec, RosterRow as OcrRosterRow } from "./types.js";
import type { OcrInput } from "./schema.js";
import { runOcrPipeline } from "../../ocr/pipeline.js";

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
    items: Array<{ name?: string; emplId?: string; itemId: string }>,
  ) => Promise<void>;
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

  const runOcr = opts._ocrPipelineOverride ?? (async ({ pdfPath, spec: s, sessionId, preRenderedPages }: { pdfPath: string; formType: string; spec: AnyOcrFormSpec; sessionId: string; preRenderedPages?: string[] }) => {
    // Page images go to .tracker/page-images/<sessionId>/ — sessionId is
    // the stable key the OCR HTTP layer mints when the operator uploads
    // the PDF. PdfPagePreview passes this value; do NOT use runId here
    // (the dashboard would have nothing to look up against).
    const pageImagesDir = join(trackerDir ?? ".tracker", "page-images", sessionId);
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
    // orchestrator writes via trackEvent directly so we replicate it here,
    // sourced from the closed-over input (not the per-emit data dict, which
    // only carries the fields each phase changes). __name is intentionally
    // not stamped — the dashboard derives the queue-row label as
    // "<workflow label> <ordinal>" so OCR rows render as "OCR 1", "OCR 2".
    // mode: "prepare" makes the dashboard render this row as OcrQueueRow
    // (clickable to open OcrReviewPane) instead of a plain EntryItem.
    const flat = flattenForData({ ...data, mode: "prepare" });
    flat.__id = input.sessionId ?? "";
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
    const pageImagesDir = join(trackerDir ?? ".tracker", "page-images", input.sessionId);
    const { renderPdfPagesToPngs } = await import("../../ocr/render-pages.js");
    const preRenderedPages = await renderPdfPagesToPngs(input.pdfPath, pageImagesDir);
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
      const verifiedCount = countVerified(records, spec);
      writeTracker(status, {
        formType: input.formType,
        pdfOriginalName: input.pdfOriginalName,
        sessionId: input.sessionId,
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
        pageImagePath: join(
          trackerDir ?? ".tracker",
          "page-images",
          input.sessionId,
          `page-${String(p.page).padStart(2, "0")}.png`,
        ),
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
      writeTracker("running", { recordCount: records.length, ambiguousCount: disambigTargets.length }, "disambiguating");

      const { disambiguateMatch } = await import("../../ocr/disambiguate.js");
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
      writeTracker("running", { recordCount: records.length, ambiguousCount: 0 }, "disambiguating");
    }

    // 4. Eid-lookup fan-out + watch
    // "name"        → lookup by printed name (CRM cross-verify path)
    // "verify"      → lookup by roster-derived EID (verify it's active in HDH)
    // "verify-only" → lookup by form-extracted EID (same as verify, different provenance)
    const lookupTargets: Array<{ rec: unknown; index: number; kind: "name" | "verify" | "verify-only" }> = [];
    records.forEach((rec, index) => {
      const kind = spec.needsLookup(rec);
      if (kind === "name" || kind === "verify" || kind === "verify-only") {
        // Defense: skip records that lack the input the dispatch needs (an
        // empty name would fail eid-lookup's name.min(1) schema). The spec's
        // needsLookup should already filter these out — this is a backstop.
        if (kind === "name" && !extractName(rec, spec).trim()) return;
        if ((kind === "verify" || kind === "verify-only") && !extractEid(rec, spec).trim()) return;
        lookupTargets.push({ rec, index, kind });
      }
    });

    if (lookupTargets.length > 0) {
      log.step(`[ocr] enqueuing ${lookupTargets.length} eid-lookup(s) for unmatched/verify-needed records (skipped ${records.length - lookupTargets.length} — already resolved, no name/EID, or manual)`);
      lookupTargets.forEach((t) => {
        const inputDesc = t.kind === "name" ? `name="${extractName(t.rec, spec)}"` : `eid=${extractEid(t.rec, spec)}`;
        log.step(`[ocr] lookup target rec ${t.index + 1}: kind=${t.kind} ${inputDesc}`);
      });
      writeTracker("running", { recordCount: records.length, pendingLookup: lookupTargets.length }, "eid-lookup");

      const enqueueItems = lookupTargets.map((t) => {
        const itemId = `ocr-${spec.formType === "oath" ? "oath" : "ec"}-${runId}-r${t.index}`;
        return { record: t.rec, index: t.index, kind: t.kind, itemId };
      });

      if (opts._enqueueEidLookupOverride) {
        await opts._enqueueEidLookupOverride(
          enqueueItems.map((e) => ({
            ...(e.kind === "name"
              ? { name: extractName(e.record, spec) }
              : { emplId: extractEid(e.record, spec) }),
            itemId: e.itemId,
          })),
        );
      } else {
        const { ensureDaemonsAndEnqueue } = await import("../../core/daemon-client.js");
        const { eidLookupCrmWorkflow } = await import("../eid-lookup/index.js");
        const inputs = enqueueItems.map((e) =>
          e.kind === "name"
            ? { name: extractName(e.record, spec) }
            : { emplId: extractEid(e.record, spec), keepNonHdh: true },
        );
        await ensureDaemonsAndEnqueue(
          eidLookupCrmWorkflow,
          inputs as never,
          {},
          {
            deriveItemId: (inp: { name?: string; emplId?: string }) => {
              const matched = enqueueItems.find((e) => {
                if ("name" in inp && inp.name) return extractName(e.record, spec) === inp.name;
                if ("emplId" in inp && inp.emplId) return extractEid(e.record, spec) === inp.emplId;
                return false;
              });
              return matched?.itemId ?? `ocr-fallback-${runId}-r0`;
            },
          },
        );
      }

      // Don't block: dispatch eid-lookup, snapshot the current pending
      // records into awaiting-approval, then return. A background watcher
      // patches each record as the eid-lookup daemon publishes outcomes.
      // This unblocks the operator immediately — they can review the
      // records the LLM extracted while UCPath lookup runs in parallel.
      log.success(`[ocr] eid-lookup dispatched to daemon — OCR workflow returning, results will patch records as they arrive`);
      // Snapshot WITH lookup-pending markers so Preview shows the pending state.
      emitSnapshot(records, "eid-lookup", "running", {
        failedPages,
        emptyPages,
        pageStatusSummary,
      });

      // Background watcher: lives past the orchestrator's return. As each
      // eid-lookup daemon outcome lands, patch the matching record and
      // re-emit the awaiting-approval row so the operator sees the EID +
      // verification badge populate live in the Preview tab.
      void (async () => {
        try {
          const outcomes = await watchChildren({
            workflow: "eid-lookup",
            expectedItemIds: enqueueItems.map((e) => e.itemId),
            trackerDir,
            date,
            timeoutMs: opts.eidLookupTimeoutMs ?? 60 * 60_000,
            onProgress: (outcome, remaining) => {
              const enq = enqueueItems.find((e) => e.itemId === outcome.itemId);
              if (!enq) return;
              patchFromOutcome(records, enq.index, outcome, enq.kind, spec);
              log.step(`[ocr/bg] eid-lookup outcome for rec ${enq.index + 1}: kind=${enq.kind} status=${outcome.status} → record patched (${remaining} remaining)`);
              emitSnapshot(records, "awaiting-approval", "running", {
                failedPages,
                emptyPages,
                pageStatusSummary,
              });
            },
          });
          // Mark any items that never got a terminal outcome as unresolved.
          const seen = new Set(outcomes.map((o) => o.itemId));
          for (const enq of enqueueItems) {
            if (!seen.has(enq.itemId)) patchUnresolved(records, enq.index, spec);
          }
          const verifiedCount = countVerified(records, spec);
          log.success(`[ocr/bg] eid-lookup watch complete — ${outcomes.length}/${enqueueItems.length} records resolved, ${verifiedCount} verified`);
          emitSnapshot(records, "awaiting-approval", "done", {
            failedPages,
            emptyPages,
            pageStatusSummary,
          });
        } catch (err) {
          log.warn(`[ocr/bg] eid-lookup watcher errored: ${errorMessage(err)}`);
        }
      })();
    }

    // 5. Verification marker (synthetic — actual verification happens
    // asynchronously inside the eid-lookup daemon). We emit the breakdown
    // of currently-known verifications so the operator can see what state
    // each record is in right now (more rows may verify in the background
    // as eid-lookup outcomes arrive).
    const verifiedCount = countVerified(records, spec);
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

function extractName(record: unknown, spec: AnyOcrFormSpec): string {
  return spec.carryForwardKey(record as never);
}

function extractEid(record: unknown, _spec: AnyOcrFormSpec): string {
  const r = record as Record<string, unknown>;
  if (typeof r.employeeId === "string") return r.employeeId;
  const employee = r.employee as Record<string, unknown> | undefined;
  if (employee && typeof employee.employeeId === "string") return employee.employeeId;
  return "";
}

function patchUnresolved(records: unknown[], idx: number, _spec: AnyOcrFormSpec): void {
  const rec = records[idx] as Record<string, unknown>;
  if (rec.matchState === "lookup-pending" || rec.matchState === "lookup-running") {
    rec.matchState = "unresolved";
    const warnings = (rec.warnings as string[]) ?? [];
    warnings.push("eid-lookup did not return within timeout");
    rec.warnings = warnings;
  }
}

function patchFromOutcome(
  records: unknown[],
  idx: number,
  outcome: ChildOutcome,
  kind: "name" | "verify" | "verify-only",
  _spec: AnyOcrFormSpec,
): void {
  const rec = records[idx] as Record<string, unknown>;
  const eid = (outcome.data?.emplId ?? "").trim();
  const looksLikeEid = /^\d{5,}$/.test(eid);

  if (kind === "name") {
    if (outcome.status === "done" && looksLikeEid) {
      if ("employee" in rec) {
        (rec.employee as Record<string, unknown>).employeeId = eid;
      } else {
        rec.employeeId = eid;
      }
      rec.matchState = "resolved";
      rec.matchSource = "eid-lookup";
    } else {
      rec.matchState = "unresolved";
      const warnings = (rec.warnings as string[]) ?? [];
      warnings.push(`eid-lookup ${outcome.status === "done" ? `returned "${eid || "no result"}"` : "failed"}`);
      rec.warnings = warnings;
    }
  }

  const v = computeVerification({
    hrStatus: outcome.data?.hrStatus,
    department: outcome.data?.department,
    personOrgScreenshot: outcome.data?.personOrgScreenshot,
  });
  rec.verification = v;
  if (v.state !== "verified") {
    rec.selected = false;
  }
}

function countVerified(records: unknown[], _spec: AnyOcrFormSpec): number {
  let n = 0;
  for (const r of records) {
    const v = (r as Record<string, unknown>).verification as { state?: string } | undefined;
    if (v?.state === "verified") n++;
  }
  return n;
}

function computeVerification(d: {
  hrStatus?: string;
  department?: string;
  personOrgScreenshot?: string;
}): {
  state: "verified" | "inactive" | "non-hdh" | "lookup-failed";
  hrStatus?: string;
  department?: string;
  screenshotFilename: string;
  checkedAt: string;
  error?: string;
} {
  const checkedAt = new Date().toISOString();
  const screenshotFilename = d.personOrgScreenshot ?? "";
  if (!d.hrStatus) return { state: "lookup-failed", error: "no result", checkedAt, screenshotFilename };
  const active = d.hrStatus === "Active";
  const hdh = isAcceptedDept(d.department ?? null);
  if (!active) return { state: "inactive", hrStatus: d.hrStatus, department: d.department, screenshotFilename, checkedAt };
  if (!hdh) return { state: "non-hdh", hrStatus: d.hrStatus, department: d.department ?? "", screenshotFilename, checkedAt };
  return { state: "verified", hrStatus: d.hrStatus, department: d.department ?? "", screenshotFilename, checkedAt };
}
