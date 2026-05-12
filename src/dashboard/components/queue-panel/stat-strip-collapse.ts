import type { TrackerEntry } from "@/components/shared/types";
import { collapseMergedPrimariesForQueueStrip } from "../../../tracker/queue-row-count.js";

/**
 * Reduces merge primaries into one unit per StatPills / sidebar-visible row.
 * Delegates to the tracker canonical implementation so SSE `wfCounts`, SQLite
 * projection counts, and the React queue strip never drift.
 */
export function collapseEntriesForStatStrip(entries: readonly TrackerEntry[]): TrackerEntry[] {
  return collapseMergedPrimariesForQueueStrip(entries);
}
