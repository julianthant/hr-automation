import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { Toaster, toast } from "sonner";
import { TooltipProvider } from "./components/ui/tooltip";
import { TopBar } from "./components/navigation/TopBar";
import { QueuePanel } from "./components/queue-panel/QueuePanel";
import { collapseEntriesForStatStrip } from "./components/queue-panel/stat-strip-collapse";
import { resolveDaemonBatchQueueTitle } from "./components/queue-panel/batch-queue-view";
import { LogPanel } from "./components/log-panel/LogPanel";
import { BatchScreenshotsPanel } from "./components/log-panel/BatchScreenshotsPanel";
import {
  OcrReviewPrepProvider,
  OcrReviewPrepToolbar,
  OcrReviewPrepBody,
} from "./components/ocr/OcrReviewPane";
import { TerminalDrawer } from "./components/terminal-drawer/TerminalDrawer";
import { TerminalDrawerProvider } from "./components/hooks/useTerminalDrawer";
import { BatchQueueParentRunIdProvider } from "./components/hooks/useBatchQueueContext";
import { useEntries } from "./components/hooks/useEntries";
import { usePreflight } from "./components/hooks/usePreflight";
import { prefetchRosters } from "./components/hooks/useRosters";
import { prefetchFormTypes } from "./components/hooks/useFormTypes";
import { useTelegramToasts } from "./components/hooks/useTelegramToasts";
import { useCaptureToasts } from "./components/hooks/useCaptureToasts";
import { resolveActionToastsForEntry } from "./components/hooks/useActionToasts";
import { useWorkflow, useWorkflows, autoLabel } from "./lib/workflows-context";
import {
  resolveEntryName,
  buildDisplayNameMap,
  buildDisplayNameEntries,
  groupMergedEntries,
  collectEntriesForMergedScope,
  mergedGroupPeersForLogPanel,
} from "./components/shared/entry-display";
import type { TrackerEntry, SearchResultRow, FailureRow } from "./components/shared/types";
import { WorkflowRail } from "./components/navigation/WorkflowRail";
import { QuickRunPanel } from "./components/navigation/QuickRunPanel";
import { getQuickRunConfig } from "./lib/quick-run-registry";
import { RetryAllButton } from "./components/queue-panel/RetryAllButton";
import { StopAllButton } from "./components/queue-panel/StopAllButton";
import { DeleteAllButton } from "./components/queue-panel/DeleteAllButton";
import { TopBarRunButton } from "./components/navigation/TopBarRunButton";
import { TopBarCaptureButton } from "./components/navigation/TopBarCaptureButton";
import { parsePrepareRowData, isResolvedPrepRow } from "./components/ocr/types";
import { RunModal } from "./components/run-modal/RunModal";
import { dateLocal } from "./lib/utils";
import type { TrackerEntry as TrackerEntryJsonl } from "../tracker/jsonl.js";
import { isResolvedPrepEntry } from "../tracker/dashboard/prep-rows.js";
import { isTerminalNotFoundEntry } from "../domain/tracker-terminal-display.js";
import {
  QUEUE_SORT_STORAGE_KEY,
  readStoredQueueSortMode,
  sortQueueEntriesForDisplay,
  type QueueSortMode,
} from "./components/queue-panel/queue-sort";

/** Default workflow when ?wf= is missing or unknown. Must always exist
 *  in the registry; if it doesn't, we fall through to the first registered
 *  workflow so the dashboard never lands on an empty pane. */
const DEFAULT_WORKFLOW = "onboarding";

/** Read initial state from URL search params so refresh preserves selection */
function readUrlState() {
  const params = new URLSearchParams(window.location.search);
  return {
    workflow: params.get("wf") || DEFAULT_WORKFLOW,
    selectedId: params.get("id") || null,
    date: params.get("date") || dateLocal(),
  };
}

/** Sync state to URL without triggering a page reload */
function syncUrlState(workflow: string, selectedId: string | null, date: string) {
  const params = new URLSearchParams();
  params.set("wf", workflow);
  if (selectedId) params.set("id", selectedId);
  params.set("date", date);
  // E2E-TEMP: preserve debug=1 so the useLogs/useRunEvents debug gate stays on across syncs
  const existing = new URLSearchParams(window.location.search);
  if (existing.get("debug") === "1") params.set("debug", "1");
  const url = `${window.location.pathname}?${params.toString()}`;
  window.history.replaceState(null, "", url);
}

export function App() {
  const initial = useMemo(readUrlState, []);
  const [workflow, setWorkflow] = useState(initial.workflow);
  const [selectedId, setSelectedId] = useState<string | null>(initial.selectedId);
  const [reviewingPrepId, setReviewingPrepId] = useState<string | null>(null);
  const [ocrPreviewVisible, setOcrPreviewVisible] = useState(false);
  const [batchQueueParentRunId, setBatchQueueParentRunId] = useState<string | null>(null);
  const [runModalOpen, setRunModalOpen] = useState(false);
  const [runModalReuploadFor, setRunModalReuploadFor] = useState<{ sessionId: string; previousRunId: string } | undefined>(undefined);
  const [date, setDate] = useState(initial.date);
  const [availableDates, setAvailableDates] = useState<string[]>([]);
  const [queueSortMode, setQueueSortMode] = useState<QueueSortMode>(() =>
    readStoredQueueSortMode(),
  );
  // Status map for the currently-watched (workflow, date). Reset whenever
  // the user navigates to a different key so each viewing session starts
  // fresh — only LIVE transitions observed during continuous viewing fire
  // toasts. Discovering a historical completion by switching dates does
  // not fire a toast.
  const statusRef = useRef<Map<string, string>>(new Map());
  const lastToastKeyRef = useRef<string>("");

  // Pre-flight check on mount
  usePreflight();
  useTelegramToasts();
  useCaptureToasts();

  // Prime caches at app boot so the Run modal's first paint already has
  // the rosters listing AND the form-type picker — no fetch-blank frame.
  useEffect(() => {
    prefetchRosters();
    prefetchFormTypes();
  }, []);

  const renderOcrPrepToolbar = useCallback(() => <OcrReviewPrepToolbar />, []);
  const renderOcrPrepBody = useCallback(() => <OcrReviewPrepBody />, []);

  // Fail-loud on unknown workflow in `?wf=`. Once the registry has loaded,
  // if the URL workflow isn't a known name, warn and reset to the default
  // (or to the first registered workflow if the default itself is missing).
  // A loaded registry is signalled by `registered.length > 0` — the
  // provider blocks render until /api/workflow-definitions returns, so
  // an empty array would mean "intentionally none registered."
  const registered = useWorkflows();
  useEffect(() => {
    if (registered.length === 0) return;
    const known = registered.some((r) => r.name === workflow);
    if (known) return;
    const fallback =
      registered.find((r) => r.name === DEFAULT_WORKFLOW)?.name ??
      registered[0]?.name;
    if (!fallback || fallback === workflow) return;
    toast.warning(`Unknown workflow "${workflow}"`, {
      description: `URL ?wf= didn't match any registered workflow. Showing ${fallback}.`,
      duration: 6000,
    });
    setWorkflow(fallback);
  }, [registered, workflow]);

  // Sync state to URL so refresh preserves selection
  useEffect(() => {
    syncUrlState(workflow, selectedId, date);
  }, [workflow, selectedId, date]);

  useEffect(() => {
    try {
      localStorage.setItem(QUEUE_SORT_STORAGE_KEY, queueSortMode);
    } catch {
      /* ignore */
    }
  }, [queueSortMode]);

  // SSE entries
  const { entries, entriesKey, workflows, wfCounts, failureCounts, connected, loading } = useEntries(workflow, date);

  // Merge entries that resolve to the same person (same EID) into a single
  // queue row. The "primary" is the entry that owns the latest run; its
  // display name and status surface on the queue row. The other entries
  // ("siblings") get folded into the LogPanel's run history. Run pooling +
  // log routing happens in LogPanel.
  const mergeGroups = useMemo(() => groupMergedEntries(entries), [entries]);

  // Queue-display entries: one per merge group (the primary).
  const dedupedEntries = useMemo<TrackerEntry[]>(
    () => {
      const primaries = mergeGroups.map((g) => g.primary);
      // Match useEntries' newest-first sort so position is stable.
      return [...primaries].sort((a, b) => {
        type WithFirstLog = TrackerEntry & { firstLogTs?: string };
        const aStart = (a as WithFirstLog).firstLogTs || "";
        const bStart = (b as WithFirstLog).firstLogTs || "";
        if (!aStart && bStart) return 1;
        if (aStart && !bStart) return -1;
        if (!aStart && !bStart) return b.timestamp.localeCompare(a.timestamp);
        return bStart.localeCompare(aStart);
      });
    },
    [mergeGroups],
  );

  /** Merged primaries Operator still cares about (excludes approved/discarded prep, etc.). */
  const statPanelEntries = useMemo(
    () => dedupedEntries.filter((e) => !isResolvedPrepEntry(e as TrackerEntryJsonl)),
    [dedupedEntries],
  );

  const collapsedStatPanelEntries = useMemo(
    () => collapseEntriesForStatStrip(statPanelEntries),
    [statPanelEntries],
  );

  /** Tracker item ids delegated under the active batch-queue parent (if any). */
  const batchMemberIds = useMemo(() => {
    if (!batchQueueParentRunId) return null;
    const ids = new Set<string>();
    for (const e of entries) {
      if (e.parentRunId === batchQueueParentRunId) ids.add(e.id);
    }
    return ids;
  }, [batchQueueParentRunId, entries]);

  // If the URL `?id=` points to a sibling that's been folded into a primary,
  // redirect to the primary so the LogPanel actually loads. Without this,
  // bookmarking/refreshing on a now-merged sibling would land on an empty
  // log panel (the sibling no longer appears in the queue).
  //
  // Batch queue drill-in lists every delegated row by id — including merge
  // siblings — so never rewrite selection away from those ids while scoped.
  useEffect(() => {
    if (!selectedId) return;
    if (dedupedEntries.some((e) => e.id === selectedId)) return;
    if (batchMemberIds?.has(selectedId)) return;
    for (const g of mergeGroups) {
      if (g.siblings.some((s) => s.id === selectedId)) {
        setSelectedId(g.primary.id);
        return;
      }
    }
  }, [selectedId, dedupedEntries, mergeGroups, batchMemberIds]);

  const selectedEntry = useMemo(() => {
    if (!selectedId) return null;
    if (
      batchQueueParentRunId &&
      batchMemberIds?.has(selectedId)
    ) {
      const hit = entries.find(
        (e) => e.id === selectedId && e.parentRunId === batchQueueParentRunId,
      );
      if (hit) return hit;
    }
    return (
      dedupedEntries.find((e) => e.id === selectedId) ??
      entries.find((e) => e.id === selectedId) ??
      null
    );
  }, [
    selectedId,
    batchQueueParentRunId,
    batchMemberIds,
    entries,
    dedupedEntries,
  ]);

  // Fetch available dates when workflow changes. The selected date is
  // preserved across workflow switches — operators want to stay on the date
  // they were investigating, even if the new workflow has no data there
  // (the queue will simply read empty for that date). The URL already
  // persists `date` across reloads via syncUrlState below.
  useEffect(() => {
    fetch("/api/dates?workflow=" + encodeURIComponent(workflow))
      .then((r) => r.json())
      .then((dates: string[]) => {
        setAvailableDates(dates);
      })
      .catch(() => {});
  }, [workflow]);

  const meta = useWorkflow(workflow);
  const wfLabel = meta?.label ?? autoLabel(workflow);

  // Per-entry "<base> <ordinal>" labels for the queue / log header / toasts.
  // Recomputed whenever entries or the workflow's label change so a row's
  // ordinal stays stable as more rows arrive (the map is keyed by entry id;
  // older rows keep their #1, the newest gets #N).
  const displayNameEntries = useMemo(
    () =>
      buildDisplayNameEntries({
        visibleEntries: dedupedEntries,
        sourceEntries: entries,
      }),
    [dedupedEntries, entries],
  );

  const displayNames = useMemo(
    () => buildDisplayNameMap(displayNameEntries, wfLabel),
    [displayNameEntries, wfLabel],
  );

  // Toast on completion/failure for LIVE transitions only — i.e. an entry
  // whose status changed while the user was continuously watching the
  // current (workflow, date). Two safeguards prevent stale-data toasts:
  //
  //   1. `entriesKey` gate — when the date or workflow changes, useEntries
  //      sets `entriesKey=""` until a fresh SSE message arrives. Skipping
  //      the effect while `entriesKey` doesn't match the target key keeps
  //      stale entries from the previous date from being recorded under
  //      the new key (which would falsely fire toasts on id collisions
  //      once the new SSE delivers).
  //   2. Reset `statusRef` on key change — the first batch under each new
  //      key is treated as silent first-observation, so navigating to a
  //      past date or back to a previously-viewed one never fires toasts
  //      for transitions that happened while the user was elsewhere.
  useEffect(() => {
    const targetKey = `${workflow}|${date}`;
    if (entriesKey !== targetKey) return;
    if (lastToastKeyRef.current !== targetKey) {
      statusRef.current = new Map();
      lastToastKeyRef.current = targetKey;
    }
    for (const entry of dedupedEntries) {
      const prevStatus = statusRef.current.get(entry.id);
      statusRef.current.set(entry.id, entry.status);
      if (prevStatus === undefined) continue;
      if (prevStatus === entry.status) continue;
      // Resolve any pending action toasts (cancel-running, cancel-queued)
      // BEFORE the generic status toasts. The action resolution updates
      // an existing toast id with a specific message; the generic toast
      // below fires a separate notification for the user's awareness.
      resolveActionToastsForEntry(entry);
      const name = resolveEntryName(entry, displayNames);
      const isCancelled = entry.status === "failed" && entry.step === "cancelled";
      if (entry.status === "done") {
        if (isTerminalNotFoundEntry(entry)) {
          toast.message(`${name} not found`, {
            description: `${wfLabel} finished with no UCPath match`,
            duration: 5000,
          });
        } else {
          toast.success(`${name} completed`, {
            description: `${wfLabel} finished`,
            duration: 5000,
          });
        }
      } else if (isCancelled) {
        // The action-toast resolver already updated the loading toast
        // with a specific "Cancelled" message. The generic flow doesn't
        // need to fire a redundant `error` toast — would just be noise.
      } else if (entry.status === "failed") {
        toast.error(`${name} failed`, {
          description: entry.error || "Unknown error",
          duration: 8000,
        });
      }
    }
  }, [dedupedEntries, entriesKey, wfLabel, workflow, date, displayNames]);

  // Update document title
  useEffect(() => {
    const running = dedupedEntries.filter((e) => e.status === "running").length;
    document.title = running > 0 ? `${running} running \u2014 HR Dashboard` : "HR Dashboard";
  }, [dedupedEntries]);

  // Clear selection when switching workflows
  const handleWorkflowChange = useCallback((wf: string) => {
    setWorkflow(wf);
    setSelectedId(null);
    setBatchQueueParentRunId(null);
  }, []);

  const handleDateChange = useCallback((d: string) => {
    setDate(d);
    setBatchQueueParentRunId(null);
  }, []);

  // Cross-date search → deep-link to the matching (workflow, date, id).
  // Each setter triggers the URL-sync effect; useEntries re-subscribes when
  // workflow/date change, and LogPanel picks up the new selectedId. No extra
  // fetch logic needed here — the existing SSE stream for that workflow/date
  // will surface the entry once entries for that bucket arrive.
  const handleSearchSelect = useCallback((row: SearchResultRow) => {
    if (row.workflow !== workflow) handleWorkflowChange(row.workflow);
    if (row.date !== date) handleDateChange(row.date);
    setSelectedId(row.id);
  }, [workflow, date, handleWorkflowChange, handleDateChange]);


  const handleFailureSelect = useCallback((row: FailureRow) => {
    if (row.workflow !== workflow) handleWorkflowChange(row.workflow);
    if (row.date !== date) handleDateChange(row.date);
    setSelectedId(row.id);
  }, [workflow, date, handleWorkflowChange, handleDateChange]);

  // Stable handlers for QueuePanel — inline arrows here would mint a fresh
  // identity on every App render and defeat the React.memo on EntryItem.
  // All setters from useState are stable references (React guarantee), so
  // empty deps are correct.
  const handleSelectEntry = useCallback((id: string) => {
    // Selecting another queue entry exits review mode (preserving
    // localStorage edits per spec — only Approve / Discard wipe).
    setReviewingPrepId(null);
    setSelectedId(id);
  }, []);
  const handleOpenReview = useCallback((runId: string) => {
    setReviewingPrepId(runId);
  }, []);
  const handleReupload = useCallback(
    (reuploadFor: { sessionId: string; previousRunId: string }) => {
      setRunModalReuploadFor(reuploadFor);
      setRunModalOpen(true);
    },
    [],
  );
  const handleEnterBatchQueue = useCallback((parentRunId: string) => {
    // One batch view at a time — drilling into another batch while scoped would
    // nest batch context and break toolbar / bulk actions expectations.
    if (batchQueueParentRunId !== null) {
      if (batchQueueParentRunId === parentRunId) return;
      toast.warning("Already viewing a batch", {
        description: "Use Back to return to the queue before opening another batch.",
        duration: 5000,
      });
      return;
    }
    // Batch queue mode exits any open prep review and clears any selected child.
    setReviewingPrepId(null);
    setSelectedId(null);
    setBatchQueueParentRunId(parentRunId);
  }, [batchQueueParentRunId]);
  const handleExitBatchQueue = useCallback(() => {
    setBatchQueueParentRunId(null);
  }, []);
  const handleOpenBatchPreview = useCallback(() => {
    setReviewingPrepId(null);
    setSelectedId(null);
  }, []);

  const handleDeleteEntry = useCallback((id: string) => {
    if (selectedId === id) setSelectedId(null);
  }, [selectedId]);

  const handleBulkDeleted = useCallback(
    (ids: string[]) => {
      if (ids.length === 0) return;
      const removed = new Set(ids);
      if (selectedId && removed.has(selectedId)) setSelectedId(null);
    },
    [selectedId],
  );

  // Rail badges: other workflows use SSE `wfCounts`; the **active** workflow
  // uses the same merged + resolved-prep exclusion as the StatPills strip so
  // the sidebar digit and "ALL" stay lockstep.
  // Only override the active workflow's count once `entriesKey` confirms the
  // loaded entries belong to the current workflow — prevents a stale count
  // flash when switching workflows before the new SSE tick arrives.
  const entriesMatchWorkflow = entriesKey.startsWith(`${workflow}|`);
  const entryCounts = useMemo(
    () => ({
      ...wfCounts,
      ...(entriesMatchWorkflow ? { [workflow]: collapsedStatPanelEntries.length } : {}),
    }),
    [wfCounts, workflow, collapsedStatPanelEntries, entriesMatchWorkflow],
  );

  const batchPreviewMembers = useMemo(
    () =>
      batchQueueParentRunId
        ? dedupedEntries.filter((e) => e.parentRunId === batchQueueParentRunId)
        : [],
    [batchQueueParentRunId, dedupedEntries],
  );

  const sortedBatchPreviewMembers = useMemo(
    () =>
      batchQueueParentRunId
        ? sortQueueEntriesForDisplay(batchPreviewMembers, queueSortMode, displayNames)
        : [],
    [batchQueueParentRunId, batchPreviewMembers, queueSortMode, displayNames],
  );

  const batchPreviewPanelTitle = useMemo(() => {
    if (!batchQueueParentRunId) return `${wfLabel} batch preview`;
    return `${resolveDaemonBatchQueueTitle(wfLabel, batchPreviewMembers, batchQueueParentRunId)} preview`;
  }, [batchQueueParentRunId, batchPreviewMembers, wfLabel]);

  const primariesForBulkActions = useMemo(() => {
    if (!batchQueueParentRunId) return dedupedEntries;
    return dedupedEntries.filter((e) => e.parentRunId === batchQueueParentRunId);
  }, [batchQueueParentRunId, dedupedEntries]);

  const bulkActionEntries = useMemo(
    () => collectEntriesForMergedScope(mergeGroups, primariesForBulkActions),
    [mergeGroups, primariesForBulkActions],
  );

  /** All item ids in the same scope as Delete all / Stop — any status (done, not-found, failed, …). */
  const retryAllIds = useMemo(() => {
    const entries = bulkActionEntries.filter((e) => !isResolvedPrepRow(e));
    return [...new Set(entries.map((e) => e.id))];
  }, [bulkActionEntries]);

  const stopAllTargets = useMemo(
    () =>
      bulkActionEntries
        .filter(
          (e) =>
            e.workflow === workflow &&
            (e.status === "pending" || e.status === "running"),
        )
        .map((e) => ({
          id: e.id,
          status: e.status as "pending" | "running",
          ...(e.runId ? { runId: e.runId } : {}),
        })),
    [bulkActionEntries, workflow],
  );

  const prepareBusyCount = useMemo(
    () =>
      dedupedEntries.filter(
        (e) =>
          (e.status === "pending" || e.status === "running") &&
          parsePrepareRowData(e.data) !== null,
      ).length,
    [dedupedEntries],
  );

  return (
    <BatchQueueParentRunIdProvider parentRunId={batchQueueParentRunId}>
    <TooltipProvider delayDuration={150} skipDelayDuration={300}>
    <TerminalDrawerProvider>
    <div className="flex flex-col h-screen">
      <Toaster
        position="bottom-right"
        toastOptions={{
          style: {
            background: "var(--card)",
            border: "1px solid var(--border)",
            color: "var(--foreground)",
          },
        }}
      />
      <TopBar
        date={date}
        onDateChange={handleDateChange}
        availableDates={availableDates}
        onSearchSelect={handleSearchSelect}
        onFailureSelect={handleFailureSelect}
        failureCounts={failureCounts ?? {}}
      />
      <OcrReviewPrepProvider
        active={Boolean(
          selectedEntry &&
            selectedEntry.workflow === "ocr" &&
            selectedEntry.data?.mode === "prepare" &&
            ocrPreviewVisible,
        )}
        entry={selectedEntry ?? null}
        onClose={() => setReviewingPrepId(null)}
        onReupload={(reuploadFor) => {
          setRunModalReuploadFor(reuploadFor);
          setRunModalOpen(true);
        }}
      >
      <div className="flex flex-1 overflow-hidden">
        <WorkflowRail
          workflow={workflow}
          workflows={workflows}
          entryCounts={entryCounts}
          onWorkflowChange={handleWorkflowChange}
        />
        <QueuePanel
          entries={dedupedEntries}
          delegationSourceEntries={entries}
          statPanelEntries={statPanelEntries}
          workflow={workflow}
          workflowLabel={wfLabel}
          displayNames={displayNames}
          selectedId={selectedId}
          onSelect={handleSelectEntry}
          date={date}
          onDelete={handleDeleteEntry}
          onBulkDeleted={handleBulkDeleted}
          reviewingPrepId={reviewingPrepId}
          onOpenReview={handleOpenReview}
          onReupload={handleReupload}
          batchQueueParentRunId={batchQueueParentRunId}
          onEnterBatchQueue={handleEnterBatchQueue}
          onExitBatchQueue={handleExitBatchQueue}
          onOpenBatchPreview={handleOpenBatchPreview}
          loading={loading}
          queueSortMode={queueSortMode}
          onQueueSortModeChange={setQueueSortMode}
          queueBulkActionsSlot={
            <>
              <TopBarRunButton activeWorkflow={workflow} busyCount={prepareBusyCount} />
              <TopBarCaptureButton workflow={workflow} />
              <RetryAllButton
                workflow={workflow}
                ids={retryAllIds}
                date={date}
                parentRunId={batchQueueParentRunId ?? undefined}
              />
              <StopAllButton workflow={workflow} items={stopAllTargets} />
              <DeleteAllButton
                workflow={workflow}
                date={date}
                entries={bulkActionEntries.map((e) => ({
                  id: e.id,
                  ...(e.runId ? { runId: e.runId } : {}),
                }))}
                onDeleted={handleBulkDeleted}
              />
            </>
          }
          runControlsSlot={
            getQuickRunConfig(workflow) ? <QuickRunPanel workflow={workflow} /> : undefined
          }
        />
        {(() => {
          if (batchQueueParentRunId && !selectedEntry) {
            return (
              <BatchScreenshotsPanel
                members={sortedBatchPreviewMembers}
                displayNames={displayNames}
                title={batchPreviewPanelTitle}
              />
            );
          }

          // The OCR review surface lives as the Preview tab inside the
          // LogPanel. Keep that tab separate from the batch screenshot
          // preview panel above.
          // Downstream workflows (oath-signature, emergency-contact) get
          // their own kernel queue rows after Approve and must NOT show the
          // Preview tab — only the OCR parent row owns the review UI.
          const isPrepEntry =
            selectedEntry?.workflow === "ocr" &&
            selectedEntry?.data?.mode === "prepare";
          const wantsPreview =
            isPrepEntry && reviewingPrepId === (selectedEntry?.runId ?? selectedEntry?.id);
          return (
            <LogPanel
              entry={selectedEntry}
              workflow={workflow}
              date={date}
              allEntries={entries}
              displayNames={displayNames}
              siblings={
                selectedEntry
                  ? mergedGroupPeersForLogPanel(selectedEntry.id, mergeGroups)
                  : []
              }
              onDeleteEntry={() => handleDeleteEntry(selectedEntry?.id ?? "")}
              previewAvailable={isPrepEntry}
              previewHeaderSlot={isPrepEntry ? renderOcrPrepToolbar : undefined}
              previewSlot={isPrepEntry ? renderOcrPrepBody : undefined}
              onPreviewVisibleChange={setOcrPreviewVisible}
              defaultTab={wantsPreview && reviewingPrepId ? "preview" : undefined}
            />
          );
        })()}
      </div>
      </OcrReviewPrepProvider>
      <TerminalDrawer connected={connected} />
      {/* Reupload RunModal — opened by OcrQueueRow's Reupload button */}
      <RunModal
        open={runModalOpen}
        onOpenChange={(open) => {
          setRunModalOpen(open);
          if (!open) setRunModalReuploadFor(undefined);
        }}
        workflow="ocr"
        reuploadFor={runModalReuploadFor}
      />
    </div>
    </TerminalDrawerProvider>
    </TooltipProvider>
    </BatchQueueParentRunIdProvider>
  );
}
