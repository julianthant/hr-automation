import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { Toaster } from "sonner";
import { toast } from "./lib/notify";
import { notify, NOTIFY_KINDS, type NotificationEntityRef } from "./lib/notifications";
import {
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle,
} from "./components/ui/resizable";
import { TooltipProvider } from "./components/ui/tooltip";
import { TopBar } from "./components/navigation/TopBar";
import { QueuePanel } from "./components/queue-panel/QueuePanel";
import { countQueuePanelTopLevelRows } from "./components/queue-panel/queue-surface-classifier";
import { resolveDaemonOperationQueueTitle } from "./components/queue-panel/operation-queue-view";
import { LogPanel } from "./components/log-panel/LogPanel";
import { OperationScreenshotsPanel } from "./components/log-panel/OperationScreenshotsPanel";
import {
  OcrReviewPrepProvider,
  OcrReviewPrepToolbar,
  OcrReviewPrepBody,
} from "./components/ocr/OcrReviewPane";
import { TerminalDrawer } from "./components/terminal-drawer/TerminalDrawer";
import { TerminalDrawerProvider } from "./components/hooks/useTerminalDrawer";
import { OperationQueueParentRunIdProvider } from "./components/hooks/useOperationQueueContext";
import { useEntries } from "./components/hooks/useEntries";
import { usePreflight } from "./components/hooks/usePreflight";
import { prefetchRosters } from "./components/hooks/useRosters";
import { prefetchFormTypes } from "./components/hooks/useFormTypes";
import { useCaptureToasts } from "./components/hooks/useCaptureToasts";
import { resolveActionToastsForEntry } from "./components/hooks/useActionToasts";
import { WorkflowsProvider, useWorkflow, useWorkflows, autoLabel } from "./lib/workflows-context";
import { buildWorkflowRailEntryCounts } from "./lib/workflow-rail-counts";
import {
  resolveEntryName,
  buildDisplayNameMap,
  buildDisplayNameEntries,
  groupMergedEntries,
  collectEntriesForMergedScope,
  mergedGroupPeersForLogPanel,
} from "./components/shared/entry-display";
import type { TrackerEntry, SearchResultRow } from "./components/shared/types";
import { WorkflowRail } from "./components/navigation/WorkflowRail";
import { useConfirm } from "@/components/shared/useConfirm";
import { InputRunPanel } from "./components/navigation/InputRunPanel";
import { getInputRunConfig } from "./lib/input-run-registry";
import { RetryAllButton } from "./components/queue-panel/RetryAllButton";
import { StopAllButton } from "./components/queue-panel/StopAllButton";
import { DeleteAllButton } from "./components/queue-panel/DeleteAllButton";
import { TopBarRunButton } from "./components/navigation/TopBarRunButton";
import { parsePrepareRowData, isResolvedPrepRow, isDiscardedPrepRow } from "./components/ocr/types";
import { RunModal } from "./components/run-modal/RunModal";
import { cn, dateLocal, isEditableFocus } from "./lib/utils";
import {
  HelpCircle,
  Settings,
  CheckCircle2,
  AlertCircle,
  AlertTriangle,
  Info,
  Loader2,
} from "lucide-react";
import { ShortcutsGuide } from "./components/navigation/ShortcutsGuide";
import { OverviewPanel } from "./components/overview/OverviewPanel";
import { SettingsDialog } from "./components/settings/SettingsDialog";
import { ConfigurationFaultBanner } from "./components/settings/ConfigurationFaultBanner";
import { WorkflowEditorScreen } from "./components/workflow-modifier/WorkflowEditorScreen";
import {
  fireDesktopNotification,
  readNotifySettings,
  writeNotifySettings,
} from "./lib/desktop-notifications";

import type { TrackerEntry as TrackerEntryJsonl } from "../tracker/jsonl.js";
import { isResolvedPrepEntry } from "../tracker/dashboard/prep-rows.js";
import { isTerminalNotFoundEntry } from "../domain/tracker-terminal-display.js";
import {
  QUEUE_SORT_STORAGE_KEY,
  readStoredQueueSortMode,
  sortQueueEntriesForDisplay,
  queueSortStartTs,
  type QueueSortMode,
} from "./components/queue-panel/queue-sort";
import { AppErrorBoundary } from "./components/shared/AppErrorBoundary";
import { UiGallery } from "./components/dev/UiGallery";

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

function mapsEqual(a: Map<string, string>, b: Map<string, string>): boolean {
  if (a.size !== b.size) return false;
  for (const [key, value] of a) {
    if (b.get(key) !== value) return false;
  }
  return true;
}

export function App() {
  const initial = useMemo(readUrlState, []);
  const [workflow, setWorkflow] = useState(initial.workflow);
  const [selectedId, setSelectedId] = useState<string | null>(initial.selectedId);
  const [reviewingPrepId, setReviewingPrepId] = useState<string | null>(null);
  const [ocrPreviewVisible, setOcrPreviewVisible] = useState(false);
  const [operationQueueParentRunId, setOperationQueueParentRunId] = useState<string | null>(null);
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

  // Desktop notifications: settings (persisted) + a per-entry awaiting-review
  // edge tracker + a stable ref to the row-select handler for click-to-focus.
  const [notifySettings, setNotifySettings] = useState(readNotifySettings);
  const notifySettingsRef = useRef(notifySettings);
  notifySettingsRef.current = notifySettings;
  const reviewNotifiedRef = useRef<Map<string, boolean>>(new Map());
  const handleSelectEntryRef = useRef<(id: string) => void>(() => {});

  // Pre-flight check on mount
  usePreflight();
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
  const { entries, entriesKey, workflows, wfCounts, wfQueuedCounts, failureCounts, connected, loading } = useEntries(workflow, date);

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
        const aStart = queueSortStartTs(a);
        const bStart = queueSortStartTs(b);
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

  /** Tracker item ids delegated under the active batch-queue parent (if any). */
  const operationMemberIds = useMemo(() => {
    if (!operationQueueParentRunId) return null;
    const ids = new Set<string>();
    for (const e of entries) {
      if (e.parentRunId === operationQueueParentRunId) ids.add(e.id);
    }
    return ids;
  }, [operationQueueParentRunId, entries]);

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
    if (operationMemberIds?.has(selectedId)) return;
    for (const g of mergeGroups) {
      if (g.siblings.some((s) => s.id === selectedId)) {
        setSelectedId(g.primary.id);
        return;
      }
    }
  }, [selectedId, dedupedEntries, mergeGroups, operationMemberIds]);

  const selectedEntry = useMemo(() => {
    if (!selectedId) return null;
    if (
      operationQueueParentRunId &&
      operationMemberIds?.has(selectedId)
    ) {
      const hit = entries.find(
        (e) => e.id === selectedId && e.parentRunId === operationQueueParentRunId,
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
    operationQueueParentRunId,
    operationMemberIds,
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
  const runtimePolicies = useMemo(
    () => new Map(
      registered
        .filter((item) => item.runtimePolicy)
        .map((item) => [item.name, item.runtimePolicy!]),
    ),
    [registered],
  );

  const presentationByWorkflow = useMemo(
    () => new Map(registered.map((m) => [m.name, m.presentation])),
    [registered],
  );
  const resolvePresentation = useCallback(
    (workflowId: string) => presentationByWorkflow.get(workflowId),
    [presentationByWorkflow],
  );

  /** Matches QueuePanel group cards + flat rows (not strip-collapse primaries). */
  const queuePanelTopLevelCount = useMemo(
    () =>
      countQueuePanelTopLevelRows({
        entries: dedupedEntries.filter((e) => !isDiscardedPrepRow(e)),
        delegationSourceEntries: entries.filter((e) => !isDiscardedPrepRow(e)),
        workflow,
        workflowLabel: wfLabel,
        runtimePolicies,
      }),
    [dedupedEntries, entries, workflow, wfLabel, runtimePolicies],
  );

  // Per-entry base-name labels for the queue / log header / toasts. Stamped
  // rows resolve their title from queue row kind (resolveQueueRowPresentation)
  // before this map is consulted; the map supplies bare base names for legacy /
  // unstamped rows and delegated-label inheritance. No session-local ordinals.
  const displayNameEntries = useMemo(
    () =>
      buildDisplayNameEntries({
        visibleEntries: dedupedEntries,
        sourceEntries: entries,
      }),
    [dedupedEntries, entries],
  );

  const displayNamesRef = useRef<Map<string, string>>(new Map());
  const displayNames = useMemo(() => {
    const next = buildDisplayNameMap(displayNameEntries, wfLabel);
    const prev = displayNamesRef.current;
    if (mapsEqual(prev, next)) return prev;
    displayNamesRef.current = next;
    return next;
  }, [displayNameEntries, wfLabel]);

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
      reviewNotifiedRef.current = new Map();
      lastToastKeyRef.current = targetKey;
    }
    for (const entry of dedupedEntries) {
      const prevStatus = statusRef.current.get(entry.id);
      statusRef.current.set(entry.id, entry.status);

      // OCR awaiting-review rising edge — fire a desktop notification once when
      // the row enters review (status stays "running", so the status-change
      // path below never catches it).
      const nowReview =
        entry.workflow === "ocr" &&
        entry.status === "running" &&
        entry.step === "awaiting-approval";
      const prevReview = reviewNotifiedRef.current.get(entry.id);
      reviewNotifiedRef.current.set(entry.id, nowReview);
      if (prevReview === false && nowReview) {
        const reviewName = resolveEntryName(entry, displayNames);
        // Center notification (no toast — review is a steady-state, not a flash)
        // plus the backgrounded-tab desktop notification when enabled.
        notify({
          kind: NOTIFY_KINDS.ocrAwaitingReview,
          title: `${reviewName} ready for approval`,
          description: `${wfLabel} is awaiting review`,
          source: entry.workflow,
          subject: reviewName,
          entityRef: { workflow: entry.workflow, id: entry.id, runId: entry.runId, date },
          traceId: entry.data?.__traceId,
          toast: false,
        });
        if (notifySettingsRef.current.awaitingReview) {
          fireDesktopNotification({
            title: `${wfLabel} — awaiting review`,
            body: `${reviewName} is ready for approval`,
            tag: `review-${entry.id}`,
            onClick: () => handleSelectEntryRef.current(entry.id),
          });
        }
      }

      if (prevStatus === undefined) continue;
      if (prevStatus === entry.status) continue;
      // Resolve any pending action toasts (cancel-running, cancel-queued)
      // BEFORE the generic status toasts. The action resolution updates
      // an existing toast id with a specific message; the generic toast
      // below fires a separate notification for the user's awareness.
      resolveActionToastsForEntry(entry);
      const name = resolveEntryName(entry, displayNames);
      const isCancelled = entry.status === "failed" && entry.step === "cancelled";
      const entityRef: NotificationEntityRef = {
        workflow: entry.workflow,
        id: entry.id,
        runId: entry.runId,
        date,
      };
      const traceId = entry.data?.__traceId;
      if (entry.status === "done") {
        if (isTerminalNotFoundEntry(entry)) {
          notify({
            kind: NOTIFY_KINDS.runNotFound,
            title: `${name} not found`,
            description: `${wfLabel} finished with no UCPath match`,
            source: entry.workflow,
            subject: name,
            entityRef,
            traceId,
            toastOptions: { duration: 5000 },
          });
        } else {
          notify({
            kind: NOTIFY_KINDS.runCompleted,
            title: `${name} completed`,
            description: `${wfLabel} finished`,
            source: entry.workflow,
            subject: name,
            entityRef,
            traceId,
            toastOptions: { duration: 5000 },
          });
        }
      } else if (isCancelled) {
        // The action-toast resolver already updated the loading toast
        // with a specific "Cancelled" message. The generic flow doesn't
        // need to fire a redundant `error` toast — would just be noise.
      } else if (entry.status === "failed") {
        notify({
          kind: NOTIFY_KINDS.runFailed,
          title: `${name} failed`,
          description: entry.error || "Unknown error",
          source: entry.workflow,
          subject: name,
          entityRef,
          traceId,
          rerunnable: true,
          toastOptions: { duration: 8000 },
        });
        if (notifySettingsRef.current.failure) {
          fireDesktopNotification({
            title: `${wfLabel} failed`,
            body: `${name} — ${entry.error || "Unknown error"}`,
            tag: `fail-${entry.id}`,
            onClick: () => handleSelectEntryRef.current(entry.id),
          });
        }
      }
    }
  }, [dedupedEntries, entriesKey, wfLabel, workflow, date, displayNames]);

  // Update document title
  useEffect(() => {
    const running = dedupedEntries.filter((e) => e.status === "running").length;
    document.title = running > 0 ? `${running} running \u2014 HR Dashboard` : "HR Dashboard";
  }, [dedupedEntries]);

  // Cross-workflow Overview landing (rail "Dashboard" entry), the Settings
  // overlay (navbar gear — a centered Dialog over the dimmed dashboard), and the
  // full-page Workflow Editor takeover (launched FROM the Settings overlay; it
  // hides the top bar + rail + drawer so the editor's own sidebar is never
  // nested under another).
  const [showOverview, setShowOverview] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showEditor, setShowEditor] = useState(false);
  // Unsaved-draft state lifted from the full-page Workflow Editor; gates the
  // leave guard. Only ever true while the editor takeover is mounted
  // (WorkflowModifierPage reports `false` on unmount), so a plain `editorDirty`
  // check covers leaving the editor with unsaved graph edits.
  const [editorDirty, setEditorDirty] = useState(false);

  const { confirm, confirmDialog } = useConfirm();

  // Leaving a dirty Workflow Editor (inside Settings) confirms before
  // discarding; a clean leave (or any non-editor view) switches instantly.
  const requestLeaveEditor = useCallback(async (): Promise<boolean> => {
    if (!editorDirty) return true;
    return confirm({
      title: "Discard unsaved changes?",
      description:
        "Your Workflow Editor changes haven't been saved. Leaving will discard them.",
      confirmLabel: "Discard",
      cancelLabel: "Keep editing",
      tone: "destructive",
    });
  }, [confirm, editorDirty]);

  // Clear selection when switching workflows (also closes Overview + Settings).
  // The editor is a separate full-page view (rail hidden), so no leave guard is
  // needed here — global shortcuts are disabled while it's open.
  const handleWorkflowChange = useCallback((wf: string) => {
    setShowOverview(false);
    setShowSettings(false);
    setWorkflow(wf);
    setSelectedId(null);
    setOperationQueueParentRunId(null);
  }, []);

  // Rail "Dashboard" entry — land on the cross-workflow Overview.
  const handleShowOverview = useCallback(() => {
    setShowOverview(true);
    setShowSettings(false);
  }, []);

  // Navbar gear — open the Settings overlay. Entering is free (the draft
  // persists across open/close; Save commits, Revert discards).
  const handleShowSettings = useCallback(() => {
    setShowSettings(true);
  }, []);

  // Settings → "Workflow Editor": close the overlay and take over the full page.
  const handleLaunchEditor = useCallback(() => {
    setShowSettings(false);
    setShowEditor(true);
  }, []);

  // Editor "Back to dashboard" — guarded against unsaved graph edits.
  const handleLeaveEditor = useCallback(async () => {
    if (!(await requestLeaveEditor())) return;
    setEditorDirty(false);
    setShowEditor(false);
  }, [requestLeaveEditor]);

  // Notification preferences live in App (the status-transition effect reads
  // them) but are EDITED from the Settings page's Notifications section.
  const handleNotifySettingsChange = useCallback((s: typeof notifySettings) => {
    setNotifySettings(s);
    writeNotifySettings(s);
  }, []);

  const handleDateChange = useCallback((d: string) => {
    setDate(d);
    setOperationQueueParentRunId(null);
  }, []);

  // Global keyboard shortcuts (row-level ↑/↓/r/x live in QueuePanel). A "g t"
  // sequence jumps to today; "?" toggles the reference guide.
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const gPressedAtRef = useRef(0);

  // Resizable queue column: the queue↔detail split is a ResizablePanelGroup
  // (react-resizable-panels) whose sizes persist via its `autoSaveId`.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isEditableFocus(e.target)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      // The full-page editor owns the keyboard; suppress dashboard shortcuts.
      if (showEditor) return;

      if (e.key === "?") {
        e.preventDefault();
        setShortcutsOpen((v) => !v);
      } else if (e.key === "/") {
        e.preventDefault();
        (document.querySelector('input[aria-label="Search history"]'))?.focus();
      } else if (e.key === "[" || e.key === "]") {
        if (workflows.length === 0) return;
        const idx = workflows.indexOf(workflow);
        if (idx === -1) return;
        e.preventDefault();
        const len = workflows.length;
        const nextIdx = e.key === "]" ? (idx + 1) % len : (idx - 1 + len) % len;
        handleWorkflowChange(workflows[nextIdx]);
      } else if (e.key === "g") {
        gPressedAtRef.current = performance.now();
      } else if (e.key === "t") {
        if (performance.now() - gPressedAtRef.current < 700) {
          e.preventDefault();
          handleDateChange(dateLocal());
        }
        gPressedAtRef.current = 0;
      } else if (e.key === "Escape") {
        // Let any open dialog own Escape; otherwise close the guide.
        if (document.querySelector('[role="dialog"][data-state="open"]')) return;
        setShortcutsOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [workflows, workflow, handleWorkflowChange, handleDateChange, showEditor]);

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


  const handleOpenNotification = useCallback((ref: NotificationEntityRef) => {
    if (ref.workflow !== workflow) handleWorkflowChange(ref.workflow);
    if (ref.date && ref.date !== date) handleDateChange(ref.date);
    setSelectedId(ref.id);
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
  // Keep the ref fresh so a notification click (fired from the status-transition
  // effect's closure) always selects via the latest handler.
  handleSelectEntryRef.current = handleSelectEntry;
  const handleOpenReview = useCallback((runId: string) => {
    setReviewingPrepId(runId);
  }, []);
  // Operation coordinator rows link to their OCR review row, which lives in the
  // OCR panel. Switch to the OCR workflow, select the OCR row (by its id =
  // sessionId), and arm the Preview/review gate by setting reviewingPrepId to
  // the OCR run's id — the gate compares `reviewingPrepId === selectedEntry.runId`,
  // so selecting alone would land on the default Events tab, not the review tab.
  const handleOpenOcrReview = useCallback(
    (target: { sessionId: string; runId: string }) => {
      if (workflow !== "ocr") handleWorkflowChange("ocr");
      setSelectedId(target.sessionId);
      setReviewingPrepId(target.runId);
    },
    [workflow, handleWorkflowChange],
  );
  const handleReupload = useCallback(
    (reuploadFor: { sessionId: string; previousRunId: string }) => {
      setRunModalReuploadFor(reuploadFor);
      setRunModalOpen(true);
    },
    [],
  );
  const handleEnterOperationQueue = useCallback((parentRunId: string) => {
    // One batch view at a time — drilling into another batch while scoped would
    // nest batch context and break toolbar / bulk actions expectations.
    if (operationQueueParentRunId !== null) {
      if (operationQueueParentRunId === parentRunId) return;
      toast.warning("Already viewing a batch", {
        description: "Use Back to return to the queue before opening another batch.",
        duration: 5000,
      });
      return;
    }
    // Batch queue mode exits any open prep review and clears any selected child.
    setReviewingPrepId(null);
    setSelectedId(null);
    setOperationQueueParentRunId(parentRunId);
  }, [operationQueueParentRunId]);
  const handleExitOperationQueue = useCallback(() => {
    setOperationQueueParentRunId(null);
  }, []);
  const handleOpenOperationPreview = useCallback(() => {
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

  const entryCounts = useMemo(
    () =>
      buildWorkflowRailEntryCounts({
        wfCounts,
        activeWorkflow: workflow,
        activeEntriesKey: entriesKey,
        activeQueuePanelTopLevelCount: queuePanelTopLevelCount,
      }),
    [wfCounts, workflow, entriesKey, queuePanelTopLevelCount],
  );

  const operationPreviewMembers = useMemo(
    () =>
      operationQueueParentRunId
        ? dedupedEntries.filter((e) => e.parentRunId === operationQueueParentRunId)
        : [],
    [operationQueueParentRunId, dedupedEntries],
  );

  const sortedOperationPreviewMembers = useMemo(
    () =>
      operationQueueParentRunId
        ? sortQueueEntriesForDisplay(operationPreviewMembers, queueSortMode, displayNames)
        : [],
    [operationQueueParentRunId, operationPreviewMembers, queueSortMode, displayNames],
  );

  const operationPreviewPanelTitle = useMemo(() => {
    if (!operationQueueParentRunId) return `${wfLabel} batch preview`;
    return `${resolveDaemonOperationQueueTitle(wfLabel, operationPreviewMembers, operationQueueParentRunId)} preview`;
  }, [operationQueueParentRunId, operationPreviewMembers, wfLabel]);

  const primariesForBulkActions = useMemo(() => {
    if (!operationQueueParentRunId) return dedupedEntries;
    return entries.filter((e) => e.parentRunId === operationQueueParentRunId);
  }, [operationQueueParentRunId, dedupedEntries, entries]);

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
    <OperationQueueParentRunIdProvider parentRunId={operationQueueParentRunId}>
    <TooltipProvider delayDuration={150} skipDelayDuration={300}>
    <TerminalDrawerProvider>
    <div className="flex flex-col h-screen">
      <Toaster
        theme="dark"
        position="top-right"
        offset={{ top: "60px", right: "16px" }}
        expand
        visibleToasts={4}
        gap={10}
        closeButton
        icons={{
          success: <CheckCircle2 className="h-[18px] w-[18px]" aria-hidden />,
          info: <Info className="h-[18px] w-[18px]" aria-hidden />,
          warning: <AlertTriangle className="h-[18px] w-[18px]" aria-hidden />,
          error: <AlertCircle className="h-[18px] w-[18px]" aria-hidden />,
          loading: (
            <Loader2 className="h-[18px] w-[18px] animate-spin motion-reduce:animate-none" aria-hidden />
          ),
        }}
      />
      {showEditor ? (
        <WorkflowEditorScreen onBack={handleLeaveEditor} onDirtyChange={setEditorDirty} />
      ) : (
        <>
      <TopBar
        date={date}
        onDateChange={handleDateChange}
        availableDates={availableDates}
        onSearchSelect={handleSearchSelect}
        onOpenNotification={handleOpenNotification}
        failureCounts={failureCounts ?? {}}
        rightSlot={
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setShortcutsOpen(true)}
              aria-label="Keyboard shortcuts"
              title="Keyboard shortcuts (?)"
              className="h-8 w-8 rounded-md border border-border bg-secondary flex items-center justify-center text-muted-foreground cursor-pointer hover:bg-accent hover:text-foreground transition-colors outline-none focus-visible:ring-2 focus-visible:ring-primary"
            >
              <HelpCircle className="w-4 h-4" />
            </button>
            <button
              type="button"
              onClick={handleShowSettings}
              aria-label="Settings"
              aria-pressed={showSettings}
              title="Settings"
              className={cn(
                "h-8 w-8 rounded-md border flex items-center justify-center cursor-pointer transition-colors outline-none focus-visible:ring-2 focus-visible:ring-primary",
                showSettings
                  ? "border-primary bg-accent text-foreground"
                  : "border-border bg-secondary text-muted-foreground hover:bg-accent hover:text-foreground",
              )}
            >
              <Settings className="w-4 h-4" />
            </button>
          </div>
        }
      />
      <ConfigurationFaultBanner onOpenSettings={handleShowSettings} />
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
        {/* Settings is a centered overlay (Dialog) and the Workflow Editor is a
            full-page takeover — neither renders here, so the rail only toggles
            between the Overview and a workflow's queue/detail panels. */}
        <WorkflowRail
          workflow={workflow}
          workflows={workflows}
          entryCounts={entryCounts}
          queuedCounts={wfQueuedCounts}
          onWorkflowChange={handleWorkflowChange}
          overviewActive={showOverview}
          onShowOverview={handleShowOverview}
        />
        {showOverview ? (
          <OverviewPanel
            workflows={workflows}
            wfCounts={wfCounts}
            failureCounts={failureCounts ?? {}}
            date={date}
            onPick={handleWorkflowChange}
          />
        ) : (
        <ResizablePanelGroup
          direction="horizontal"
          autoSaveId="dashboard.queue-split"
          className="min-w-0 flex-1"
        >
          <ResizablePanel
            id="queue"
            order={1}
            defaultSize={28}
            minSize={18}
            maxSize={50}
            className="flex"
          >
        <QueuePanel
          entries={dedupedEntries}
          delegationSourceEntries={entries}
          statPanelEntries={statPanelEntries}
          workflow={workflow}
          workflowLabel={wfLabel}
          runtimePolicies={runtimePolicies}
          resolvePresentation={resolvePresentation}
          displayNames={displayNames}
          selectedId={selectedId}
          onSelect={handleSelectEntry}
          date={date}
          onDelete={handleDeleteEntry}
          onBulkDeleted={handleBulkDeleted}
          reviewingPrepId={reviewingPrepId}
          onOpenReview={handleOpenReview}
          onReupload={handleReupload}
          onOpenOcrReview={handleOpenOcrReview}
          operationQueueParentRunId={operationQueueParentRunId}
          onEnterOperationQueue={handleEnterOperationQueue}
          onExitOperationQueue={handleExitOperationQueue}
          onOpenOperationPreview={handleOpenOperationPreview}
          loading={loading}
          queueSortMode={queueSortMode}
          onQueueSortModeChange={setQueueSortMode}
          queueBulkActionsSlot={
            <>
              <TopBarRunButton activeWorkflow={workflow} busyCount={prepareBusyCount} />
              <RetryAllButton
                workflow={workflow}
                ids={retryAllIds}
                items={bulkActionEntries
                  .filter((e) => !isResolvedPrepRow(e))
                  .map((e) => ({
                    id: e.id,
                    ...(e.runId ? { runId: e.runId } : {}),
                  }))}
                date={date}
                parentRunId={operationQueueParentRunId ?? undefined}
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
            getInputRunConfig(workflow) ? <InputRunPanel workflow={workflow} /> : undefined
          }
          fill
        />
          </ResizablePanel>
          <ResizableHandle />
          <ResizablePanel id="detail" order={2} defaultSize={72} minSize={40} className="flex">
        {(() => {
          if (operationQueueParentRunId && !selectedEntry) {
            return (
              <OperationScreenshotsPanel
                members={sortedOperationPreviewMembers}
                displayNames={displayNames}
                title={operationPreviewPanelTitle}
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
          </ResizablePanel>
        </ResizablePanelGroup>
        )}
      </div>
      </OcrReviewPrepProvider>
      <TerminalDrawer connected={connected} viewingHistory={date !== dateLocal()} queuedCounts={wfQueuedCounts} />
        </>
      )}
      <ShortcutsGuide open={shortcutsOpen} onOpenChange={setShortcutsOpen} />
      <SettingsDialog
        open={showSettings}
        onOpenChange={setShowSettings}
        notifySettings={notifySettings}
        onNotifySettingsChange={handleNotifySettingsChange}
        onLaunchEditor={handleLaunchEditor}
      />
      {confirmDialog}
      {/* Reupload RunModal — opened by the Reupload action in the OCR review toolbar */}
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
    </OperationQueueParentRunIdProvider>
  );
}

export function DashboardApp() {
  // TEMPORARY dev route — ?view=ui-gallery catalogs the dashboard's reusable
  // surfaces (queue rows, session cards, controls) with the real components.
  // Remove this gate + src/dashboard/components/dev/UiGallery.tsx when done.
  if (new URLSearchParams(window.location.search).get("view") === "ui-gallery") {
    return (
      <AppErrorBoundary>
        <UiGallery />
      </AppErrorBoundary>
    );
  }
  return (
    <AppErrorBoundary>
      <WorkflowsProvider>
        <App />
      </WorkflowsProvider>
    </AppErrorBoundary>
  );
}
