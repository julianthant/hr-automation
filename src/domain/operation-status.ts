import type { TrackerEntry } from "../tracker/jsonl.js";

/**
 * Shared operation effective-status rollup, used by BOTH the queue-surface
 * projection (`workflow-runtime/projection.ts`) and the log-panel coordinator
 * helpers (`dashboard/.../coordinator-logs.ts`) so the single rule lives in one
 * client-safe leaf. The `TrackerEntry` import is type-only, so this module
 * pulls no `node:fs` (or any other Node-only) code into the React bundle.
 */

/** A fanned-out member row is terminal once it can no longer transition. */
export function isTerminalMemberStatus(status: TrackerEntry["status"]): boolean {
  return status === "done" || status === "failed" || status === "skipped";
}

/**
 * Shared operation effective-status rollup. Parent terminal wins; else when
 * there are members and ALL are terminal the operation reads done; else the
 * parent status passes through. (Pre-fan-out / OCR-specific branches stay at
 * each call site.)
 */
export function rollupOperationStatus(
  parentStatus: TrackerEntry["status"],
  memberStatuses: readonly TrackerEntry["status"][],
): TrackerEntry["status"] {
  if (parentStatus === "failed" || parentStatus === "done") return parentStatus;
  if (memberStatuses.length > 0 && memberStatuses.every(isTerminalMemberStatus)) return "done";
  return parentStatus;
}
