import { readEntries, readEntriesForDate, dateLocal } from "../../jsonl.js";
import type { TrackerEntry } from "../../jsonl.js";

const WORKFLOW = "ocr";
const SESSION_LOOKBACK_DAYS = 7;

/**
 * Walk OCR JSONL entries for a given session newest-first across up to
 * SESSION_LOOKBACK_DAYS days. Handles cross-midnight sessions where the
 * session was created just before midnight and approved after.
 */
function walkOcrJsonl(
  sessionId: string,
  trackerDir: string | undefined,
  predicate: (e: TrackerEntry) => boolean,
): TrackerEntry | undefined {
  const dir = trackerDir ?? ".tracker";
  const today = new Date();
  for (let dayOffset = 0; dayOffset < SESSION_LOOKBACK_DAYS; dayOffset++) {
    const d = new Date(today);
    d.setDate(d.getDate() - dayOffset);
    const rows = dayOffset === 0
      ? readEntries(WORKFLOW, dir)
      : readEntriesForDate(WORKFLOW, dateLocal(d), dir);
    for (let i = rows.length - 1; i >= 0; i--) {
      const e = rows[i];
      if (e.id === sessionId && predicate(e)) return e;
    }
  }
  return undefined;
}

export function readFormType(sessionId: string, trackerDir: string | undefined): string | null {
  const e = walkOcrJsonl(sessionId, trackerDir, (row) => typeof row.data?.formType === "string");
  return e ? (e.data!.formType as string) : null;
}

export function readParentRunId(sessionId: string, trackerDir: string | undefined): string | undefined {
  const e = walkOcrJsonl(
    sessionId,
    trackerDir,
    (row) => typeof row.parentRunId === "string" && row.parentRunId.length > 0,
  );
  return e?.parentRunId;
}

export function readOriginWorkflow(sessionId: string, trackerDir: string | undefined): string | undefined {
  const e = walkOcrJsonl(sessionId, trackerDir, (row) => {
    const v = row.data?.originWorkflow as unknown;
    return typeof v === "string" && v.length > 0;
  });
  return e ? (e.data!.originWorkflow as string) : undefined;
}

export function readDryRun(sessionId: string, trackerDir: string | undefined): boolean {
  const e = walkOcrJsonl(sessionId, trackerDir, (row) => {
    const v = row.data?.dryRun;
    return v === "true" || v === "1";
  });
  return e !== undefined;
}
