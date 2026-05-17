import type { TrackerEntry } from "@/components/shared/types";
import { collapseMergedPrimariesForQueueStrip } from "../../../tracker/queue-row-count.js";

/**
 * Reduces merge primaries for StatPills **per-status** bucketing on collapsed
 * tracker rows. The "All" pill count + WorkflowRail badges use
 * {@link countQueuePanelTopLevelRows} / SSE `wfCounts` (queue-surface model)
 * instead so delegation cards are not double-counted.
 */
export function collapseEntriesForStatStrip(entries: readonly TrackerEntry[]): TrackerEntry[] {
  return collapseMergedPrimariesForQueueStrip(entries);
}
