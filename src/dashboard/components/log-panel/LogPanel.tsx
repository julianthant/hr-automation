import { useState, useEffect, useMemo } from "react";
import type { ReactNode } from "react";
import { TerminalSquare } from "lucide-react";
import { StepPipeline } from "./StepPipeline";
import { LogStream } from "./LogStream";
import { RunSelector } from "./RunSelector";
import { EmptyState } from "@/components/shared/EmptyState";
import { ScreenshotsPanel } from "./ScreenshotsPanel";
import { EditDataTab } from "./EditDataTab";
import { useLogs } from "@/components/hooks/useLogs";
import { useRunEvents } from "@/components/hooks/useRunEvents";
import { useRunsForMergedEntry } from "@/components/hooks/useRunsForMergedEntry";
import { cn } from "@/lib/utils";
import type { TrackerEntry } from "@/components/shared/types";
import { formatTrackerValue, isMonospaceKey } from "@/components/shared/types";
import { deriveTrackerFallbackLog } from "./log-fallback";
import { useWorkflow } from "@/lib/workflows-context";
import { queueStatusDisplayLabel } from "../../../domain/tracker-terminal-display.js";
import { resolveRowArchetype } from "../../../domain/row-archetype.js";

type LazySlot = ReactNode | (() => ReactNode);

interface LogPanelProps {
  entry: TrackerEntry | null;
  workflow: string;
  date: string;
  /** Cross-workflow entries for child-run detection. Optional — if absent, child section is hidden. */
  allEntries?: TrackerEntry[];
  /** Per-entry "<base> <ordinal>" labels from `buildDisplayNameMap`. */
  displayNames?: Map<string, string>;
  /**
   * Other entries merged into this entry (same person, different input
   * shapes — e.g. EID + name checks). Their runs are pooled with `entry`'s
   * runs and presented as one combined history. Each pooled run keeps its
   * true `itemId` so log fetching addresses the right JSONL key.
   */
  siblings?: TrackerEntry[];
  /** Default-active LogStream tab (e.g. "preview" when opening from an OcrQueueRow click). */
  defaultTab?: string;
  /** Optional preview content for the LogStream's Preview tab (e.g. OCR two-column body). */
  previewSlot?: LazySlot;
  /** Optional chrome row under the Preview tab strip (e.g. OCR filename + actions). */
  previewHeaderSlot?: LazySlot;
  /** Whether the Preview tab is shown. */
  previewAvailable?: boolean;
  /** Reports whether the Preview tab is currently selected. */
  onPreviewVisibleChange?: (visible: boolean) => void;
  /** Called when the operator triggers a hard-delete from the RunSelector toolbar. */
  onDeleteEntry?: () => void;
}

function deriveQueueRowTypeLabel(
  entry: TrackerEntry,
  childEntries: TrackerEntry[],
  allEntries: TrackerEntry[],
  previewAvailable: boolean,
): string {
  const archetype = resolveRowArchetype(entry);

  switch (archetype) {
    case "batch-parent": {
      // recordCount (set by OCR orchestrator) takes precedence; childEntries covers non-OCR anchors
      const recordCount = Number(entry.data?.recordCount ?? 0);
      const count = recordCount > 0 ? recordCount : childEntries.length;
      const base = count > 1 ? "Batch delegation" : "Single delegation";
      return previewAvailable ? `${base} · Preview` : base;
    }
    case "dispatch":
      return "Single delegation";
    case "passive-child":
      return "Passive delegation";
    case "delegate-child": {
      const siblingCount = entry.parentRunId
        ? allEntries.filter((e) => e.parentRunId === entry.parentRunId).length
        : 1;
      return siblingCount > 1 ? "Batch delegation" : "Single delegation";
    }
    case "batch-member":
      return "Delegation member";
    case "single":
    default: {
      // Legacy: delegating-workflow top-level rows (e.g. oath-upload) have taskRole "delegator"
      // until they receive an explicit archetype stamp on their tracker rows.
      if (entry.data?.taskRole === "delegator") return "Single delegation";
      if (childEntries.length > 0) return "Batch row";
      if (entry.parentRunId) return "Delegation member";
      return "Normal row";
    }
  }
}

export function LogPanel({ entry, workflow, date, allEntries, siblings, defaultTab, previewSlot, previewHeaderSlot, previewAvailable, onPreviewVisibleChange, onDeleteEntry }: LogPanelProps) {
  const effectiveWorkflow = entry?.workflow ?? workflow;
  const registered = useWorkflow(effectiveWorkflow);
  const [maximized, setMaximized] = useState(false);
  // Reset maximized whenever we switch to a different entry — operator's
  // intent for "fullscreen the tab" is per-row, not session-wide.
  useEffect(() => { setMaximized(false); }, [entry?.id, entry?.runId]);

  // Compute child entries (other entries where parentRunId === this run's runId).
  const childEntries: TrackerEntry[] = useMemo(
    () =>
      entry?.runId && allEntries
        ? allEntries.filter((e) => e.parentRunId === entry.runId && e.id !== entry.id)
        : [],
    [allEntries, entry?.id, entry?.runId],
  );
  const registeredSteps = registered?.steps ?? [];
  const detailFields = registered?.detailFields ?? [];

  // Runs for this entry + siblings, pooled and globally renumbered.
  // Keyed on (id, runId) tuples — NOT on status/step — so status updates
  // at 1 Hz do not trigger /api/runs refetches (new runs start by runId
  // changing, not status changing).
  const { runs, setRuns, activeRunId, setActiveRunId } = useRunsForMergedEntry({
    entry,
    siblings,
    workflow,
    date,
  });

  // Use the entry's own workflow when present (cross-workflow rows: OCR
  // prep rows surface in oath-signature/emergency-contact queues, but
  // their logs live in ocr-logs.jsonl). Falls back to the topbar workflow
  // when no entry is selected (skeleton state).
  const logSourceWorkflow = effectiveWorkflow;
  // When the active run came from a merged sibling, fetch logs against
  // the run's TRUE itemId rather than the primary's id — JSONL keys logs
  // per (workflow, itemId, runId) and the sibling's logs live under its
  // own itemId.
  const activeRunForLog = runs.find((r) => r.runId === activeRunId);
  const activeItemId = activeRunForLog?.itemId || entry?.id || null;
  const handleRunDeleted = () => {
    const remainingRuns = runs.filter((run) => run.runId !== activeRunId);
    if (remainingRuns.length === 0) {
      onDeleteEntry?.();
      return;
    }
    setRuns(remainingRuns);
    setActiveRunId(remainingRuns[remainingRuns.length - 1]?.runId ?? null);
  };
  const { logs, loading: logsLoading } = useLogs(logSourceWorkflow, activeItemId, activeRunId, date);
  const { events } = useRunEvents(logSourceWorkflow, activeItemId, activeRunId, date);
  const screenshotEventCount = useMemo(
    () => events.reduce((n, e) => (e.type === "screenshot" ? n + 1 : n), 0),
    [events],
  );
  const trackerFallbackLog = useMemo(
    () => deriveTrackerFallbackLog(entry, activeRunId),
    [entry, activeRunId],
  );
  const displayedLogs = useMemo(
    () =>
      !logsLoading && logs.length === 0 && trackerFallbackLog
        ? [trackerFallbackLog]
        : logs,
    [logs, logsLoading, trackerFallbackLog],
  );

  // Derive step/status from active run when viewing a HISTORICAL run via the
  // RunSelector. For the LIVE run (activeRun matches the SSE-delivered entry's
  // runId) prefer the SSE entry — `/api/runs` is polled every 2s only while
  // entry.status is running/pending, so the moment SSE flips status to done
  // the polling stops and `activeRun.step` freezes at whatever step the LAST
  // poll captured. For fast workflows (e.g. OCR with 0 records) that's the
  // first step, leaving the timeline stuck even though the entry is terminal.
  const activeRun = runs.find((r) => r.runId === activeRunId);
  const isViewingLiveRun = !activeRunId || activeRunId === entry?.runId;
  const runStatus = isViewingLiveRun
    ? (entry?.status || activeRun?.status || "pending")
    : (activeRun?.status || entry?.status || "pending");
  const runStep = isViewingLiveRun
    ? (entry?.step || activeRun?.step || null)
    : (activeRun?.step || null);
  const runStepDurations = activeRun?.stepDurations ?? entry?.stepDurations;
  const steps = useMemo(
    () =>
      effectiveWorkflow === "ocr"
        ? registeredSteps.filter((step) => {
            if (step === "awaiting-approval") return Boolean(entry?.parentRunId);
            return true;
          })
        : registeredSteps,
    [effectiveWorkflow, entry?.parentRunId, registeredSteps],
  );

  const allDetailFields = useMemo(
    () => detailFields.filter((f) => f.displayInGrid !== false),
    [detailFields],
  );

  if (!entry) {
    return (
      <div className="flex-1 flex flex-col bg-card">
        <EmptyState
          icon={TerminalSquare}
          title="Select an entry"
          description="Click an entry in the queue to view its logs"
        />
      </div>
    );
  }

  // The detail grid renders fields off `formatTrackerValue(entry, key)`,
  // which reads `entry.data[key]`. `allDetailFields` is memoized above.
  // When the operator is viewing a HISTORICAL run via the RunSelector, the deduped entry's data is the LATEST run's
  // data (often null/empty for cancelled rows) — not the data captured by
  // the run they actually selected. Use the per-run `data` carried on
  // `RunInfo` (server-side `runs.latest_data_json` via `/api/runs`) so
  // switching the run pill repaints the grid with that run's own values.
  // When swapping in a historical run's data, ALSO clear typedData — it's
  // the typed-shape mirror of the deduped entry's `data` and `formatTrackerValue`
  // checks it first. Leaving the primary's typedData in place would mask the
  // per-run `data` we just substituted (e.g. showing "Not found" from
  // 10874572's last run while the operator is viewing Langley's earlier
  // successful run).
  const detailEntry: TrackerEntry = !isViewingLiveRun && activeRun?.data
    ? { ...entry, data: activeRun.data as TrackerEntry["data"], typedData: undefined }
    : entry;

  const renderDetailValue = (key: string): string => formatTrackerValue(detailEntry, key);

  const Skeleton = ({ className }: { className?: string }) => (
    <div className={cn("rounded bg-muted animate-pulse", className)} />
  );

  // Show skeleton while logs are loading and we have no data yet
  const showSkeleton = logsLoading && displayedLogs.length === 0;
  const hideDetailGrid = logSourceWorkflow === "ocr" || detailEntry?.data?.requestRole === "delegation-dispatch";

  return (
    <div className="flex-1 flex flex-col bg-card min-w-0 min-h-0 overflow-hidden">
      {/* Detail grid + step pipeline are hidden when the operator maximizes
          a tab so the tab content takes the full LogPanel height. The
          previous title/action header was removed to move content up. */}
      {!maximized && (<>
      {/* Detail grid — rendered from registry metadata via formatTrackerValue;
          auto-adapts to any workflow's detailFields declaration. Wraps to
          rows of 4. */}
      {!hideDetailGrid && (
        <div className="grid grid-cols-4 flex-shrink-0">
          {allDetailFields.map((f) => {
            const value = renderDetailValue(f.key);
            const mono = isMonospaceKey(f.key);
            return (
              <div
                key={f.key}
                style={{ height: "69.5px" }}
                className="px-6 flex flex-col justify-center gap-1 overflow-hidden border-b border-r border-border"
              >
                <div className="text-[11px] uppercase tracking-wider text-muted-foreground font-medium leading-none">
                  {f.label}
                </div>
                {showSkeleton ? (
                  <Skeleton className="h-4 w-20" />
                ) : (
                  <div className={cn(
                    "text-sm truncate leading-tight",
                    mono ? "font-mono" : "font-medium",
                  )} title={value}>
                    {value}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Step pipeline */}
      {(showSkeleton ? (
        <div className="flex items-center gap-3 px-6 py-4 border-b border-border">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="flex items-center">
              {i > 0 && <Skeleton className="w-8 h-0.5 mx-1.5" />}
              <Skeleton className="w-6 h-6 rounded-full" />
              <Skeleton className="h-3 w-16 ml-1.5" />
            </div>
          ))}
        </div>
      ) : (
        <StepPipeline
          steps={steps}
          currentStep={runStep}
          status={runStatus}
          stepDurations={runStepDurations}
          entry={entry ?? undefined}
        />
      ))}

      </>)}

      {!maximized && childEntries.length > 0 && (
        <section className="mb-3 rounded-md border border-border p-3 mx-0">
          <h3 className="mb-2 text-[11px] uppercase tracking-wider text-muted-foreground">
            Delegated runs ({childEntries.length})
          </h3>
          <ul className="space-y-1">
            {childEntries.map((c) => {
              const childDisplay = queueStatusDisplayLabel({
                workflow: c.workflow,
                status: c.status,
                data: c.data,
              });
              return (
              <li
                key={`${c.workflow}#${c.id}#${c.runId}`}
                className="flex items-center gap-2 text-[11px] font-mono text-muted-foreground"
              >
                <span className="font-medium text-foreground/80">{c.workflow}</span>
                <span className="truncate">{c.id}</span>
                <span className={cn(
                  "ml-auto px-1.5 py-px rounded text-[10px]",
                  childDisplay === "Not found" && "bg-secondary/90 text-muted-foreground",
                  childDisplay !== "Not found" && c.status === "done" && "bg-success/10 text-success",
                  c.status === "failed" && "bg-destructive/10 text-destructive",
                  c.status === "running" && "bg-primary/10 text-primary",
                  c.status === "pending" && "bg-warning/10 text-warning",
                )}>
                  {childDisplay}
                </span>
              </li>
              );
            })}
          </ul>
        </section>
      )}

      <LogStream
        logs={displayedLogs}
        events={events}
        loading={logsLoading}
        rowTypeLabel={deriveQueueRowTypeLabel(entry, childEntries, allEntries ?? [], previewAvailable ?? false)}
        screenshotsSlot={
          <ScreenshotsPanel
            workflow={logSourceWorkflow}
            itemId={activeItemId}
            screenshotEventCount={screenshotEventCount}
            runId={activeRunId}
          />
        }
        editDataAvailable={detailFields.some((f) => f.editable)}
        editDataSlot={
          <EditDataTab
            workflow={logSourceWorkflow}
            entry={entry ?? null}
            runId={activeRunId}
            date={date}
          />
        }
        previewSlot={previewSlot}
        previewHeaderSlot={previewHeaderSlot}
        previewAvailable={previewAvailable}
        onPreviewVisibleChange={onPreviewVisibleChange}
        runControlsSlot={
          <RunSelector
            runs={runs}
            activeRunId={activeRunId}
            onSelect={setActiveRunId}
            workflow={logSourceWorkflow}
            retryTarget={{
              workflow: logSourceWorkflow,
              id: activeItemId ?? entry.id,
              runId: activeRunId ?? undefined,
              date,
            }}
            deleteTarget={onDeleteEntry && activeRunId ? {
              workflow: entry.workflow,
              id: activeItemId ?? entry.id,
              date,
              runId: activeRunId,
              onDeleted: handleRunDeleted,
            } : undefined}
          />
        }
        initialTab={defaultTab}
        maximized={maximized}
        onToggleMaximize={() => setMaximized((v) => !v)}
      />
    </div>
  );
}
