import { ChevronDown, ChevronRight, FileSearch, UsersRound } from "lucide-react";
import { useMemo, useState } from "react";
import type { TrackerEntry } from "@/components/shared/types";
import type { WorkflowRunProjection } from "../../../domain/workflow-runtime/types.js";
import type { OperationOcrLink } from "./queue-surface-classifier";
import { EntryItem } from "./EntryItem";
import { cn } from "@/lib/utils";

export interface OperationRowProps {
  date?: string;
  parentRunId: string;
  projection?: WorkflowRunProjection;
  /** Per-entry base-name labels from `buildDisplayNameMap`. */
  displayNames?: Map<string, string>;
  /** Operation coordinator row (the anchor). Footer fallback before fan-out. */
  parent: TrackerEntry;
  /** Fanned-out signer / contact child rows (present after approval). */
  members: TrackerEntry[];
  /** Lightweight OCR status link (denormalized onto the operation row). */
  ocr?: OperationOcrLink;
  selected: boolean;
  selectedId?: string | null;
  onSelect: (id: string) => void;
  onDelete?: (id: string) => void;
  /** Gallery/dev fixtures can render the expanded state by default. */
  defaultExpanded?: boolean;
  /**
   * Open the OCR review row for this operation (cross-workflow navigation).
   * Needs both the OCR row's id (`sessionId`, to select it) and its `runId`
   * (to arm the OCR-panel Preview/review gate).
   */
  onOpenOcrReview?: (target: { sessionId: string; runId: string }) => void;
}

function ocrStatusLabel(status: string): string {
  switch (status) {
    case "awaiting-review":
      return "awaiting review";
    case "approved":
    case "done":
      return "approved";
    case "discarded":
      return "discarded";
    case "failed":
      return "failed";
    default:
      // Surface any other live OCR step verbatim (e.g. "wait-signatures")
      // instead of masking every unmapped status as "running".
      return status;
  }
}

function aggregateMemberCounts(members: TrackerEntry[]) {
  let done = 0;
  let running = 0;
  let queued = 0;
  let failed = 0;
  for (const member of members) {
    if (member.status === "done") done += 1;
    else if (member.status === "running") running += 1;
    else if (member.status === "pending" || member.status === "skipped") queued += 1;
    else if (member.status === "failed") failed += 1;
  }
  return { done, running, queued, failed, total: members.length };
}

function statusForDisplay(
  parent: TrackerEntry,
  projection: WorkflowRunProjection | undefined,
): TrackerEntry {
  if (!projection?.status || projection.status === parent.status) return parent;
  return {
    ...parent,
    status: projection.status as TrackerEntry["status"],
    _hash: `${parent._hash ?? parent.id}:${projection.status}`,
  };
}

/**
 * Top-level coordinator row for an OCR-backed target workflow
 * (oath-signature, emergency-contact). The coordinator stays selectable for
 * its own log timeline; before approval it shows the OCR status/link, and after
 * approval it expands downward to reveal the fanned-out member rows.
 */
export function OperationRow({
  date,
  parentRunId,
  projection,
  displayNames,
  parent,
  members,
  ocr,
  selected,
  selectedId,
  onSelect,
  onDelete,
  defaultExpanded = false,
  onOpenOcrReview,
}: OperationRowProps) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const showOcrStatus = members.length === 0 && Boolean(ocr);
  // Narrow once so the "Open OCR review" button needs no non-null assertion and
  // can hand both ids to the cross-workflow navigation callback.
  const ocrSessionId = ocr?.sessionId;
  const ocrRunId = ocr?.runId;
  const memberCounts = useMemo(() => aggregateMemberCounts(members), [members]);
  const memberProjectionById = useMemo(
    () => new Map((projection?.batchMembers ?? []).map((member) => [member.itemId, member])),
    [projection?.batchMembers],
  );
  const displayParent = statusForDisplay(parent, projection);
  const memberSummary = members.length > 0
    ? `${memberCounts.done} / ${memberCounts.total} done`
    : "";

  return (
    <div data-queue-operation-run-id={parentRunId}>
      <EntryItem
        entry={displayParent}
        projection={projection}
        displayNames={displayNames}
        selected={selected}
        onSelect={onSelect}
        date={date}
        onDelete={onDelete}
      />

      {members.length > 0 ? (
        <div className="-mt-1 border-x border-b border-border/70 bg-card/60 px-3 min-[1440px]:px-4 pb-2 rounded-b-md">
          <button
            type="button"
            className={cn(
              "flex h-8 w-full items-center gap-2 text-left text-xs text-muted-foreground",
              "hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1",
            )}
            aria-expanded={expanded}
            onClick={(event) => {
              event.stopPropagation();
              setExpanded((next) => !next);
            }}
          >
            {expanded ? (
              <ChevronDown className="size-3.5 shrink-0" aria-hidden />
            ) : (
              <ChevronRight className="size-3.5 shrink-0" aria-hidden />
            )}
            <UsersRound className="size-3.5 shrink-0" aria-hidden />
            <span className="truncate">Rows: {memberSummary}</span>
            {memberCounts.running > 0 ? (
              <span className="ml-auto shrink-0 text-primary">{memberCounts.running} running</span>
            ) : memberCounts.failed > 0 ? (
              <span className="ml-auto shrink-0 text-destructive">{memberCounts.failed} failed</span>
            ) : null}
          </button>

          {expanded ? (
            <div className="space-y-2 border-t border-border/60 pt-2">
              {members.map((member) => (
                <EntryItem
                  key={member.id}
                  entry={member}
                  projection={memberProjectionById.get(member.id)}
                  displayNames={displayNames}
                  selected={selectedId === member.id}
                  onSelect={onSelect}
                  date={date}
                  onDelete={onDelete}
                />
              ))}
            </div>
          ) : null}
        </div>
      ) : null}

      {showOcrStatus && ocr ? (
        <div className="flex items-center gap-2 px-3 min-[1440px]:px-4 pb-2 -mt-1 text-xs text-muted-foreground">
          <FileSearch className="size-3.5 shrink-0" aria-hidden />
          <span className="truncate">
            OCR: <span className="text-foreground/80">{ocrStatusLabel(ocr.status)}</span>
          </span>
          {ocrSessionId && ocrRunId && onOpenOcrReview ? (
            <button
              type="button"
              className="ml-auto shrink-0 text-primary hover:underline"
              onClick={() => onOpenOcrReview({ sessionId: ocrSessionId, runId: ocrRunId })}
            >
              Open OCR review
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
