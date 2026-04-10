import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync } from "fs";
import { join } from "path";
import { execSync } from "child_process";
import { Mutex } from "async-mutex";
import { log, setLogRunId } from "../utils/log.js";
import { classifyError } from "../utils/errors.js";

const writeMutex = new Mutex();

export const DEFAULT_DIR = ".tracker";

export interface LogEntry {
  workflow: string;
  itemId: string;
  runId?: string;
  level: "step" | "success" | "error" | "waiting";
  message: string;
  ts: string;
}

function getLogFilePath(workflow: string, dir: string): string {
  const today = new Date().toISOString().slice(0, 10);
  return join(dir, `${workflow}-${today}-logs.jsonl`);
}

export function appendLogEntry(entry: LogEntry, dir: string = DEFAULT_DIR): void {
  writeMutex.runExclusive(() => {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const logPath = getLogFilePath(entry.workflow, dir);
    appendFileSync(logPath, JSON.stringify(entry) + "\n");
  });
}

export function readLogEntries(
  workflow: string,
  itemId?: string,
  dir: string = DEFAULT_DIR,
): LogEntry[] {
  const logPath = getLogFilePath(workflow, dir);
  if (!existsSync(logPath)) return [];
  const all = readFileSync(logPath, "utf-8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as LogEntry);
  if (itemId) return all.filter((e) => e.itemId === itemId);
  return all;
}

export interface TrackerEntry {
  workflow: string;
  timestamp: string;
  id: string;
  runId?: string;
  status: "pending" | "running" | "done" | "failed" | "skipped";
  step?: string;
  data?: Record<string, string>;
  error?: string;
}

function getLogPath(workflow: string, dir: string): string {
  const today = new Date().toISOString().slice(0, 10);
  return join(dir, `${workflow}-${today}.jsonl`);
}

export function trackEvent(entry: TrackerEntry, dir: string = DEFAULT_DIR): void {
  writeMutex.runExclusive(() => {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const logPath = getLogPath(entry.workflow, dir);
    appendFileSync(logPath, JSON.stringify(entry) + "\n");
  });
}

/**
 * Wrap a workflow function with automatic lifecycle tracking.
 *
 * Emits: pending (on start) → running/step (via setStep) → done (on success) | failed (on throw).
 * Call `updateData()` to enrich the entry with data discovered during execution (e.g. employee name).
 */
export async function withTrackedWorkflow<T>(
  workflow: string,
  id: string,
  initialData: Record<string, string>,
  fn: (
    setStep: (step: string) => void,
    updateData: (d: Record<string, string>) => void,
    /** Register a sync cleanup function (e.g. kill browsers) that runs on SIGINT before exit. */
    onCleanup: (cb: () => void) => void,
  ) => Promise<T>,
  /** Pre-assigned runId (batch mode) — skips run computation and initial pending emit. */
  preAssignedRunId?: string,
): Promise<T> {
  const data = { ...initialData };
  const ts = () => new Date().toISOString();

  let runId: string;
  if (preAssignedRunId) {
    runId = preAssignedRunId;
  } else {
    const existing = readEntries(workflow);
    const priorRuns = new Set(
      existing.filter((e) => e.id === id).map((e) => e.runId)
    );
    runId = `${id}#${priorRuns.size + 1}`;
  }
  setLogRunId(runId);

  const emit = (status: TrackerEntry["status"], extra?: { step?: string; error?: string }) => {
    trackEvent({ workflow, timestamp: ts(), id, runId, status, data, ...extra });
  };

  if (!preAssignedRunId) emit("pending");

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
    const error = `Process terminated (${signal})`;
    const now = ts();
    const date = now.slice(0, 10);
    if (!existsSync(DEFAULT_DIR)) mkdirSync(DEFAULT_DIR, { recursive: true });
    const logEntry: LogEntry = { workflow, itemId: id, runId, level: "error", message: error, ts: now };
    const trackEntry: TrackerEntry = { workflow, timestamp: now, id, runId, status: "failed", data, error };
    appendFileSync(join(DEFAULT_DIR, `${workflow}-${date}-logs.jsonl`), JSON.stringify(logEntry) + "\n");
    appendFileSync(join(DEFAULT_DIR, `${workflow}-${date}.jsonl`), JSON.stringify(trackEntry) + "\n");
  };
  process.on("SIGINT", () => { onSignal("SIGINT"); process.exit(130); });
  process.on("SIGTERM", () => { onSignal("SIGTERM"); process.exit(143); });

  try {
    const result = await fn(
      (step) => emit("running", { step }),
      (d) => Object.assign(data, d),
      (cb) => cleanupFns.push(cb),
    );
    emit("done");
    return result;
  } catch (e) {
    const error = classifyError(e);
    log.error(error);
    emit("failed", { error });
    throw e;
  } finally {
    process.removeAllListeners("SIGINT");
    process.removeAllListeners("SIGTERM");
  }
}

export function readEntries(workflow: string, dir: string = DEFAULT_DIR): TrackerEntry[] {
  const logPath = getLogPath(workflow, dir);
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, "utf-8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as TrackerEntry);
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
  const logPath = join(dir, `${workflow}-${date}.jsonl`);
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, "utf-8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as TrackerEntry);
}

/** Read log entries for a specific date (not just today). */
export function readLogEntriesForDate(
  workflow: string,
  itemId: string | undefined,
  date: string,
  dir: string = DEFAULT_DIR,
): LogEntry[] {
  const logPath = join(dir, `${workflow}-${date}-logs.jsonl`);
  if (!existsSync(logPath)) return [];
  const all = readFileSync(logPath, "utf-8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as LogEntry);
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
  dir: string = DEFAULT_DIR,
): { runId: string; status: string; step?: string; timestamp: string }[] {
  const entries = readEntries(workflow, dir).filter((e) => e.id === id);
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
