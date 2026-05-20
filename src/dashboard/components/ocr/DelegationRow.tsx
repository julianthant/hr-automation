import type { TrackerEntry } from "@/components/shared/types";
import { GroupRowBase } from "@/components/queue-panel/group-row-base";
import { BatchFooterActions } from "@/components/queue-panel/BatchFooterActions";
import { readQueueTitle } from "../../../domain/queue-title.js";
import type { WorkflowRunProjection } from "../../../domain/workflow-runtime/types.js";

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
  projection?: WorkflowRunProjection;
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
  projection,
  isBatchQueueFocused,
  onEnterBatchQueue,
  date,
  onDelete,
  batchDrillInEnabled = true,
}: DelegationRowProps) {
  const runId = parent.runId ?? parent.id;
  const title = parent.data?.pdfOriginalName ?? readQueueTitle(parent.data) ?? "Prep batch";
  const footerActionEntries = delegatedEntries.length > 0 ? delegatedEntries : [parent];

  return (
    <GroupRowBase
      variant="approval-delegation"
      title={projection?.title ?? title}
      parentRunId={runId}
      members={delegatedEntries}
      countTone="warning"
      footerRunOrdinal={parent.runOrdinal}
      footerSecondaryId={projection?.subtitle ?? parent.data?.__name || parent.id}
      firstTimestamp={parent.timestamp}
      isFocused={isBatchQueueFocused}
      drillInEnabled={batchDrillInEnabled}
      onEnter={onEnterBatchQueue}
      footerActions={
        <BatchFooterActions
          workflow={parent.workflow}
          date={date}
          batchParentRunId={runId}
          memberEntries={footerActionEntries}
          projection={projection}
          onDeletedIds={(ids) => {
            if (ids.includes(parent.id)) onDelete?.(parent.id);
          }}
        />
      }
    />
  );
}
