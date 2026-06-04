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
  BatchQueueBackButton,
  BatchQueueMemberList,
  BatchQueuePrepReviewButton,
  BatchQueuePreviewButton,
} from "./batch-queue-view";
import { DaemonBatchRow } from "./DaemonBatchRow";
import { OperationRow } from "./OperationRow";
import { DelegationRow } from "@/components/ocr/DelegationRow";
import type { TrackerEntry } from "@/components/shared/types";
import { isDiscardedPrepRow } from "@/components/ocr/types";
import {
  buildQueueProjectionRows,
  type QueueGroupProjectionRow,
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
import type { WorkflowRuntimePolicyLookup } from "../../../domain/workflow-runtime/registry.js";

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
  /** Per-entry base-name labels from `buildDisplayNameMap`. */
  displayNames?: Map<string, string>;
  /** Per-workflow runtime policies from workflow metadata. */
  runtimePolicies?: WorkflowRuntimePolicyLookup;
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
   * Open the OCR review row for an operation coordinator (cross-workflow: the
   * OCR review row lives in the OCR panel). Receives the OCR row's id
   * (`sessionId`) and its `runId` so the OCR panel can both select the row and
   * arm its Preview/review gate.
   */
  onOpenOcrReview?: (target: { sessionId: string; runId: string }) => void;
  /**
   * When set, the panel shows the consolidated batch toolbar + `BatchQueueMemberList`
   * for that batch anchor only (delegation children today; same shell for future daemon batches).
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
   * Input-run strip (`InputRunPanel`: text input + play) in the panel
   * footer only — bulk actions live in {@link queueBulkActionsSlot}.
   */
  runControlsSlot?: ReactNode;
  /** Controlled sort mode (persisted at App level — matches batch screenshot preview). */
  queueSortMode: QueueSortMode;
  onQueueSortModeChange: (mode: QueueSortMode) => void;
}

function pickProjectionRows<K extends QueueGroupSurface["kind"]>(
  rows: QueueGroupProjectionRow[],
  kind: K,
): Array<QueueGroupProjectionRow & { surface: Extract<QueueGroupSurface, { kind: K }> }> {
  return rows.filter(
    (row): row is QueueGroupProjectionRow & { surface: Extract<QueueGroupSurface, { kind: K }> } =>
      row.surface.kind === kind,
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
  leading,
  actions,
}: {
  value: QueueSortMode;
  onChange: (mode: QueueSortMode) => void;
  disabled: boolean;
  /** Rendered before the sort dropdown (batch-queue Back affordance). */
  leading?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="flex min-h-8 items-center gap-1.5 min-w-0">
      {leading ? <div className="flex shrink-0 items-center gap-1">{leading}</div> : null}
      <QueueSortDropdown
        value={value}
        onChange={onChange}
        disabled={disabled}
        className="flex-1 min-w-0"
      />
      {actions ? (
        <div className="flex shrink-0 items-center gap-1">{actions}</div>
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
            <div className="h-4 w-32 rounded bg-muted motion-safe:animate-pulse" />
            <div className="h-4 w-16 rounded bg-muted motion-safe:animate-pulse" />
          </div>
          <div className="h-3 w-48 rounded bg-muted motion-safe:animate-pulse mt-1" />
          <div className="h-3 w-24 rounded bg-muted motion-safe:animate-pulse mt-2" />
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
 *   [ Input-run footer ]       ← input + play only
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
  runtimePolicies,
  selectedId,
  onSelect,
  date,
  onDelete,
  onBulkDeleted,
  reviewingPrepId,
  onOpenReview,
  onReupload,
  onOpenOcrReview,
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

  const queueProjectionRows = useMemo(
    () =>
      buildQueueProjectionRows({
        entries: visibleEntries,
        delegationSourceEntries: visibleDelegationSources,
        workflow,
        workflowLabel,
        displayNames,
        runtimePolicies,
      }),
    [visibleEntries, visibleDelegationSources, workflow, workflowLabel, displayNames, runtimePolicies],
  );
  const queueSurfaces = queueProjectionRows.surfaces;

  const batchMembersByParentRunId = queueSurfaces.membersByParentRunId;

  const focusedBatchProjection = useMemo(
    () =>
      batchQueueParentRunId
        ? queueProjectionRows.groupRows.find(
            (row) => row.projection.runId === batchQueueParentRunId,
          )?.projection
        : undefined,
    [batchQueueParentRunId, queueProjectionRows.groupRows],
  );

  const batchAnchorIsPrep = useMemo(
    () =>
      Boolean(
        batchQueueParentRunId &&
          queueSurfaces.groupRows.some(
            (surface) =>
              surface.kind === "preview" &&
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

  const previewSurfaces = useMemo(
    () =>
      pickProjectionRows(queueProjectionRows.groupRows, "preview")
        .filter((row): row is QueueGroupProjectionRow & { surface: Extract<QueueGroupSurface, { kind: "preview" }> & { parent: TrackerEntry } } =>
          Boolean(row.surface.parent),
        ),
    [queueProjectionRows.groupRows],
  );

  const sortedPreviewSurfaces = useMemo(() => {
    const sortedParents = sortQueueEntriesForDisplay(
      previewSurfaces.map((row) => row.surface.parent),
      queueSortMode,
      displayNames,
    );
    return reorderByIds(
      previewSurfaces,
      (row) => row.surface.parentRunId,
      sortedParents.map((parent) => parent.runId ?? parent.id),
    );
  }, [previewSurfaces, queueSortMode, displayNames]);

  const batchSurfaces = useMemo(
    () => pickProjectionRows(queueProjectionRows.groupRows, "batch"),
    [queueProjectionRows.groupRows],
  );

  const sortedBatchSurfaces = useMemo(() => {
    const ids = sortDaemonBatchParentIds(
      batchSurfaces.map((row) => row.surface.parentRunId),
      batchMembersByParentRunId,
      queueSortMode,
      workflowLabel,
      displayNames,
    );
    return reorderByIds(batchSurfaces, (row) => row.surface.parentRunId, ids);
  }, [batchSurfaces, batchMembersByParentRunId, queueSortMode, workflowLabel, displayNames]);

  const operationSurfaces = useMemo(
    () => pickProjectionRows(queueProjectionRows.groupRows, "operation"),
    [queueProjectionRows.groupRows],
  );

  const sortedOperationSurfaces = useMemo(() => {
    const ids = sortDaemonBatchParentIds(
      operationSurfaces.map((row) => row.surface.parentRunId),
      batchMembersByParentRunId,
      queueSortMode,
      workflowLabel,
      displayNames,
    );
    return reorderByIds(operationSurfaces, (row) => row.surface.parentRunId, ids);
  }, [operationSurfaces, batchMembersByParentRunId, queueSortMode, workflowLabel, displayNames]);

  /** Preview cards respect StatPills — show when parent or any child matches. */
  const visiblePreviewSurfaces = useMemo(
    () =>
      sortedPreviewSurfaces.filter((surface) => {
        return queueGroupMatchesStatusFilter(statusFilter, surface.surface.members, surface.surface.parent);
      }),
    [sortedPreviewSurfaces, statusFilter],
  );

  /** Daemon batch cards: visible when any member matches the status filter. */
  const visibleBatchSurfaces = useMemo(
    () =>
      sortedBatchSurfaces.filter((surface) =>
        queueGroupMatchesStatusFilter(statusFilter, surface.surface.members),
      ),
    [sortedBatchSurfaces, statusFilter],
  );

  /** Operation coordinator cards: visible when the row or any member matches. */
  const visibleOperationSurfaces = useMemo(
    () =>
      sortedOperationSurfaces.filter((surface) =>
        queueGroupMatchesStatusFilter(statusFilter, surface.surface.members, surface.surface.parent),
      ),
    [sortedOperationSurfaces, statusFilter],
  );

  /** Group cards are not included in {@link sortedFiltered}; avoid empty-state under them. */
  const hasGroupQueueCards =
    visiblePreviewSurfaces.length > 0 ||
    visibleBatchSurfaces.length > 0 ||
    visibleOperationSurfaces.length > 0;

  const filtered = useMemo(() => {
    let result = queueProjectionRows.flatEntries;
    if (statusFilter) {
      result = result.filter((row) => entryMatchesStatusFilter(row.entry, statusFilter));
    }
    return result;
  }, [queueProjectionRows.flatEntries, statusFilter]);

  const sortedFiltered = useMemo(
    () => {
      const entries = sortQueueEntriesForDisplay(
        filtered.map((row) => row.entry),
        queueSortMode,
        displayNames,
      );
      return reorderByIds(filtered, (row) => row.entry.id, entries.map((entry) => entry.id));
    },
    [filtered, queueSortMode, displayNames],
  );

  const sortedBatchMembers = useMemo(
    () =>
      sortQueueEntriesForDisplay(batchQueueMembers, queueSortMode, displayNames),
    [batchQueueMembers, queueSortMode, displayNames],
  );

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
    return sortedFiltered.map((row) => row.entry.id);
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

  const renderQueueGroupSurface = (row: QueueGroupProjectionRow): ReactNode => {
    const { surface, projection } = row;
    switch (surface.kind) {
      case "preview":
        // A preview with no delegated members (the OCR review row awaiting
        // approval) is a flat row, not a member-summary card. Render it as a
        // normal EntryItem — same as the UI gallery's `preview` variant — so it
        // gets the kind title/subtitle (PDF name · trace id) and the unified
        // status-gated footer instead of a degenerate 0/0 batch chrome.
        // DelegationRow stays for previews that have fanned out to members.
        if (surface.members.length === 0) {
          return (
            <EntryItem
              key={`preview-${surface.parentRunId}`}
              entry={surface.parent}
              projection={row.parentProjection}
              displayNames={displayNames}
              selected={selectedId === surface.parent.id}
              onSelect={onSelect}
              date={date}
              onDelete={onDelete}
            />
          );
        }
        return (
          <DelegationRow
            key={`preview-${surface.parentRunId}`}
            parent={surface.parent}
            delegatedEntries={surface.members}
            projection={projection}
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
            titleOverride={surface.titleOverride}
            projection={projection}
            memberEntries={surface.members}
            anchorEntry={surface.parent}
            isBatchQueueFocused={batchQueueParentRunId === surface.parentRunId}
            onEnterBatchQueue={(runId) => onEnterBatchQueue?.(runId)}
            batchDrillInEnabled={!batchQueueParentRunId}
            onDeletedIds={onBulkDeleted}
          />
        );
      case "operation":
        return (
          <OperationRow
            key={`operation-${surface.parentRunId}`}
            date={date}
            parentRunId={surface.parentRunId}
            projection={projection}
            displayNames={displayNames}
            parent={surface.parent}
            members={surface.members}
            ocr={surface.ocr}
            selected={selectedId === surface.parent.id}
            selectedId={selectedId}
            onSelect={onSelect}
            onDelete={onDelete}
            {...(onOpenOcrReview ? { onOpenOcrReview } : {})}
          />
        );
      default:
        return assertNeverSurface(surface);
    }
  };

  const visibleGroupSurfaces: QueueGroupProjectionRow[] = [
    ...visiblePreviewSurfaces,
    ...visibleOperationSurfaces,
    ...visibleBatchSurfaces,
  ];

  return (
    <div className="w-[300px] min-[1440px]:w-[380px] 2xl:w-[460px] shrink-0 flex flex-col bg-background">
      {batchQueueParentRunId ? (
        // Batch-queue mode: one consolidated toolbar (the old title/"Started …"
        // header band is gone). Back sits before the sort dropdown; the
        // screenshot-preview (and prep-review for prep anchors) sit after the
        // bulk actions — i.e. after the trash.
        <div className="shrink-0 px-3 min-[1440px]:px-4 py-2 border-b border-border bg-card/60">
          <QueueSortToolbar
            value={queueSortMode}
            onChange={onQueueSortModeChange}
            disabled={loading}
            leading={<BatchQueueBackButton onBack={() => onExitBatchQueue?.()} />}
            actions={
              <>
                {queueBulkActionsSlot}
                {onOpenBatchPreview ? (
                  <BatchQueuePreviewButton
                    active={selectedId === null}
                    memberCount={batchQueueMembers.length}
                    onOpen={onOpenBatchPreview}
                  />
                ) : null}
                {batchAnchorIsPrep ? (
                  <BatchQueuePrepReviewButton
                    onOpen={() => onOpenReview?.(batchQueueParentRunId)}
                  />
                ) : null}
              </>
            }
          />
        </div>
      ) : (
        <div className="flex flex-col shrink-0 border-b border-border bg-card/60">
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

      <div ref={scrollAreaRef} className="flex-1 overflow-y-auto border-b border-border">
        {batchQueueParentRunId ? (
          <BatchQueueMemberList
            members={sortedBatchMembers}
            projections={focusedBatchProjection?.batchMembers}
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
              !hasGroupQueueCards ? (
              <EmptyState
                icon={Inbox}
                title="No entries yet"
                description="Data will appear here as workflows run"
              />
            ) : (
              sortedFiltered.map(({ entry, projection }) => (
                <EntryItem
                  key={entry.id}
                  entry={entry}
                  projection={projection}
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
        <div className="flex h-12 w-full min-w-0 items-center gap-2 px-3 min-[1440px]:px-4 bg-card/40 shrink-0">
          {runControlsSlot}
        </div>
      )}
    </div>
  );
}

function assertNeverSurface(surface: never): never {
  throw new Error(`Unsupported queue surface kind: ${JSON.stringify(surface)}`);
}
