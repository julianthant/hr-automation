import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync } from "fs";
import { join } from "path";
import { execSync } from "child_process";
import { log, setLogRunId } from "../utils/log.js";
import { classifyError } from "../utils/errors.js";
import { maskSsn, maskDob, redactPii } from "../utils/pii.js";
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
} from "./session-events.js";

export const DEFAULT_DIR = ".tracker";

export interface LogEntry {
  workflow: string;
  itemId: string;
  runId?: string;
  level: "step" | "success" | "error" | "waiting" | "warn";
  message: string;
  ts: string;
}

function getLogFilePath(workflow: string, dir: string): string {
  const today = new Date().toISOString().slice(0, 10);
  return join(dir, `${workflow}-${today}-logs.jsonl`);
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
  status: "pending" | "running" | "done" | "failed" | "skipped";
  step?: string;
  data?: Record<string, string>;
  /**
   * Rich-typed mirror of `data`. Absent on older JSONL records — the frontend
   * falls back to `data` when a key is missing from `typedData`.
   */
  typedData?: Record<string, TypedValue>;
  error?: string;
}

function getLogPath(workflow: string, dir: string): string {
  const today = new Date().toISOString().slice(0, 10);
  return join(dir, `${workflow}-${today}.jsonl`);
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
 * Optional richness hooks passed by the kernel. Legacy callers omit these —
 * in that case the runtime warning never fires and `getName`/`getId` aren't
 * computed, preserving pre-subsystem-D behavior exactly.
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
}

export async function withTrackedWorkflow<T>(
  workflow: string,
  id: string,
  initialData: Record<string, string>,
  fn: (
    setStep: (step: string) => void,
    updateData: (d: Record<string, unknown>) => void,
    /** Register a sync cleanup function (e.g. kill browsers) that runs on SIGINT before exit. */
    onCleanup: (cb: () => void) => void,
    session: SessionContext,
  ) => Promise<T>,
  /** Pre-assigned runId (batch mode) — skips run computation and initial pending emit. */
  preAssignedRunId?: string,
  /** Override tracker directory — defaults to DEFAULT_DIR (`.tracker`). Mainly for test isolation. */
  dir: string = DEFAULT_DIR,
  /** Optional richness hooks — see WithTrackedWorkflowOpts. */
  opts: WithTrackedWorkflowOpts = {},
): Promise<T> {
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
      ...extra,
    }, dir);
  };

  if (!preAssignedRunId) emit("pending");

  // Session tracking context
  const instanceName = generateInstanceName(workflow);
  emitWorkflowStart(instanceName);
  // Store instance name in tracker data so EntryItem can show it
  data.instance = instanceName;

  const session: SessionContext = {
    instance: instanceName,
    registerSession: (sessionId) => emitSessionCreate(instanceName, sessionId),
    registerBrowser: (sessionId, browserId, system) => emitBrowserLaunch(instanceName, sessionId, browserId, system),
    closeBrowser: (browserId, system) => emitBrowserClose(instanceName, browserId, system),
    setAuthState: (browserId, system, state) => {
      if (state === "start") emitAuthStart(instanceName, browserId, system);
      else if (state === "complete") emitAuthComplete(instanceName, browserId, system);
      else emitAuthFailed(instanceName, browserId, system);
    },
    setCurrentItem: (itemId) => emitItemStart(instanceName, itemId),
    completeItem: (itemId) => emitItemComplete(instanceName, itemId),
  };

  // Cleanup callbacks registered by the workflow (e.g. kill browsers)
  const cleanupFns: (() => void)[] = [];

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
    emitWorkflowEnd(instanceName, "failed");
    const error = `Process terminated (${signal})`;
    const now = ts();
    const date = now.slice(0, 10);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const logEntry: LogEntry = { workflow, itemId: id, runId, level: "error", message: error, ts: now };
    const trackEntry: TrackerEntry = { workflow, timestamp: now, id, runId, status: "failed", data, error };
    appendFileSync(join(dir, `${workflow}-${date}-logs.jsonl`), JSON.stringify(logEntry) + "\n");
    appendFileSync(join(dir, `${workflow}-${date}.jsonl`), JSON.stringify(trackEntry) + "\n");
  };
  process.on("SIGINT", () => { onSignal("SIGINT"); process.exit(130); });
  process.on("SIGTERM", () => { onSignal("SIGTERM"); process.exit(143); });

  try {
    const result = await fn(
      (step) => { emit("running", { step }); emitStepChange(instanceName, step); },
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
    emitWorkflowEnd(instanceName, "done");
    return result;
  } catch (e) {
    const error = classifyError(e);
    log.error(error);
    emit("failed", { error });
    emitWorkflowEnd(instanceName, "failed");
    throw e;
  } finally {
    process.removeAllListeners("SIGINT");
    process.removeAllListeners("SIGTERM");
  }
}

export function readEntries(workflow: string, dir: string = DEFAULT_DIR): TrackerEntry[] {
  return readJsonlCached<TrackerEntry>(getLogPath(workflow, dir));
}

/** List all workflows that have tracker data (scans dir for *.jsonl files, excludes log files). */
export function listWorkflows(dir: string = DEFAULT_DIR): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl") && !f.includes("-logs.jsonl"))
    .map((f) => f.replace(/-\d{4}-\d{2}-\d{2}\.jsonl$/, ""))
    .filter((v, i, a) => a.indexOf(v) === i);
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

/** Delete JSONL files older than maxAgeDays. Returns count of deleted files. */
export function cleanOldTrackerFiles(maxAgeDays: number = 7, dir: string = DEFAULT_DIR): number {
  if (!existsSync(dir)) return 0;
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - maxAgeDays);
  const cutoffStr = cutoff.toISOString().slice(0, 10);

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

/** List distinct runs for a given ID, with their latest status, step, and timestamp. */
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
  return [...runMap.values()]
    .map((e) => {
      const rid = e.runId || `${e.id}#1`;
      return { runId: rid, status: e.status, step: lastStep.get(rid), timestamp: e.timestamp };
    })
    .sort((a, b) => a.runId.localeCompare(b.runId));
}
