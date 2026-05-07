import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { log } from "../../../utils/log.js";
import { errorMessage } from "../../../utils/errors.js";
import { trackEvent, dateLocal } from "../../jsonl.js";
import type { TrackerEntry } from "../../jsonl.js";
import { getFormSpec } from "../../../services/ocr/forms/registry.js";
import { isAcceptedHdhDepartment } from "../../../domain/hdh/departments.js";
import type { ChildOutcome, WatchChildRunsOpts } from "../../delegation/watch-child-runs.js";
import type { OcrRequest, OcrResult } from "../../../services/ocr/index.js";
import { rowKey, hasRowLock, acquireRowLock, releaseRowLock } from "./lock.js";

const WORKFLOW = "ocr";

// ─── POST /api/ocr/reocr-whole-pdf ────────────────────────────

export interface ReocrWholePdfBody {
  sessionId: string;
  runId: string;
}
export interface ReocrWholePdfHttpResponse {
  status: 200 | 400 | 404 | 409;
  body: { ok: true; recordCount: number; verifiedCount: number } | { ok: false; error: string };
}
export interface ReocrWholePdfHandlerOpts {
  trackerDir?: string;
  date?: string;
  _emitOverride?: (entry: TrackerEntry) => void;
  _wholePdfOverride?: <U>(req: OcrRequest<U>) => Promise<OcrResult<U>>;
  _loadRosterOverride?: (path: string) => Promise<unknown>;
  _watchChildRunsOverride?: (opts: WatchChildRunsOpts) => Promise<ChildOutcome[]>;
  _enqueueEidLookupOverride?: (
    items: Array<{ name?: string; emplId?: string; itemId: string }>,
  ) => Promise<void>;
}

export function buildOcrReocrWholePdfHandler(opts: ReocrWholePdfHandlerOpts = {}) {
  const trackerDir = opts.trackerDir;
  return async (input: ReocrWholePdfBody): Promise<ReocrWholePdfHttpResponse> => {
    if (!input.sessionId || !input.runId) {
      return { status: 400, body: { ok: false, error: "Missing sessionId/runId" } };
    }
    const key = rowKey(input.sessionId, input.runId);
    if (hasRowLock(key)) {
      return { status: 409, body: { ok: false, error: "Operation already in progress for this row" } };
    }
    acquireRowLock(key);
    try {
      const date = opts.date ?? dateLocal();
      const file = join(trackerDir ?? ".tracker", `ocr-${date}.jsonl`);
      if (!existsSync(file)) return { status: 404, body: { ok: false, error: "OCR row not found" } };
      const lines = readFileSync(file, "utf-8").split("\n").filter(Boolean);
      let row: TrackerEntry | null = null;
      for (const line of lines) {
        try {
          const e: TrackerEntry = JSON.parse(line);
          if (e.id === input.sessionId && e.runId === input.runId) row = e;
        } catch { /* tolerate */ }
      }
      if (!row) return { status: 404, body: { ok: false, error: "OCR row not found" } };
      const formType = row.data?.formType as unknown as string | undefined;
      if (!formType) return { status: 400, body: { ok: false, error: "Row missing formType" } };
      const spec = getFormSpec(formType);
      if (!spec) return { status: 400, body: { ok: false, error: `Unknown formType "${formType}"` } };

      const pdfPath = row.data?.pdfPath as unknown as string | undefined;
      if (!pdfPath) return { status: 400, body: { ok: false, error: "Row missing pdfPath" } };
      const rosterPath = (row.data?.rosterPath as unknown as string | undefined) ?? "";

      const { runOcrWholePdf } = await import("../../../services/ocr/pipeline.js");
      const ocrResult = await runOcrWholePdf({
        pdfPath,
        arraySchema: spec.ocrArraySchema as never,
        prompt: spec.prompt,
        schemaName: spec.schemaName,
        _override: opts._wholePdfOverride,
      });

      const { loadRoster: realLoadRoster } = await import("../../../services/matching/index.js");
      const loadRosterFn = opts._loadRosterOverride ?? realLoadRoster;
      const roster = rosterPath ? (await loadRosterFn(rosterPath) as unknown[]) : [];

      const records = await Promise.all(
        (ocrResult.data as unknown[]).map((r) => spec.matchRecord({ record: r, roster: roster as never })),
      );

      // Eid-lookup fan-out (mirror the orchestrator's lookup phase)
      const lookupTargets: Array<{ rec: unknown; index: number; kind: "name" | "verify" }> = [];
      records.forEach((rec, index) => {
        const kind = spec.needsLookup(rec);
        if (kind === "name" || kind === "verify") lookupTargets.push({ rec, index, kind });
      });

      if (lookupTargets.length > 0) {
        const enqueueItems = lookupTargets.map((t) => ({
          record: t.rec,
          index: t.index,
          kind: t.kind,
          itemId: `ocr-whole-${input.runId}-r${t.index}`,
        }));
        if (opts._enqueueEidLookupOverride) {
          await opts._enqueueEidLookupOverride(
            enqueueItems.map((e) => ({
              ...(e.kind === "name"
                ? { name: spec.carryForwardKey(e.record as never) }
                : { emplId: extractEidLocal(e.record) }),
              itemId: e.itemId,
            })),
          );
        } else {
          const { ensureDaemonsAndEnqueue } = await import("../../../core/daemon/client.js");
          const { eidLookupCrmWorkflow } = await import("../../../workflows/eid-lookup/index.js");
          const inputs = enqueueItems.map((e) =>
            e.kind === "name"
              ? { name: spec.carryForwardKey(e.record as never) }
              : { emplId: extractEidLocal(e.record), keepNonHdh: true },
          );
          await ensureDaemonsAndEnqueue(eidLookupCrmWorkflow, inputs as never, {}, {
            deriveItemId: (inp: { name?: string; emplId?: string }) => {
              const matched = enqueueItems.find((e) => {
                if ("name" in inp && inp.name)
                  return spec.carryForwardKey(e.record as never) === inp.name;
                if ("emplId" in inp && inp.emplId)
                  return extractEidLocal(e.record) === inp.emplId;
                return false;
              });
              return matched?.itemId ?? `ocr-whole-fallback-${input.runId}`;
            },
          });
        }

        const { watchChildRuns: realWatchChildRuns } = await import("../../delegation/watch-child-runs.js");
        const watchChildren = opts._watchChildRunsOverride ?? realWatchChildRuns;
        const outcomes = await watchChildren({
          workflow: "eid-lookup",
          expectedItemIds: enqueueItems.map((e) => e.itemId),
          trackerDir,
          date,
          timeoutMs: 60 * 60_000,
        }).catch(() => [] as ChildOutcome[]);

        const outcomesByItemId = new Map(outcomes.map((o) => [o.itemId, o]));
        for (const enq of enqueueItems) {
          const outcome = outcomesByItemId.get(enq.itemId);
          const idx = enq.index;
          const rec = records[idx] as Record<string, unknown>;
          if (!outcome) {
            if (rec.matchState === "lookup-pending" || rec.matchState === "lookup-running") rec.matchState = "unresolved";
            continue;
          }
          if (enq.kind === "name") {
            const eid = (outcome.data?.emplId ?? "").trim();
            if (outcome.status === "done" && /^\d{5,}$/.test(eid)) {
              if ("employee" in rec) (rec.employee as Record<string, unknown>).employeeId = eid;
              else rec.employeeId = eid;
              rec.matchState = "resolved";
              rec.matchSource = "eid-lookup";
            } else {
              rec.matchState = "unresolved";
            }
          }
          const v = computeVerificationLocal({
            hrStatus: outcome.data?.hrStatus,
            department: outcome.data?.department,
            personOrgScreenshot: outcome.data?.personOrgScreenshot,
          });
          rec.verification = v;
          // Match `isApprovable` in OcrReviewPane: only auto-deselect on a
          // hard "don't process" verification. Soft `lookup-failed` keeps
          // selection — operator decides from the warning banner.
          if (v.state === "inactive" || v.state === "non-hdh") {
            rec.selected = false;
          }
        }
      }

      const verifiedCount = records.filter((r) => {
        const v = (r as Record<string, unknown>).verification as { state?: string } | undefined;
        return v?.state === "verified";
      }).length;

      const emit = opts._emitOverride ?? ((e: TrackerEntry) => trackEvent(e, trackerDir));
      const data = {
        formType,
        pdfOriginalName: (row.data?.pdfOriginalName as unknown as string) ?? "",
        sessionId: input.sessionId,
        ...(row.parentRunId ? { parentRunId: row.parentRunId } : {}),
        recordCount: String(records.length),
        verifiedCount: String(verifiedCount),
        records: JSON.stringify(records),
        failedPages: JSON.stringify([]),
        pageStatusSummary: JSON.stringify({ total: 0, succeeded: 0, failed: 0 }),
      };
      emit({
        workflow: WORKFLOW,
        timestamp: new Date().toISOString(),
        id: input.sessionId,
        runId: input.runId,
        ...(row.parentRunId ? { parentRunId: row.parentRunId } : {}),
        status: "running",
        step: "awaiting-approval",
        data,
      });
      emit({
        workflow: WORKFLOW,
        timestamp: new Date().toISOString(),
        id: input.sessionId,
        runId: input.runId,
        ...(row.parentRunId ? { parentRunId: row.parentRunId } : {}),
        status: "done",
        step: "awaiting-approval",
        data,
      });

      return { status: 200, body: { ok: true, recordCount: records.length, verifiedCount } };
    } catch (err) {
      log.error(`[ocr-http] reocr-whole-pdf threw: ${errorMessage(err)}`);
      return { status: 400, body: { ok: false, error: errorMessage(err) } };
    } finally {
      releaseRowLock(key);
    }
  };
}

function extractEidLocal(record: unknown): string {
  const r = record as Record<string, unknown>;
  if (typeof r.employeeId === "string") return r.employeeId;
  const employee = r.employee as Record<string, unknown> | undefined;
  if (employee && typeof employee.employeeId === "string") return employee.employeeId;
  return "";
}

function computeVerificationLocal(d: { hrStatus?: string; department?: string; personOrgScreenshot?: string }): {
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
  const hdh = isAcceptedHdhDepartment(d.department ?? null);
  if (!active) return { state: "inactive", hrStatus: d.hrStatus, department: d.department, screenshotFilename, checkedAt };
  if (!hdh) return { state: "non-hdh", hrStatus: d.hrStatus, department: d.department ?? "", screenshotFilename, checkedAt };
  return { state: "verified", hrStatus: d.hrStatus, department: d.department ?? "", screenshotFilename, checkedAt };
}
