/**
 * Single-page retry for the OCR workflow. Scoped mini-orchestrator:
 * load the row's prior state from JSONL, re-OCR just one page through
 * the multi-provider pool, match new records against the roster, fan
 * out eid-lookup for any that need it, and emit a fresh
 * awaiting-approval row with patched records + failedPages.
 *
 * Reuses the same primitives as the main orchestrator (matchRecord,
 * watchChildRuns, eid-lookup daemon dispatch). Test escape hatches
 * mirror those on `runOcrOrchestrator`.
 */
import { existsSync, readFileSync } from "node:fs";
import { join, basename, dirname } from "node:path";
import type { ZodType } from "zod/v4";
import { runOcrPerPage } from "../../ocr/per-page.js";
import { buildVisionPool } from "../../ocr/per-page-pool.js";
import { loadRoster as realLoadRoster } from "../../match/index.js";
import type { RosterRow as MatchRosterRow } from "../../match/match.js";
import { watchChildRuns as realWatchChildRuns, type ChildOutcome, type WatchChildRunsOpts } from "../../tracker/watch-child-runs.js";
import { trackEvent, dateLocal, type TrackerEntry } from "../../tracker/jsonl.js";
import { isAcceptedDept } from "../eid-lookup/search.js";
import { getFormSpec } from "./form-registry.js";
import type { AnyOcrFormSpec, RosterRow as OcrRosterRow } from "./types.js";

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
  if (row.status === "failed") throw new RetryPageError("row-not-mutable", "Row is in failed state");
  const formType = row.data?.formType as unknown as string | undefined;
  if (!formType) throw new RetryPageError("spec-missing", "Row missing formType");
  const spec = getFormSpec(formType);
  if (!spec) throw new RetryPageError("spec-missing", `Unknown formType "${formType}"`);

  const records = parseRecords(row.data);
  const failedPages = parseFailedPages(row.data);
  const summary = parsePageSummary(row.data) ?? { total: 0, succeeded: 0, failed: 0 };

  const failedEntry = failedPages.find((fp) => fp.page === input.pageNum);
  const pageImagePath = failedEntry?.pageImagePath ?? join(
    trackerDir ?? ".tracker",
    "page-images",
    input.sessionId,
    `page-${String(input.pageNum).padStart(2, "0")}.png`,
  );

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
    emitRow({ row, records, failedPages: newFailedPages, summary, emit, parentRunId: row.parentRunId, sessionId: input.sessionId, runId: input.runId, formType, pdfOriginalName: row.data?.pdfOriginalName as unknown as string ?? "", rosterPath: rosterPathForFailed });
    return { ok: true, page: input.pageNum, recordsAdded: 0, stillFailed: true };
  }

  // 3. Match new records against the roster.
  const rosterPath = (row.data?.rosterPath as unknown as string | undefined) ?? "";
  const roster = rosterPath ? ((await loadRosterFn(rosterPath)) as OcrRosterRow[]) : [];
  let newRecords = await Promise.all(
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
            ? { name: extractName(e.record, spec) }
            : { emplId: extractEid(e.record) }),
          itemId: e.itemId,
        })),
      );
    } else {
      const { ensureDaemonsAndEnqueue } = await import("../../core/daemon-client.js");
      const { eidLookupCrmWorkflow } = await import("../eid-lookup/index.js");
      const inputs = enqueueItems.map((e) =>
        e.kind === "name"
          ? { name: extractName(e.record, spec) }
          : { emplId: extractEid(e.record), keepNonHdh: true },
      );
      await ensureDaemonsAndEnqueue(eidLookupCrmWorkflow, inputs as never, {}, {
        deriveItemId: (inp: { name?: string; emplId?: string }) => {
          const matched = enqueueItems.find((e) => {
            if ("name" in inp && inp.name) return extractName(e.record, spec) === inp.name;
            if ("emplId" in inp && inp.emplId) return extractEid(e.record) === inp.emplId;
            return false;
          });
          return matched?.itemId ?? `ocr-retry-fallback-${input.runId}-p${input.pageNum}`;
        },
      });
    }

    const outcomes = await watchChildren({
      workflow: "eid-lookup",
      expectedItemIds: enqueueItems.map((e) => e.itemId),
      trackerDir,
      date,
      timeoutMs: opts.eidLookupTimeoutMs ?? 60 * 60_000,
    }).catch(() => [] as ChildOutcome[]);

    const outcomesByItemId = new Map(outcomes.map((o) => [o.itemId, o]));
    for (const enq of enqueueItems) {
      const outcome = outcomesByItemId.get(enq.itemId);
      const idx = enq.localIndex;
      if (!outcome) {
        patchUnresolved(newRecords, idx);
        continue;
      }
      patchFromOutcome(newRecords, idx, outcome, enq.kind);
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

function readLatestRow(
  sessionId: string,
  runId: string,
  trackerDir: string | undefined,
  date: string,
): TrackerEntry | null {
  const file = join(trackerDir ?? ".tracker", `ocr-${date}.jsonl`);
  if (!existsSync(file)) return null;
  const raw = readFileSync(file, "utf-8");
  const lines = raw.split("\n").filter(Boolean);
  let latest: TrackerEntry | null = null;
  for (const line of lines) {
    try {
      const e: TrackerEntry = JSON.parse(line);
      if (e.id === sessionId && e.runId === runId) latest = e;
    } catch { /* tolerate */ }
  }
  return latest;
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
      attemptedKeys: status?.poolKeyId ? [status.poolKeyId] : [],
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
}): void {
  const verifiedCount = countVerified(args.records);
  const data = flattenForData({
    formType: args.formType,
    pdfOriginalName: args.pdfOriginalName,
    sessionId: args.sessionId,
    rosterPath: args.rosterPath,
    ...(args.parentRunId ? { parentRunId: args.parentRunId } : {}),
    recordCount: args.records.length,
    verifiedCount,
    records: args.records,
    failedPages: args.failedPages,
    pageStatusSummary: args.summary,
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

function extractName(record: unknown, spec: AnyOcrFormSpec): string {
  return spec.carryForwardKey(record as never);
}

function extractEid(record: unknown): string {
  const r = record as Record<string, unknown>;
  if (typeof r.employeeId === "string") return r.employeeId;
  const employee = r.employee as Record<string, unknown> | undefined;
  if (employee && typeof employee.employeeId === "string") return employee.employeeId;
  return "";
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

function patchFromOutcome(records: unknown[], idx: number, outcome: ChildOutcome, kind: "name" | "verify" | "verify-only"): void {
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
  if (v.state !== "verified") rec.selected = false;
}

function countVerified(records: unknown[]): number {
  let n = 0;
  for (const r of records) {
    const v = (r as Record<string, unknown>).verification as { state?: string } | undefined;
    if (v?.state === "verified") n++;
  }
  return n;
}

function computeVerification(d: { hrStatus?: string; department?: string; personOrgScreenshot?: string }): {
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
