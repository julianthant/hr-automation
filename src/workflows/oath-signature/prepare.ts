import { existsSync, mkdirSync, readFileSync, statSync, watch as fsWatch } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { ocrDocument, type OcrRequest, type OcrResult } from "../../ocr/index.js";
import { dateLocal, trackEvent } from "../../tracker/jsonl.js";
import { errorMessage } from "../../utils/errors.js";
import { log } from "../../utils/log.js";
import {
  findLatestRoster,
  loadRoster,
  matchAgainstRoster,
} from "../../match/index.js";
import {
  OathOcrOutputSchema,
  OathPrepareRowDataSchema,
  type OathPrepareRowData,
  type OathPreviewRecord,
} from "./preview-schema.js";

const WORKFLOW = "oath-signature";

/** Auto-accept threshold for roster name match. Below → eid-lookup. */
const ROSTER_AUTO_ACCEPT = 0.85;

/** How long resolveEidsAsync waits for eid-lookup completions before giving up. */
const EID_LOOKUP_TIMEOUT_MS = 10 * 60_000;

export interface PaperOathPrepareInput {
  pdfPath: string;
  pdfOriginalName: string;
  rosterDir: string;
  uploadsDir: string;
  trackerDir?: string;
  /**
   * Externally-supplied runId. The HTTP handler uses this so it can return
   * `parentRunId` synchronously — `runPaperOathPrepare` writes the pending
   * tracker row before its first await, so by the time the fire-and-forget
   * promise hands back, the row exists on disk.
   */
  runId?: string;
}

export interface PaperOathPrepareOutput {
  runId: string;
  parentRunId: string;
}

// ─── Test escape hatches ───────────────────────────────────

type OcrFn = <T>(req: OcrRequest<T>) => Promise<OcrResult<T>>;
let _ocrFn: OcrFn | undefined;

/** @internal — test escape hatch. */
export function __setOcrForTests(fn: OcrFn | undefined): void {
  _ocrFn = fn;
}

type EidLookupEnqueueFn = (
  inputs: Array<{ name: string; __prepIndex: number }>,
  parentRunId: string,
) => Promise<void>;
let _eidLookupEnqueueFn: EidLookupEnqueueFn | undefined;

/** @internal — test escape hatch. */
export function __setEidLookupEnqueueForTests(fn: EidLookupEnqueueFn | undefined): void {
  _eidLookupEnqueueFn = fn;
}

// ─── Public entry ─────────────────────────────────────────

/**
 * Run OCR + roster match on a paper-oath-roster PDF and write a tracker
 * row with `data.mode === "prepare"`. Returns immediately after the
 * synchronous OCR + match phase; the async EID-lookup phase (if any
 * unmatched signed rows) continues in the background and emits further
 * `running` events as each record resolves.
 *
 * Status transitions:
 *   pending → running(loading-roster) → running(ocr) → running(matching)
 *     → done                                              (no eid-lookup needed)
 *     OR
 *     → running(eid-lookup) → ... → done                  (with progressive updates)
 *
 * Unsigned rows (`signed === false`) are kept in the records list with
 * `matchState: "extracted"`, `selected: false`, and skipped from both
 * roster matching and eid-lookup. They give the operator a complete
 * picture of the page (so they can spot OCR misreads) without ever
 * becoming approvable kernel inputs.
 */
export async function runPaperOathPrepare(
  input: PaperOathPrepareInput,
): Promise<PaperOathPrepareOutput> {
  const runId = input.runId ?? randomUUID();
  const id = `oath-prep-${dateLocal()}-${runId.slice(0, 8)}`;
  const trackerDir = input.trackerDir;

  const writeTracker = (
    status: "pending" | "running" | "done" | "failed",
    data: Partial<OathPrepareRowData>,
    step?: string,
    error?: string,
  ): void => {
    trackEvent(
      {
        workflow: WORKFLOW,
        timestamp: new Date().toISOString(),
        id,
        runId,
        status,
        ...(step ? { step } : {}),
        data: flattenForData(data),
        ...(error ? { error } : {}),
      },
      trackerDir,
    );
  };

  // Initial pending row — written before the first await so the HTTP
  // handler's fire-and-forget caller sees the row by the time it returns.
  writeTracker("pending", {
    mode: "prepare",
    pdfPath: input.pdfPath,
    pdfOriginalName: input.pdfOriginalName,
    rosterPath: "",
    records: [],
  });

  try {
    // ── 1. Pick the roster
    if (!existsSync(input.rosterDir)) {
      mkdirSync(input.rosterDir, { recursive: true });
    }
    const rosterRef = findLatestRoster(input.rosterDir);
    if (!rosterRef) {
      writeTracker(
        "failed",
        {
          mode: "prepare",
          pdfPath: input.pdfPath,
          pdfOriginalName: input.pdfOriginalName,
          rosterPath: "",
          records: [],
        },
        undefined,
        `No roster found in ${input.rosterDir}. Place an .xlsx there or use the SharePoint Download button.`,
      );
      return { runId, parentRunId: runId };
    }
    writeTracker("running", { rosterPath: rosterRef.filename }, "loading-roster");
    const roster = await loadRoster(rosterRef.path);
    log.step(`[oath-prep] Loaded roster ${rosterRef.filename} (${roster.length} rows)`);

    // ── 2. Run OCR
    writeTracker("running", { rosterPath: rosterRef.filename }, "ocr");
    const ocrFn = _ocrFn ?? (ocrDocument as OcrFn);
    const ocrResult = await ocrFn({
      pdfPath: input.pdfPath,
      schema: OathOcrOutputSchema,
      schemaName: "oath-roster-batch",
    });
    log.step(
      `[oath-prep] OCR returned ${ocrResult.data.length} record(s) (provider=${ocrResult.provider}, attempts=${ocrResult.attempts}, cached=${ocrResult.cached})`,
    );

    // ── 3. Match each record against the roster
    writeTracker(
      "running",
      {
        rosterPath: rosterRef.filename,
        ocrProvider: ocrResult.provider,
        ocrAttempts: ocrResult.attempts,
        ocrCached: ocrResult.cached,
      },
      "matching",
    );

    const records: OathPreviewRecord[] = ocrResult.data.map((r): OathPreviewRecord => {
      // Unsigned row: skip matching, deselect, keep in the preview for
      // operator visibility (catches OCR misreads of the signed/unsigned
      // column).
      if (!r.signed) {
        return {
          ...r,
          employeeId: "",
          matchState: "extracted",
          selected: false,
          warnings: [],
        };
      }
      const result = matchAgainstRoster(roster, r.printedName);
      if (result.bestScore >= ROSTER_AUTO_ACCEPT) {
        const top = result.candidates[0];
        return {
          ...r,
          employeeId: top.eid,
          matchState: "matched",
          matchSource: "roster",
          matchConfidence: top.score,
          rosterCandidates: result.candidates.slice(0, 3),
          selected: true,
          warnings:
            top.score < 1.0
              ? [`Roster fuzzy-matched "${top.name}" (score ${top.score.toFixed(2)})`]
              : [],
        };
      }
      // Signed but no good roster match — eid-lookup needed.
      return {
        ...r,
        employeeId: "",
        matchState: "lookup-pending",
        rosterCandidates: result.candidates.slice(0, 3),
        selected: true,
        warnings:
          result.candidates.length > 0
            ? [`Best roster score ${result.bestScore.toFixed(2)} < ${ROSTER_AUTO_ACCEPT} — needs eid-lookup`]
            : ["No roster match — falling back to eid-lookup"],
      };
    });

    // ── 4. Build the final data object
    const finalData: OathPrepareRowData = {
      mode: "prepare",
      pdfPath: input.pdfPath,
      pdfOriginalName: input.pdfOriginalName,
      rosterPath: rosterRef.filename,
      records,
      ocrProvider: ocrResult.provider,
      ocrAttempts: ocrResult.attempts,
      ocrCached: ocrResult.cached,
    };
    OathPrepareRowDataSchema.parse(finalData);

    // ── 5. Done now if no records need eid-lookup; else kick off async
    let pendingCount = 0;
    let approvableCount = 0;
    for (const r of records) {
      if (r.matchState === "lookup-pending") pendingCount += 1;
      if (r.selected) approvableCount += 1;
    }
    if (pendingCount === 0) {
      writeTracker("done", finalData);
      log.success(
        `[oath-prep] All ${approvableCount} approvable record(s) matched without eid-lookup`,
      );
    } else {
      writeTracker("running", finalData, "eid-lookup");
      log.step(
        `[oath-prep] ${pendingCount} record(s) need eid-lookup — kicking off async`,
      );
      void resolveEidsAsync(runId, id, finalData, trackerDir).catch((err) => {
        log.warn(`[oath-prep] resolveEidsAsync threw: ${errorMessage(err)}`);
      });
    }

    return { runId, parentRunId: runId };
  } catch (err) {
    writeTracker(
      "failed",
      {
        mode: "prepare",
        pdfPath: input.pdfPath,
        pdfOriginalName: input.pdfOriginalName,
        rosterPath: "",
        records: [],
      },
      undefined,
      errorMessage(err),
    );
    return { runId, parentRunId: runId };
  }
}

// ─── Async EID resolution ──────────────────────────────────

async function resolveEidsAsync(
  runId: string,
  id: string,
  data: OathPrepareRowData,
  trackerDir?: string,
): Promise<void> {
  const pending = data.records
    .map((r, i) => ({ r, i }))
    .filter(({ r }) => r.matchState === "lookup-pending");
  if (pending.length === 0) return;

  const writeRunningEidLookup = (): void => {
    trackEvent(
      {
        workflow: WORKFLOW,
        timestamp: new Date().toISOString(),
        id,
        runId,
        status: "running",
        step: "eid-lookup",
        data: flattenForData(data),
      },
      trackerDir,
    );
  };

  const writeDone = (): void => {
    trackEvent(
      {
        workflow: WORKFLOW,
        timestamp: new Date().toISOString(),
        id,
        runId,
        status: "done",
        data: flattenForData(data),
      },
      trackerDir,
    );
  };

  const lookupInputs = pending.map(({ r, i }) => ({
    name: r.printedName,
    __prepIndex: i,
  }));

  try {
    if (_eidLookupEnqueueFn) {
      await _eidLookupEnqueueFn(lookupInputs, runId);
    } else {
      const { ensureDaemonsAndEnqueue } = await import("../../core/daemon-client.js");
      const { eidLookupCrmWorkflow } = await import("../eid-lookup/index.js");
      const enqueueInputs = lookupInputs.map(({ name }) => ({ name }));
      await ensureDaemonsAndEnqueue(
        eidLookupCrmWorkflow,
        enqueueInputs,
        {},
        {
          deriveItemId: (input: { name: string }) => {
            const target = input.name;
            const found = lookupInputs.find((x) => x.name === target);
            const idx = found?.__prepIndex ?? 0;
            return `oath-prep-${runId}-r${idx}`;
          },
        },
      );
    }
  } catch (err) {
    log.warn(
      `[oath-prep] eid-lookup enqueue failed: ${errorMessage(err)} — marking remaining as unresolved`,
    );
    for (const { i } of pending) {
      data.records[i].matchState = "unresolved";
      data.records[i].warnings.push(`eid-lookup unavailable: ${errorMessage(err)}`);
    }
    writeDone();
    return;
  }

  for (const { i } of pending) {
    data.records[i].matchState = "lookup-running";
  }
  writeRunningEidLookup();

  // ── Subscribe to eid-lookup tracker JSONL for completions
  const eidLookupFile = join(trackerDir ?? ".tracker", `eid-lookup-${dateLocal()}.jsonl`);
  const expectedIds = new Set(pending.map(({ i }) => `oath-prep-${runId}-r${i}`));
  let resolvedCount = 0;
  let lastSize = 0;

  const checkFile = (): void => {
    if (!existsSync(eidLookupFile)) return;
    let cur;
    try {
      cur = statSync(eidLookupFile);
    } catch {
      return;
    }
    if (cur.size <= lastSize) return;
    let raw;
    try {
      raw = readFileSync(eidLookupFile, "utf-8");
    } catch {
      return;
    }
    const lines = raw.split("\n").filter(Boolean);
    let progressed = false;
    for (const line of lines) {
      let entry: { id?: string; status?: string; data?: { emplId?: string } };
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      if (!entry.id || !expectedIds.has(entry.id)) continue;
      if (entry.status !== "done" && entry.status !== "failed") continue;
      const idx = Number(entry.id.split("-r").pop());
      if (!Number.isFinite(idx)) continue;
      const rec = data.records[idx];
      if (!rec || (rec.matchState !== "lookup-pending" && rec.matchState !== "lookup-running")) continue;

      const eid = (entry.data?.emplId ?? "").trim();
      const looksLikeEid = /^\d{5,}$/.test(eid);
      if (entry.status === "done" && looksLikeEid) {
        rec.employeeId = eid;
        rec.matchState = "resolved";
        rec.matchSource = "eid-lookup";
      } else {
        rec.matchState = "unresolved";
        rec.warnings.push(
          `eid-lookup ${entry.status === "done" ? `returned "${eid || "no result"}"` : "failed"}`,
        );
      }
      resolvedCount += 1;
      progressed = true;
    }
    lastSize = cur.size;
    if (progressed) writeRunningEidLookup();
    if (resolvedCount >= pending.length) finalize();
  };

  let finalized = false;
  const finalize = (): void => {
    if (finalized) return;
    finalized = true;
    for (const { i } of pending) {
      const r = data.records[i];
      if (r.matchState === "lookup-pending" || r.matchState === "lookup-running") {
        r.matchState = "unresolved";
        r.warnings.push("eid-lookup did not return within timeout");
      }
    }
    writeDone();
    try {
      watcher?.close();
    } catch {
      /* ignore */
    }
  };

  let watcher: ReturnType<typeof fsWatch> | undefined;
  try {
    if (existsSync(eidLookupFile)) {
      lastSize = 0;
    }
    checkFile();
    if (resolvedCount < pending.length) {
      try {
        watcher = fsWatch(eidLookupFile, { persistent: false }, () => checkFile());
      } catch {
        // fs.watch failed — polling covers
      }
      const poll = setInterval(() => {
        checkFile();
        if (finalized) clearInterval(poll);
      }, 200);
      poll.unref?.();

      setTimeout(() => {
        if (!finalized) {
          log.warn(`[oath-prep] eid-lookup timeout after ${EID_LOOKUP_TIMEOUT_MS}ms`);
          finalize();
          clearInterval(poll);
        }
      }, EID_LOOKUP_TIMEOUT_MS).unref?.();
    }
  } catch (err) {
    log.warn(`[oath-prep] subscription setup failed: ${errorMessage(err)}`);
    finalize();
  }
}

// ─── Helpers ──────────────────────────────────────────────

function flattenForData(d: Partial<OathPrepareRowData>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(d)) {
    if (v === undefined || v === null) continue;
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
      out[k] = String(v);
    } else {
      try {
        out[k] = JSON.stringify(v);
      } catch {
        out[k] = String(v);
      }
    }
  }
  return out;
}
