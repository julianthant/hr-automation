import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync } from "fs";
import { join } from "path";
import { Mutex } from "async-mutex";

const writeMutex = new Mutex();

const DEFAULT_DIR = ".tracker";

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
  ) => Promise<T>,
): Promise<T> {
  const data = { ...initialData };
  const ts = () => new Date().toISOString();

  // Compute run number: count existing entries with same id, then +1
  const existing = readEntries(workflow);
  const priorRuns = new Set(
    existing.filter((e) => e.id === id).map((e) => e.runId)
  );
  const runNumber = priorRuns.size + 1;
  const runId = `${id}#${runNumber}`;

  const emit = (status: TrackerEntry["status"], extra?: { step?: string; error?: string }) => {
    trackEvent({ workflow, timestamp: ts(), id, runId, status, data, ...extra });
  };

  emit("pending");
  try {
    const result = await fn(
      (step) => emit("running", { step }),
      (d) => Object.assign(data, d),
    );
    emit("done");
    return result;
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    emit("failed", { error });
    throw e;
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

/** List distinct runs for a given ID, with their latest status and timestamp. */
export function readRunsForId(
  workflow: string,
  id: string,
  dir: string = DEFAULT_DIR,
): { runId: string; status: string; timestamp: string }[] {
  const entries = readEntries(workflow, dir).filter((e) => e.id === id);
  const runMap = new Map<string, TrackerEntry>();
  for (const e of entries) {
    const rid = e.runId || `${e.id}#1`;
    runMap.set(rid, e); // keeps latest
  }
  return [...runMap.values()]
    .map((e) => ({ runId: e.runId || `${e.id}#1`, status: e.status, timestamp: e.timestamp }))
    .sort((a, b) => a.runId.localeCompare(b.runId));
}
