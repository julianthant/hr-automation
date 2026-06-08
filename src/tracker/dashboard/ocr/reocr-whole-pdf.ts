import { existsSync, readFileSync } from "node:fs";
import { log } from "../../../utils/log.js";
import { errorMessage } from "../../../utils/errors.js";
import { emitTrackerRow, dateLocal, type TrackerRowEmission } from "../../jsonl.js";
import type { TrackerEntry } from "../../jsonl.js";
import { getFormSpec } from "../../../services/ocr/forms/registry.js";
import type { ChildOutcome, WatchChildRunsOpts } from "../../delegation/watch-child-runs.js";
import type { OcrRequest, OcrResult } from "../../../services/ocr/index.js";
import { rowKey, hasRowLock, acquireRowLock, releaseRowLock } from "./lock.js";
import { rowFilePath } from "../../paths.js";
import { DEFAULT_DIR } from "../../jsonl.js";
import type { OcrLookupKind } from "../../../services/ocr/eid-lookup-results.js";
import { patchOcrRecordFromEidLookupOutcome } from "../../../services/ocr/eid-lookup-results.js";
import { extractOcrRecordEid } from "../../../workflows/ocr/record-helpers.js";
import { readQueueTitle } from "../../../domain/queue-title.js";
import { tracePrefix } from "../../../domain/queue-trace-id.js";
import { parseParallelWorkers, type RunOptions } from "../../../domain/run-options.js";

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
    context: { parentRunId: string },
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
      const file = rowFilePath(WORKFLOW, date, trackerDir ?? DEFAULT_DIR);
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

      const childParentRunId = row.parentRunId ?? input.runId;
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
                : { emplId: extractOcrRecordEid(e.record) }),
              itemId: e.itemId,
            })),
            { parentRunId: childParentRunId },
          );
        } else {
          const { ensureDaemonsAndEnqueue } = await import("../../../core/daemon/client.js");
          const { personLookupWorkflow } = await import("../../../workflows/person-lookup/index.js");
          const inputs = enqueueItems.map((e) =>
            e.kind === "name"
              ? { name: spec.carryForwardKey(e.record as never) }
              : { emplId: extractOcrRecordEid(e.record), keepNonHdh: true },
          );
          await ensureDaemonsAndEnqueue(personLookupWorkflow, inputs as never, {}, {
            trackerDir,
            parentRunId: childParentRunId,
            deriveItemId: (inp: { name?: string; emplId?: string }) => {
              const matched = enqueueItems.find((e) => {
                if ("name" in inp && inp.name)
                  return spec.carryForwardKey(e.record as never) === inp.name;
                if ("emplId" in inp && inp.emplId)
                  return extractOcrRecordEid(e.record) === inp.emplId;
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
      const parentSubject =
        readQueueTitle(capturedRow.data) ??
        (capturedRow.data?.parentSubject as unknown as string | undefined);
      const rootTracePrefix = rootTracePrefixFromRow(capturedRow);
      const runOptions = runOptionsFromRow(capturedRow);
      const emitDataSnapshot = (
        nextRecords: unknown[],
        status: TrackerEntry["status"],
      ) => {
        emit({
          workflow: WORKFLOW,
          timestamp: new Date().toISOString(),
          id: input.sessionId,
          runId: input.runId,
          ...(parentRunId ? { parentRunId } : {}),
          status,
          step: status === "running" ? "person-lookup" : "awaiting-approval",
          data: buildReviewData({
            row: capturedRow,
            formType,
            sessionId: input.sessionId,
            parentRunId,
            records: nextRecords,
          }),
        });
      };
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

          if (spec.enrichRecords) {
            const enriched = await spec.enrichRecords({
              records: records as never[],
              runId: input.runId,
              sessionId: input.sessionId,
              trackerDir,
              date,
              parentSubject,
              rootTracePrefix,
              runOptions,
              emitProgress: (recs: unknown[]) => emitDataSnapshot(recs, "running"),
            }) as unknown[];
            enriched.forEach((rec, index) => {
              records[index] = rec;
            });
          }

          emitDataSnapshot(records, "done");
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

function buildReviewData(input: {
  row: TrackerEntry;
  formType: string;
  sessionId: string;
  parentRunId?: string;
  records: unknown[];
}): Record<string, string> & { archetype: "preview" } {
  const { row, formType, sessionId, parentRunId, records } = input;
  return {
    ...stringData(row.data),
    formType,
    pdfOriginalName: (row.data?.pdfOriginalName as unknown as string | undefined) ?? "",
    sessionId,
    ...(parentRunId ? { parentRunId } : {}),
    recordCount: String(records.length),
    verifiedCount: String(countVerified(records)),
    records: JSON.stringify(records),
    failedPages: JSON.stringify([]),
    pageStatusSummary: JSON.stringify({ total: 0, succeeded: 0, failed: 0 }),
    mode: "prepare",
    // OCR prep parent rows are preview-shaped.
    archetype: "preview" as const,
  };
}

function countVerified(records: unknown[]): number {
  return records.filter((r) => {
    const v = (r as Record<string, unknown>).verification as { state?: string } | undefined;
    return v?.state === "verified";
  }).length;
}

function stringData(data: TrackerEntry["data"]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(data ?? {})) {
    if (typeof value === "string") out[key] = value;
  }
  return out;
}

function rootTracePrefixFromRow(row: TrackerEntry): string {
  const traceId = row.data?.__traceId;
  return typeof traceId === "string" && traceId ? tracePrefix(traceId) : "";
}

function runOptionsFromRow(row: TrackerEntry): RunOptions | undefined {
  const raw = row.data?.parallelWorkers;
  if (raw === undefined) return undefined;
  try {
    const parallelWorkers = parseParallelWorkers(raw);
    return parallelWorkers === undefined ? {} : { parallelWorkers };
  } catch {
    return undefined;
  }
}
