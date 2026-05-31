import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { log } from "../../../utils/log.js";
import { errorMessage } from "../../../utils/errors.js";
import { emitTrackerRow, dateLocal, type TrackerRowEmission } from "../../jsonl.js";
import type { TrackerEntry } from "../../jsonl.js";
import { getFormSpec } from "../../../services/ocr/forms/registry.js";
import { normalizeUcpathEmployeeId } from "../../../domain/identity/eid.js";
import type { ChildOutcome, WatchChildRunsOpts } from "../../delegation/watch-child-runs.js";
import type { OcrRequest, OcrResult } from "../../../services/ocr/index.js";
import { rowKey, hasRowLock, acquireRowLock, releaseRowLock } from "./lock.js";
import type { OcrLookupKind } from "../../../services/ocr/eid-lookup-results.js";
import { patchOcrRecordFromEidLookupOutcome } from "../../../services/ocr/eid-lookup-results.js";

const WORKFLOW = "ocr";

// ─── POST /api/ocr/reocr-whole-pdf ────────────────────────────

export interface ReocrWholePdfBody {
  sessionId: string;
  runId: string;
}
export interface ReocrWholePdfHttpResponse {
  status: 200 | 202 | 400 | 404 | 409;
  body:
    | { ok: true; recordCount: number; verifiedCount: number }
    | { ok: true; accepted: true; parentRunId?: string }
    | { ok: false; error: string };
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
    let backgroundStarted = false;
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
      const lookupTargets: Array<{ rec: unknown; index: number; kind: OcrLookupKind }> = [];
      records.forEach((rec, index) => {
        const kind = spec.needsLookup(rec);
        if (kind) lookupTargets.push({ rec, index, kind });
      });

      let enqueueItems: Array<{ record: unknown; index: number; kind: OcrLookupKind; itemId: string }> = [];
      if (lookupTargets.length > 0) {
        enqueueItems = lookupTargets.map((t) => ({
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
                : { emplId: extractRecordEid(e.record) }),
              itemId: e.itemId,
            })),
          );
        } else {
          const { ensureDaemonsAndEnqueue } = await import("../../../core/daemon/client.js");
          const { personLookupWorkflow } = await import("../../../workflows/person-lookup/index.js");
          const inputs = enqueueItems.map((e) =>
            e.kind === "name"
              ? { name: spec.carryForwardKey(e.record as never) }
              : { emplId: extractRecordEid(e.record), keepNonHdh: true },
          );
          await ensureDaemonsAndEnqueue(personLookupWorkflow, inputs as never, {}, {
            trackerDir,
            deriveItemId: (inp: { name?: string; emplId?: string }) => {
              const matched = enqueueItems.find((e) => {
                if ("name" in inp && inp.name)
                  return spec.carryForwardKey(e.record as never) === inp.name;
                if ("emplId" in inp && inp.emplId)
                  return extractRecordEid(e.record) === inp.emplId;
                return false;
              });
              return matched?.itemId ?? `ocr-whole-fallback-${input.runId}`;
            },
          });
        }
      }

      // All pre-watch work (validation, OCR, matching, enqueue) is done.
      // The watch can hold the connection for up to 1 hour — fire it in the
      // background and return 202 immediately. The frontend polls SSE for
      // OCR row state changes regardless of this HTTP response.
      const parentRunId = row.parentRunId;
      const emit = opts._emitOverride ?? ((e: TrackerEntry) => emitTrackerRow(e as TrackerRowEmission, trackerDir));
      const capturedRow = row;
      const capturedEnqueueItems = enqueueItems;
      backgroundStarted = true;
      void (async () => {
        try {
          let outcomes: ChildOutcome[] = [];
          if (capturedEnqueueItems.length > 0) {
            const { watchChildRuns: realWatchChildRuns } = await import("../../delegation/watch-child-runs.js");
            const watchChildren = opts._watchChildRunsOverride ?? realWatchChildRuns;
            outcomes = await watchChildren({
              workflow: "person-lookup",
              expectedItemIds: capturedEnqueueItems.map((e) => e.itemId),
              trackerDir,
              date,
              timeoutMs: 60 * 60_000,
            }).catch(() => [] as ChildOutcome[]);

            const outcomesByItemId = new Map(outcomes.map((o) => [o.itemId, o]));
            for (const enq of capturedEnqueueItems) {
              const outcome = outcomesByItemId.get(enq.itemId);
              const idx = enq.index;
              const rec = records[idx] as Record<string, unknown>;
              if (!outcome) {
                if (rec.matchState === "lookup-pending" || rec.matchState === "lookup-running") rec.matchState = "unresolved";
                continue;
              }
              patchOcrRecordFromEidLookupOutcome(records, idx, outcome, enq.kind);
            }
          }

          const verifiedCount = records.filter((r) => {
            const v = (r as Record<string, unknown>).verification as { state?: string } | undefined;
            return v?.state === "verified";
          }).length;

          const data = {
            formType,
            pdfOriginalName: (capturedRow.data?.pdfOriginalName as unknown as string) ?? "",
            sessionId: input.sessionId,
            ...(parentRunId ? { parentRunId } : {}),
            recordCount: String(records.length),
            verifiedCount: String(verifiedCount),
            records: JSON.stringify(records),
            failedPages: JSON.stringify([]),
            pageStatusSummary: JSON.stringify({ total: 0, succeeded: 0, failed: 0 }),
            // OCR prep parent rows are preview-shaped.
            archetype: "preview" as const,
          };
          emit({
            workflow: WORKFLOW,
            timestamp: new Date().toISOString(),
            id: input.sessionId,
            runId: input.runId,
            ...(parentRunId ? { parentRunId } : {}),
            status: "done",
            step: "awaiting-approval",
            data,
          });
        } catch (err) {
          log.warn(`[reocr-whole-pdf] watch failed for parent=${input.runId}: ${err instanceof Error ? err.message : String(err)}`);
        } finally {
          releaseRowLock(key);
        }
      })();

      return {
        status: 202,
        body: { ok: true, accepted: true, ...(parentRunId ? { parentRunId } : {}) },
      };
    } catch (err) {
      log.error(`[ocr-http] reocr-whole-pdf threw: ${errorMessage(err)}`);
      return { status: 400, body: { ok: false, error: errorMessage(err) } };
    } finally {
      if (!backgroundStarted) releaseRowLock(key);
    }
  };
}

function extractRecordEid(record: unknown): string {
  const r = record as Record<string, unknown>;
  if (typeof r.employeeId === "string") return normalizeUcpathEmployeeId(r.employeeId);
  const employee = r.employee as Record<string, unknown> | undefined;
  if (employee && typeof employee.employeeId === "string") return normalizeUcpathEmployeeId(employee.employeeId);
  return "";
}
