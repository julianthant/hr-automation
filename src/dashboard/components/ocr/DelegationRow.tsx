import type { TrackerEntry } from "@/components/shared/types";
import { GroupRowBase } from "@/components/queue-panel/group-row-base";
import { ApprovalDelegationFooterActions } from "@/components/queue-panel/ApprovalDelegationFooterActions";
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
  isOperationQueueFocused: boolean;
  onEnterOperationQueue: (parentRunId: string) => void;
  /** Tracker date — required for delete. */
  date?: string;
  /** Called after deleting the prep parent row. */
  onDelete?: (id: string) => void;
  /**
   * When false, the row is display-only (no drill-in). Nested batch navigation
   * is unsupported; keep this true only on the main queue list.
   */
  operationDrillInEnabled?: boolean;
}

export function DelegationRow({
  parent,
  delegatedEntries,
  projection,
  isOperationQueueFocused,
  onEnterOperationQueue,
  date,
  onDelete,
  operationDrillInEnabled = true,
}: DelegationRowProps) {
  const runId = parent.runId ?? parent.id;
  const title = parent.data?.pdfOriginalName ?? readQueueTitle(parent.data) ?? "Prep batch";

  return (
    <GroupRowBase
      variant="preview"
      title={projection?.title ?? title}
      parentRunId={runId}
      members={delegatedEntries}
      countTone="warning"
      footerRunOrdinal={parent.runOrdinal}
      // Subtitle is the kind-resolved trace id (file kind → trace id). Never
      // fall back to `data.__name` — for OCR that leaks the literal workflow
      // label "OCR" into the slot. A stale, pre-trace-id row simply shows no id.
      footerSecondaryId={projection?.subtitle}
      firstTimestamp={parent.timestamp}
      elapsedEntries={[parent, ...delegatedEntries]}
      isFocused={isOperationQueueFocused}
      drillInEnabled={operationDrillInEnabled}
      onEnter={onEnterOperationQueue}
      footerActions={
        <ApprovalDelegationFooterActions
          parent={parent}
          delegatedEntries={delegatedEntries}
          projection={projection}
          operationParentRunId={runId}
          date={date}
          onDelete={onDelete}
        />
      }
    />
  );
}
