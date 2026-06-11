import { Clock, FileText, GripVertical } from "lucide-react";
import { useMemo, type KeyboardEvent, type ReactNode } from "react";
import type { TrackerEntry } from "@/components/shared/types";
import type { WorkflowRunProjection } from "../../../domain/workflow-runtime/types.js";
import { QueueRowCard } from "./QueueRowCard";
import { StatusCounts } from "./StatusCounts";
import {
  formatEntryTime,
  getRunNumber,
  resolveEntryId,
  resolveEntryName,
} from "@/components/shared/entry-display";
import { cn } from "@/lib/utils";
import {
  aggregateBatchCounts,
  computeBatchElapsed,
  useBatchElapsedLabel,
} from "@/components/ocr/delegation-row-helpers";
import { memberStatusSpec } from "@/components/shared/status-styles";

/**
 * Batch queue row (`?view=ui-gallery` plus production `DaemonBatchRow`).
 *
 * This is deliberately NOT an operation/coordinator card. Operation rows are a
 * parent tracker with optional fanned-out children; batch rows are a dedicated
 * queue container for many items. The shape is:
 *
 *     queue header (file/person identity + totals)
 *     progress ledger
 *     compact member preview / empty waiting strip
 *     footer with batch bulk actions
 */

export interface BatchRowUnifiedProps {
  date?: string;
  parentRunId: string;
  projection?: WorkflowRunProjection;
  displayNames?: Map<string, string>;
  members: TrackerEntry[];
  /** Footer fallback when the batch has not fanned out yet (0 members). */
  anchorEntry?: TrackerEntry;
  /** Title from the batch's file/spec; empty → member-name preview. */
  title?: string;
  /** Footer secondary id (trace id). */
  subtitle?: string;
  selected: boolean;
  onSelect?: (id: string) => void;
  onDelete?: (id: string) => void;
  isQueueFocused?: boolean;
  drillInEnabled?: boolean;
  onEnterBatchQueue?: (batchParentRunId: string) => void;
  footerActions?: ReactNode;
}

const PREVIEW_LIMIT = 4;

/** Running first, then queued in source order, then done to fill remaining slots. */
export function orderBatchPreviewMembers(members: TrackerEntry[], limit = PREVIEW_LIMIT): TrackerEntry[] {
  const running: TrackerEntry[] = [];
  const queued: TrackerEntry[] = [];
  const failed: TrackerEntry[] = [];
  const done: TrackerEntry[] = [];
  for (const member of members) {
    if (member.status === "running") running.push(member);
    else if (member.status === "pending" || member.status === "skipped") queued.push(member);
    else if (member.status === "failed" && member.step === "cancelled") queued.push(member);
    else if (member.status === "failed") failed.push(member);
    else if (member.status === "done") done.push(member);
    else queued.push(member);
  }
  return [...running, ...queued, ...failed, ...done].slice(0, limit);
}

export function BatchRowUnified({
  date,
  parentRunId,
  projection,
  displayNames,
  members,
  anchorEntry,
  title,
  subtitle,
  selected,
  onSelect,
  onDelete,
  isQueueFocused,
  drillInEnabled = true,
  onEnterBatchQueue,
  footerActions,
}: BatchRowUnifiedProps) {
  const counts = useMemo(() => aggregateBatchCounts(members), [members]);
  const fileTitle = title?.trim() ?? "";
  const footerEntry = members[0] ?? anchorEntry;
  const footerEntries = useMemo(
    () => (members.length > 0 ? members : anchorEntry ? [anchorEntry] : members),
    [members, anchorEntry],
  );
  const firstTimestamp = [...footerEntries].sort((a, b) => a.timestamp.localeCompare(b.timestamp))[0]
    ?.timestamp;
  const elapsed = computeBatchElapsed(footerEntries);
  const elapsedLabel = useBatchElapsedLabel(elapsed);
  const previewMembers = useMemo(
    () => orderBatchPreviewMembers(members, PREVIEW_LIMIT),
    [members],
  );
  const canOpenQueue = drillInEnabled && Boolean(onEnterBatchQueue);
  const interactive = canOpenQueue || Boolean(onSelect);
  const selectedState = isQueueFocused ?? selected;
  const runNumber = footerEntry ? getRunNumber(footerEntry) : 1;
  const displayTitle = fileTitle || (counts.total > 0 ? `${counts.total} rows` : "Batch queue");

  function activate() {
    if (canOpenQueue) {
      onEnterBatchQueue?.(parentRunId);
      return;
    }
    onSelect?.(parentRunId);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (!interactive) return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      activate();
    }
  }

  return (
    <div data-queue-batch-run-id={parentRunId}>
      <QueueRowCard
        selected={selectedState}
        interactive={interactive}
        rootProps={{
          ...(interactive
            ? {
                onClick: activate,
                role: "button",
                tabIndex: 0,
                "aria-pressed": selectedState,
                onKeyDown: handleKeyDown,
              }
            : {}),
          "aria-label": `${displayTitle} batch queue, ${counts.done} of ${counts.total} done`,
          "data-queue-entry-id": parentRunId,
        }}
        footer={{
          time: firstTimestamp ? formatEntryTime(firstTimestamp) : "",
          runNumber,
          secondaryId: projection?.subtitle ?? subtitle,
          elapsed: elapsedLabel && !elapsed?.frozen ? elapsedLabel : null,
          duration: elapsedLabel && elapsed?.frozen ? elapsedLabel : null,
          actions: footerActions,
          rowAction: footerActions
            ? undefined
            : {
                workflow: footerEntry?.workflow ?? "oath-signature",
                id: parentRunId,
                runId: parentRunId,
                date,
                actions: projection?.actions,
                subject: displayTitle,
                onDelete,
              },
        }}
      >
        {fileTitle ? (
          <div className="px-3.5 py-2.5">
            <div className="flex min-w-0 items-center gap-2">
              <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
              <span className="truncate text-[14px] font-semibold text-foreground">
                {fileTitle}
              </span>
            </div>
          </div>
        ) : null}

        <div
          className={cn(
            "border-border/60 bg-secondary/15 px-3.5 py-2",
            fileTitle ? "border-t" : "",
          )}
        >
          <div className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1 font-mono text-[10.5px]">
            <StatusCounts counts={counts} />
          </div>
        </div>

        {members.length > 0 ? (
          <div className="border-t border-border/60 bg-card">
            <div className="divide-y divide-border/45">
              {previewMembers.map((member, index) => {
                const status = memberStatusSpec(member);
                const StatusIcon = status.Icon;
                return (
                  <div
                    key={member.id}
                    className="grid min-w-0 grid-cols-[1rem_minmax(0,1fr)_5.75rem] items-center gap-2 px-3.5 py-1.5 text-[12px]"
                  >
                    <GripVertical className="size-3 text-muted-foreground/70" aria-hidden />
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="w-4 shrink-0 font-mono text-[10.5px] tabular-nums text-muted-foreground">
                        {index + 1}
                      </span>
                      <span className="truncate font-medium text-foreground">
                        {resolveEntryName(member, displayNames)}
                      </span>
                      <span className="shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground">
                        {resolveEntryId(member)}
                      </span>
                    </div>
                    <span
                      className={cn(
                        "inline-flex shrink-0 items-center justify-end gap-1 whitespace-nowrap font-mono text-[10.5px] tabular-nums",
                        status.tone,
                      )}
                    >
                      <StatusIcon
                        className={cn("size-3", status.spin && "animate-spin motion-reduce:animate-none")}
                        aria-hidden
                      />
                      {status.label}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        ) : (
          <div className="border-t border-border/60 bg-card px-3.5 py-3">
            <div className="flex items-center justify-center gap-2 rounded-md border border-dashed border-border bg-secondary/15 py-2 font-mono text-[11px] text-muted-foreground">
              <Clock className="size-3.5" aria-hidden />
              <span>no rows yet</span>
            </div>
          </div>
        )}
      </QueueRowCard>
    </div>
  );
}
