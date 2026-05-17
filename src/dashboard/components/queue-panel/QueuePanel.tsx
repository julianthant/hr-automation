import {
  useMemo,
  useState,
  useEffect,
  useRef,
  type ReactNode,
} from "react";
import { Inbox } from "lucide-react";
import { StatPills } from "./StatPills";
import { EntryItem } from "./EntryItem";
import { EmptyState } from "@/components/shared/EmptyState";
import {
  BatchQueueMemberList,
  BatchQueueToolbar,
  buildSyntheticBatchQueueAnchor,
} from "./batch-queue-view";
import { DaemonBatchRow } from "./DaemonBatchRow";
import { DelegationRow } from "@/components/ocr/DelegationRow";
import { GroupRowBase } from "./group-row-base";
import type { TrackerEntry } from "@/components/shared/types";
import { isDiscardedPrepRow } from "@/components/ocr/types";
import {
  buildQueueSurfaces,
  type QueueGroupSurface,
} from "./queue-surface-classifier";
import { entryMatchesStatusFilter, queueGroupMatchesStatusFilter } from "./queue-status";
import {
  sortDaemonBatchParentIds,
  sortQueueEntriesForDisplay,
  type QueueSortMode,
} from "./queue-sort";
import { QueueSortDropdown } from "./QueueSortDropdown";
import { collapseEntriesForStatStrip } from "./stat-strip-collapse";
import { isEditableFocus } from "@/lib/utils";

interface QueuePanelProps {
  /**
   * Visible queue rows — merge-collapsed primaries from `App` (`dedupedEntries`).
   */
  entries: TrackerEntry[];
  /**
   * Latest row per tracker `id` **before** merge grouping. Must include merge siblings so
   * `parentRunId` batches and batch delete enumerate every delegated item.
   */
  delegationSourceEntries: TrackerEntry[];
  /**
   * Row set for StatPills before batch collapse (merged excluding operator-resolved prep).
   * Parent-run batches count as **one** row in the pills; omit to use discarded-prep-filtered entries.
   */
  statPanelEntries?: TrackerEntry[];
  /** When set, "All" StatPill + rail use this top-level row count (group cards + flat). */
  topLevelQueueCount?: number;
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
  /** Bulk delete callback for daemon batch cards (same shape as DeleteAllButton). */
  onBulkDeleted?: (ids: string[]) => void;
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
  /** Open the right-pane batch screenshot preview. */
  onOpenBatchPreview?: () => void;
  loading: boolean;
  /**
   * Run/upload (`TopBarRunButton`), Capture (`TopBarCaptureButton`) when registered,
   * then retry-all / stop-active / delete-all — beside the queue sort control.
   */
  queueBulkActionsSlot?: ReactNode;
  /**
   * Quick-run enqueue strip (`QuickRunPanel`: text input + play) in the panel
   * footer only — bulk actions live in {@link queueBulkActionsSlot}.
   */
  runControlsSlot?: ReactNode;
  /** Controlled sort mode (persisted at App level — matches batch screenshot preview). */
  queueSortMode: QueueSortMode;
  onQueueSortModeChange: (mode: QueueSortMode) => void;
}

function pickSurfaces<K extends QueueGroupSurface["kind"]>(
  surfaces: QueueGroupSurface[],
  kind: K,
): Extract<QueueGroupSurface, { kind: K }>[] {
  return surfaces.filter(
    (surface): surface is Extract<QueueGroupSurface, { kind: K }> =>
      surface.kind === kind,
  );
}

function reorderByIds<T>(
  items: T[],
  idFn: (item: T) => string,
  sortedIds: string[],
): T[] {
  const byId = new Map(items.map((item) => [idFn(item), item]));
  return sortedIds.map((id) => byId.get(id)).filter((item): item is T => item !== undefined);
}

function QueueSortToolbar({
  value,
  onChange,
  disabled,
  actions,
}: {
  value: QueueSortMode;
  onChange: (mode: QueueSortMode) => void;
  disabled: boolean;
  actions?: ReactNode;
}) {
  return (
    <div className="flex min-h-8 items-center gap-1.5 min-w-0">
      <QueueSortDropdown
        value={value}
        onChange={onChange}
        disabled={disabled}
        className="flex-1 min-w-0"
      />
      {actions ? (
        <div className="flex flex-shrink-0 items-center gap-1">{actions}</div>
      ) : null}
    </div>
  );
}

function QueueLoadingSkeleton() {
  return (
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
  );
}

/**
 * QueuePanel — left column of the main split.
 *
 *   [ Status filter strip ]    ← top of panel; tab-like pills
 *   [ Entry list ]             ← scrollable
 *   [ Quick-run footer ]       ← input + play only
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
  delegationSourceEntries,
  statPanelEntries,
  topLevelQueueCount,
  workflow,
  workflowLabel,
  displayNames,
  selectedId,
  onSelect,
  date,
  onDelete,
  onBulkDeleted,
  reviewingPrepId,
  onOpenReview,
  onReupload,
  batchQueueParentRunId,
  onEnterBatchQueue,
  onExitBatchQueue,
  onOpenBatchPreview,
  loading,
  queueBulkActionsSlot,
  runControlsSlot,
  queueSortMode,
  onQueueSortModeChange,
}: QueuePanelProps) {
  const [statusFilter, setStatusFilter] = useState<string | null>(null);

  // Resolved prep rows (approved/discarded) are treated as fully retired —
  // gone from the lists AND from the StatPills counts. Without this filter,
  // discarding a row leaves it hidden but still counted ("3 ALL / 1 visible").
  const visibleEntries = useMemo(
    () => entries.filter((e) => !isDiscardedPrepRow(e)),
    [entries],
  );

  const visibleDelegationSources = useMemo(
    () => delegationSourceEntries.filter((e) => !isDiscardedPrepRow(e)),
    [delegationSourceEntries],
  );

  const queueSurfaces = useMemo(
    () =>
      buildQueueSurfaces({
        entries: visibleEntries,
        delegationSourceEntries: visibleDelegationSources,
        workflow,
        workflowLabel,
      }),
    [visibleEntries, visibleDelegationSources, workflow, workflowLabel],
  );

  const batchMembersByParentRunId = queueSurfaces.membersByParentRunId;

  /**
   * Toolbar title row for batch-queue mode: OCR prep anchor row if present,
   * else a synthetic row for daemon/dashboard batch ids.
   */
  const resolvedBatchToolbarEntry = useMemo(() => {
    if (!batchQueueParentRunId) return null;
    const approvalSurface = queueSurfaces.groupRows.find(
      (surface) =>
        surface.kind === "approval-delegation" &&
        surface.parentRunId === batchQueueParentRunId,
    );
    if (approvalSurface?.parent) return approvalSurface.parent;
    const members = batchMembersByParentRunId.get(batchQueueParentRunId) ?? [];
    return buildSyntheticBatchQueueAnchor(
      batchQueueParentRunId,
      members,
      workflowLabel,
      workflow,
    );
  }, [
    batchQueueParentRunId,
    queueSurfaces,
    batchMembersByParentRunId,
    workflowLabel,
    workflow,
  ]);

  const batchAnchorIsPrep = useMemo(
    () =>
      Boolean(
        batchQueueParentRunId &&
          queueSurfaces.groupRows.some(
            (surface) =>
              surface.kind === "approval-delegation" &&
              surface.parentRunId === batchQueueParentRunId,
          ),
      ),
    [batchQueueParentRunId, queueSurfaces.groupRows],
  );

  const batchQueueMembers = useMemo(
    () =>
      batchQueueParentRunId
        ? batchMembersByParentRunId.get(batchQueueParentRunId) ?? []
        : [],
    [batchQueueParentRunId, batchMembersByParentRunId],
  );

  const approvalDelegationSurfaces = useMemo(
    () =>
      pickSurfaces(queueSurfaces.groupRows, "approval-delegation")
        .filter((surface): surface is Extract<QueueGroupSurface, { kind: "approval-delegation" }> & { parent: TrackerEntry } =>
          Boolean(surface.parent),
        ),
    [queueSurfaces],
  );

  const sortedApprovalDelegationSurfaces = useMemo(() => {
    const sortedParents = sortQueueEntriesForDisplay(
      approvalDelegationSurfaces.map((surface) => surface.parent),
      queueSortMode,
      displayNames,
    );
    return reorderByIds(
      approvalDelegationSurfaces,
      (surface) => surface.parentRunId,
      sortedParents.map((parent) => parent.runId ?? parent.id),
    );
  }, [approvalDelegationSurfaces, queueSortMode, displayNames]);

  const batchSurfaces = useMemo(
    () => pickSurfaces(queueSurfaces.groupRows, "batch"),
    [queueSurfaces],
  );

  const sortedBatchSurfaces = useMemo(() => {
    const ids = sortDaemonBatchParentIds(
      batchSurfaces.map((surface) => surface.parentRunId),
      batchMembersByParentRunId,
      queueSortMode,
      workflowLabel,
      displayNames,
    );
    return reorderByIds(batchSurfaces, (surface) => surface.parentRunId, ids);
  }, [batchSurfaces, batchMembersByParentRunId, queueSortMode, workflowLabel, displayNames]);

  /** Delegation cards respect StatPills — show when parent or any child matches. */
  const visibleApprovalDelegationSurfaces = useMemo(
    () =>
      sortedApprovalDelegationSurfaces.filter((surface) => {
        return queueGroupMatchesStatusFilter(statusFilter, surface.members, surface.parent);
      }),
    [sortedApprovalDelegationSurfaces, statusFilter],
  );

  /** Daemon batch cards: visible when any member matches the status filter. */
  const visibleBatchSurfaces = useMemo(
    () =>
      sortedBatchSurfaces.filter((surface) =>
        queueGroupMatchesStatusFilter(statusFilter, surface.members),
      ),
    [sortedBatchSurfaces, statusFilter],
  );

  const visiblePassiveDelegationSurfaces = useMemo(
    () =>
      pickSurfaces(queueSurfaces.groupRows, "passive-delegation")
        .filter((surface) => queueGroupMatchesStatusFilter(statusFilter, surface.members)),
    [queueSurfaces, statusFilter],
  );

  const filtered = useMemo(() => {
    let result = queueSurfaces.flatEntries;
    if (statusFilter) {
      result = result.filter((e) => entryMatchesStatusFilter(e, statusFilter));
    }
    return result;
  }, [queueSurfaces, statusFilter]);

  const sortedFiltered = useMemo(
    () => sortQueueEntriesForDisplay(filtered, queueSortMode, displayNames),
    [filtered, queueSortMode, displayNames],
  );

  const sortedBatchMembers = useMemo(
    () =>
      sortQueueEntriesForDisplay(batchQueueMembers, queueSortMode, displayNames),
    [batchQueueMembers, queueSortMode, displayNames],
  );

  /** Batch/delegation cards are not included in {@link sortedFiltered}; avoid empty-state under them. */
  const hasBatchOrDelegationQueueCards =
    visibleApprovalDelegationSurfaces.length > 0 ||
    visibleBatchSurfaces.length > 0 ||
    visiblePassiveDelegationSurfaces.length > 0;

  const statPillSource = statPanelEntries ?? visibleEntries;

  /** Stat strip counts each delegation/daemon batch as one surface row, not N members. */
  const collapsedStatPillEntries = useMemo(
    () => collapseEntriesForStatStrip(statPillSource),
    [statPillSource],
  );

  /** Same order as rendered `EntryItem` rows — used for ↑/↓ keyboard selection. */
  const navigableIds = useMemo(() => {
    if (loading) return [];
    if (batchQueueParentRunId) return sortedBatchMembers.map((e) => e.id);
    return sortedFiltered.map((e) => e.id);
  }, [loading, batchQueueParentRunId, sortedBatchMembers, sortedFiltered]);

  const scrollAreaRef = useRef<HTMLDivElement>(null);
  const navigableIdsRef = useRef(navigableIds);
  navigableIdsRef.current = navigableIds;
  const selectedIdRef = useRef(selectedId);
  selectedIdRef.current = selectedId;
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;

  useEffect(() => {
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

  const renderQueueGroupSurface = (surface: QueueGroupSurface): ReactNode => {
    switch (surface.kind) {
      case "approval-delegation":
        return (
          <DelegationRow
            key={`delegation-${surface.parentRunId}`}
            parent={surface.parent}
            delegatedEntries={surface.members}
            isBatchQueueFocused={batchQueueParentRunId === surface.parentRunId}
            onEnterBatchQueue={(runId) => onEnterBatchQueue?.(runId)}
            date={date}
            onDelete={onDelete}
            batchDrillInEnabled={!batchQueueParentRunId}
          />
        );
      case "batch":
        return (
          <DaemonBatchRow
            key={`daemon-batch-${surface.parentRunId}`}
            workflow={workflow}
            date={date}
            batchParentRunId={surface.parentRunId}
            workflowLabel={workflowLabel}
            memberEntries={surface.members}
            isBatchQueueFocused={batchQueueParentRunId === surface.parentRunId}
            onEnterBatchQueue={(runId) => onEnterBatchQueue?.(runId)}
            batchDrillInEnabled={!batchQueueParentRunId}
            onDeletedIds={onBulkDeleted}
          />
        );
      case "passive-delegation":
        return (
          <GroupRowBase
            key={`passive-delegation-${surface.parentRunId}`}
            variant="passive-delegation"
            title={surface.titleOverride ?? "Delegated utility work"}
            parentRunId={surface.parentRunId}
            members={surface.members}
            countTone="neutral"
            footerSecondaryId={surface.parentRunId}
            firstTimestamp={surface.members[0]?.timestamp}
            isFocused={batchQueueParentRunId === surface.parentRunId}
            drillInEnabled={!batchQueueParentRunId}
            onEnter={(runId) => onEnterBatchQueue?.(runId)}
          />
        );
      default:
        return assertNeverSurface(surface);
    }
  };

  const visibleGroupSurfaces: QueueGroupSurface[] = [
    ...visibleApprovalDelegationSurfaces,
    ...visibleBatchSurfaces,
    ...visiblePassiveDelegationSurfaces,
  ];

  return (
    <div className="w-[300px] min-[1440px]:w-[380px] 2xl:w-[460px] flex-shrink-0 flex flex-col bg-background">
      {batchQueueParentRunId && resolvedBatchToolbarEntry ? (
        <BatchQueueToolbar
          batchAnchor={resolvedBatchToolbarEntry}
          titleOverride={resolvedBatchToolbarEntry.data?.__name as string | undefined}
          anchorKind={batchAnchorIsPrep ? "prep" : "daemon"}
          memberCount={batchQueueMembers.length}
          batchPreviewActive={selectedId === null}
          onBack={() => onExitBatchQueue?.()}
          onOpenBatchPreview={onOpenBatchPreview}
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
        <div className="flex flex-col flex-shrink-0 border-b border-border bg-card/60">
          <div className="h-[69.5px] flex items-center px-3 min-[1440px]:px-4 py-2">
            <StatPills
              entries={collapsedStatPillEntries}
              allCountOverride={topLevelQueueCount}
              activeFilter={statusFilter}
              onFilter={setStatusFilter}
            />
          </div>
          <div className="px-3 min-[1440px]:px-4 py-2 border-t border-border/60">
            <QueueSortToolbar
              value={queueSortMode}
              onChange={onQueueSortModeChange}
              disabled={loading}
              actions={queueBulkActionsSlot}
            />
          </div>
        </div>
      )}

      {batchQueueParentRunId ? (
        <div className="flex-shrink-0 px-3 min-[1440px]:px-4 py-2 border-b border-border bg-card/50">
          <QueueSortToolbar
            value={queueSortMode}
            onChange={onQueueSortModeChange}
            disabled={loading}
            actions={queueBulkActionsSlot}
          />
        </div>
      ) : null}

      <div ref={scrollAreaRef} className="flex-1 overflow-y-auto border-b border-border">
        {batchQueueParentRunId ? (
          <BatchQueueMemberList
            members={sortedBatchMembers}
            selectedId={selectedId}
            onSelect={onSelect}
            displayNames={displayNames}
            date={date}
            onDelete={onDelete}
          />
        ) : (
          <>
            {/* Queue virtualization is intentionally deferred: operator-visible
                lists are dominated by grouped/batch rows and are normally well
                below the ~50-row threshold where virtualization pays for its
                added keyboard/focus complexity. LogStream is the hot path. */}
            {visibleGroupSurfaces.map(renderQueueGroupSurface)}
            {/* Prep rows render as regular EntryItem (same size + behavior
                as other workflow rows). The only differentiator is the
                Preview tab inside LogPanel, gated on data.mode === "prepare".
                Reupload + Discard live in OcrReviewPane's header. */}
            {loading ? (
              <QueueLoadingSkeleton />
            ) : sortedFiltered.length === 0 &&
              !hasBatchOrDelegationQueueCards ? (
              <EmptyState
                icon={Inbox}
                title="No entries yet"
                description="Data will appear here as workflows run"
              />
            ) : (
              sortedFiltered.map((entry) => (
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
        <div className="flex h-12 w-full min-w-0 items-center gap-2 px-3 min-[1440px]:px-4 bg-card/40 flex-shrink-0">
          {runControlsSlot}
        </div>
      )}
    </div>
  );
}

function assertNeverSurface(surface: never): never {
  throw new Error(`Unsupported queue surface kind: ${JSON.stringify(surface)}`);
}
