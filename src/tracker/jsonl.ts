import { appendFileSync, existsSync, mkdirSync, readFileSync } from "fs";
import { join } from "path";

const DEFAULT_DIR = ".tracker";

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
