import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { Toaster, toast } from "sonner";
import { TooltipProvider } from "./components/ui/tooltip";
import { TopBar } from "./components/TopBar";
import { QueuePanel } from "./components/QueuePanel";
import { LogPanel } from "./components/LogPanel";
import { OcrReviewPane } from "./components/ocr/OcrReviewPane";
import { TerminalDrawer } from "./components/TerminalDrawer";
import { TerminalDrawerProvider } from "./components/hooks/useTerminalDrawer";
import { useEntries } from "./components/hooks/useEntries";
import { usePreflight } from "./components/hooks/usePreflight";
import { prefetchRosters } from "./components/hooks/useRosters";
import { prefetchFormTypes } from "./components/hooks/useFormTypes";
import { useTelegramToasts } from "./components/hooks/useTelegramToasts";
import { useCaptureToasts } from "./components/hooks/useCaptureToasts";
import { resolveActionToastsForEntry } from "./components/hooks/useActionToasts";
import { useWorkflow, useWorkflows, autoLabel } from "./workflows-context";
import { resolveEntryName, buildDisplayNameMap } from "./components/entry-display";
import type { SearchResultRow, PreviewInboxRow, FailureRow } from "./components/types";
import { WorkflowRail } from "./components/WorkflowRail";
import { QuickRunPanel } from "./components/QuickRunPanel";
import { RetryAllButton } from "./components/RetryAllButton";
import { TopBarRunButton } from "./components/TopBarRunButton";
import { TopBarCaptureButton } from "./components/TopBarCaptureButton";
import { parsePrepareRowData, isResolvedPrepRow } from "./components/ocr/types";
import { RunModal } from "./components/RunModal";
import { dateLocal } from "./lib/utils";

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
  const url = `${window.location.pathname}?${params.toString()}`;
  window.history.replaceState(null, "", url);
}

export default function App() {
  const initial = useMemo(readUrlState, []);
  const [workflow, setWorkflow] = useState(initial.workflow);
  const [selectedId, setSelectedId] = useState<string | null>(initial.selectedId);
  const [reviewingPrepId, setReviewingPrepId] = useState<string | null>(null);
  const [drilledBatchRunId, setDrilledBatchRunId] = useState<string | null>(null);
  const [runModalOpen, setRunModalOpen] = useState(false);
  const [runModalReuploadFor, setRunModalReuploadFor] = useState<{ sessionId: string; previousRunId: string } | undefined>(undefined);
  const [date, setDate] = useState(initial.date);
  const [availableDates, setAvailableDates] = useState<string[]>([]);
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
    console.warn(
      `[dashboard] Unknown workflow "${workflow}" in ?wf= URL param. ` +
        `Falling back to "${fallback}". Known workflows: ${registered
          .map((r) => r.name)
          .join(", ")}.`,
    );
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

  // SSE entries
  const { entries, entriesKey, workflows, wfCounts, failureCounts, connected, loading } = useEntries(workflow, date);

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
  const displayNames = useMemo(
    () => buildDisplayNameMap(entries, wfLabel),
    [entries, wfLabel],
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
    for (const entry of entries) {
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
        toast.success(`${name} completed`, {
          description: `${wfLabel} finished`,
          duration: 5000,
        });
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
  }, [entries, entriesKey, wfLabel, workflow, date, displayNames]);

  // Update document title
  useEffect(() => {
    const running = entries.filter((e) => e.status === "running").length;
    document.title = running > 0 ? `${running} running \u2014 HR Dashboard` : "HR Dashboard";
  }, [entries]);

  // Clear selection when switching workflows
  const handleWorkflowChange = useCallback((wf: string) => {
    setWorkflow(wf);
    setSelectedId(null);
    setDrilledBatchRunId(null);
  }, []);

  const handleDateChange = useCallback((d: string) => {
    setDate(d);
    setDrilledBatchRunId(null);
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

  const handlePreviewSelect = useCallback((row: PreviewInboxRow) => {
    if (row.workflow !== workflow) handleWorkflowChange(row.workflow);
    if (row.date !== date) handleDateChange(row.date);
    setSelectedId(row.id);
  }, [workflow, date, handleWorkflowChange, handleDateChange]);

  const handleFailureSelect = useCallback((row: FailureRow) => {
    if (row.workflow !== workflow) handleWorkflowChange(row.workflow);
    if (row.date !== date) handleDateChange(row.date);
    setSelectedId(row.id);
  }, [workflow, date, handleWorkflowChange, handleDateChange]);

  // Entry counts per workflow from backend SSE (accurate across all workflows)
  const entryCounts = wfCounts;

  const selectedEntry = entries.find((e) => e.id === selectedId) || null;

  // Failed IDs across the current workflow + date — feeds RetryAllButton.
  // Excludes operator-discarded prep rows via `isResolvedPrepRow` so retry-bulk
  // doesn't try to re-enqueue rows whose `data.mode === "prepare"` (no valid
  // emplId/docId for schema validation). Mirrors `computeFailureCounts` on the
  // backend — same predicate drives FailureBell badge + WorkflowRail counts.
  const failedIds = useMemo(
    () =>
      entries
        .filter((e) => e.status === "failed" && !isResolvedPrepRow(e))
        .map((e) => e.id),
    [entries],
  );

  return (
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
        onPreviewSelect={handlePreviewSelect}
        onFailureSelect={handleFailureSelect}
        failureCounts={failureCounts ?? {}}
      />
      <div className="flex flex-1 overflow-hidden">
        <WorkflowRail
          workflow={workflow}
          workflows={workflows}
          entryCounts={entryCounts}
          onWorkflowChange={handleWorkflowChange}
        />
        <QueuePanel
          entries={entries}
          workflow={workflow}
          displayNames={displayNames}
          selectedId={selectedId}
          onSelect={(id) => {
            // Selecting another queue entry exits review mode (preserving
            // localStorage edits per spec — only Approve / Discard wipe).
            setReviewingPrepId(null);
            setSelectedId(id);
          }}
          reviewingPrepId={reviewingPrepId}
          onOpenReview={(runId) => setReviewingPrepId(runId)}
          onReupload={(reuploadFor) => {
            setRunModalReuploadFor(reuploadFor);
            setRunModalOpen(true);
          }}
          drilledBatchRunId={drilledBatchRunId}
          onDrillIn={(parentRunId) => {
            // Drilling exits any open prep review and clears any selected child —
            // the user explicitly switched contexts.
            setReviewingPrepId(null);
            setSelectedId(null);
            setDrilledBatchRunId(parentRunId);
          }}
          onDrillOut={() => {
            setDrilledBatchRunId(null);
          }}
          loading={loading}
          runControlsSlot={
            <>
              <QuickRunPanel workflow={workflow} />
              <TopBarRunButton
                activeWorkflow={workflow}
                busyCount={
                  entries.filter(
                    (e) =>
                      (e.status === "pending" || e.status === "running") &&
                      parsePrepareRowData(e.data) !== null,
                  ).length
                }
              />
              <RetryAllButton workflow={workflow} failedIds={failedIds} />
              <TopBarCaptureButton workflow={workflow} />
            </>
          }
        />
        {(() => {
          // Preview now lives as a tab inside LogPanel. When a prep row is
          // selected (or operator clicks "Open review" on an OcrQueueRow),
          // we make the Preview tab available and switch to it by default.
          const isPrepEntry = selectedEntry?.data?.mode === "prepare";
          const wantsPreview =
            isPrepEntry && (reviewingPrepId === (selectedEntry?.runId ?? selectedEntry?.id) || true);
          return (
            <LogPanel
              entry={selectedEntry}
              workflow={workflow}
              date={date}
              displayNames={displayNames}
              previewAvailable={isPrepEntry}
              previewSlot={
                isPrepEntry && selectedEntry ? (
                  <OcrReviewPane
                    entry={selectedEntry}
                    onClose={() => setReviewingPrepId(null)}
                    onReupload={(reuploadFor) => {
                      setRunModalReuploadFor(reuploadFor);
                      setRunModalOpen(true);
                    }}
                  />
                ) : undefined
              }
              defaultTab={wantsPreview && reviewingPrepId ? "preview" : undefined}
            />
          );
        })()}
      </div>
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
  );
}
