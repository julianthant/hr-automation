import { existsSync, mkdirSync, readFileSync, statSync, watch as fsWatch } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { OcrRequest, OcrResult } from "../../ocr/index.js";
import { runOcrPipeline } from "../../ocr/pipeline.js";
import { dateLocal, trackEvent } from "../../tracker/jsonl.js";
import { errorMessage } from "../../utils/errors.js";
import { log } from "../../utils/log.js";
import { isAcceptedDept } from "../eid-lookup/search.js";
import type { Verification } from "../emergency-contact/preview-schema.js";
import {
  findLatestRoster,
  loadRoster,
  matchAgainstRoster,
} from "../../match/index.js";
import {
  OathOcrOutputSchema,
  OathRosterOcrRecordSchema,
  OathPrepareRowDataSchema,
  type OathPrepareRowData,
  type OathPreviewRecord,
} from "./preview-schema.js";
import type { EidLookupItem } from "../eid-lookup/schema.js";

const WORKFLOW = "oath-signature";

const OATH_OCR_PROMPT = `You are an OCR system. Extract structured data from the attached PDF.

The PDF is a stack of paper oath signature documents in one of three formats — each page is one of:
- "signin"  — multi-row sign-in sheet (many records per page)
- "upay585" — single-form per page, UPAY585 (1997, includes Patent Acknowledgment)
- "upay586" — single-form per page, UPAY586 (2015 DocuSign, oath only)
- "unknown" — blank, irrelevant, or doesn't match any of the above

For each page you process:

1. Classify the document type. Map "signin" / "upay585" / "upay586" to \`documentType: "expected"\`; "unknown" → \`documentType: "unknown"\`.

2. For each record extract:
   - printedName (always)
   - employeeId if visible on the form
   - dateSigned if visible
   - employeeSigned: whether the employee/officer signature line is filled (a scribble counts; an empty box doesn't)
   - officerSigned: whether the authorized-official / witness signature is filled. For sign-in sheets that only have a single signature column, set \`officerSigned\` to null. For UPAY585/UPAY586, false when the column is empty.

3. After extraction, report which expected fields were BLANK or ILLEGIBLE on the paper:
   - printedName (always expected)
   - dateSigned (only for signed records)
   - employeeSigned (if false, treat the missing employee signature as a blank field worth flagging)
   - officerSigned (if false on a UPAY585/UPAY586, flag it; if null on a signin, do not flag)

   Add the names of any blank/illegible expected fields to \`originallyMissing\` on each record.

Field-level rules:
- One record per signer (multi-row sign-in sheets emit multiple records per page; single-form pages emit one).
- For handwritten text, use your best transcription. If a field is illegible, set it to null and add it to \`originallyMissing\`.
- dateSigned should be transcribed as it appears on the paper (typical formats: MM/DD/YYYY or M/D/YY).
- Output ONLY valid JSON matching the schema. No commentary.`;

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

type EnqueueItem =
  | { name: string; __prepIndex: number; __itemId: string }
  | { emplId: string; __prepIndex: number; __itemId: string };
type EidLookupEnqueueFn = (
  inputs: EnqueueItem[],
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
    //
    // Same two-tier shape as emergency-contact's prep: per-page parallel
    // across the multi-provider key pool when available, whole-PDF
    // fallback otherwise. See `src/ocr/pipeline.ts` for the threshold +
    // fallback logic.
    writeTracker("running", { rosterPath: rosterRef.filename }, "ocr");
    const pageImagesTargetDir = join(input.uploadsDir, runId);
    const ocrResult = await runOcrPipeline({
      pdfPath: input.pdfPath,
      pageImagesDir: pageImagesTargetDir,
      recordSchema: OathRosterOcrRecordSchema,
      arraySchema: OathOcrOutputSchema,
      prompt: OATH_OCR_PROMPT,
      schemaName: "oath-roster-batch",
      ocrFnOverride: _ocrFn,
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
      if (!r.employeeSigned) {
        return {
          ...r,
          employeeId: "",
          matchState: "extracted",
          documentType: "expected",
          originallyMissing: [],
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
          documentType: "expected",
          originallyMissing: [],
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
        documentType: "expected",
        originallyMissing: [],
        selected: true,
        warnings:
          result.candidates.length > 0
            ? [`Best roster score ${result.bestScore.toFixed(2)} < ${ROSTER_AUTO_ACCEPT} — needs eid-lookup`]
            : ["No roster match — falling back to eid-lookup"],
      };
    });

    // ── 3b. Page images: the OCR pipeline already rendered them when
    // it took the per-page path. Whole-PDF fallback returns "" and the
    // dashboard's preview tile silently drops to its 404 placeholder.
    const pageImagesDir = ocrResult.pageImagesDir || undefined;
    if (pageImagesDir) {
      log.step(`[oath-prep] Page previews available at ${pageImagesDir}`);
    }

    // ── 4. Build the final data object
    const finalData: OathPrepareRowData = {
      mode: "prepare",
      pdfPath: input.pdfPath,
      pdfOriginalName: input.pdfOriginalName,
      rosterPath: rosterRef.filename,
      pageImagesDir,
      records,
      ocrProvider: ocrResult.provider,
      ocrAttempts: ocrResult.attempts,
      ocrCached: ocrResult.cached,
    };
    OathPrepareRowDataSchema.parse(finalData);

    // ── 5. Plan stages 4 (eid-lookup) + 5 (verification).
    let pendingNameCount = 0;
    let pendingVerifyCount = 0;
    let approvableCount = 0;
    for (const r of records) {
      if (r.matchState === "lookup-pending") {
        pendingNameCount += 1;
      } else if (
        r.employeeId &&
        (r.matchState === "matched" || r.matchState === "resolved")
      ) {
        pendingVerifyCount += 1;
      }
      if (r.selected) approvableCount += 1;
    }
    if (pendingNameCount === 0 && pendingVerifyCount === 0) {
      writeTracker("done", finalData);
      log.success(
        `[oath-prep] All ${approvableCount} approvable record(s) terminal without eid-lookup`,
      );
    } else {
      writeTracker("running", finalData, "eid-lookup");
      log.step(
        `[oath-prep] ${pendingNameCount} name lookup(s) + ${pendingVerifyCount} verify(s) — kicking off async`,
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
  const pendingName = data.records
    .map((r, i) => ({ r, i }))
    .filter(({ r }) => r.matchState === "lookup-pending");
  const pendingVerify = data.records
    .map((r, i) => ({ r, i }))
    .filter(
      ({ r }) =>
        Boolean(r.employeeId) &&
        (r.matchState === "matched" || r.matchState === "resolved"),
    );
  if (pendingName.length === 0 && pendingVerify.length === 0) return;

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

  const enqueueItems: EnqueueItem[] = [
    ...pendingName.map(({ r, i }) => ({
      name: r.printedName,
      __prepIndex: i,
      __itemId: `oath-prep-${runId}-r${i}`,
    })),
    ...pendingVerify.map(({ r, i }) => ({
      emplId: r.employeeId,
      __prepIndex: i,
      __itemId: `oath-verify-${runId}-r${i}`,
    })),
  ];

  try {
    if (_eidLookupEnqueueFn) {
      await _eidLookupEnqueueFn(enqueueItems, runId);
    } else {
      const { ensureDaemonsAndEnqueue } = await import("../../core/daemon-client.js");
      const { eidLookupCrmWorkflow } = await import("../eid-lookup/index.js");
      const enqueueInputs: EidLookupItem[] = enqueueItems.map((item) =>
        "name" in item ? { name: item.name } : { emplId: item.emplId, keepNonHdh: true },
      );
      await ensureDaemonsAndEnqueue(
        eidLookupCrmWorkflow,
        enqueueInputs,
        {},
        {
          deriveItemId: (input: EidLookupItem) => {
            if ("name" in input) {
              const found = enqueueItems.find(
                (x) => "name" in x && x.name === input.name,
              );
              return found?.__itemId ?? `oath-prep-${runId}-r0`;
            }
            const found = enqueueItems.find(
              (x) => "emplId" in x && x.emplId === input.emplId,
            );
            return found?.__itemId ?? `oath-verify-${runId}-r0`;
          },
        },
      );
    }
  } catch (err) {
    log.warn(
      `[oath-prep] eid-lookup enqueue failed: ${errorMessage(err)} — marking remaining as unresolved`,
    );
    for (const { i } of pendingName) {
      data.records[i].matchState = "unresolved";
      data.records[i].warnings.push(`eid-lookup unavailable: ${errorMessage(err)}`);
    }
    writeDone();
    return;
  }

  for (const { i } of pendingName) {
    data.records[i].matchState = "lookup-running";
  }
  writeRunningEidLookup();

  // ── Subscribe to eid-lookup tracker JSONL for completions of either prefix.
  const eidLookupFile = join(trackerDir ?? ".tracker", `eid-lookup-${dateLocal()}.jsonl`);
  const expectedIds = new Set(enqueueItems.map((x) => x.__itemId));
  const totalExpected = expectedIds.size;
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
      let entry: {
        id?: string;
        status?: string;
        data?: {
          emplId?: string;
          hrStatus?: string;
          department?: string;
          personOrgScreenshot?: string;
        };
      };
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      if (!entry.id || !expectedIds.has(entry.id)) continue;
      if (entry.status !== "done" && entry.status !== "failed") continue;

      const isVerify = entry.id.startsWith(`oath-verify-${runId}-`);
      const idx = Number(entry.id.split("-r").pop());
      if (!Number.isFinite(idx)) continue;
      const rec = data.records[idx];
      if (!rec) continue;

      const eid = (entry.data?.emplId ?? "").trim();
      const looksLikeEid = /^\d{5,}$/.test(eid);

      if (!isVerify) {
        if (rec.matchState !== "lookup-pending" && rec.matchState !== "lookup-running") continue;
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
      }

      const v = computeVerification({
        hrStatus: entry.data?.hrStatus,
        department: entry.data?.department,
        personOrgScreenshot: entry.data?.personOrgScreenshot,
      });
      rec.verification = v;
      if (v.state !== "verified") {
        rec.selected = false;
      }
      expectedIds.delete(entry.id);
      resolvedCount += 1;
      progressed = true;
    }
    lastSize = cur.size;
    if (progressed) writeRunningEidLookup();
    if (resolvedCount >= totalExpected) finalize();
  };

  let finalized = false;
  const finalize = (): void => {
    if (finalized) return;
    finalized = true;
    for (const { i } of pendingName) {
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
    if (resolvedCount < totalExpected) {
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

/**
 * Pure transform from an eid-lookup result row's data fields into a
 * `Verification` discriminator. Mirrors the EC helper — kept duplicated
 * to keep each prep orchestrator self-contained.
 */
export function computeVerification(d: {
  hrStatus?: string;
  department?: string;
  personOrgScreenshot?: string;
}): Verification {
  const checkedAt = new Date().toISOString();
  if (!d.hrStatus) {
    return { state: "lookup-failed", error: "no result", checkedAt };
  }
  const active = d.hrStatus === "Active";
  const hdh = isAcceptedDept(d.department ?? null);
  const screenshotFilename = d.personOrgScreenshot ?? "";
  if (!active) {
    return {
      state: "inactive",
      hrStatus: d.hrStatus,
      department: d.department,
      screenshotFilename,
      checkedAt,
    };
  }
  if (!hdh) {
    return {
      state: "non-hdh",
      hrStatus: d.hrStatus,
      department: d.department ?? "",
      screenshotFilename,
      checkedAt,
    };
  }
  return {
    state: "verified",
    hrStatus: d.hrStatus,
    department: d.department ?? "",
    screenshotFilename,
    checkedAt,
  };
}

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
