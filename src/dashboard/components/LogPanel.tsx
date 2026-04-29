import { useState, useEffect } from "react";
import { TerminalSquare } from "lucide-react";
import { StepPipeline } from "./StepPipeline";
import { LogStream } from "./LogStream";
import { RunSelector } from "./RunSelector";
import { RetryButton } from "./RetryButton";
import { EmptyState } from "./EmptyState";
import { ScreenshotsPanel } from "./ScreenshotsPanel";
import { EditDataTab } from "./EditDataTab";
import { useLogs } from "./hooks/useLogs";
import { useRunEvents } from "./hooks/useRunEvents";
import { useElapsed, formatDuration } from "./hooks/useElapsed";
import { cn } from "@/lib/utils";
import type { TrackerEntry, RunInfo } from "./types";
import { formatTrackerValue, isMonospaceKey } from "./types";
import { useWorkflow } from "../workflows-context";
import { resolveEntryName } from "./entry-display";
import { statusBadgeClass } from "./status-styles";

interface LogPanelProps {
  entry: TrackerEntry | null;
  workflow: string;
  date: string;
}

// Special virtual keys the generic detail renderer recognizes. These come
// from the entry's timestamp metadata rather than tracker data, so the
// type-aware formatter can't handle them — we branch on the key.
const COMPUTED_KEYS = new Set(["__started", "__elapsed"]);

export function LogPanel({ entry, workflow, date }: LogPanelProps) {
  const [runs, setRuns] = useState<RunInfo[]>([]);
  const [activeRunId, setActiveRunId] = useState<string | null>(entry?.runId || null);
  const registered = useWorkflow(workflow);
  const steps = registered?.steps ?? [];
  const detailFields = registered?.detailFields ?? [];

  // Fetch runs when entry changes or a new run appears
  useEffect(() => {
    if (!entry) {
      setRuns([]);
      setActiveRunId(null);
      return;
    }
    // Set runId from entry immediately so useLogs doesn't fire with null first
    setActiveRunId((prev) => prev || entry.runId || null);

    const fetchRuns = () => {
      fetch(`/api/runs?workflow=${encodeURIComponent(workflow)}&id=${encodeURIComponent(entry.id)}&date=${encodeURIComponent(date)}`)
        .then((r) => r.json())
        .then((data: RunInfo[]) => {
          setRuns((prev) => {
            // Only update if runs actually changed
            if (JSON.stringify(prev) === JSON.stringify(data)) return prev;
            return data;
          });
          // Switch to latest run when a NEW run appears
          setActiveRunId((prev) => {
            if (!prev) return data.length > 0 ? data[data.length - 1].runId : entry.runId || null;
            // If a new run appeared that wasn't there before, switch to it
            const latestRunId = data.length > 0 ? data[data.length - 1].runId : null;
            if (latestRunId && latestRunId !== prev && !data.slice(0, -1).some((r) => r.runId === latestRunId)) {
              return latestRunId;
            }
            if (data.some((r) => r.runId === prev)) return prev;
            return data.length > 0 ? data[data.length - 1].runId : entry.runId || null;
          });
        })
        .catch(() => {});
    };

    fetchRuns();
    // Poll for new runs while entry is running/pending
    const isLive = entry.status === "running" || entry.status === "pending";
    const interval = isLive ? setInterval(fetchRuns, 2_000) : undefined;
    return () => { if (interval) clearInterval(interval); };
  }, [entry?.id, entry?.runId, entry?.status, workflow, date]);

  const { logs, loading: logsLoading } = useLogs(workflow, entry?.id || null, activeRunId, date);
  const { events } = useRunEvents(workflow, entry?.id || null, activeRunId, date);

  // Derive step/status from active run (not the globally deduped entry)
  const activeRun = runs.find((r) => r.runId === activeRunId);
  const runStatus = activeRun?.status || entry?.status || "pending";
  const runStep = activeRun?.step || null;

  // Prefer the per-run timestamps on the selected RunInfo; fall back to the
  // deduped entry's fields so the live (latest) run keeps working even
  // before /api/runs has returned. Using the run-scoped values means
  // "Started" + "Elapsed" actually switch when the operator picks an older
  // run in the RunSelector, instead of always mirroring the latest run.
  const firstTs =
    activeRun?.firstLogTs ||
    entry?.firstLogTs ||
    entry?.startTimestamp ||
    entry?.timestamp ||
    null;
  const lastTs =
    activeRun?.lastLogTs || entry?.lastLogTs || entry?.timestamp || null;
  const elapsed = useElapsed(runStatus === "running" ? firstTs : null);
  const duration = runStatus !== "running" && firstTs && lastTs && firstTs !== lastTs
    ? formatDuration(firstTs, lastTs)
    : null;

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

  const name = resolveEntryName(entry);
  const displayTs = firstTs || entry.timestamp;
  const startTime = displayTs
    ? new Date(displayTs).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", second: "2-digit" })
    : "";

  // Compose the full detail-field list: registered workflow fields whose
  // `displayInGrid` isn't explicitly false + the two synthesized
  // (Started/Elapsed) cells. Edit-only fields (e.g. separations'
  // separationDate) stay declared on the workflow but are hidden here —
  // they only render in the Edit Data tab.
  const allDetailFields: Array<{ key: string; label: string }> = [
    ...detailFields.filter((f) => f.displayInGrid !== false),
    { key: "__started", label: "Started" },
    { key: "__elapsed", label: "Elapsed" },
  ];

  const renderDetailValue = (key: string): string => {
    if (key === "__started") return startTime;
    if (key === "__elapsed") return elapsed || duration || "\u2014";
    return formatTrackerValue(entry, key);
  };

  const Skeleton = ({ className }: { className?: string }) => (
    <div className={cn("rounded bg-muted animate-pulse", className)} />
  );

  // Show skeleton while logs are loading and we have no data yet
  const showSkeleton = logsLoading && logs.length === 0;

  return (
    <div className="flex-1 flex flex-col bg-card min-w-0 min-h-0 overflow-hidden">
      {/* Header — height matches QueuePanel search + DuoPanel title */}
      <div className="h-[69.5px] flex items-center justify-between px-6 border-b border-border flex-shrink-0">
        <div className="flex items-center gap-3.5">
          {showSkeleton ? (
            <>
              <Skeleton className="h-6 w-40" />
              <Skeleton className="h-5 w-16 rounded-xl" />
            </>
          ) : (
            <>
              <span className="font-bold text-lg">{name || entry.id}</span>
              <span className={cn("text-[10px] font-semibold px-2.5 py-0.5 rounded-xl uppercase tracking-wide font-mono", statusBadgeClass(runStatus))}>
                {runStatus}
              </span>
              {name && <span className="font-mono text-[13px] text-muted-foreground">{entry.id}</span>}
            </>
          )}
        </div>
        <div className="flex items-center gap-1">
          <RunSelector runs={runs} activeRunId={activeRunId} onSelect={setActiveRunId} />
          {runStatus === "failed" && entry && (
            <RetryButton workflow={entry.workflow} id={entry.id} size="md" />
          )}
        </div>
      </div>

      {/* Detail grid — rendered from registry metadata via formatTrackerValue;
          auto-adapts to any workflow's detailFields declaration. Wraps to
          rows of 4. Special __started / __elapsed keys are synthesized from
          entry timestamps. */}
      <div className="grid grid-cols-4 flex-shrink-0">
        {allDetailFields.map((f) => {
          const value = renderDetailValue(f.key);
          const isComputed = COMPUTED_KEYS.has(f.key);
          // Monospace treatment for id-like fields + computed timestamps
          const mono = isComputed || isMonospaceKey(f.key);
          const isRunningElapsed = f.key === "__elapsed" && runStatus === "running";
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
                  isRunningElapsed && "text-primary",
                )} title={value}>
                  {value}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Step pipeline */}
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
          steps={steps}
          currentStep={runStep}
          status={runStatus}
          stepDurations={activeRun?.stepDurations ?? entry?.stepDurations}
          entry={entry ?? undefined}
        />
      )}

      <LogStream
        logs={logs}
        events={events}
        loading={logsLoading}
        screenshotsSlot={
          <ScreenshotsPanel
            workflow={workflow}
            itemId={entry?.id ?? null}
            runId={activeRunId}
            date={date}
          />
        }
        editDataAvailable={detailFields.some((f) => f.editable)}
        editDataSlot={
          <EditDataTab
            workflow={workflow}
            entry={entry ?? null}
            runId={activeRunId}
            date={date}
          />
        }
      />
    </div>
  );
}
