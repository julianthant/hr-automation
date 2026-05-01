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

  const runOcr = opts._ocrPipelineOverride ?? (async ({ pdfPath, spec: s, sessionId }: { pdfPath: string; formType: string; spec: AnyOcrFormSpec; sessionId: string }) => {
    const { runOcrPipeline } = await import("../../ocr/pipeline.js");
    const pageImagesDir = join(trackerDir ?? ".tracker", "page-images", sessionId);
    const result = await runOcrPipeline({
      pdfPath,
      pageImagesDir,
      recordSchema: s.ocrRecordSchema as ZodType<unknown>,
      arraySchema: s.ocrArraySchema as ZodType<unknown[]>,
      schemaName: s.schemaName,
      prompt: s.prompt,
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
    emit({
      workflow: WORKFLOW,
      timestamp: new Date().toISOString(),
      id,
      runId,
      ...(input.parentRunId ? { parentRunId: input.parentRunId } : {}),
      status,
      ...(step ? { step } : {}),
      data: flattenForData(data),
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
    // 1. Loading-roster (supports rosterMode=download via SharePoint delegation)
    writeTracker("running", { formType: input.formType, rosterMode: input.rosterMode }, "loading-roster");

    let resolvedRosterPath = input.rosterPath;

    if (input.rosterMode === "download") {
      const { runWorkflow } = await import("../../core/index.js");
      const { sharepointDownloadWorkflow } = await import("../sharepoint-download/index.js");
      const { SHAREPOINT_DOWNLOADS } = await import("../sharepoint-download/registry.js");
      const spec0 = SHAREPOINT_DOWNLOADS[0];
      if (!spec0) throw new Error("OCR: no SharePoint download spec registered");
      const url = (process.env[spec0.envVar] ?? "").trim();
      if (!url && !opts._skipSharepointDispatch) {
        throw new Error(`OCR rosterMode=download but ${spec0.envVar} env var is unset`);
      }
      if (!opts._skipSharepointDispatch) {
        void runWorkflow(sharepointDownloadWorkflow, {
          id: spec0.id,
          label: spec0.label,
          url,
          parentRunId: runId,
        }).catch((err) => log.warn(`[ocr] sharepoint download crashed: ${errorMessage(err)}`));
      }

      const outcomes = await watchChildren({
        workflow: "sharepoint-download",
        expectedItemIds: [spec0.id],
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
    }

    if (!resolvedRosterPath) {
      throw new Error("OCR: no roster path resolved");
    }
    const roster = (await loadRosterFn(resolvedRosterPath)) as OcrRosterRow[];

    // 2. OCR
    writeTracker("running", { formType: input.formType, rosterPath: resolvedRosterPath }, "ocr");
    const ocrResult = await runOcr({
      pdfPath: input.pdfPath,
      formType: input.formType,
      spec,
      sessionId: input.sessionId,
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
        attempts: p.attemptedKeys.length || 1,
      }));
    const pageStatusSummary = {
      total: pages.length,
      succeeded: pages.filter((p) => p.success).length,
      failed: failedPages.length,
    };

    // 3. Match
    writeTracker(
      "running",
      {
        formType: input.formType,
        rosterPath: resolvedRosterPath,
        ocrProvider: ocrResult.provider,
        ocrAttempts: ocrResult.attempts,
        ocrCached: ocrResult.cached,
      },
      "matching",
    );
    let records = (ocrResult.data as unknown[]).map((r) =>
      spec.matchRecord({ record: r, roster }),
    );

    // 3b. Carry-forward (if reupload)
    if (input.previousRunId) {
      const v1Records = readPreviousRecords(input.sessionId, input.previousRunId, trackerDir, date);
      if (v1Records.length > 0) {
        records = applyCarryForward({ v2Records: records, v1Records, spec });
      }
    }

    // 4. Eid-lookup fan-out + watch
    const lookupTargets: Array<{ rec: unknown; index: number; kind: "name" | "verify" }> = [];
    records.forEach((rec, index) => {
      const kind = spec.needsLookup(rec);
      if (kind === "name" || kind === "verify") {
        lookupTargets.push({ rec, index, kind });
      }
    });

    if (lookupTargets.length > 0) {
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

      // Watch for terminations.
      const outcomes = await watchChildren({
        workflow: "eid-lookup",
        expectedItemIds: enqueueItems.map((e) => e.itemId),
        trackerDir,
        date,
        timeoutMs: opts.eidLookupTimeoutMs ?? 60 * 60_000,
      }).catch((err) => {
        log.warn(`[ocr] watchChildRuns timed out: ${errorMessage(err)}`);
        return [] as ChildOutcome[];
      });

      // Patch records from outcomes.
      const outcomesByItemId = new Map(outcomes.map((o) => [o.itemId, o]));
      for (const enq of enqueueItems) {
        const outcome = outcomesByItemId.get(enq.itemId);
        const idx = enq.index;
        if (!outcome) {
          patchUnresolved(records, idx, spec);
          continue;
        }
        patchFromOutcome(records, idx, outcome, enq.kind, spec);
      }
    }

    // 5. Verification marker
    const verifiedCount = countVerified(records, spec);
    writeTracker("running", { recordCount: records.length, verifiedCount }, "verification");

    // 6. Awaiting-approval
    writeTracker("running", {
      formType: input.formType,
      pdfOriginalName: input.pdfOriginalName,
      sessionId: input.sessionId,
      ...(input.parentRunId ? { parentRunId: input.parentRunId } : {}),
      recordCount: records.length,
      verifiedCount,
      records,
      failedPages,
      pageStatusSummary,
    }, "awaiting-approval");
    writeTracker("done", {
      formType: input.formType,
      pdfOriginalName: input.pdfOriginalName,
      sessionId: input.sessionId,
      ...(input.parentRunId ? { parentRunId: input.parentRunId } : {}),
      recordCount: records.length,
      verifiedCount,
      records,
      failedPages,
      pageStatusSummary,
    }, "awaiting-approval");
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
  kind: "name" | "verify",
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
