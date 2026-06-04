import type { TrackerEntry } from "../../jsonl.js";
import { findLatestEntryForPredicate } from "../../find-latest-entry.js";

const WORKFLOW = "ocr";
const SESSION_LOOKBACK_DAYS = 7;

/**
 * Target workflows that get a top-level DISPLAY-only `operation` coordinator row
 * in their own panel when launched from a PDF upload — created at OCR prepare,
 * with the OCR run delegated under it. `oath-upload` is intentionally NOT in
 * this set: it is a real daemon task born at upload as a `single` row, not a
 * display coordinator. A standalone OCR run (no targetWorkflow) gets none.
 *
 * The single source of truth for "does this OCR run have a coordinator row?" —
 * shared by `prepare` (creates the row) and `approve` (mirrors `approved` onto
 * it). Discard reaches the same rows via its own parent-mirror path.
 */
export const OPERATION_COORDINATOR_WORKFLOWS = new Set(["oath-signature", "emergency-contact"]);

export function isOperationCoordinatorWorkflow(workflow: string | undefined): boolean {
  return workflow !== undefined && OPERATION_COORDINATOR_WORKFLOWS.has(workflow);
}

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

/**
 * The target-workflow operation this OCR run belongs to (oath-signature |
 * emergency-contact | oath-upload), stamped on every OCR row by the orchestrator
 * from `OcrInput.operationWorkflow`. `undefined` for a standalone OCR-hub upload.
 * Lets the approve route route the fan-out by intent.
 */
export function readOperationWorkflow(sessionId: string, trackerDir: string | undefined): string | undefined {
  const e = walkOcrJsonl(
    sessionId,
    trackerDir,
    (row) => typeof row.data?.operationWorkflow === "string" && row.data.operationWorkflow.length > 0,
  );
  const value = e?.data?.operationWorkflow;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function readDryRun(sessionId: string, trackerDir: string | undefined): boolean {
  const e = walkOcrJsonl(sessionId, trackerDir, (row) => {
    const v = row.data?.dryRun;
    return v === "true" || v === "1";
  });
  return e !== undefined;
}
