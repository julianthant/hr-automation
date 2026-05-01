import { useMemo, useState, type ReactNode } from "react";
import { Inbox } from "lucide-react";
import { StatPills } from "./StatPills";
import { EntryItem } from "./EntryItem";
import { EmptyState } from "./EmptyState";
import { OcrQueueRow } from "./ocr/OcrQueueRow";
import { ParentChildRow } from "./ocr/ParentChildRow";
import type { TrackerEntry } from "./types";
import {
  isPrepareRow,
  isApprovedPrepRow,
  isDiscardedPrepRow,
} from "./ocr/types";

interface QueuePanelProps {
  entries: TrackerEntry[];
  workflow: string;
  selectedId: string | null;
  onSelect: (id: string) => void;
  /** Run-id of the prep row currently open in the right-pane review. */
  reviewingPrepId?: string | null;
  /** Open the right-pane review for this prep row. */
  onOpenReview?: (runId: string) => void;
  /** Open RunModal in reupload mode for the given OCR session. */
  onReupload?: (reuploadFor: { sessionId: string; previousRunId: string }) => void;
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
  selectedId,
  onSelect,
  reviewingPrepId,
  onOpenReview,
  onReupload,
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
  const inFlightPrepEntries = useMemo(
    () =>
      visibleEntries.filter(
        (e) => isPrepareRow(e) && !isApprovedPrepRow(e),
      ),
    [visibleEntries],
  );

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
        !isPrepareRow(e) &&
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
      {/* ── Status filter strip — top of panel ── */}
      <div className="h-[69.5px] flex items-center px-3 min-[1440px]:px-4 py-2 border-b border-border bg-card/60 flex-shrink-0">
        <StatPills entries={visibleEntries} activeFilter={statusFilter} onFilter={setStatusFilter} />
      </div>

      {/* ── Entry list ── */}
      <div className="flex-1 overflow-y-auto border-b border-border">
        {/* Pinned: approved prep rows render as ParentChildRow batch summaries. */}
        {approvedPrepEntries.map((e) => {
          const runId = e.runId ?? e.id;
          return (
            <ParentChildRow
              key={`pcr-${runId}`}
              parent={e}
              childEntries={childrenByParentRun.get(runId) ?? []}
              isDrilled={false}
              onDrillIn={() => {
                /* Task 5 wires this. */
              }}
            />
          );
        })}

        {/* Pinned: in-flight prep rows (preparing/ready/reviewing/failed-non-discarded). */}
        {inFlightPrepEntries.map((e) => {
          const runId = e.runId ?? e.id;
          return (
            <OcrQueueRow
              key={`prep-${runId}`}
              entry={e}
              isReviewing={reviewingPrepId === runId}
              onOpenReview={(rid) => onOpenReview?.(rid)}
              onReupload={onReupload}
            />
          );
        })}
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
              selected={selectedId === entry.id}
              onClick={() => onSelect(entry.id)}
            />
          ))
        )}
      </div>

      {/* ── Run controls footer — h-12 mirrors the LogStream footer's
            height + padding so the bottom edges of the two panels' footers
            tile cleanly. Right-stuck cluster: QuickRunPanel (input + Play
            + Retry-all) when wired for the workflow, plus per-workflow
            Capture / Run / Oath buttons. `justify-end` makes the buttons
            hug the right edge for workflows where QuickRunPanel returns
            null (e.g. emergency-contact); when QuickRunPanel renders, its
            form's `flex-1 min-w-0` expands to fill the leading space. ── */}
      {runControlsSlot && (
        <div className="h-12 flex items-center gap-2 px-3 min-[1440px]:px-4 bg-card/40 flex-shrink-0 justify-end">
          {runControlsSlot}
        </div>
      )}
    </div>
  );
}
