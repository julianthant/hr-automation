import type { TrackerEntry } from "../../jsonl.js";
import { findLatestEntryForPredicate } from "../../find-latest-entry.js";

const WORKFLOW = "ocr";
const SESSION_LOOKBACK_DAYS = 7;

/**
 * Walk OCR JSONL entries for a given session newest-first across up to
 * SESSION_LOOKBACK_DAYS days. Handles cross-midnight sessions where the
 * session was created just before midnight and approved after.
 *
 * Thin wrapper over the canonical `findLatestEntryForPredicate` helper — kept
 * JSONL-only (no `db` handle) because these readers match `data.*` predicates
 * that have no SQLite index. Returns `undefined` (not `null`) for no-match to
 * preserve the original signature.
 */
function walkOcrJsonl(
  sessionId: string,
  trackerDir: string | undefined,
  predicate: (e: TrackerEntry) => boolean,
): TrackerEntry | undefined {
  return (
    findLatestEntryForPredicate({
      workflow: WORKFLOW,
      ...(trackerDir !== undefined ? { trackerDir } : {}),
      lookbackDays: SESSION_LOOKBACK_DAYS,
      predicate: (e) => e.id === sessionId && predicate(e),
    }) ?? undefined
  );
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

export function readDryRun(sessionId: string, trackerDir: string | undefined): boolean {
  const e = walkOcrJsonl(sessionId, trackerDir, (row) => {
    const v = row.data?.dryRun;
    return v === "true" || v === "1";
  });
  return e !== undefined;
}
