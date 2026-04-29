/**
 * HTTP handlers for the emergency-contact "Run" button flow.
 *
 * Three POST endpoints + one GET:
 *
 *   POST /api/emergency-contact/prepare        — multipart upload
 *   POST /api/emergency-contact/approve-batch  — JSON
 *   POST /api/emergency-contact/discard-prepare — JSON
 *   GET  /api/rosters                          — JSON (lists xlsx files)
 *
 * Plus `sweepStuckPrepRows(dir)` for the dashboard's startup sweep.
 *
 * Factored out of `dashboard.ts` so each handler can be unit-tested with a
 * fake `dir` argument and so the route bodies in dashboard.ts stay short.
 *
 * Naming: this file is workflow-specific by design. The "preview row"
 * abstraction (parent row that fans out to N kernel items on approve) is
 * tied to emergency-contact's OCR-then-confirm flow today; if a second
 * workflow grows the same shape, promote the helpers up to a generic
 * `prepare-row.ts` then.
 */
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { writeFile, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

import {
  dateLocal,
  listDatesForWorkflow,
  readEntries,
  readEntriesForDate,
  trackEvent,
  type TrackerEntry,
} from "./jsonl.js";
import { log } from "../utils/log.js";
import { errorMessage } from "../utils/errors.js";
import { runPrepare } from "../workflows/emergency-contact/prepare.js";
import {
  PrepareRowDataSchema,
  PreviewRecordSchema,
  type PreviewRecord,
} from "../workflows/emergency-contact/preview-schema.js";
import { RecordSchema } from "../workflows/emergency-contact/schema.js";
import { ROSTERS_DIR } from "../workflows/emergency-contact/config.js";
import { enqueueFromHttp } from "../core/enqueue-dispatch.js";

const WORKFLOW = "emergency-contact";

/**
 * Find the latest tracker entry for a prep row across every available date
 * file. `readEntries(WORKFLOW, dir)` only reads today's local-date file —
 * which misses prep rows created late on the previous local day (operator
 * uploaded at 5pm PDT, returned the next morning to discard/approve). The
 * sweep at startup also leaves them in the previous day's file. We scan
 * every date returned by `listDatesForWorkflow` so the lookup is robust
 * regardless of when the row was first written.
 */
function findLatestPrepRow(
  parentRunId: string,
  dir: string,
): TrackerEntry | null {
  let latest: TrackerEntry | null = null;
  for (const date of listDatesForWorkflow(WORKFLOW, dir)) {
    for (const e of readEntriesForDate(WORKFLOW, date, dir)) {
      if (e.runId !== parentRunId) continue;
      if (!e.data || typeof e.data !== "object" || e.data.mode !== "prepare") continue;
      if (!latest || latest.timestamp < e.timestamp) latest = e;
    }
  }
  return latest;
}

/**
 * Dirs we'll consult when listing rosters. Both are relative to cwd. The
 * first is the canonical place for emergency-contact preflight downloads
 * (`ROSTERS_DIR = .tracker/rosters`); the second is where the dashboard's
 * SharePoint Download button drops files. Tests pass a single dir via
 * `prepareDirsForTests` instead.
 */
function defaultRosterDirs(): string[] {
  return [resolve(process.cwd(), ROSTERS_DIR), resolve(process.cwd(), "src/data")];
}

let _rosterDirsForTests: string[] | undefined;
let _uploadsDirForTests: string | undefined;
let _prepareForTests: typeof runPrepare | undefined;

/** @internal — tests override which dirs `/api/rosters` scans. */
export function __setRosterDirsForTests(dirs: string[] | undefined): void {
  _rosterDirsForTests = dirs;
}

/** @internal — tests override the uploads dir (where the PDF gets saved). */
export function __setUploadsDirForTests(dir: string | undefined): void {
  _uploadsDirForTests = dir;
}

/** @internal — tests can replace `runPrepare` with a stub. */
export function __setPrepareForTests(fn: typeof runPrepare | undefined): void {
  _prepareForTests = fn;
}

// ─── /api/rosters ─────────────────────────────────────────

export interface RosterListing {
  filename: string;
  path: string;
  dir: string;
  bytes: number;
  modifiedAt: string;
}

export function listRosters(): RosterListing[] {
  const dirs = _rosterDirsForTests ?? defaultRosterDirs();
  const out: RosterListing[] = [];
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const filename of entries) {
      if (!filename.toLowerCase().endsWith(".xlsx")) continue;
      const fullPath = join(dir, filename);
      let s;
      try {
        s = statSync(fullPath);
      } catch {
        continue;
      }
      if (!s.isFile()) continue;
      out.push({
        filename,
        path: fullPath,
        dir,
        bytes: s.size,
        modifiedAt: new Date(s.mtimeMs).toISOString(),
      });
    }
  }
  // Newest first — the prepare flow auto-picks the latest, so the user
  // sees the same default the workflow will use.
  out.sort((a, b) => (a.modifiedAt < b.modifiedAt ? 1 : -1));
  return out;
}

// ─── POST /api/emergency-contact/prepare ─────────────────

export interface PrepareHttpInput {
  pdfBytes: Buffer;
  pdfOriginalName: string;
  rosterMode: "download" | "existing";
}

export interface PrepareHttpResult {
  ok: boolean;
  parentRunId?: string;
  pdfPath?: string;
  error?: string;
}

/**
 * Persist the uploaded PDF to disk and kick off `runPrepare()` in the
 * background. Returns `{ok:true, parentRunId, pdfPath}` synchronously —
 * the OCR + roster match happens after the response is sent so the HTTP
 * connection isn't held open for ~30s+ of OCR / EID lookup.
 *
 * The pending tracker row is written by `runPrepare` as its first line of
 * work, so the dashboard's preview row appears within the SSE poll cycle
 * (~1s). If `runPrepare` throws before the first tracker write, we still
 * return success — the failure shows up as a `failed` row when the
 * background promise rejects.
 *
 * @param dir tracker dir (for the runPrepare invocation + restart sweep
 *            consistency). The PDF is saved under `<dir>/uploads/`.
 */
export async function handlePrepareUpload(
  input: PrepareHttpInput,
  dir: string,
): Promise<PrepareHttpResult> {
  if (!input.pdfBytes || input.pdfBytes.length === 0) {
    return { ok: false, error: "PDF is required" };
  }
  if (input.rosterMode !== "download" && input.rosterMode !== "existing") {
    return { ok: false, error: "rosterMode must be 'download' or 'existing'" };
  }

  // ── Save PDF to disk
  const uploadsDir = _uploadsDirForTests ?? join(dir, "uploads");
  mkdirSync(uploadsDir, { recursive: true });
  const safeName = input.pdfOriginalName.replace(/[^\w.\- ]+/g, "_").slice(0, 80) || "upload.pdf";
  const filename = `${dateLocal()}-${randomUUID().slice(0, 8)}-${safeName}`;
  const pdfPath = join(uploadsDir, filename);
  await writeFile(pdfPath, input.pdfBytes);

  // ── Kick off the preparer (background — handler must return fast)
  const fn = _prepareForTests ?? runPrepare;
  // Use the canonical roster dirs unless tests overrode them. Pick the
  // first one that exists; if none, fall back to .tracker/rosters and
  // runPrepare will create + fail with a clear "no roster" message.
  const rosterDirs = _rosterDirsForTests ?? [resolve(process.cwd(), ROSTERS_DIR)];
  const rosterDir = rosterDirs.find((d) => existsSync(d)) ?? rosterDirs[0];

  // Generate the parentRunId synchronously so we can return it right away.
  // `runPrepare` writes the pending tracker row before its first await, so
  // by the time control returns from the call, the row exists on disk —
  // the dashboard's SSE poll picks it up on the next tick. We
  // fire-and-forget the rest (OCR can take 30s+, eid-lookup chain longer).
  const parentRunId = randomUUID();
  void fn({
    pdfPath,
    pdfOriginalName: input.pdfOriginalName,
    rosterMode: input.rosterMode,
    rosterDir,
    uploadsDir,
    trackerDir: dir,
    runId: parentRunId,
  }).catch((err) => {
    log.error(`[handlePrepareUpload] runPrepare threw: ${errorMessage(err)}`);
  });
  return { ok: true, parentRunId, pdfPath };
}

// ─── POST /api/emergency-contact/approve-batch ───────────

export interface ApproveBatchInput {
  parentRunId: string;
  /** User-edited records. Replace anything that came back from prep. */
  records: unknown[];
}

export interface ApproveBatchResult {
  ok: boolean;
  enqueued?: number;
  parentRunId?: string;
  error?: string;
}

/**
 * Validate the user's edits, build kernel inputs (one `EmergencyContactRecord`
 * per selected approvable preview record), and enqueue them via the daemon
 * path the CLI uses. Mark the prep row as `done` with `step: "approved"` so
 * the dashboard collapses it into the parent of the new child rows.
 *
 * Refuses to enqueue when no records are approvable (every record is
 * unresolved / lookup-pending / not selected). Caller can re-edit and try
 * again.
 */
export async function handleApproveBatch(
  input: ApproveBatchInput,
  dir: string,
): Promise<ApproveBatchResult> {
  if (!input.parentRunId || typeof input.parentRunId !== "string") {
    return { ok: false, error: "parentRunId is required" };
  }
  if (!Array.isArray(input.records) || input.records.length === 0) {
    return { ok: false, error: "records must be a non-empty array" };
  }

  // ── Validate user input matches the preview shape
  const previewRecords: PreviewRecord[] = [];
  for (let i = 0; i < input.records.length; i++) {
    const parsed = PreviewRecordSchema.safeParse(input.records[i]);
    if (!parsed.success) {
      return {
        ok: false,
        error: `record[${i}] failed validation: ${parsed.error.message}`,
      };
    }
    previewRecords.push(parsed.data);
  }

  // ── Find the prep row this approve corresponds to
  const prepRow = findLatestPrepRow(input.parentRunId, dir);
  if (!prepRow) {
    return { ok: false, error: `no prepare row found for parentRunId=${input.parentRunId}` };
  }

  // ── Filter to approvable records (selected + has terminal good state)
  const approvable: PreviewRecord[] = [];
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
    if (!r.employee.employeeId || !/^\d{5,}$/.test(r.employee.employeeId)) {
      skipped.push({ index: i, reason: `invalid EID (${r.employee.employeeId || "empty"})` });
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

  // ── Build kernel inputs (strict RecordSchema validates)
  const kernelInputs: Array<unknown> = [];
  for (const r of approvable) {
    // Strip preview-only fields (matchState, rosterCandidates, etc.) so the
    // kernel sees a vanilla `EmergencyContactRecord`.
    const kernelInput = {
      sourcePage: r.sourcePage,
      employee: {
        name: r.employee.name,
        employeeId: r.employee.employeeId,
        pid: r.employee.pid,
        jobTitle: r.employee.jobTitle,
        workLocation: r.employee.workLocation,
        supervisor: r.employee.supervisor,
        workEmail: r.employee.workEmail,
        personalEmail: r.employee.personalEmail,
        homeAddress: r.employee.homeAddress,
        homePhone: r.employee.homePhone,
        cellPhone: r.employee.cellPhone,
      },
      emergencyContact: r.emergencyContact,
      notes: r.notes,
    };
    const parsed = RecordSchema.safeParse(kernelInput);
    if (!parsed.success) {
      return {
        ok: false,
        error: `record for "${r.employee.name}" failed strict validation: ${parsed.error.message}`,
      };
    }
    kernelInputs.push(parsed.data);
  }

  // ── Enqueue. Each becomes its own daemon-mode queue item.
  const enq = await enqueueFromHttp(WORKFLOW, kernelInputs, dir);
  if (!enq.ok) {
    return { ok: false, error: enq.error ?? "enqueue failed" };
  }

  // ── Mark the prep row done with parent metadata so the dashboard can
  // group child rows under it. Record the approve action separately as a
  // synthetic terminal entry — keeps the prep row's history visible while
  // making it clear the user clicked Approve.
  const parsedPrev = PrepareRowDataSchema.safeParse({ ...prepRow.data, records: previewRecords });
  const finalData = parsedPrev.success ? parsedPrev.data : prepRow.data;
  trackEvent(
    {
      workflow: WORKFLOW,
      timestamp: new Date().toISOString(),
      id: prepRow.id,
      runId: prepRow.runId,
      status: "done",
      step: "approved",
      data: flattenForData(finalData as Record<string, unknown>),
    },
    dir,
  );

  return {
    ok: true,
    enqueued: kernelInputs.length,
    parentRunId: input.parentRunId,
  };
}

// ─── POST /api/emergency-contact/discard-prepare ─────────

export interface DiscardPrepareInput {
  parentRunId: string;
  reason?: string;
}

export interface DiscardPrepareResult {
  ok: boolean;
  parentRunId?: string;
  error?: string;
}

/**
 * Mark the prep row as `failed` with `step: "discarded"`. Best-effort
 * deletes the uploaded PDF on disk (the prep row records `pdfPath`).
 */
export async function handleDiscardPrepare(
  input: DiscardPrepareInput,
  dir: string,
): Promise<DiscardPrepareResult> {
  if (!input.parentRunId || typeof input.parentRunId !== "string") {
    return { ok: false, error: "parentRunId is required" };
  }
  const prepRow = findLatestPrepRow(input.parentRunId, dir);
  if (!prepRow) {
    return { ok: false, error: `no prepare row found for parentRunId=${input.parentRunId}` };
  }
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
      // Best-effort — file may already be gone or path may be relative
      // to a different cwd. Don't block the discard.
    }
  }
  trackEvent(
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
    dir,
  );
  return { ok: true, parentRunId: input.parentRunId };
}

// ─── Dashboard restart sweep ─────────────────────────────

/**
 * Mark prep rows that are still in a transient state (pending, running) as
 * failed when the dashboard backend starts up. A prep row is considered
 * "stuck" if its latest tracker entry is non-terminal — the dashboard
 * process owns its lifecycle (the OCR + eid-lookup polling lives in this
 * Node process), so a backend restart leaves the row orphaned.
 *
 * Idempotent — safe to call multiple times. Only emits `failed` entries
 * for runIds whose latest status is `pending` or `running`.
 *
 * Returns the number of rows swept.
 */
export function sweepStuckPrepRows(dir: string): number {
  let swept = 0;
  let entries: TrackerEntry[];
  try {
    entries = readEntries(WORKFLOW, dir);
  } catch {
    return 0;
  }
  // Keep the latest entry per runId (only prep rows we care about).
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
      `[sweep-prep] marked prep row ${e.id} (runId=${e.runId}) as failed — stuck in '${e.status}/${e.step ?? "?"}'`,
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

// Unused import placeholders — silenced to keep the imports list tidy
// without modifying it on every refactor.
void writeFileSync;
void dirname;
