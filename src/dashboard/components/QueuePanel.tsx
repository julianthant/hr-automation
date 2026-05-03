import { useMemo, useState, type ReactNode } from "react";
import { Inbox } from "lucide-react";
import { StatPills } from "./StatPills";
import { EntryItem } from "./EntryItem";
import { EmptyState } from "./EmptyState";
import { ParentChildRow } from "./ocr/ParentChildRow";
import type { TrackerEntry } from "./types";
import {
  isApprovedPrepRow,
  isDiscardedPrepRow,
} from "./ocr/types";

interface QueuePanelProps {
  entries: TrackerEntry[];
  workflow: string;
  /** Per-entry "<base> <ordinal>" labels from `buildDisplayNameMap`. */
  displayNames?: Map<string, string>;
  selectedId: string | null;
  onSelect: (id: string) => void;
  /** Run-id of the prep row currently open in the right-pane review. */
  reviewingPrepId?: string | null;
  /** Open the right-pane review for this prep row. */
  onOpenReview?: (runId: string) => void;
  /** Open RunModal in reupload mode for the given OCR session. */
  onReupload?: (reuploadFor: { sessionId: string; previousRunId: string }) => void;
  /** RunId of the approved prep row currently drilled-into. null = main queue view. */
  drilledBatchRunId?: string | null;
  /** Open the drilled batch view for the given parent runId. */
  onDrillIn?: (parentRunId: string) => void;
  /** Exit drilled batch view back to the main queue. */
  onDrillOut?: () => void;
  loading: boolean;
  /**
   * Optional cluster of run controls (QuickRunPanel + Capture / Oath /
   * Run buttons) rendered in the panel's bottom footer, mirroring the
   * LogStream's "Streaming · N entries" footer on the right side. The
   * cluster is right-aligned within the footer when its contents are
   * narrower than the panel; QuickRunPanel's input naturally fills the
   * leading space when present.
   */
  runControlsSlot?: ReactNode;
}

/**
 * QueuePanel — left column of the main split.
 *
 *   [ Status filter strip ]    ← top of panel; tab-like pills
 *   [ Entry list ]             ← scrollable
 *   [ Run controls footer ]    ← matches LogStream footer height
 *
 * The cross-workflow search lives in the TopBar (centered) — there is no
 * panel-internal search input. The previous "Search by name, email, or
 * ID…" affordance was a near-duplicate of TopBar's `SearchBar`; folding
 * the two together removes a redundant control and gives the entry list
 * more vertical real estate.
 *
 * Border treatment: the panel's right divider is gone (the `bg-card`
 * neighbours visually separate themselves via tone alone). The footer's
 * top border keeps the run controls visually distinct from the scrollable
 * list above.
 */
export function QueuePanel({
  entries,
  workflow,
  displayNames,
  selectedId,
  onSelect,
  reviewingPrepId,
  onOpenReview,
  onReupload,
  drilledBatchRunId,
  onDrillIn,
  onDrillOut,
  loading,
  runControlsSlot,
}: QueuePanelProps) {
  void workflow;
  const [statusFilter, setStatusFilter] = useState<string | null>(null);

  // Resolved prep rows (approved/discarded) are treated as fully retired —
  // gone from the lists AND from the StatPills counts. Without this filter,
  // discarding a row leaves it hidden but still counted ("3 ALL / 1 visible").
  const visibleEntries = useMemo(
    () => entries.filter((e) => !isDiscardedPrepRow(e)),
    [entries],
  );

  // Prep rows are split out so they can render at the top of the panel
  // regardless of search/filter. The user always wants to see "what's
  // currently being prepared" — hiding it behind a status filter would be
  // surprising.
  const approvedPrepEntries = useMemo(
    () => visibleEntries.filter(isApprovedPrepRow),
    [visibleEntries],
  );

  /**
   * Map approved-prep runId → list of child entries (entries whose
   * `parentRunId` matches the prep row's runId). Computed once per entries
   * change so each ParentChildRow render is O(1) lookup.
   */
  const childrenByParentRun = useMemo(() => {
    const map = new Map<string, TrackerEntry[]>();
    for (const e of visibleEntries) {
      if (!e.parentRunId) continue;
      const list = map.get(e.parentRunId) ?? [];
      list.push(e);
      map.set(e.parentRunId, list);
    }
    return map;
  }, [visibleEntries]);

  const drilledParent = useMemo(
    () =>
      drilledBatchRunId
        ? approvedPrepEntries.find(
            (e) => (e.runId ?? e.id) === drilledBatchRunId,
          ) ?? null
        : null,
    [drilledBatchRunId, approvedPrepEntries],
  );

  const drilledChildren = useMemo(
    () =>
      drilledBatchRunId ? childrenByParentRun.get(drilledBatchRunId) ?? [] : [],
    [drilledBatchRunId, childrenByParentRun],
  );

  /**
   * Set of parent runIds that are currently rendered as ParentChildRow above
   * the regular list. Children of these parents are folded INTO the parent
   * card, so they should not also appear in the flat list.
   */
  const approvedParentRunIds = useMemo(
    () =>
      new Set(
        approvedPrepEntries.map((e) => e.runId ?? e.id),
      ),
    [approvedPrepEntries],
  );

  const filtered = useMemo(() => {
    let result = visibleEntries.filter(
      (e) =>
        // Prep rows now render as regular EntryItem in the main list — only
        // approved-prep parents (which become ParentChildRow above) and
        // children-of-approved-parents (folded into the parent) are excluded.
        !isApprovedPrepRow(e) &&
        !(e.parentRunId && approvedParentRunIds.has(e.parentRunId)),
    );
    if (statusFilter) {
      result = result.filter((e) =>
        statusFilter === "pending"
          ? e.status === "pending" || e.status === "skipped"
          : e.status === statusFilter,
      );
    }
    return result;
  }, [visibleEntries, statusFilter, approvedParentRunIds]);

  return (
    <div className="w-[300px] min-[1440px]:w-[380px] 2xl:w-[460px] flex-shrink-0 flex flex-col bg-background">
      {drilledParent ? (
        <DrilledHeader
          parent={drilledParent}
          onBack={() => onDrillOut?.()}
          onOpenReview={() => {
            const runId = drilledParent.runId ?? drilledParent.id;
            onOpenReview?.(runId);
          }}
        />
      ) : (
        <div className="h-[69.5px] flex items-center px-3 min-[1440px]:px-4 py-2 border-b border-border bg-card/60 flex-shrink-0">
          <StatPills
            entries={visibleEntries}
            activeFilter={statusFilter}
            onFilter={setStatusFilter}
          />
        </div>
      )}

      <div className="flex-1 overflow-y-auto border-b border-border">
        {drilledParent ? (
          drilledChildren.length === 0 ? (
            <EmptyState
              icon={Inbox}
              title="No children yet"
              description="Children will appear here as the workflow processes them"
            />
          ) : (
            drilledChildren.map((entry) => (
              <EntryItem
                key={entry.id}
                entry={entry}
                displayNames={displayNames}
                selected={selectedId === entry.id}
                onClick={() => onSelect(entry.id)}
              />
            ))
          )
        ) : (
          <>
            {approvedPrepEntries.map((e) => {
              const runId = e.runId ?? e.id;
              return (
                <ParentChildRow
                  key={`pcr-${runId}`}
                  parent={e}
                  childEntries={childrenByParentRun.get(runId) ?? []}
                  isDrilled={drilledBatchRunId === runId}
                  onDrillIn={(rid) => onDrillIn?.(rid)}
                />
              );
            })}
            {/* Prep rows render as regular EntryItem (same size + behavior
                as other workflow rows). The only differentiator is the
                Preview tab inside LogPanel, gated on data.mode === "prepare".
                Reupload + Discard live in OcrReviewPane's header. */}
            {loading ? (
              <div className="space-y-0">
                {Array.from({ length: 6 }).map((_, i) => (
                  <div key={i} className="px-5 py-3.5 border-b border-border">
                    <div className="flex justify-between mb-2">
                      <div className="h-4 w-32 rounded bg-muted animate-pulse" />
                      <div className="h-4 w-16 rounded bg-muted animate-pulse" />
                    </div>
                    <div className="h-3 w-48 rounded bg-muted animate-pulse mt-1" />
                    <div className="h-3 w-24 rounded bg-muted animate-pulse mt-2" />
                  </div>
                ))}
              </div>
            ) : filtered.length === 0 ? (
              <EmptyState
                icon={Inbox}
                title="No entries yet"
                description="Data will appear here as workflows run"
              />
            ) : (
              filtered.map((entry) => (
                <EntryItem
                  key={entry.id}
                  entry={entry}
                  displayNames={displayNames}
                  selected={selectedId === entry.id}
                  onClick={() => onSelect(entry.id)}
                />
              ))
            )}
          </>
        )}
      </div>

      {runControlsSlot && (
        <div className="h-12 flex items-center gap-2 px-3 min-[1440px]:px-4 bg-card/40 flex-shrink-0 justify-end">
          {runControlsSlot}
        </div>
      )}
    </div>
  );
}

function DrilledHeader({
  parent,
  onBack,
  onOpenReview,
}: {
  parent: TrackerEntry;
  onBack: () => void;
  onOpenReview: () => void;
}) {
  const filename = parent.data?.pdfOriginalName || "Prep batch";
  const runId = parent.runId ?? parent.id;
  const time = formatPrepHeaderTime(parent.timestamp);
  return (
    <div className="h-[69.5px] flex flex-col justify-center px-3 min-[1440px]:px-4 border-b border-border bg-card/60 flex-shrink-0 gap-1">
      <div className="flex items-center gap-2 min-w-0">
        <button
          type="button"
          onClick={onBack}
          className="inline-flex items-center gap-1 rounded-md border border-border bg-secondary/40 px-2 py-1 text-[11px] text-foreground hover:bg-secondary/70 flex-shrink-0"
        >
          ← Queue
        </button>
        <span className="text-muted-foreground/60">/</span>
        <span className="font-semibold text-[13px] text-foreground truncate min-w-0 flex-1">
          {filename}
        </span>
      </div>
      <div className="text-[10px] font-mono text-muted-foreground pl-1 flex items-center gap-1.5">
        <span>Approved {time} · prep#{runId.slice(-4)}</span>
        <span className="text-muted-foreground/50">·</span>
        <button
          type="button"
          onClick={onOpenReview}
          className="text-primary hover:text-primary/80 underline-offset-2 hover:underline transition-colors"
        >
          Open prep review
        </button>
      </div>
    </div>
  );
}

function formatPrepHeaderTime(ts: string): string {
  try {
    const d = new Date(ts);
    if (Number.isNaN(d.getTime())) return ts.slice(11, 16);
    return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  } catch {
    return ts.slice(11, 16);
  }
}
