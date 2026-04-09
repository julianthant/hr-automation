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

export function readEntries(workflow: string, dir: string = DEFAULT_DIR): TrackerEntry[] {
  const logPath = getLogPath(workflow, dir);
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, "utf-8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as TrackerEntry);
}

/** List all workflows that have tracker data (scans dir for *.jsonl files). */
export function listWorkflows(dir: string = DEFAULT_DIR): string[] {
  if (!existsSync(dir)) return [];
  const today = new Date().toISOString().slice(0, 10);
  return readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => f.replace(`-${today}.jsonl`, "").replace(/\.jsonl$/, ""))
    .filter((v, i, a) => a.indexOf(v) === i);
}
