import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync } from "fs";
import { join } from "path";
import { execSync } from "child_process";
import { log, setLogRunId } from "../utils/log.js";
import { classifyError } from "../utils/errors.js";
import { maskSsn, maskDob, redactPii } from "../utils/pii.js";
import { PATHS } from "../config.js";
import {
  generateInstanceName,
  emitWorkflowStart,
  emitWorkflowEnd,
  emitSessionCreate,
  emitBrowserLaunch,
  emitBrowserClose,
  emitAuthStart,
  emitAuthComplete,
  emitAuthFailed,
  emitItemStart,
  emitItemComplete,
  emitStepChange,
  getSessionsFilePath,
  type ScreenshotSessionEvent,
} from "./session-events.js";

export const DEFAULT_DIR = ".tracker";

/**
 * YYYY-MM-DD in the system's local timezone. Tracker filenames roll over at
 * local midnight (not UTC midnight) so reads/writes stay coherent for the
 * user's day — without this, every operation between local 5pm PDT and local
 * midnight reads/writes a different file than the dashboard is showing.
 */
export function dateLocal(d: Date = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export interface LogEntry {
  workflow: string;
  itemId: string;
  runId?: string;
  level: "step" | "success" | "error" | "waiting" | "warn" | "debug";
  message: string;
  ts: string;
}

function getLogFilePath(workflow: string, dir: string): string {
  return join(dir, `${workflow}-${dateLocal()}-logs.jsonl`);
}

export function appendLogEntry(entry: LogEntry, dir: string = DEFAULT_DIR): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const logPath = getLogFilePath(entry.workflow, dir);
  // Scrub free-form PII (SSN, DOB) from the message before it hits disk.
  // Errors like `Error: SSN 123-45-6789 not found in I9` get normalized to
  // `Error: SSN ***-**-**** not found in I9` automatically.
  const scrubbed: LogEntry = { ...entry, message: redactPii(entry.message) };
  appendFileSync(logPath, JSON.stringify(scrubbed) + "\n");
}

// Cache parsed JSONL by file path — avoids re-parsing on every SSE tick.
// Invalidated when mtime or size changes (covers new appends and file rotation).
const parseCache = new Map<string, { mtimeMs: number; size: number; entries: unknown[] }>();

function readJsonlCached<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  const stat = statSync(path);
  const cached = parseCache.get(path);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    return cached.entries as T[];
  }
  const entries = readFileSync(path, "utf-8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  parseCache.set(path, { mtimeMs: stat.mtimeMs, size: stat.size, entries });
  return entries as T[];
}

export function readLogEntries(
  workflow: string,
  itemId?: string,
  dir: string = DEFAULT_DIR,
): LogEntry[] {
  const all = readJsonlCached<LogEntry>(getLogFilePath(workflow, dir));
  if (itemId) return all.filter((e) => e.itemId === itemId);
  return all;
}

/**
 * Rich-typed value carried alongside the string-at-rest `data` record. Each
 * slot preserves the original primitive's shape so the frontend can render
 * dates, numbers, and booleans correctly. Values are string-encoded on the
 * wire so the JSONL-on-disk format stays grep-friendly and numbers can't
 * lose precision across the SSE boundary.
 */
export type TypedValue =
  | { type: "string"; value: string }
  | { type: "number"; value: string }
  | { type: "boolean"; value: string }
  | { type: "date"; value: string }
  | { type: "null"; value: "" };

/**
 * Derive a `TypedValue` from a raw tracker value for co-emission with
 * `data`. Frontend consumers read `typedData?.[k]` when present for
 * type-aware formatting, falling back to `data[k]` otherwise.
 *
 * Objects/arrays are collapsed to a JSON string ("string" type) — they don't
 * cleanly fit the primitive taxonomy and the dashboard never rendered them
 * specially before.
 */
export function toTypedValue(v: unknown): TypedValue {
  if (v === null || v === undefined) return { type: "null", value: "" };
  if (v instanceof Date) return { type: "date", value: v.toISOString() };
  if (typeof v === "number") return { type: "number", value: String(v) };
  if (typeof v === "boolean") return { type: "boolean", value: String(v) };
  if (typeof v === "string") return { type: "string", value: v };
  // fallback for objects/bigint/etc — serialize as string so the frontend
  // shows *something* rather than "[object Object]".
  try {
    return { type: "string", value: JSON.stringify(v) };
  } catch {
    return { type: "string", value: String(v) };
  }
}

export interface TrackerEntry {
  workflow: string;
  timestamp: string;
  id: string;
  runId?: string;
  parentRunId?: string;
  status: "pending" | "running" | "done" | "failed" | "skipped";
  step?: string;
  data?: Record<string, string>;
  /**
   * Rich-typed mirror of `data`. Absent on older JSONL records — the frontend
   * falls back to `data` when a key is missing from `typedData`.
   */
  typedData?: Record<string, TypedValue>;
  /**
   * Original validated input the workflow was invoked with. Set ONLY on
   * `pending` rows by the enqueue / kernel pre-emit path. Subsequent status
   * updates (running/done/failed) do not touch this field — retry & edit-and-
   * resume read it from the run's pending entry. Absent on rows written
   * before this field landed; consumers must fall back to `data`-based
   * reconstruction or report "input unavailable" rather than crashing.
   */
  input?: Record<string, unknown>;
  error?: string;
}

function getLogPath(workflow: string, dir: string): string {
  return join(dir, `${workflow}-${dateLocal()}.jsonl`);
}

/**
 * Append a tracker entry to a *specific* date file (instead of today's).
 * Used by the prep-row HTTP handlers (approve / discard) so resolution
 * lines land in the same file as the row's existing history — otherwise
 * the dashboard's per-date SSE never sees them when the operator resolves
 * a row created on a previous local day.
 */
export function trackEventForDate(
  entry: TrackerEntry,
  date: string,
  dir: string = DEFAULT_DIR,
): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const logPath = join(dir, `${entry.workflow}-${date}.jsonl`);
  appendFileSync(logPath, JSON.stringify(entry) + "\n");
}

export function trackEvent(entry: TrackerEntry, dir: string = DEFAULT_DIR): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const logPath = getLogPath(entry.workflow, dir);
  appendFileSync(logPath, JSON.stringify(entry) + "\n");
}

/** Keys whose values are always masked as SSN. */
const SSN_KEYS: ReadonlySet<string> = new Set(["ssn"]);
/** Keys whose values are always masked as DOB, preserving the year. */
const DOB_KEYS: ReadonlySet<string> = new Set(["dob", "dateOfBirth", "birthdate"]);

/**
 * Serialize an arbitrary value for storage in `TrackerEntry.data` (which is
 * `Record<string, string>` at rest). Preserves fidelity for common rich types:
 *   - Date → ISO string
 *   - null/undefined → ""
 *   - primitive (string/number/boolean/bigint) → String(v)
 *   - object/array → JSON.stringify(v) (falls back to String(v) if circular)
 *
 * When `key` is provided, field-aware PII masks trigger:
 *   - `ssn` → maskSsn(...)           e.g. "123-45-6789" becomes "x-x-6789" pattern
 *   - `dob`/`dateOfBirth`/`birthdate` → maskDob(...)  year preserved, month+day masked
 *
 * Other fields pass through unchanged — we can't blanket-redact every value
 * (would mangle `effectiveDate`, ISO timestamps, etc.).
 */
export function serializeValue(v: unknown, key?: string): string {
  if (v === null || v === undefined) return "";
  // Field-aware masking runs FIRST so Date instances passed as a DOB still get
  // formatted via the mask path rather than leaking the ISO year-month-day.
  if (key && SSN_KEYS.has(key)) {
    return maskSsn(v instanceof Date ? v.toISOString() : String(v));
  }
  if (key && DOB_KEYS.has(key)) {
    return maskDob(v instanceof Date ? v.toISOString().slice(0, 10) : String(v));
  }
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean" || typeof v === "bigint") {
    return String(v);
  }
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/** Session context passed to workflow callbacks for registering sessions/browsers. */
export interface SessionContext {
  /** Auto-generated instance name, e.g. "Separation 1" */
  instance: string;
  registerSession(sessionId: string): void;
  registerBrowser(sessionId: string, browserId: string, system: string): void;
  closeBrowser(browserId: string, system: string): void;
  setAuthState(browserId: string, system: string, state: "start" | "complete" | "failed"): void;
  setCurrentItem(itemId: string): void;
  completeItem(itemId: string): void;
}

/**
 * Wrap a workflow function with automatic lifecycle tracking.
 *
 * Emits: pending (on start) → running/step (via setStep) → done (on success) | failed (on throw).
 * Call `updateData()` to enrich the entry with data discovered during execution (e.g. employee name).
 *
 * `updateData` accepts `Record<string, unknown>`; each value is stringified at the write
 * boundary via `serializeValue` (Date → ISO, object → JSON). The on-disk `TrackerEntry.data`
 * remains `Record<string, string>`.
 */
/**
 * All non-required arguments to `withTrackedWorkflow`. Includes both the
 * pre-existing richness hooks (declaredDetailFields, nameFn, idFn — the kernel
 * passes these via `buildTrackerOpts`) AND the previously-positional batch /
 * test-isolation knobs (initialData, preAssignedRunId, dir).
 *
 * Legacy callers omit any field they don't need — the runtime warning never
 * fires when `declaredDetailFields` is absent, and `getName`/`getId` aren't
 * computed when `nameFn`/`idFn` are absent, preserving pre-subsystem-D
 * behavior exactly.
 */
export interface WithTrackedWorkflowOpts {
  /**
   * Declared detailFields keys from `defineWorkflow`. If provided, the wrapper
   * logs `log.warn` for any key never populated via `updateData` before the
   * `done` emit. Non-fatal — only a warning.
   */
  declaredDetailFields?: readonly string[];
  /**
   * Server-side name computation. Result is stored as `data.__name`.
   */
  nameFn?: (data: Record<string, string>) => string;
  /**
   * Server-side id computation. Result is stored as `data.__id`.
   */
  idFn?: (data: Record<string, string>) => string;
  /** Seed data — merged into the entry before the first emit. Default `{}`. */
  initialData?: Record<string, string>;
  /** Pre-assigned runId (batch mode) — skips run computation and initial pending emit. */
  preAssignedRunId?: string;
  /**
   * Pool-/batch-assigned workflow instance name. When provided, the wrapper
   * REUSES this name instead of calling `generateInstanceName` and SKIPS the
   * `emitWorkflowStart` / `emitWorkflowEnd` calls on every code path
   * (success, error, SIGINT/SIGTERM). The batch runner that owns the
   * lifecycle (e.g. `withBatchLifecycle`) is responsible for both emits,
   * ensuring the dashboard sees ONE session-panel row per batch regardless
   * of item count. `data.instance` on tracker rows still gets stamped so the
   * dashboard's `EntryItem` still renders an instance chip per row.
   */
  preAssignedInstance?: string;
  /**
   * Original validated input the run was invoked with. Stamped onto the
   * initial `pending` tracker row only. Used by the dashboard's retry / edit-
   * and-resume features to reconstruct the input verbatim. Optional — when
   * absent, the pending row is written without the `input` field.
   */
  input?: Record<string, unknown>;
  /** Override tracker directory — defaults to DEFAULT_DIR (`.tracker`). Mainly for test isolation. */
  dir?: string;
}

export async function withTrackedWorkflow<T>(
  workflow: string,
  id: string,
  fn: (
    setStep: (step: string) => void,
    updateData: (d: Record<string, unknown>) => void,
    /** Register a sync cleanup function (e.g. kill browsers) that runs on SIGINT before exit. */
    onCleanup: (cb: () => void) => void,
    session: SessionContext,
    /**
     * Emit a proper step-failed signal. Routes to the same underlying emission
     * path as Stepper's emitFailed: writes a `running` entry whose step encodes
     * the failure, then the outer `catch` block writes the terminal `failed`
     * entry. Use this instead of encoding failure info into a mangled step name.
     */
    emitFailed: (step: string, error: string) => void,
    /**
     * The tracker-stamped runId for this invocation — either the caller's
     * `preAssignedRunId` or the auto-generated `{id}#N` value. Callers that
     * build a Stepper / screenshot emitter inside the body should thread this
     * in so their emitted events correlate 1:1 with the JSONL rows. Without
     * this, the body would generate its own runId for Stepper while the
     * tracker stamps a different one on its rows (prior bug fixed 2026-04-23).
     */
    runId: string,
    /**
     * Emit a "this step was bypassed" signal — writes a `skipped` tracker
     * row that the dashboard's StepPipeline can render distinctly from
     * `done`. Use for edit-and-resume style flows where extracted data was
     * pre-populated and the extraction step is intentionally not executed.
     * The bypassed step name still becomes `currentStep` so subsequent
     * step transitions advance the pipeline correctly.
     */
    emitSkipped: (step: string) => void,
  ) => Promise<T>,
  opts: WithTrackedWorkflowOpts = {},
): Promise<T> {
  const initialData = opts.initialData ?? {};
  const preAssignedRunId = opts.preAssignedRunId;
  const dir = opts.dir ?? DEFAULT_DIR;
  const data = { ...initialData };
  const typedData: Record<string, TypedValue> = {};
  const ts = () => new Date().toISOString();

  let runId: string;
  if (preAssignedRunId) {
    runId = preAssignedRunId;
  } else {
    const existing = readEntries(workflow, dir);
    const priorRuns = new Set(
      existing.filter((e) => e.id === id).map((e) => e.runId)
    );
    runId = `${id}#${priorRuns.size + 1}`;
  }
  setLogRunId(runId);

  const emit = (status: TrackerEntry["status"], extra?: { step?: string; error?: string }) => {
    // Apply server-side getName/getId before each emit so the dashboard sees
    // the freshest computed display values. Functions receive the current
    // stringified data snapshot and mutate __name / __id back into it.
    if (opts.nameFn) {
      try { data.__name = opts.nameFn(data); } catch { /* non-fatal */ }
    }
    if (opts.idFn) {
      try { data.__id = opts.idFn(data); } catch { /* non-fatal */ }
    }
    trackEvent({
      workflow,
      timestamp: ts(),
      id,
      runId,
      status,
      data,
      ...(Object.keys(typedData).length > 0 ? { typedData } : {}),
      // `input` rides ONLY on the initial pending row (see TrackerEntry doc).
      ...(status === "pending" && opts.input ? { input: opts.input } : {}),
      ...extra,
    }, dir);
  };

  if (!preAssignedRunId) emit("pending");

  // Session tracking context. All session-event emits route to the same `dir`
  // as the tracker writes — without this, tests passing `trackerDir: TMP_DIR`
  // for entry/log isolation would still leak workflow_start/step_change/etc.
  // into the real `.tracker/sessions.jsonl` and clutter the operator's
  // SessionPanel with dead test workflow instances.
  const instanceName = opts.preAssignedInstance ?? generateInstanceName(workflow, dir);
  if (!opts.preAssignedInstance) emitWorkflowStart(instanceName, dir);
  // Store instance name in tracker data so EntryItem can show it
  data.instance = instanceName;

  const session: SessionContext = {
    instance: instanceName,
    registerSession: (sessionId) => emitSessionCreate(instanceName, sessionId, dir),
    registerBrowser: (sessionId, browserId, system) => emitBrowserLaunch(instanceName, sessionId, browserId, system, dir),
    closeBrowser: (browserId, system) => emitBrowserClose(instanceName, browserId, system, dir),
    setAuthState: (browserId, system, state) => {
      if (state === "start") emitAuthStart(instanceName, browserId, system, dir);
      else if (state === "complete") emitAuthComplete(instanceName, browserId, system, dir);
      else emitAuthFailed(instanceName, browserId, system, dir);
    },
    setCurrentItem: (itemId) => emitItemStart(instanceName, itemId, dir),
    completeItem: (itemId) => emitItemComplete(instanceName, itemId, dir),
  };

  // Cleanup callbacks registered by the workflow (e.g. kill browsers)
  const cleanupFns: (() => void)[] = [];

  // Track the last `running` step so terminal `failed` emits (SIGINT, error
  // rethrow) can preserve it. Without this the dashboard's RunSelector
  // shows "interrupted" (or falls back to step 0) for any run killed mid-
  // step, even though we knew exactly which step was in flight.
  let lastStep: string | undefined;

  // Catch Ctrl+C / kill — write synchronously (bypass async mutex) since process.exit follows
  let cleaned = false;
  const onSignal = (signal: string) => {
    if (cleaned) return;
    cleaned = true;
    // Kill all Playwright-launched Chrome processes (Windows-safe)
    try {
      execSync('wmic process where "name=\'chrome.exe\' and CommandLine like \'%--enable-automation%\'" call terminate', { stdio: "ignore" });
    } catch { /* best-effort */ }
    for (const cb of cleanupFns) { try { cb(); } catch { /* best-effort */ } }
    // Skip the end-emit when a batch runner owns the lifecycle — it writes
    // its own `workflow_end(failed)` in its SIGINT path so the orphan-start
    // heal in generateInstanceName doesn't need to kick in.
    if (!opts.preAssignedInstance) emitWorkflowEnd(instanceName, "failed", dir);
    const error = `Process terminated (${signal})`;
    const now = ts();
    const date = now.slice(0, 10);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const logEntry: LogEntry = { workflow, itemId: id, runId, level: "error", message: error, ts: now };
    const trackEntry: TrackerEntry = {
      workflow,
      timestamp: now,
      id,
      runId,
      status: "failed",
      data,
      error,
      ...(lastStep ? { step: lastStep } : {}),
    };
    appendFileSync(join(dir, `${workflow}-${date}-logs.jsonl`), JSON.stringify(logEntry) + "\n");
    appendFileSync(join(dir, `${workflow}-${date}.jsonl`), JSON.stringify(trackEntry) + "\n");
  };
  process.on("SIGINT", () => { onSignal("SIGINT"); process.exit(130); });
  process.on("SIGTERM", () => { onSignal("SIGTERM"); process.exit(143); });

  // Real emitFailed: sets lastStep (preserves step in terminal failed entry)
  // then emits a running row with a `step:failed:<error>` step string that the
  // StepPipeline uses to show the failed dot. The outer catch block then writes
  // the terminal `failed` entry, so the sequence is:
  //   running(step:failed:…) → [rethrow] → failed(step=lastStep)
  const emitFailedFn = (step: string, error: string) => {
    const encoded = `${step}:failed:${error}`
    lastStep = step
    emit("running", { step: encoded })
    emitStepChange(instanceName, encoded, dir)
  }

  // emitSkipped: announce a bypassed step. Writes a single `skipped` tracker
  // row with the step name. Updates lastStep so a later terminal failure
  // attributes correctly. No corresponding emitStepChange — the dashboard
  // SessionPanel's "current step" tracking treats skipped as a no-op
  // advance for live state (the session-events stream covers running steps).
  const emitSkippedFn = (step: string) => {
    lastStep = step
    emit("skipped", { step })
  }

  try {
    const result = await fn(
      (step) => { lastStep = step; emit("running", { step }); emitStepChange(instanceName, step, dir); },
      (d) => {
        // Stringify rich values at the write boundary — data stays Record<string, string>
        // on disk, but callers can pass Date/object/etc. without losing fidelity.
        // Also populate the typedData mirror so the dashboard can render
        // dates/numbers/booleans with type-aware formatting.
        for (const [k, v] of Object.entries(d)) {
          data[k] = serializeValue(v, k);
          typedData[k] = toTypedValue(v);
        }
      },
      (cb) => cleanupFns.push(cb),
      session,
      emitFailedFn,
      runId,
      emitSkippedFn,
    );

    // Runtime warning (Option A) — any declared detailField key that the
    // workflow never populated is surfaced as a log.warn so drift is audible
    // without being fatal. Only runs on the success path; failed runs often
    // short-circuit before populating everything.
    if (opts.declaredDetailFields) {
      for (const key of opts.declaredDetailFields) {
        if (!(key in data)) {
          log.warn(`dashboard: detailField '${key}' was declared but never populated`);
        }
      }
    }

    emit("done");
    if (!opts.preAssignedInstance) emitWorkflowEnd(instanceName, "done", dir);
    return result;
  } catch (e) {
    const error = classifyError(e);
    log.error(error);
    emit("failed", { error, ...(lastStep ? { step: lastStep } : {}) });
    if (!opts.preAssignedInstance) emitWorkflowEnd(instanceName, "failed", dir);
    throw e;
  } finally {
    process.removeAllListeners("SIGINT");
    process.removeAllListeners("SIGTERM");
  }
}

export function readEntries(workflow: string, dir: string = DEFAULT_DIR): TrackerEntry[] {
  return readJsonlCached<TrackerEntry>(getLogPath(workflow, dir));
}

/**
 * List all workflows that have tracker data. Scans `dir` for files matching
 * `<workflow>-YYYY-MM-DD.jsonl` and returns the workflow names.
 *
 * The positive regex match (instead of "ends in .jsonl, isn't logs") rejects
 * meta files like `sessions.jsonl`, `idempotency.jsonl`, `step-cache/...`
 * that share the directory but aren't workflow tracker files.
 */
export function listWorkflows(dir: string = DEFAULT_DIR): string[] {
  if (!existsSync(dir)) return [];
  const out = new Set<string>();
  for (const f of readdirSync(dir)) {
    if (f.endsWith("-logs.jsonl")) continue;
    const m = f.match(/^(.+)-\d{4}-\d{2}-\d{2}\.jsonl$/);
    if (m) out.add(m[1]);
  }
  return [...out];
}

/** List all dates that have tracker data for a given workflow. */
export function listDatesForWorkflow(workflow: string, dir: string = DEFAULT_DIR): string[] {
  if (!existsSync(dir)) return [];
  const prefix = `${workflow}-`;
  return readdirSync(dir)
    .filter((f) => f.startsWith(prefix) && f.endsWith(".jsonl") && !f.includes("-logs.jsonl"))
    .map((f) => {
      const match = f.match(/(\d{4}-\d{2}-\d{2})\.jsonl$/);
      return match ? match[1] : "";
    })
    .filter(Boolean)
    .sort()
    .reverse();
}

/** Read entries for a specific date (not just today). */
export function readEntriesForDate(
  workflow: string,
  date: string,
  dir: string = DEFAULT_DIR,
): TrackerEntry[] {
  return readJsonlCached<TrackerEntry>(join(dir, `${workflow}-${date}.jsonl`));
}

/** Read log entries for a specific date (not just today). */
export function readLogEntriesForDate(
  workflow: string,
  itemId: string | undefined,
  date: string,
  dir: string = DEFAULT_DIR,
): LogEntry[] {
  const all = readJsonlCached<LogEntry>(join(dir, `${workflow}-${date}-logs.jsonl`));
  if (itemId) return all.filter((e) => e.itemId === itemId);
  return all;
}

/**
 * Delete JSONL files older than maxAgeDays. Returns count of deleted files.
 *
 * Default 30 days — workflow history below that floor is considered "recent
 * enough to keep" for operator retro investigation. Callers that want a
 * shorter window must pass it explicitly.
 */
export function cleanOldTrackerFiles(maxAgeDays: number = 30, dir: string = DEFAULT_DIR): number {
  if (!existsSync(dir)) return 0;
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - maxAgeDays);
  const cutoffStr = dateLocal(cutoff);

  let deleted = 0;
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".jsonl")) continue;
    const match = f.match(/(\d{4}-\d{2}-\d{2})/);
    if (match && match[1] < cutoffStr) {
      unlinkSync(join(dir, f));
      deleted++;
    }
  }
  return deleted;
}

/**
 * Delete failure-screenshot PNGs older than `maxAgeDays`. Returns the count of
 * deleted files.
 *
 * Unlike tracker JSONL files (whose filename carries the date), screenshot
 * filenames encode the timestamp as a ms-since-epoch integer in their tail:
 *   `<workflow>-<itemId>-<step>-<systemId>-<ts>.png`
 * We parse the trailing numeric segment and compare to the cutoff. Files that
 * don't match the shape (or have a non-numeric trailing segment) are skipped —
 * never accidentally deleted.
 */
export function cleanOldScreenshots(
  maxAgeDays: number = 30,
  dir: string = PATHS.screenshotDir,
): number {
  if (!existsSync(dir)) return 0;
  const cutoffMs = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;

  let deleted = 0;
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".png")) continue;
    // Extract the trailing `<ts>.png` segment. File shape:
    //   <workflow>-<itemId>-<step>-<systemId>-<ts>.png
    // We can't split blindly (step names may contain dashes); instead take the
    // last hyphen-separated segment before `.png` and require it to be numeric.
    const stripped = f.slice(0, -".png".length);
    const lastDash = stripped.lastIndexOf("-");
    if (lastDash === -1) continue;
    const tsStr = stripped.slice(lastDash + 1);
    const tsNum = Number(tsStr);
    if (!Number.isFinite(tsNum) || tsNum <= 0) continue;
    if (tsNum < cutoffMs) {
      unlinkSync(join(dir, f));
      deleted++;
    }
  }
  return deleted;
}

/**
 * List distinct runs for a given ID, with their latest status, step, and timestamp.
 *
 * Older runs left in `pending` or `running` are reclassified to `failed`
 * (with step `"interrupted"`) when a newer run for the same ID has started
 * after them. Such runs were killed before they could emit a terminal event
 * (Ctrl+C, SIGKILL, process crash before the SIGINT handler could write
 * synchronously) — leaving them as "pending" forever in the dropdown is
 * misleading. Only the most recent run is allowed to retain a non-terminal
 * status, since it may legitimately still be in-flight.
 */
export function readRunsForId(
  workflow: string,
  id: string,
  date?: string,
  dir: string = DEFAULT_DIR,
): { runId: string; status: string; step?: string; timestamp: string }[] {
  const all = date ? readEntriesForDate(workflow, date, dir) : readEntries(workflow, dir);
  const entries = all.filter((e) => e.id === id);
  const runMap = new Map<string, TrackerEntry>();
  // Track the last known step per run (the "failed"/"done" event may have no step)
  const lastStep = new Map<string, string>();
  for (const e of entries) {
    const rid = e.runId || `${e.id}#1`;
    runMap.set(rid, e);
    if (e.step) lastStep.set(rid, e.step);
  }
  // Earliest tracker timestamp per run (the pending emit) — defines
  // chronological order regardless of runId shape.
  const runFirstTs = new Map<string, string>();
  for (const e of entries) {
    const rid = e.runId || `${e.id}#1`;
    const existing = runFirstTs.get(rid);
    if (!existing || e.timestamp < existing) runFirstTs.set(rid, e.timestamp);
  }

  const raw = [...runMap.values()]
    .map((e) => {
      const rid = e.runId || `${e.id}#1`;
      return { runId: rid, status: e.status, step: lastStep.get(rid), timestamp: e.timestamp };
    })
    // Chronological asc (oldest first, newest last — callers rely on
    // data[length-1] to be the latest run). Both legacy `{id}#N` and UUID
    // runIds use tracker timestamps so the sort is shape-agnostic.
    .sort((a, b) => {
      const at = runFirstTs.get(a.runId) ?? a.timestamp;
      const bt = runFirstTs.get(b.runId) ?? b.timestamp;
      return at.localeCompare(bt);
    });

  if (raw.length <= 1) return raw;

  // Reclassify abandoned non-terminal runs. The newest run (last after sort)
  // keeps its real status — that may legitimately be running/pending.
  const newestIdx = raw.length - 1;
  return raw.map((r, i) => {
    if (i === newestIdx) return r;
    if (r.status === "pending" || r.status === "running") {
      return { ...r, status: "failed", step: r.step ?? "interrupted" };
    }
    return r;
  });
}

export function emitScreenshotEvent(
  event: ScreenshotSessionEvent,
  opts?: { dir?: string },
): void {
  const dir = opts?.dir ?? DEFAULT_DIR;
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  appendFileSync(getSessionsFilePath(dir), JSON.stringify(event) + "\n");
}
