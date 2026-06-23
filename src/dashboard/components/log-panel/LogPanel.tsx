import { useState, useEffect, useMemo, useCallback } from "react";
import type { ReactNode } from "react";
import { TerminalSquare, TriangleAlert } from "lucide-react";
import { StepPipeline, computeOcrPipelineView } from "./StepPipeline";
import { LogStream } from "./LogStream";
import { RunSelector } from "./RunSelector";
import { ExportMenu } from "./ExportMenu";
import { RetryButton } from "@/components/shared/RetryButton";
import { EmptyState } from "@/components/shared/EmptyState";
import { ScreenshotsPanel } from "./ScreenshotsPanel";
import { BatchScreenshotsPanel } from "./BatchScreenshotsPanel";
import { EditDataTab } from "./EditDataTab";
import { useLogs, type CollapsedLogEntry } from "@/components/hooks/useLogs";
import { useCoordinatorAggregatedLogs } from "@/components/hooks/useCoordinatorAggregatedLogs";
import {
  COORDINATOR_LOG_SOURCE_LABEL,
  computeOperationPipelineView,
  isOperationCoordinatorWorkflow,
  operationCoordinatorEffectiveStatus,
  type CoordinatorLogLine,
} from "./coordinator-logs";
import { resolveEntryName } from "@/components/shared/entry-display";
import { useRunEvents } from "@/components/hooks/useRunEvents";
import { useRunsForMergedEntry } from "@/components/hooks/useRunsForMergedEntry";
import { cn } from "@/lib/utils";
import type { TrackerEntry } from "@/components/shared/types";
import { formatTrackerValue, isMonospaceKey } from "@/components/shared/types";
import { deriveTrackerFallbackLog } from "./log-fallback";
import { useWorkflow, useWorkflows } from "@/lib/workflows-context";
import { hasDelegationRole } from "../../../domain/row-archetype.js";
import type { DelegatedChild } from "./LogStream.js";

type LazySlot = ReactNode | (() => ReactNode);

interface LogPanelProps {
  entry: TrackerEntry | null;
  workflow: string;
  date: string;
  /** Cross-workflow entries for child-run detection. Optional — if absent, child section is hidden. */
  allEntries?: TrackerEntry[];
  /** Per-entry base-name labels from `buildDisplayNameMap`. */
  displayNames?: Map<string, string>;
  /**
   * Other entries merged into this entry (same person, different input
   * shapes — e.g. EID + name checks). Their runs are pooled with `entry`'s
   * runs and presented as one combined history. Each pooled run keeps its
   * true `itemId` so log fetching addresses the right JSONL key.
   */
  siblings?: TrackerEntry[];
  /** Default-active LogStream tab (e.g. "preview" when opening from an OCR review row click). */
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

/**
 * The log-panel footer chip describes the run's DELEGATION rather than its row
 * shape: a delegated run (`parentRunId`) reads "from <Parent Workflow>" (resolved
 * by finding the parent run in `allEntries` and labeling its workflow), and a
 * root run (no `parentRunId`) reads "Standalone" — it was run directly by the
 * workflow, not as a sub-step of another. Pure + exported for unit testing
 * (`workflowLabel` is injected so the resolver stays out of the function).
 */
export function deriveDelegationLabel(
  entry: TrackerEntry,
  allEntries: TrackerEntry[],
  workflowLabel: (workflow: string) => string,
): string {
  if (entry.parentRunId) {
    const parent = allEntries.find((e) => e.runId === entry.parentRunId);
    return parent?.workflow ? `from ${workflowLabel(parent.workflow)}` : "Delegated";
  }
  return "Standalone";
}

export function LogPanel({ entry, workflow, date, allEntries, displayNames, siblings, defaultTab, previewSlot, previewHeaderSlot, previewAvailable, onPreviewVisibleChange, onDeleteEntry }: LogPanelProps) {
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
  const isOperationCoordinator = Boolean(
    entry && isOperationCoordinatorWorkflow(entry.workflow) && entry.data?.archetype === "operation",
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
  // Operation coordinator rows (oath-signature / emergency-contact) merge their
  // own sparse lifecycle logs with the delegated OCR run's KEY events + a
  // one-line-per-member summary, so the Logs panel shows the real workflow
  // lifecycle instead of just the coordinator's near-empty runId. No-op
  // (`active: false`) for every other row.
  const { active: coordinatorAggregateActive, logs: coordinatorLogs } =
    useCoordinatorAggregatedLogs({ entry, coordinatorLogs: logs, childEntries, date });
  const { events } = useRunEvents(logSourceWorkflow, activeItemId, activeRunId, date);
  const screenshotEventCount = useMemo(
    () => events.reduce((n, e) => (e.type === "screenshot" ? n + 1 : n), 0),
    [events],
  );
  const trackerFallbackLog = useMemo(
    () => deriveTrackerFallbackLog(entry, activeRunId),
    [entry, activeRunId],
  );
  const displayedLogs = useMemo(() => {
    // Coordinator rows show the merged (coordinator + OCR + member) timeline
    // when it has any real content; otherwise fall through to the normal
    // fallback (e.g. a just-created operation with no logs yet).
    if (coordinatorAggregateActive && coordinatorLogs.length > 0) {
      return coordinatorLogs;
    }
    if (!logsLoading && logs.length === 0 && trackerFallbackLog) {
      return [trackerFallbackLog];
    }
    return logs;
  }, [coordinatorAggregateActive, coordinatorLogs, logs, logsLoading, trackerFallbackLog]);

  // Source-label resolver for the merged coordinator timeline — maps each line's
  // `source` to its human badge. undefined for non-coordinator rows (no badge).
  const sourceLabelOf = useMemo(() => {
    if (!coordinatorAggregateActive) return undefined;
    return (entry: CollapsedLogEntry): string | undefined => {
      // The merged coordinator lines are `CoordinatorLogLine`s (carry `source`);
      // the LogStream prop is typed on the base `CollapsedLogEntry`, so read it
      // through the wider shape. Non-coordinator lines (none here) yield no badge.
      const source = (entry as CoordinatorLogLine).source;
      return source ? COORDINATOR_LOG_SOURCE_LABEL[source] : undefined;
    };
  }, [coordinatorAggregateActive]);

  // Derive step/status from active run when viewing a HISTORICAL run via the
  // RunSelector. For the LIVE run (activeRun matches the SSE-delivered entry's
  // runId) prefer the SSE entry — `/api/runs` is polled every 2s only while
  // entry.status is running/pending, so the moment SSE flips status to done
  // the polling stops and `activeRun.step` freezes at whatever step the LAST
  // poll captured. For fast workflows (e.g. OCR with 0 records) that's the
  // first step, leaving the timeline stuck even though the entry is terminal.
  const activeRun = runs.find((r) => r.runId === activeRunId);
  const isViewingLiveRun = !activeRunId || activeRunId === entry?.runId;
  const liveEntryStatus = entry
    ? operationCoordinatorEffectiveStatus(entry, childEntries)
    : undefined;
  const runStatus = isViewingLiveRun
    ? (liveEntryStatus || entry?.status || activeRun?.status || "pending") // || entry?.status only reached when entry is null (liveEntryStatus is undefined)
    : (activeRun?.status || entry?.status || "pending");
  const runStep = isViewingLiveRun
    ? (entry?.step || activeRun?.step || null)
    : (activeRun?.step || null);
  // Step durations follow the SAME live-vs-historical preference as
  // status/step above. For the LIVE run, prefer the SSE `entry` — `activeRun`
  // is a one-shot `/api/runs` snapshot taken when the row was opened
  // (`useRunsForMergedEntry` only refetches when runId/id/date change, not as
  // the run progresses), so its `stepDurations` freezes at open time. The SSE
  // entry refreshes whenever a step closes or the run goes terminal (both
  // change `step`/`status`, which are in the entry hash), which is exactly when
  // durations change — so the timeline now updates live instead of only after a
  // remount (tab switch). Historical runs keep using the run's own snapshot.
  const runStepDurations = isViewingLiveRun
    ? (entry?.stepDurations ?? activeRun?.stepDurations)
    : (activeRun?.stepDurations ?? entry?.stepDurations);
  // OCR rows drop the `verification` (always) and "Review"/`awaiting-approval`
  // (standalone only) chips cosmetically — see `computeOcrPipelineView`. The
  // helper also remaps currentStep/status so a run parked on a hidden step
  // still renders the visible chips as complete. Non-OCR rows pass through.
  const pipeline = useMemo(() => {
    // Operation coordinators show their OWN lifecycle (Prepare → Review →
    // Fan-out) instead of the target workflow's member steps — see
    // `computeOperationPipelineView`.
    if (isOperationCoordinator && entry) {
      return computeOperationPipelineView(entry, childEntries);
    }
    if (entry?.workflow === "ocr") {
      return computeOcrPipelineView(
        registeredSteps,
        runStep,
        runStatus,
        Boolean(entry?.parentRunId),
      );
    }
    return { steps: registeredSteps, currentStep: runStep, status: runStatus };
  }, [entry, isOperationCoordinator, childEntries, registeredSteps, runStep, runStatus]);

  const allDetailFields = useMemo(
    () => detailFields.filter((f) => f.displayInGrid !== false),
    [detailFields],
  );

  // Footer chip = delegation provenance ("from <Parent>" / "Standalone"), not the
  // row shape. Resolve a parent run's workflow → its human label via the registry.
  const allWorkflows = useWorkflows();
  const workflowLabel = useCallback(
    (name: string) => allWorkflows.find((w) => w.name === name)?.label ?? name,
    [allWorkflows],
  );
  const delegationLabel = useMemo(
    () => (entry ? deriveDelegationLabel(entry, allEntries ?? [], workflowLabel) : ""),
    [entry, allEntries, workflowLabel],
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
    <div className={cn("rounded bg-muted motion-safe:animate-pulse", className)} />
  );

  // Show skeleton while logs are loading and we have no data yet
  const showSkeleton = logsLoading && displayedLogs.length === 0;
  const hideDetailGrid =
    Boolean(previewAvailable) ||
    hasDelegationRole(entry, "dispatch") ||
    isOperationCoordinator;
  // Run-level failure banner — elevates `entry.error` above the log wall with a
  // Retry. A cancelled run (failed + step="cancelled") is operator-stopped, not
  // a failure, so it gets no banner.
  const isCancelledRun = runStatus === "failed" && runStep === "cancelled";
  const failureBanner =
    runStatus === "failed" && !isCancelledRun && entry.error ? (
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2.5">
        <TriangleAlert aria-hidden className="h-4 w-4 shrink-0 text-destructive" />
        <p className="min-w-0 flex-1 text-[12.5px] leading-snug">
          <span className="font-semibold text-destructive">Run failed.</span>{" "}
          <span className="text-foreground/80">{entry.error}</span>
        </p>
        <RetryButton
          workflow={logSourceWorkflow}
          id={activeItemId ?? entry.id}
          runId={activeRunId ?? entry.runId ?? undefined}
          date={date}
          size="md"
        />
      </div>
    ) : undefined;

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
        <div className="grid grid-cols-4 shrink-0">
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

      {/* Step pipeline — every row, including the operation coordinator, shows
          its own lifecycle timeline (Prepare → Review → Fan-out for
          coordinators, whose steps are derived in `computeOperationPipelineView`). */}
      {showSkeleton ? (
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
          steps={pipeline.steps}
          currentStep={pipeline.currentStep}
          status={pipeline.status}
          stepDurations={isOperationCoordinator ? undefined : runStepDurations}
          entry={entry ?? undefined}
        />
      )}

      </>)}

      {/* Delegated runs are surfaced in the "Delegated" LogStream tab — see below. */}

      <LogStream
        logs={displayedLogs}
        events={events}
        loading={logsLoading}
        delegationLabel={delegationLabel}
        failureBanner={failureBanner}
        sourceLabelOf={sourceLabelOf}
        delegatedChildren={childEntries.length > 0 ? (childEntries as DelegatedChild[]) : undefined}
        screenshotsSlot={
          isOperationCoordinator ? (
            <BatchScreenshotsPanel
              members={childEntries}
              displayNames={displayNames}
              title={resolveEntryName(entry, displayNames) || entry.id}
            />
          ) : (
            <ScreenshotsPanel
              workflow={logSourceWorkflow}
              itemId={activeItemId}
              screenshotEventCount={screenshotEventCount}
              runId={activeRunId}
            />
          )
        }
        editDataAvailable={!isOperationCoordinator && detailFields.some((f) => f.editable)}
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
          <>
          <ExportMenu
            entry={entry}
            logs={displayedLogs}
            events={events}
            workflow={logSourceWorkflow}
            runId={activeRunId}
            date={date}
          />
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
          </>
        }
        initialTab={defaultTab}
        maximized={maximized}
        onToggleMaximize={() => setMaximized((v) => !v)}
      />
    </div>
  );
}
