import { useMemo, useState, useEffect, useRef, type ReactNode } from "react";
import { Inbox } from "lucide-react";
import { StatPills } from "./StatPills";
import { EntryItem } from "./EntryItem";
import { EmptyState } from "@/components/shared/EmptyState";
import { cn } from "@/lib/utils";
import {
  BatchQueueMemberList,
  BatchQueueToolbar,
  buildSyntheticBatchQueueAnchor,
} from "./batch-queue-view";
import { DaemonBatchRow } from "./DaemonBatchRow";
import { DelegationRow } from "@/components/ocr/DelegationRow";
import type { TrackerEntry } from "@/components/shared/types";
import {
  isApprovedPrepRow,
  isDiscardedPrepRow,
} from "@/components/ocr/types";
import { entryMatchesStatusFilter } from "./queue-status";

interface QueuePanelProps {
  entries: TrackerEntry[];
  /** Row set for StatPills (merged EXCLUDING operator-resolved prep). Defaults to discarded-prep-filtered entries when omitted. */
  statPanelEntries?: TrackerEntry[];
  workflow: string;
  /** Registry label for batch summary cards / synthetic batch toolbar titles. */
  workflowLabel: string;
  /** Per-entry "<base> <ordinal>" labels from `buildDisplayNameMap`. */
  displayNames?: Map<string, string>;
  selectedId: string | null;
  onSelect: (id: string) => void;
  /** The tracker date — forwarded to EntryItem delete buttons. */
  date?: string;
  /** Called after a hard-delete so App.tsx can remove the row from state. */
  onDelete?: (id: string) => void;
  /** Run-id of the prep row currently open in the right-pane review. */
  reviewingPrepId?: string | null;
  /** Open the right-pane review for this prep row. */
  onOpenReview?: (runId: string) => void;
  /** Open RunModal in reupload mode for the given OCR session. */
  onReupload?: (reuploadFor: { sessionId: string; previousRunId: string }) => void;
  /**
   * When set, the panel shows `BatchQueueToolbar` + `BatchQueueMemberList` for
   * that batch anchor only (delegation children today; same shell for future daemon batches).
   */
  batchQueueParentRunId?: string | null;
  /** Enter batch-queue mode scoped to entries whose parent run id matches. */
  onEnterBatchQueue?: (parentRunId: string) => void;
  /** Leave batch-queue mode and return to the main queue list. */
  onExitBatchQueue?: () => void;
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
  statPanelEntries,
  workflow,
  workflowLabel,
  displayNames,
  selectedId,
  onSelect,
  date,
  onDelete,
  reviewingPrepId,
  onOpenReview,
  onReupload,
  batchQueueParentRunId,
  onEnterBatchQueue,
  onExitBatchQueue,
  loading,
  runControlsSlot,
}: QueuePanelProps) {
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
   * Map parent runId → delegated member entries (`parentRunId`). Used for
   * {@link DelegationRow} summaries and for {@link BatchQueueMemberList}.
   */
  const batchMembersByParentRunId = useMemo(() => {
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
   * Toolbar title row for batch-queue mode: OCR prep anchor row if present,
   * else a synthetic row for daemon/dashboard batch ids.
   */
  const resolvedBatchToolbarEntry = useMemo(() => {
    if (!batchQueueParentRunId) return null;
    const prep = approvedPrepEntries.find(
      (e) => (e.runId ?? e.id) === batchQueueParentRunId,
    );
    if (prep) return prep;
    const members = batchMembersByParentRunId.get(batchQueueParentRunId) ?? [];
    return buildSyntheticBatchQueueAnchor(
      batchQueueParentRunId,
      members,
      workflowLabel,
      workflow,
    );
  }, [
    batchQueueParentRunId,
    approvedPrepEntries,
    batchMembersByParentRunId,
    workflowLabel,
    workflow,
  ]);

  const batchAnchorIsPrep = Boolean(
    batchQueueParentRunId &&
      approvedPrepEntries.some((e) => (e.runId ?? e.id) === batchQueueParentRunId),
  );

  const batchQueueMembers = useMemo(
    () =>
      batchQueueParentRunId
        ? batchMembersByParentRunId.get(batchQueueParentRunId) ?? []
        : [],
    [batchQueueParentRunId, batchMembersByParentRunId],
  );

  /**
   * Approved prep rows render as {@link DelegationRow} above the flat list.
   * Their members are folded into the batch card or the batch queue view, so
   * exclude them from the main list.
   */
  const approvedParentRunIds = useMemo(
    () =>
      new Set(
        approvedPrepEntries.map((e) => e.runId ?? e.id),
      ),
    [approvedPrepEntries],
  );

  /** Non–OCR-prep `parentRunId` keys (daemon batches, dashboard multi-enqueue). */
  const daemonBatchParentIds = useMemo(() => {
    const ids: string[] = [];
    for (const pid of batchMembersByParentRunId.keys()) {
      if (!approvedParentRunIds.has(pid)) ids.push(pid);
    }
    ids.sort((a, b) => {
      const ta = batchMembersByParentRunId.get(a)?.[0]?.timestamp ?? "";
      const tb = batchMembersByParentRunId.get(b)?.[0]?.timestamp ?? "";
      return tb.localeCompare(ta);
    });
    return ids;
  }, [batchMembersByParentRunId, approvedParentRunIds]);

  const filtered = useMemo(() => {
    let result = visibleEntries.filter(
      (e) =>
        // Prep rows render as EntryItem in the main list — approved-prep
        // parents become DelegationRow; their members stay out of the flat list.
        !isApprovedPrepRow(e) &&
        !(e.parentRunId && approvedParentRunIds.has(e.parentRunId)) &&
        !(e.parentRunId && batchMembersByParentRunId.has(e.parentRunId)),
    );
    if (statusFilter) {
      result = result.filter((e) => entryMatchesStatusFilter(e, statusFilter));
    }
    return result;
  }, [
    visibleEntries,
    statusFilter,
    approvedParentRunIds,
    batchMembersByParentRunId,
  ]);

  const statPillSource = statPanelEntries ?? visibleEntries;

  /** Same order as rendered `EntryItem` rows — used for ↑/↓ keyboard selection. */
  const navigableIds = useMemo(() => {
    if (loading) return [];
    if (batchQueueParentRunId) return batchQueueMembers.map((e) => e.id);
    return filtered.map((e) => e.id);
  }, [loading, batchQueueParentRunId, batchQueueMembers, filtered]);

  const scrollAreaRef = useRef<HTMLDivElement>(null);
  const navigableIdsRef = useRef(navigableIds);
  navigableIdsRef.current = navigableIds;
  const selectedIdRef = useRef(selectedId);
  selectedIdRef.current = selectedId;
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;

  useEffect(() => {
    const isEditableFocus = (el: EventTarget | null): boolean => {
      if (!(el instanceof HTMLElement)) return false;
      if (el.isContentEditable) return true;
      const tag = el.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
      return Boolean(el.closest("[role='textbox'][contenteditable='true']"));
    };

    const scrollEntryIntoView = (id: string) => {
      const root = scrollAreaRef.current;
      if (!root) return;
      const node = root.querySelector(`[data-queue-entry-id="${CSS.escape(id)}"]`);
      if (node instanceof HTMLElement) {
        node.scrollIntoView({ block: "nearest", behavior: "smooth" });
      }
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
      if (e.defaultPrevented) return;
      if (isEditableFocus(e.target)) return;

      const ids = navigableIdsRef.current;
      if (ids.length === 0) return;

      e.preventDefault();
      let idx = ids.indexOf(selectedIdRef.current ?? "");
      if (idx === -1) {
        idx = e.key === "ArrowDown" ? -1 : ids.length;
      }
      const delta = e.key === "ArrowDown" ? 1 : -1;
      const nextIdx = idx + delta;
      if (nextIdx < 0 || nextIdx >= ids.length) return;
      const nextId = ids[nextIdx]!;
      onSelectRef.current(nextId);
      requestAnimationFrame(() => scrollEntryIntoView(nextId));
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  return (
    <div className="w-[300px] min-[1440px]:w-[380px] 2xl:w-[460px] flex-shrink-0 flex flex-col bg-background">
      {batchQueueParentRunId && resolvedBatchToolbarEntry ? (
        <BatchQueueToolbar
          batchAnchor={resolvedBatchToolbarEntry}
          anchorKind={batchAnchorIsPrep ? "prep" : "daemon"}
          onBack={() => onExitBatchQueue?.()}
          onOpenPrepReview={
            batchAnchorIsPrep
              ? () => {
                  const runId =
                    resolvedBatchToolbarEntry.runId ?? resolvedBatchToolbarEntry.id;
                  onOpenReview?.(runId);
                }
              : undefined
          }
        />
      ) : (
        <div className="h-[69.5px] flex items-center px-3 min-[1440px]:px-4 py-2 border-b border-border bg-card/60 flex-shrink-0">
          <StatPills
            entries={statPillSource}
            activeFilter={statusFilter}
            onFilter={setStatusFilter}
          />
        </div>
      )}

      <div ref={scrollAreaRef} className="flex-1 overflow-y-auto border-b border-border">
        {batchQueueParentRunId ? (
          <BatchQueueMemberList
            members={batchQueueMembers}
            selectedId={selectedId}
            onSelect={onSelect}
            displayNames={displayNames}
            date={date}
            onDelete={onDelete}
          />
        ) : (
          <>
            {approvedPrepEntries.map((e) => {
              const runId = e.runId ?? e.id;
              return (
                <DelegationRow
                  key={`delegation-${runId}`}
                  parent={e}
                  delegatedEntries={batchMembersByParentRunId.get(runId) ?? []}
                  isBatchQueueFocused={batchQueueParentRunId === runId}
                  onEnterBatchQueue={(rid) => onEnterBatchQueue?.(rid)}
                />
              );
            })}
            {daemonBatchParentIds.map((batchId) => (
              <DaemonBatchRow
                key={`daemon-batch-${batchId}`}
                batchParentRunId={batchId}
                workflowLabel={workflowLabel}
                memberEntries={batchMembersByParentRunId.get(batchId) ?? []}
                isBatchQueueFocused={batchQueueParentRunId === batchId}
                onEnterBatchQueue={(rid) => onEnterBatchQueue?.(rid)}
              />
            ))}
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
                  onSelect={onSelect}
                  date={date}
                  onDelete={onDelete}
                />
              ))
            )}
          </>
        )}
      </div>

      {runControlsSlot && (
        <div
          className={cn(
            "h-12 flex items-center gap-2 px-3 min-[1440px]:px-4 bg-card/40 flex-shrink-0",
            batchQueueParentRunId ? "justify-between" : "justify-end",
          )}
        >
          {runControlsSlot}
        </div>
      )}
    </div>
  );
}
