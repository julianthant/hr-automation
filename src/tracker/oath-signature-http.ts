/**
 * HTTP handlers for the oath-signature paper-roster "Run" button flow.
 *
 *   POST /api/oath-signature/prepare        — multipart upload (PDF only)
 *   POST /api/oath-signature/approve-batch  — JSON
 *   POST /api/oath-signature/discard-prepare — JSON
 *
 * Plus `sweepStuckOathPrepRows(dir)` for the dashboard's startup sweep.
 *
 * Mirrors `emergency-contact-http.ts` deliberately — same prepare-row
 * pattern (`data.mode === "prepare"`), single-workflow scoping
 * (parent + children both carry `workflow: "oath-signature"`), same
 * fan-out-on-approve shape. The roster source is fixed: paper rosters
 * always match against the SharePoint onboarding xlsx (no `rosterMode`
 * input field — operator places the xlsx in `.tracker/rosters/` or
 * `src/data/`, prepare picks the newest).
 */
import { existsSync, mkdirSync } from "node:fs";
import { writeFile, unlink, rm as fsRm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

import {
  dateLocal,
  listDatesForWorkflow,
  readEntries,
  readEntriesForDate,
  trackEvent,
  trackEventForDate,
  type TrackerEntry,
} from "./jsonl.js";
import { log } from "../utils/log.js";
import { errorMessage } from "../utils/errors.js";
import { runPaperOathPrepare } from "../workflows/oath-signature/prepare.js";
import { runDigitalOathPrepare } from "../workflows/oath-signature/digital-prepare.js";
import {
  OathPrepareRowDataSchema,
  OathPreviewRecordSchema,
  type OathPreviewRecord,
} from "../workflows/oath-signature/preview-schema.js";
import { OathSignatureInputSchema } from "../workflows/oath-signature/schema.js";
import { ROSTERS_DIR } from "../workflows/emergency-contact/config.js";
import { enqueueFromHttp } from "../core/enqueue-dispatch.js";

const WORKFLOW = "oath-signature";

/**
 * Locate a prep row across every available date file. Returns the latest
 * entry (used for status checks) along with `homeDate` — the date file
 * that holds the row's earliest entry. Resolution lines (approve/discard)
 * are written into `homeDate` so the dashboard's per-date SSE always picks
 * up the new state when the operator is viewing the date the prep row was
 * born on (typically the only place they encounter the row).
 *
 * `readEntries(WORKFLOW, dir)` alone would only consult today's local-date
 * file — which misses prep rows created late on the previous local day,
 * those whose history was split across midnight by an in-flight prep, and
 * any stale orphan-resolution lines left in the wrong file by an earlier
 * version of this code. Scanning every date returned by
 * `listDatesForWorkflow` makes the lookup robust to all three.
 */
function findPrepRow(
  parentRunId: string,
  dir: string,
): { latest: TrackerEntry; homeDate: string } | null {
  let latest: TrackerEntry | null = null;
  let homeDate: string | null = null;
  let earliestTs: string | null = null;
  for (const date of listDatesForWorkflow(WORKFLOW, dir)) {
    for (const e of readEntriesForDate(WORKFLOW, date, dir)) {
      if (e.runId !== parentRunId) continue;
      if (!e.data || typeof e.data !== "object" || e.data.mode !== "prepare") continue;
      if (!latest || latest.timestamp < e.timestamp) latest = e;
      if (!earliestTs || e.timestamp < earliestTs) {
        earliestTs = e.timestamp;
        homeDate = date;
      }
    }
  }
  if (!latest || !homeDate) return null;
  return { latest, homeDate };
}

let _uploadsDirForTests: string | undefined;
let _prepareForTests: typeof runPaperOathPrepare | undefined;

/** @internal — tests override the uploads dir. */
export function __setUploadsDirForTests(dir: string | undefined): void {
  _uploadsDirForTests = dir;
}

/** @internal — tests can replace `runPaperOathPrepare` with a stub. */
export function __setOathPrepareForTests(
  fn: typeof runPaperOathPrepare | undefined,
): void {
  _prepareForTests = fn;
}

// ─── POST /api/oath-signature/prepare ────────────────────

export interface OathPrepareHttpInput {
  pdfBytes: Buffer;
  pdfOriginalName: string;
}

export interface OathPrepareHttpResult {
  ok: boolean;
  parentRunId?: string;
  pdfPath?: string;
  error?: string;
}

/**
 * Persist the uploaded PDF, fire-and-forget `runPaperOathPrepare`, return
 * `{ok, parentRunId, pdfPath}` synchronously. The pending tracker row is
 * written before runPaperOathPrepare's first await, so the dashboard SSE
 * poll picks it up on the next tick.
 */
export async function handleOathPrepareUpload(
  input: OathPrepareHttpInput,
  dir: string,
): Promise<OathPrepareHttpResult> {
  if (!input.pdfBytes || input.pdfBytes.length === 0) {
    return { ok: false, error: "PDF is required" };
  }

  const uploadsDir = _uploadsDirForTests ?? join(dir, "uploads");
  mkdirSync(uploadsDir, { recursive: true });
  const safeName =
    input.pdfOriginalName.replace(/[^\w.\- ]+/g, "_").slice(0, 80) || "upload.pdf";
  const filename = `${dateLocal()}-${randomUUID().slice(0, 8)}-${safeName}`;
  const pdfPath = join(uploadsDir, filename);
  await writeFile(pdfPath, input.pdfBytes);

  // Pick the canonical roster dirs. Prepare's loadRoster picks the newest
  // .xlsx in whatever dir we hand it; we pass the first that exists.
  const rosterDirs = [
    resolve(process.cwd(), ROSTERS_DIR),
    resolve(process.cwd(), "src/data"),
  ];
  const rosterDir = rosterDirs.find((d) => existsSync(d)) ?? rosterDirs[0];

  const fn = _prepareForTests ?? runPaperOathPrepare;
  const parentRunId = randomUUID();
  void fn({
    pdfPath,
    pdfOriginalName: input.pdfOriginalName,
    rosterDir,
    uploadsDir,
    trackerDir: dir,
    runId: parentRunId,
  }).catch((err) => {
    log.error(`[handleOathPrepareUpload] runPaperOathPrepare threw: ${errorMessage(err)}`);
  });
  return { ok: true, parentRunId, pdfPath };
}

// ─── POST /api/oath-signature/digital-prepare ───────────

export interface OathDigitalPrepareHttpInput {
  emplIds: unknown;
  label?: string;
}

export interface OathDigitalPrepareHttpResult {
  ok: boolean;
  parentRunId?: string;
  error?: string;
}

let _digitalPrepareForTests: typeof runDigitalOathPrepare | undefined;
/** @internal — tests can replace `runDigitalOathPrepare` with a stub. */
export function __setOathDigitalPrepareForTests(
  fn: typeof runDigitalOathPrepare | undefined,
): void {
  _digitalPrepareForTests = fn;
}

/**
 * Validate the EID list (5+ digits each, deduped) and fire-and-forget
 * `runDigitalOathPrepare`. Returns synchronously with the parentRunId
 * the operator can use to find the resulting prep row in the dashboard.
 */
export async function handleOathDigitalPrepare(
  input: OathDigitalPrepareHttpInput,
  dir: string,
): Promise<OathDigitalPrepareHttpResult> {
  if (!Array.isArray(input.emplIds) || input.emplIds.length === 0) {
    return { ok: false, error: "emplIds must be a non-empty array" };
  }
  const emplIds: string[] = [];
  const seen = new Set<string>();
  for (const raw of input.emplIds) {
    const v = String(raw ?? "").trim();
    if (!/^\d{5,}$/.test(v)) {
      return { ok: false, error: `invalid EID: ${JSON.stringify(raw)}` };
    }
    if (seen.has(v)) continue;
    seen.add(v);
    emplIds.push(v);
  }

  const fn = _digitalPrepareForTests ?? runDigitalOathPrepare;
  const parentRunId = randomUUID();
  void fn({
    emplIds,
    label: input.label ? String(input.label).slice(0, 80) : undefined,
    trackerDir: dir,
    runId: parentRunId,
  }).catch((err) => {
    log.error(`[handleOathDigitalPrepare] runDigitalOathPrepare threw: ${errorMessage(err)}`);
  });
  return { ok: true, parentRunId };
}

// ─── POST /api/oath-signature/approve-batch ─────────────

export interface OathApproveBatchInput {
  parentRunId: string;
  records: unknown[];
}

export interface OathApproveBatchResult {
  ok: boolean;
  enqueued?: number;
  parentRunId?: string;
  error?: string;
}

/**
 * Validate the user's edits, build kernel inputs (one
 * `OathSignatureInput` per selected matched/resolved preview record),
 * and enqueue them via the shared daemon-mode dispatcher. Mark the prep
 * row `done` step `approved` so the dashboard collapses it into the
 * parent of the new child rows.
 */
export async function handleOathApproveBatch(
  input: OathApproveBatchInput,
  dir: string,
): Promise<OathApproveBatchResult> {
  if (!input.parentRunId || typeof input.parentRunId !== "string") {
    return { ok: false, error: "parentRunId is required" };
  }
  if (!Array.isArray(input.records) || input.records.length === 0) {
    return { ok: false, error: "records must be a non-empty array" };
  }

  const previewRecords: OathPreviewRecord[] = [];
  for (let i = 0; i < input.records.length; i++) {
    const parsed = OathPreviewRecordSchema.safeParse(input.records[i]);
    if (!parsed.success) {
      return {
        ok: false,
        error: `record[${i}] failed validation: ${parsed.error.message}`,
      };
    }
    previewRecords.push(parsed.data);
  }

  const found = findPrepRow(input.parentRunId, dir);
  if (!found) {
    return { ok: false, error: `no prepare row found for parentRunId=${input.parentRunId}` };
  }
  const { latest: prepRow, homeDate: prepRowDate } = found;

  const approvable: OathPreviewRecord[] = [];
  const skipped: Array<{ index: number; reason: string }> = [];
  previewRecords.forEach((r, i) => {
    if (!r.selected) {
      skipped.push({ index: i, reason: "deselected by user" });
      return;
    }
    if (r.matchState !== "matched" && r.matchState !== "resolved") {
      skipped.push({ index: i, reason: `not approvable (matchState=${r.matchState})` });
      return;
    }
    if (!r.employeeId || !/^\d{5,}$/.test(r.employeeId)) {
      skipped.push({ index: i, reason: `invalid EID (${r.employeeId || "empty"})` });
      return;
    }
    approvable.push(r);
  });

  if (approvable.length === 0) {
    return {
      ok: false,
      error: `no approvable records (${skipped.length} skipped)`,
    };
  }

  // Build OathSignatureInput per approvable record. dateSigned (if any)
  // becomes the kernel's `date` field; absent → UCPath uses today's date.
  const kernelInputs: Array<unknown> = [];
  for (const r of approvable) {
    const candidate: { emplId: string; date?: string } = { emplId: r.employeeId };
    if (r.dateSigned && r.dateSigned.trim().length > 0) {
      candidate.date = r.dateSigned.trim();
    }
    const parsed = OathSignatureInputSchema.safeParse(candidate);
    if (!parsed.success) {
      return {
        ok: false,
        error: `record for "${r.printedName}" failed strict validation: ${parsed.error.message}`,
      };
    }
    kernelInputs.push(parsed.data);
  }

  const enq = await enqueueFromHttp(WORKFLOW, kernelInputs, dir);
  if (!enq.ok) {
    return { ok: false, error: enq.error ?? "enqueue failed" };
  }

  const parsedPrev = OathPrepareRowDataSchema.safeParse({
    ...prepRow.data,
    records: previewRecords,
  });
  const finalData = parsedPrev.success ? parsedPrev.data : prepRow.data;
  trackEventForDate(
    {
      workflow: WORKFLOW,
      timestamp: new Date().toISOString(),
      id: prepRow.id,
      runId: prepRow.runId,
      status: "done",
      step: "approved",
      data: flattenForData(finalData as Record<string, unknown>),
    },
    prepRowDate,
    dir,
  );

  // Best-effort cleanup of the per-run uploads dir (page renders).
  await cleanupOathUploadsDir(input.parentRunId);

  return {
    ok: true,
    enqueued: kernelInputs.length,
    parentRunId: input.parentRunId,
  };
}

// ─── POST /api/oath-signature/discard-prepare ────────────

export interface OathDiscardPrepareInput {
  parentRunId: string;
  reason?: string;
}

export interface OathDiscardPrepareResult {
  ok: boolean;
  parentRunId?: string;
  error?: string;
}

export async function handleOathDiscardPrepare(
  input: OathDiscardPrepareInput,
  dir: string,
): Promise<OathDiscardPrepareResult> {
  if (!input.parentRunId || typeof input.parentRunId !== "string") {
    return { ok: false, error: "parentRunId is required" };
  }
  const found = findPrepRow(input.parentRunId, dir);
  if (!found) {
    return { ok: false, error: `no prepare row found for parentRunId=${input.parentRunId}` };
  }
  const { latest: prepRow, homeDate: prepRowDate } = found;
  // Only block if the row is *already resolved* (approved or discarded).
  // Failed-from-restart rows must remain discardable so the operator can
  // clear them off the dashboard.
  if (prepRow.status === "done" && prepRow.step === "approved") {
    return { ok: false, error: "prepare row is already approved; nothing to discard" };
  }
  if (prepRow.status === "failed" && prepRow.step === "discarded") {
    return { ok: false, error: "prepare row is already discarded; nothing to discard" };
  }

  const pdfPath = typeof prepRow.data?.pdfPath === "string" ? prepRow.data.pdfPath : "";
  if (pdfPath) {
    try {
      await unlink(pdfPath);
    } catch {
      // Best-effort — file may already be gone.
    }
  }
  trackEventForDate(
    {
      workflow: WORKFLOW,
      timestamp: new Date().toISOString(),
      id: prepRow.id,
      runId: prepRow.runId,
      status: "failed",
      step: "discarded",
      data: prepRow.data,
      error: input.reason ?? "discarded by user",
    },
    prepRowDate,
    dir,
  );

  await cleanupOathUploadsDir(input.parentRunId);

  return { ok: true, parentRunId: input.parentRunId };
}

/**
 * Recursively remove `.tracker/uploads/<parentRunId>/`. Mirrors the
 * emergency-contact cleanup path. Best-effort — failures are logged
 * and never block the operator's success path.
 */
async function cleanupOathUploadsDir(parentRunId: string): Promise<void> {
  const uploadsDir = join(".tracker", "uploads", parentRunId);
  try {
    await fsRm(uploadsDir, { recursive: true, force: true });
    log.step(`Cleaned up oath prep uploads for ${parentRunId}`);
  } catch (err) {
    log.warn(`Failed to clean up oath prep uploads for ${parentRunId}: ${errorMessage(err)}`);
  }
}

// ─── Dashboard restart sweep ─────────────────────────────

/**
 * Mark prep rows that are still in a transient state (pending, running)
 * as failed when the dashboard backend starts up. The OCR + eid-lookup
 * polling lives in this Node process, so a backend restart leaves any
 * in-flight prep row orphaned.
 */
export function sweepStuckOathPrepRows(dir: string): number {
  let swept = 0;
  let entries: TrackerEntry[];
  try {
    entries = readEntries(WORKFLOW, dir);
  } catch {
    return 0;
  }
  const latestByRunId = new Map<string, TrackerEntry>();
  for (const e of entries) {
    if (!e.runId) continue;
    if (!e.data || typeof e.data !== "object" || e.data.mode !== "prepare") continue;
    const prev = latestByRunId.get(e.runId);
    if (!prev || prev.timestamp < e.timestamp) latestByRunId.set(e.runId, e);
  }
  for (const e of latestByRunId.values()) {
    if (e.status !== "pending" && e.status !== "running") continue;
    trackEvent(
      {
        workflow: WORKFLOW,
        timestamp: new Date().toISOString(),
        id: e.id,
        runId: e.runId,
        status: "failed",
        step: e.step ?? "interrupted",
        data: e.data,
        error: "Dashboard restarted while prepare was in progress — please re-upload",
      },
      dir,
    );
    swept += 1;
    log.warn(
      `[sweep-oath-prep] marked prep row ${e.id} (runId=${e.runId}) as failed — stuck in '${e.status}/${e.step ?? "?"}'`,
    );
  }
  return swept;
}

// ─── helpers ─────────────────────────────────────────────

function flattenForData(d: Record<string, unknown>): Record<string, string> {
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
