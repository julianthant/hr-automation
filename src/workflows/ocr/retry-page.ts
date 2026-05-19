/**
 * Single-page retry for the OCR workflow. Scoped mini-orchestrator:
 * load the row's prior state from SQLite projection (when present) or
 * OCR JSONL, re-OCR just one page through
 * the multi-provider pool, match new records against the roster, fan
 * out eid-lookup for any that need it, and emit a fresh
 * awaiting-approval row with patched records + failedPages.
 *
 * Reuses the same primitives as the main orchestrator (matchRecord,
 * watchChildRuns, eid-lookup daemon dispatch). Test escape hatches
 * mirror those on `runOcrOrchestrator`.
 */
import { existsSync } from "node:fs";
import { join, basename, dirname } from "node:path";
import { openStateDb, stateDbPath } from "../../tracker/state/db.js";
import type { ZodType } from "zod/v4";
import { runOcrPerPage } from "../../services/ocr/per-page.js";
import { buildVisionPool } from "../../services/ocr/per-page-pool.js";
import { loadRoster as realLoadRoster } from "../../services/matching/index.js";
import type { RosterRow as MatchRosterRow } from "../../services/matching/match.js";
import { watchChildRuns as realWatchChildRuns, type ChildOutcome, type WatchChildRunsOpts } from "../../tracker/delegation/watch-child-runs.js";
import { trackEvent, dateLocal, type TrackerEntry } from "../../tracker/jsonl.js";
import { findLatestEntryForPredicate } from "../../tracker/find-latest-entry.js";
import { patchOcrRecordFromEidLookupOutcome } from "../../services/ocr/eid-lookup-results.js";
import { flattenForData } from "../../services/ocr/tracker-data.js";
import { countVerified } from "../../services/ocr/records-stats.js";
import { getFormSpec } from "../../services/ocr/forms/registry.js";
import type { AnyOcrFormSpec, RosterRow as OcrRosterRow } from "./types.js";
import { extractOcrRecordEid, extractOcrRecordName } from "./record-helpers.js";

const WORKFLOW = "ocr";

export interface RetryPageInput {
  sessionId: string;
  runId: string;
  pageNum: number;
}

export interface RetryPageOpts {
  trackerDir?: string;
  date?: string;
  eidLookupTimeoutMs?: number;

  _emitOverride?: (entry: TrackerEntry) => void;
  _ocrPageOverride?: (args: { pageNum: number; pageImagePath: string; spec: AnyOcrFormSpec }) => Promise<{
    records: unknown[];
    stillFailed: boolean;
    error?: string;
    attemptedKeys?: string[];
  }>;
  _loadRosterOverride?: (path: string) => Promise<MatchRosterRow[]>;
  _watchChildRunsOverride?: (opts: WatchChildRunsOpts) => Promise<ChildOutcome[]>;
  _enqueueEidLookupOverride?: (
    items: Array<{ name?: string; emplId?: string; itemId: string }>,
  ) => Promise<void>;
}

export interface RetryPageResult {
  ok: true;
  page: number;
  recordsAdded: number;
  stillFailed: boolean;
}

export class RetryPageError extends Error {
  constructor(public readonly code: "row-not-found" | "row-not-mutable" | "image-missing" | "spec-missing", message: string) {
    super(message);
    this.name = "RetryPageError";
  }
}

export async function runOcrRetryPage(
  input: RetryPageInput,
  opts: RetryPageOpts = {},
): Promise<RetryPageResult> {
  const trackerDir = opts.trackerDir;
  const date = opts.date ?? dateLocal();
  const emit = opts._emitOverride ?? ((e: TrackerEntry) => trackEvent(e, trackerDir));
  const loadRosterFn = opts._loadRosterOverride ?? realLoadRoster;
  const watchChildren = opts._watchChildRunsOverride ?? realWatchChildRuns;

  // 1. Load the latest row state.
  const row = readLatestRow(input.sessionId, input.runId, trackerDir, date);
  if (!row) throw new RetryPageError("row-not-found", `No OCR row for sessionId=${input.sessionId} runId=${input.runId}`);
  if (row.status === "failed" && row.step === "discarded") {
    throw new RetryPageError("row-not-mutable", `cannot retry discarded row ${input.sessionId}`);
  }
  if (row.status === "done" && row.step === "approved") {
    throw new RetryPageError("row-not-mutable", `cannot retry approved row ${input.sessionId}`);
  }
  const formType = row.data?.formType as unknown as string | undefined;
  if (!formType) throw new RetryPageError("spec-missing", "Row missing formType");
  const spec = getFormSpec(formType);
  if (!spec) throw new RetryPageError("spec-missing", `Unknown formType "${formType}"`);

  const records = parseRecords(row.data);
  const failedPages = parseFailedPages(row.data);
  const summary = parsePageSummary(row.data) ?? { total: 0, succeeded: 0, failed: 0 };

  const pdfFileId = row.data?.pdfFileId as unknown as string | undefined;
  if (!pdfFileId) {
    throw new RetryPageError("image-missing", `OCR retry requires pdfFileId (legacy page-images path removed)`);
  }
  const pageImagePath =
    join(trackerDir ?? ".tracker", "pdf-cache", pdfFileId, `page-${String(input.pageNum).padStart(3, "0")}.png`);

  if (!opts._ocrPageOverride && !existsSync(pageImagePath)) {
    throw new RetryPageError("image-missing", `Page image expired at ${pageImagePath}`);
  }

  // 2. OCR the single page.
  const ocr = opts._ocrPageOverride
    ? await opts._ocrPageOverride({ pageNum: input.pageNum, pageImagePath, spec })
    : await runSinglePageThroughPool({ pageNum: input.pageNum, pageImagePath, spec });

  if (ocr.stillFailed) {
    // Patch failedPages: bump attempts, update error.
    const newFailedPages = failedPages.map((fp) =>
      fp.page === input.pageNum
        ? {
            ...fp,
            attempts: fp.attempts + 1,
            error: ocr.error ?? fp.error,
            attemptedKeys: ocr.attemptedKeys ?? fp.attemptedKeys,
            pageImagePath,
          }
        : fp,
    );
    if (!newFailedPages.some((fp) => fp.page === input.pageNum)) {
      // Wasn't in failedPages before — operator retried a successful page.
      newFailedPages.push({
        page: input.pageNum,
        error: ocr.error ?? "retry failed",
        attemptedKeys: ocr.attemptedKeys ?? [],
        pageImagePath,
        attempts: 1,
      });
    }
    const rosterPathForFailed = (row.data?.rosterPath as unknown as string | undefined) ?? "";
    emitRow({ row, records, failedPages: newFailedPages, summary, emit, parentRunId: row.parentRunId, sessionId: input.sessionId, runId: input.runId, formType, pdfOriginalName: row.data?.pdfOriginalName as unknown as string ?? "", rosterPath: rosterPathForFailed, pdfFileId });
    return { ok: true, page: input.pageNum, recordsAdded: 0, stillFailed: true };
  }

  // 3. Match new records against the roster.
  const rosterPath = (row.data?.rosterPath as unknown as string | undefined) ?? "";
  const roster = rosterPath ? ((await loadRosterFn(rosterPath)) as OcrRosterRow[]) : [];
  const newRecords = await Promise.all(
    ocr.records.map((r) => spec.matchRecord({ record: r, roster })),
  );

  // 4. Eid-lookup for new records that need it.
  const lookupTargets: Array<{ rec: unknown; localIndex: number; kind: "name" | "verify" | "verify-only" }> = [];
  newRecords.forEach((rec, localIndex) => {
    const kind = spec.needsLookup(rec);
    if (kind === "name" || kind === "verify" || kind === "verify-only") {
      lookupTargets.push({ rec, localIndex, kind });
    }
  });

  if (lookupTargets.length > 0) {
    const enqueueItems = lookupTargets.map((t, i) => ({
      record: t.rec,
      localIndex: t.localIndex,
      kind: t.kind,
      itemId: `ocr-retry-${input.runId}-p${input.pageNum}-r${i}`,
    }));
    if (opts._enqueueEidLookupOverride) {
      await opts._enqueueEidLookupOverride(
        enqueueItems.map((e) => ({
          ...(e.kind === "name"
            ? { name: extractOcrRecordName(e.record, spec) }
            : { emplId: extractOcrRecordEid(e.record) }),
          itemId: e.itemId,
        })),
      );
    } else {
      const { ensureDaemonsAndEnqueue } = await import("../../core/daemon/client.js");
      const { eidLookupCrmWorkflow } = await import("../eid-lookup/index.js");
      const inputs = enqueueItems.map((e) =>
        e.kind === "name"
          ? { name: extractOcrRecordName(e.record, spec) }
          : { emplId: extractOcrRecordEid(e.record), keepNonHdh: true },
      );
      const nameKeyToItemId = new Map<string, string>();
      const eidKeyToItemId = new Map<string, string>();
      const fallbackItemId = `ocr-retry-fallback-${input.runId}-p${input.pageNum}`;
      for (const e of enqueueItems) {
        if (e.kind === "name") {
          const nk = extractOcrRecordName(e.record, spec);
          if (nk) nameKeyToItemId.set(nk, e.itemId);
        } else {
          const ek = extractOcrRecordEid(e.record);
          if (ek) eidKeyToItemId.set(ek, e.itemId);
        }
      }
      await ensureDaemonsAndEnqueue(eidLookupCrmWorkflow, inputs as never, {}, {
        trackerDir,
        deriveItemId: (inp: { name?: string; emplId?: string }) => {
          if ("name" in inp && inp.name) return nameKeyToItemId.get(inp.name) ?? fallbackItemId;
          if ("emplId" in inp && inp.emplId) return eidKeyToItemId.get(inp.emplId) ?? fallbackItemId;
          return fallbackItemId;
        },
      });
    }

    const outcomes = await watchChildren({
      workflow: "eid-lookup",
      expectedItemIds: enqueueItems.map((e) => e.itemId),
      trackerDir,
      date,
      timeoutMs: opts.eidLookupTimeoutMs ?? 60 * 60_000,
    });

    const outcomesByItemId = new Map(outcomes.map((o) => [o.itemId, o]));
    for (const enq of enqueueItems) {
      const outcome = outcomesByItemId.get(enq.itemId);
      const idx = enq.localIndex;
      if (!outcome) {
        patchUnresolved(newRecords, idx);
        continue;
      }
      patchOcrRecordFromEidLookupOutcome(newRecords, idx, outcome, enq.kind);
    }
  }

  // 5. Splice into records[]: drop existing records with sourcePage === pageNum, append new ones.
  const survivingRecords = records.filter((r) => (r as { sourcePage: number }).sourcePage !== input.pageNum);
  const updatedRecords = [...survivingRecords, ...newRecords];

  // 6. Clear page from failedPages.
  const updatedFailedPages = failedPages.filter((fp) => fp.page !== input.pageNum);

  // 7. Recompute summary.
  const updatedSummary = {
    total: summary.total,
    succeeded: Math.max(0, summary.total - updatedFailedPages.length),
    failed: updatedFailedPages.length,
  };

  emitRow({
    row,
    records: updatedRecords,
    failedPages: updatedFailedPages,
    summary: updatedSummary,
    emit,
    parentRunId: row.parentRunId,
    sessionId: input.sessionId,
    runId: input.runId,
    formType,
    pdfOriginalName: row.data?.pdfOriginalName as unknown as string ?? "",
    rosterPath,
    pdfFileId,
  });

  return { ok: true, page: input.pageNum, recordsAdded: newRecords.length, stillFailed: false };
}

// ─── Helpers ─────────────────────────────────────────────────

interface FailedPageEntry {
  page: number;
  error: string;
  attemptedKeys: string[];
  pageImagePath: string;
  attempts: number;
}

function coerceLatestDataJson(raw: string | null): Record<string, string> | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (v === undefined || v === null) continue;
      if (typeof v === "string") out[k] = v;
      else if (typeof v === "number" || typeof v === "boolean") out[k] = String(v);
      else try { out[k] = JSON.stringify(v); } catch { out[k] = String(v); }
    }
    return out;
  } catch {
    return undefined;
  }
}

function readLatestRowFromSqlite(
  sessionId: string,
  runId: string,
  trackerDir: string | undefined,
  _date: string,
): TrackerEntry | null {
  const dir = trackerDir ?? ".tracker";
  if (!existsSync(stateDbPath(dir))) return null;
  try {
    const db = openStateDb(dir);
    const row = db.prepare(`
      SELECT workflow, item_id, run_id, parent_run_id, latest_tracker_ts, latest_status, latest_step, latest_data_json, latest_error
      FROM runs
      WHERE workflow = @workflow AND item_id = @itemId AND run_id = @runId
      ORDER BY tracker_date DESC
      LIMIT 1
    `).get({
      workflow: WORKFLOW,
      itemId: sessionId,
      runId,
    }) as {
      workflow: string;
      item_id: string;
      run_id: string;
      parent_run_id: string | null;
      latest_tracker_ts: string;
      latest_status: string;
      latest_step: string | null;
      latest_data_json: string | null;
      latest_error: string | null;
    } | undefined;
    if (!row) return null;
    const data = coerceLatestDataJson(row.latest_data_json);
    const status = row.latest_status as TrackerEntry["status"];
    return {
      workflow: row.workflow,
      id: row.item_id,
      runId: row.run_id,
      ...(row.parent_run_id ? { parentRunId: row.parent_run_id } : {}),
      timestamp: row.latest_tracker_ts,
      status,
      ...(row.latest_step ? { step: row.latest_step } : {}),
      ...(data ? { data } : {}),
      ...(row.latest_error ? { error: row.latest_error } : {}),
    };
  } catch {
    return null;
  }
}

const RETRY_PAGE_LOOKBACK_DAYS = 7;

function readLatestRow(
  sessionId: string,
  runId: string,
  trackerDir: string | undefined,
  date: string,
): TrackerEntry | null {
  const sqliteResult = readLatestRowFromSqlite(sessionId, runId, trackerDir, date);
  if (sqliteResult) return sqliteResult;
  const [yStr, mStr, dStr] = date.split("-");
  const anchor = new Date(Number(yStr), Number(mStr) - 1, Number(dStr));
  return findLatestEntryForPredicate({
    workflow: WORKFLOW,
    trackerDir,
    lookbackDays: RETRY_PAGE_LOOKBACK_DAYS,
    ...(Number.isNaN(anchor.getTime()) ? {} : { now: anchor }),
    predicate: (e) => e.id === sessionId && e.runId === runId,
  });
}

function parseRecords(data: Record<string, string> | undefined): unknown[] {
  if (!data?.records) return [];
  try {
    const parsed = JSON.parse(data.records);
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}

function parseFailedPages(data: Record<string, string> | undefined): FailedPageEntry[] {
  if (!data?.failedPages) return [];
  try {
    const parsed = JSON.parse(data.failedPages);
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}

function parsePageSummary(data: Record<string, string> | undefined): { total: number; succeeded: number; failed: number } | null {
  if (!data?.pageStatusSummary) return null;
  try {
    const p = JSON.parse(data.pageStatusSummary);
    if (typeof p?.total === "number") return p;
    return null;
  } catch { return null; }
}

async function runSinglePageThroughPool(args: {
  pageNum: number;
  pageImagePath: string;
  spec: AnyOcrFormSpec;
}): Promise<{ records: unknown[]; stillFailed: boolean; error?: string; attemptedKeys?: string[] }> {
  const pool = buildVisionPool();
  if (pool.length === 0) {
    return { records: [], stillFailed: true, error: "No vision API keys configured", attemptedKeys: [] };
  }
  // runOcrPerPage operates on filenames within pageImagesDir — use path helpers.
  const dir = dirname(args.pageImagePath);
  const filename = basename(args.pageImagePath);
  const result = await runOcrPerPage({
    pagesAsImages: [filename],
    pageImagesDir: dir,
    prompt: args.spec.prompt,
    schema: args.spec.ocrRecordSchema as ZodType<unknown>,
    pool,
  });
  const status = result.pages[0];
  if (!status?.success) {
    return {
      records: [],
      stillFailed: true,
      error: status?.error ?? "unknown failure",
      attemptedKeys: status?.attemptedKeys ?? (status?.poolKeyId ? [status.poolKeyId] : []),
    };
  }
  const newRecords = result.records
    .filter((r) => (r as { sourcePage: number }).sourcePage === 1)
    .map((r) => ({ ...(r as object), sourcePage: args.pageNum }));
  return { records: newRecords, stillFailed: false };
}

function emitRow(args: {
  row: TrackerEntry;
  records: unknown[];
  failedPages: FailedPageEntry[];
  summary: { total: number; succeeded: number; failed: number };
  emit: (e: TrackerEntry) => void;
  parentRunId: string | undefined;
  sessionId: string;
  runId: string;
  formType: string;
  pdfOriginalName: string;
  rosterPath: string;
  pdfFileId?: string;
}): void {
  const verifiedCount = countVerified(args.records);
  // Inherit display fields from the prior row so dashboard preview-tab
  // affordance and batch label are preserved after a page retry.
  const priorName = (args.row.data?.__name as string | undefined) ?? "OCR";
  const priorParentSubject = args.row.data?.parentSubject as string | undefined;
  const data = flattenForData({
    formType: args.formType,
    pdfOriginalName: args.pdfOriginalName,
    ...(args.pdfFileId ? { pdfFileId: args.pdfFileId } : {}),
    sessionId: args.sessionId,
    rosterPath: args.rosterPath,
    ...(args.parentRunId ? { parentRunId: args.parentRunId } : {}),
    recordCount: args.records.length,
    verifiedCount,
    records: args.records,
    failedPages: args.failedPages,
    pageStatusSummary: args.summary,
    // Mirror the orchestrator's awaiting-approval stamp so dashboard
    // surfaces the preview-tab affordance and batch label on retried rows.
    archetype: "batch-parent",
    mode: "prepare",
    __id: args.sessionId,
    __name: priorName,
    ...(priorParentSubject ? { parentSubject: priorParentSubject } : {}),
  });
  args.emit({
    workflow: WORKFLOW,
    timestamp: new Date().toISOString(),
    id: args.sessionId,
    runId: args.runId,
    ...(args.parentRunId ? { parentRunId: args.parentRunId } : {}),
    status: "running",
    step: "awaiting-approval",
    data,
  });
  args.emit({
    workflow: WORKFLOW,
    timestamp: new Date().toISOString(),
    id: args.sessionId,
    runId: args.runId,
    ...(args.parentRunId ? { parentRunId: args.parentRunId } : {}),
    status: "done",
    step: "awaiting-approval",
    data,
  });
}

function patchUnresolved(records: unknown[], idx: number): void {
  const rec = records[idx] as Record<string, unknown>;
  if (rec.matchState === "lookup-pending" || rec.matchState === "lookup-running") {
    rec.matchState = "unresolved";
    const warnings = (rec.warnings as string[]) ?? [];
    warnings.push("eid-lookup did not return within timeout");
    rec.warnings = warnings;
  }
}

