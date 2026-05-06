import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { dateLocal } from "../../jsonl.js";
import type { TrackerEntry } from "../../jsonl.js";

export function readFormType(sessionId: string, trackerDir: string | undefined): string | null {
  const date = dateLocal();
  const file = join(trackerDir ?? ".tracker", `ocr-${date}.jsonl`);
  if (!existsSync(file)) return null;
  const lines = readFileSync(file, "utf-8").split("\n").filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const e: TrackerEntry = JSON.parse(lines[i]);
      if (e.id === sessionId && e.data?.formType) {
        return e.data.formType as unknown as string;
      }
    } catch { /* tolerate */ }
  }
  return null;
}

export function readParentRunId(sessionId: string, trackerDir: string | undefined): string | undefined {
  const date = dateLocal();
  const file = join(trackerDir ?? ".tracker", `ocr-${date}.jsonl`);
  if (!existsSync(file)) return undefined;
  const lines = readFileSync(file, "utf-8").split("\n").filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const e = JSON.parse(lines[i]) as TrackerEntry;
      if (e.id === sessionId && typeof e.parentRunId === "string" && e.parentRunId.length > 0) {
        return e.parentRunId;
      }
    } catch { /* tolerate malformed lines */ }
  }
  return undefined;
}

export function readDryRun(sessionId: string, trackerDir: string | undefined): boolean {
  const date = dateLocal();
  const file = join(trackerDir ?? ".tracker", `ocr-${date}.jsonl`);
  if (!existsSync(file)) return false;
  const lines = readFileSync(file, "utf-8").split("\n").filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const e = JSON.parse(lines[i]) as TrackerEntry;
      if (e.id !== sessionId) continue;
      const value = e.data?.dryRun as unknown;
      if (value === true || value === "true" || value === "1") return true;
    } catch { /* tolerate malformed lines */ }
  }
  return false;
}
