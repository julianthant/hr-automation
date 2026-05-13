import type { TrackerEntry } from "@/components/shared/types";
import { GroupRowBase } from "@/components/queue-panel/group-row-base";

/**
 * Summary card for an approval delegation: an approved prep row and its
 * downstream kernel runs (`parentRunId`). Kept in OCR as a compatibility
 * wrapper while the shared queue-panel base owns the visual structure.
 */
export interface DelegationRowProps {
  /** The approved prep tracker row (delegation parent). */
  parent: TrackerEntry;
  /** Downstream entries with `parentRunId === parent.runId`. */
  delegatedEntries: TrackerEntry[];
  /** Whether the batch queue view is showing this parent's members. */
  isBatchQueueFocused: boolean;
  onEnterBatchQueue: (parentRunId: string) => void;
  /**
   * When false, the row is display-only (no drill-in). Nested batch navigation
   * is unsupported; keep this true only on the main queue list.
   */
  batchDrillInEnabled?: boolean;
}

export function DelegationRow({
  parent,
  delegatedEntries,
  isBatchQueueFocused,
  onEnterBatchQueue,
  batchDrillInEnabled = true,
}: DelegationRowProps) {
  const runId = parent.runId ?? parent.id;
  const title = parent.data?.pdfOriginalName || "Prep batch";

  return (
    <GroupRowBase
      variant="approval-delegation"
      title={title}
      parentRunId={runId}
      members={delegatedEntries}
      countTone="warning"
      footerLabelPrefix="prep"
      firstTimestamp={parent.timestamp}
      isFocused={isBatchQueueFocused}
      drillInEnabled={batchDrillInEnabled}
      onEnter={onEnterBatchQueue}
    />
  );
}
