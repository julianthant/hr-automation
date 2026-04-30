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
  compareUsAddresses,
  normalizeEid,
} from "../../match/index.js";
import {
  OcrOutputSchema,
  PrepareRowDataSchema,
  type PreviewRecord,
  type PrepareRowData,
} from "./preview-schema.js";
import type { EmergencyContactRecord } from "./schema.js";

const WORKFLOW = "emergency-contact";

const EC_OCR_PROMPT = `You are an OCR system. Extract structured data from the attached PDF.

The PDF is a stack of UCSD R&R Emergency Contact Information forms — one form per page (occasionally a page may not be a form at all). For each page produce one record.

For each page you process:

1. Classify the document type:
   - "expected" if the page is a UCSD R&R Emergency Contact Information form
   - "unknown" if the page is blank, a different form, a scan artifact, or anything that doesn't match the expected template

2. After extracting fields, also report which expected fields were BLANK or ILLEGIBLE on the paper.
   The expected fields for this form are:
     - employee.name
     - employee.employeeId
     - emergencyContact.name
     - emergencyContact.relationship
     - emergencyContact.address
     - emergencyContact.cellPhone, homePhone, workPhone (any one is sufficient — list none of these as missing if at least one is filled)

   Add the names of any blank/illegible expected fields to a \`originallyMissing\` array on the record.
   The match phase will fill values from the roster; the operator needs the list to know which to write back on the physical paper.

Field-level rules:
- Extract every record visible in the PDF; produce one entry per page.
- For handwritten text, use your best transcription. If a field is illegible, set it to null where the schema allows AND add the field path to \`originallyMissing\`.
- Phone numbers should be normalized to "(XXX) XXX-XXXX" format when the digits are clear.
- Addresses: keep US format. Pull out street, city, state (2-letter), and ZIP into separate fields if the schema requests them.
- Do not invent data. If a field is blank on the form, return null (or omit per schema) and list the field in \`originallyMissing\`.
- Output ONLY valid JSON matching the schema. No commentary.`;

/** Auto-accept threshold for roster name match. Records below land in lookup-pending. */
const ROSTER_AUTO_ACCEPT = 0.85;

/** How long the prep handler waits for eid-lookup completions before giving up. */
const EID_LOOKUP_TIMEOUT_MS = 10 * 60_000;

export interface PrepareInput {
  pdfPath: string;
  pdfOriginalName: string;
  rosterMode: "download" | "existing";
  rosterDir: string;
  uploadsDir: string;
  trackerDir?: string;
  /**
   * Externally-supplied runId. The HTTP handler uses this so it can
   * return the parentRunId in its response BEFORE awaiting OCR — the
   * synchronous "pending" write happens before the first await, so the
   * tracker row exists by the time the fire-and-forget caller resumes.
   * When omitted, `runPrepare` generates one.
   */
  runId?: string;
}

export interface PrepareOutput {
  runId: string;
  /** Same as runId — exposed under both names so the HTTP shim is explicit. */
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

/**
 * @internal — test escape hatch. Replaces the eid-lookup daemon enqueue
 * with a no-op (or test-defined behavior). When unset, the real
 * `ensureDaemonsAndEnqueue` is used.
 */
export function __setEidLookupEnqueueForTests(fn: EidLookupEnqueueFn | undefined): void {
  _eidLookupEnqueueFn = fn;
}

// ─── Public entry point ────────────────────────────────────

/**
 * Run OCR + roster match on a PDF and write a tracker row with
 * `data.mode === "prepare"`. Returns immediately after the synchronous
 * OCR + match phase; the async EID-lookup phase (if any records need it)
 * continues in the background and emits further `running` events as
 * each record resolves.
 *
 * Status transitions written to tracker:
 *   pending → running(loading-roster) → running(ocr) → running(matching)
 *     → done                                              (no eid-lookup needed)
 *     OR
 *     → running(eid-lookup) → ... → done                  (with progressive updates)
 */
export async function runPrepare(input: PrepareInput): Promise<PrepareOutput> {
  const runId = input.runId ?? randomUUID();
  const id = `ec-prep-${dateLocal()}-${runId.slice(0, 8)}`;
  const trackerDir = input.trackerDir;

  const writeTracker = (
    status: "pending" | "running" | "done" | "failed",
    data: Partial<PrepareRowData>,
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

  // Initial pending row.
  writeTracker("pending", {
    mode: "prepare",
    pdfPath: input.pdfPath,
    pdfOriginalName: input.pdfOriginalName,
    rosterMode: input.rosterMode,
    rosterPath: "",
    records: [],
  });

  try {
    // ── 1. Pick roster
    if (!existsSync(input.rosterDir)) {
      mkdirSync(input.rosterDir, { recursive: true });
    }
    const rosterRef = findLatestRoster(input.rosterDir);
    if (!rosterRef) {
      writeTracker(
        "failed",
        { mode: "prepare", pdfPath: input.pdfPath, pdfOriginalName: input.pdfOriginalName, rosterMode: input.rosterMode, rosterPath: "", records: [] },
        undefined,
        `No roster found in ${input.rosterDir}. Use "download" mode or place an .xlsx there.`,
      );
      return { runId, parentRunId: runId };
    }
    writeTracker("running", { rosterPath: rosterRef.filename }, "loading-roster");
    const roster = await loadRoster(rosterRef.path);
    log.step(`[prepare] Loaded roster ${rosterRef.filename} (${roster.length} rows)`);

    // ── 2. Run OCR
    writeTracker("running", { rosterPath: rosterRef.filename }, "ocr");
    const ocrFn = _ocrFn ?? (ocrDocument as OcrFn);
    const ocrResult = await ocrFn({
      pdfPath: input.pdfPath,
      schema: OcrOutputSchema,
      prompt: EC_OCR_PROMPT,
      schemaName: "emergency-contact-batch",
    });
    log.step(
      `[prepare] OCR returned ${ocrResult.data.length} record(s) (provider=${ocrResult.provider}, attempts=${ocrResult.attempts}, cached=${ocrResult.cached})`,
    );

    // ── 3. Match each record (synchronous: form-EID + roster)
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

    const records: PreviewRecord[] = ocrResult.data.map((r): PreviewRecord => {
      const existingEid = normalizeEid(r.employee.employeeId);
      if (existingEid) {
        return {
          ...r,
          employee: { ...r.employee, employeeId: existingEid },
          matchState: "matched",
          matchSource: "form",
          matchConfidence: 1.0,
          documentType: "expected",
          originallyMissing: [],
          selected: true,
          warnings: [],
        };
      }
      const result = matchAgainstRoster(roster, r.employee.name);
      if (result.bestScore >= ROSTER_AUTO_ACCEPT) {
        const top = result.candidates[0];
        return {
          ...r,
          employee: { ...r.employee, employeeId: top.eid },
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
      // No good roster match — eid-lookup needed.
      return {
        ...r,
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

    // ── 4. Address sanity check (using employee.homeAddress vs roster row)
    for (const r of records) {
      if (r.matchSource === "roster") {
        const top = r.rosterCandidates?.[0];
        if (top) {
          const rosterRow = roster.find((x) => x.eid === top.eid);
          if (rosterRow && rosterRow.street) {
            r.addressMatch = compareUsAddresses(
              r.employee.homeAddress ?? null,
              {
                street: rosterRow.street,
                city: rosterRow.city,
                state: rosterRow.state,
                zip: rosterRow.zip,
              },
            );
          }
        }
      }
    }

    // ── 5. Build the final data object
    const finalData: PrepareRowData = {
      mode: "prepare",
      pdfPath: input.pdfPath,
      pdfOriginalName: input.pdfOriginalName,
      rosterMode: input.rosterMode,
      rosterPath: rosterRef.filename,
      records,
      ocrProvider: ocrResult.provider,
      ocrAttempts: ocrResult.attempts,
      ocrCached: ocrResult.cached,
    };
    PrepareRowDataSchema.parse(finalData); // throws if invariants broken

    // ── 6. If all records have a terminal matchState, write done now.
    let pendingCount = 0;
    for (const r of records) {
      if (r.matchState === "lookup-pending") pendingCount += 1;
    }
    if (pendingCount === 0) {
      writeTracker("done", finalData);
      log.success(`[prepare] All ${records.length} record(s) matched without eid-lookup`);
    } else {
      writeTracker("running", finalData, "eid-lookup");
      log.step(
        `[prepare] ${pendingCount} record(s) need eid-lookup — kicking off async`,
      );
      // Fire async; HTTP handler returns immediately after this function returns.
      void resolveEidsAsync(runId, id, finalData, trackerDir).catch((err) => {
        log.warn(`[prepare] resolveEidsAsync threw: ${errorMessage(err)}`);
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
        rosterMode: input.rosterMode,
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
  data: PrepareRowData,
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

  // ── Enqueue eid-lookup items (one per pending record).
  const lookupInputs = pending.map(({ r, i }) => ({
    name: r.employee.name,
    __prepIndex: i,
  }));

  try {
    if (_eidLookupEnqueueFn) {
      await _eidLookupEnqueueFn(lookupInputs, runId);
    } else {
      const { ensureDaemonsAndEnqueue } = await import("../../core/daemon-client.js");
      const { eidLookupCrmWorkflow } = await import("../eid-lookup/index.js");
      // The eid-lookup schema is z.object({ name }). Strip __prepIndex when
      // sending; recover the index from the deriveItemId output instead.
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
            return `ec-prep-${runId}-r${idx}`;
          },
        },
      );
    }
  } catch (err) {
    log.warn(`[prepare] eid-lookup enqueue failed: ${errorMessage(err)} — marking remaining as unresolved`);
    for (const { i } of pending) {
      data.records[i].matchState = "unresolved";
      data.records[i].warnings.push(`eid-lookup unavailable: ${errorMessage(err)}`);
    }
    writeDone();
    return;
  }

  // Mark records as lookup-running.
  for (const { i } of pending) {
    data.records[i].matchState = "lookup-running";
  }
  writeRunningEidLookup();

  // ── Subscribe to eid-lookup tracker JSONL for completions.
  const eidLookupFile = join(trackerDir ?? ".tracker", `eid-lookup-${dateLocal()}.jsonl`);
  const expectedIds = new Set(pending.map(({ i }) => `ec-prep-${runId}-r${i}`));
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
        rec.employee.employeeId = eid;
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
    if (resolvedCount >= pending.length) {
      finalize();
    }
  };

  let finalized = false;
  const finalize = (): void => {
    if (finalized) return;
    finalized = true;
    // Mark anything still hanging as unresolved.
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
      lastSize = statSync(eidLookupFile).size;
      // Re-read from 0 in case results landed before subscription.
      lastSize = 0;
    }
    checkFile();
    if (resolvedCount < pending.length) {
      try {
        watcher = fsWatch(eidLookupFile, { persistent: false }, () => checkFile());
      } catch {
        // fs.watch failed — fall back to polling
      }
      // Periodic poll as belt-and-braces (some filesystems miss watch events,
      // and fs.watch on a non-existent file throws ENOENT — polling covers
      // the gap until the file appears).
      const poll = setInterval(() => {
        checkFile();
        if (finalized) clearInterval(poll);
      }, 200);
      poll.unref?.();

      // Hard timeout safety net.
      setTimeout(() => {
        if (!finalized) {
          log.warn(`[prepare] eid-lookup timeout after ${EID_LOOKUP_TIMEOUT_MS}ms`);
          finalize();
          clearInterval(poll);
        }
      }, EID_LOOKUP_TIMEOUT_MS).unref?.();
    }
  } catch (err) {
    log.warn(`[prepare] subscription setup failed: ${errorMessage(err)}`);
    finalize();
  }
}

// ─── Helpers ──────────────────────────────────────────────

function flattenForData(d: Partial<PrepareRowData>): Record<string, string> {
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
