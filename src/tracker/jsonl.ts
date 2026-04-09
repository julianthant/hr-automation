import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from "fs";
import { join } from "path";

const DEFAULT_DIR = ".tracker";

export interface LogEntry {
  workflow: string;
  itemId: string;
  level: "step" | "success" | "error" | "waiting";
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
  appendFileSync(logPath, JSON.stringify(entry) + "\n");
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
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const logPath = getLogPath(entry.workflow, dir);
  appendFileSync(logPath, JSON.stringify(entry) + "\n");
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
  const emit = (status: TrackerEntry["status"], extra?: { step?: string; error?: string }) => {
    trackEvent({ workflow, timestamp: ts(), id, status, data, ...extra });
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
