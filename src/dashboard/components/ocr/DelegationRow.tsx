import type { TrackerEntry } from "@/components/shared/types";
import { GroupRowBase } from "@/components/queue-panel/group-row-base";
import { RetryButton } from "@/components/shared/RetryButton";
import { DeleteButton } from "@/components/shared/DeleteButton";

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
  /** Tracker date — required for delete. */
  date?: string;
  /** Called after deleting the prep parent row. */
  onDelete?: (id: string) => void;
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
  date,
  onDelete,
  batchDrillInEnabled = true,
}: DelegationRowProps) {
  const runId = parent.runId ?? parent.id;
  const title = parent.data?.pdfOriginalName || "Prep batch";
  const footerActions = (
    <>
      <RetryButton
        workflow={parent.workflow}
        id={parent.id}
        runId={parent.runId}
        date={date}
      />
      {date && onDelete ? (
        <DeleteButton
          workflow={parent.workflow}
          id={parent.id}
          runId={parent.runId}
          date={date}
          onDeleted={onDelete}
        />
      ) : null}
    </>
  );

  return (
    <GroupRowBase
      variant="approval-delegation"
      title={title}
      parentRunId={runId}
      members={delegatedEntries}
      countTone="warning"
      footerRunOrdinal={parent.runOrdinal}
      footerSecondaryId={parent.id}
      firstTimestamp={parent.timestamp}
      isFocused={isBatchQueueFocused}
      drillInEnabled={batchDrillInEnabled}
      onEnter={onEnterBatchQueue}
      footerActions={footerActions}
    />
  );
}
