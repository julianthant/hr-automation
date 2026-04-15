import { useState, useEffect } from "react";
import { TerminalSquare } from "lucide-react";
import { StepPipeline } from "./StepPipeline";
import { LogStream } from "./LogStream";
import { RunSelector } from "./RunSelector";
import { EmptyState } from "./EmptyState";
import { useLogs } from "./hooks/useLogs";
import { useElapsed, formatDuration } from "./hooks/useElapsed";
import { cn } from "@/lib/utils";
import type { TrackerEntry, RunInfo } from "./types";
import { getConfig } from "./types";

interface LogPanelProps {
  entry: TrackerEntry | null;
  workflow: string;
  date: string;
}

const badgeStyles: Record<string, string> = {
  running: "bg-primary/15 text-primary",
  done: "bg-[#4ade80]/12 text-[#4ade80]",
  failed: "bg-destructive/12 text-destructive",
  pending: "bg-[#fbbf24]/12 text-[#fbbf24]",
  skipped: "bg-secondary text-muted-foreground",
};

export function LogPanel({ entry, workflow, date }: LogPanelProps) {
  const [runs, setRuns] = useState<RunInfo[]>([]);
  const [activeRunId, setActiveRunId] = useState<string | null>(entry?.runId || null);
  const cfg = getConfig(workflow);

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

  // Derive step/status from active run (not the globally deduped entry)
  const activeRun = runs.find((r) => r.runId === activeRunId);
  const runStatus = activeRun?.status || entry?.status || "pending";
  const runStep = activeRun?.step || null;

  // Same timestamp source as queue panel (backend enrichment) for consistency
  const firstTs = entry?.firstLogTs || entry?.startTimestamp || entry?.timestamp || null;
  const lastTs = entry?.lastLogTs || entry?.timestamp || null;
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

  const name = cfg.getName(entry);
  const displayTs = firstTs || entry.timestamp;
  const startTime = displayTs
    ? new Date(displayTs).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", second: "2-digit" })
    : "";

  const Skeleton = ({ className }: { className?: string }) => (
    <div className={cn("rounded bg-muted animate-pulse", className)} />
  );

  // Show skeleton while logs are loading and we have no data yet
  const showSkeleton = logsLoading && logs.length === 0;

  return (
    <div className="flex-1 flex flex-col bg-card min-w-0 min-h-0 overflow-hidden">
      {/* Header — height matches QueuePanel search + DuoPanel title */}
      <div className="h-[60px] flex items-center justify-between px-6 border-b border-border flex-shrink-0">
        <div className="flex items-center gap-3.5">
          {showSkeleton ? (
            <>
              <Skeleton className="h-6 w-40" />
              <Skeleton className="h-5 w-16 rounded-xl" />
            </>
          ) : (
            <>
              <span className="font-bold text-lg">{name || entry.id}</span>
              <span className={cn("text-[10px] font-semibold px-2.5 py-0.5 rounded-xl uppercase tracking-wide font-mono", badgeStyles[runStatus])}>
                {runStatus}
              </span>
              {name && <span className="font-mono text-[13px] text-muted-foreground">{entry.id}</span>}
            </>
          )}
        </div>
        <RunSelector runs={runs} activeRunId={activeRunId} onSelect={setActiveRunId} />
      </div>

      {/* Detail grid — renders cfg.detailFields dynamically; wraps to rows of 4 */}
      <div className="grid grid-cols-4 border-b border-border flex-shrink-0">
        {cfg.detailFields.map((f, i) => {
          const isLastInRow = (i + 1) % 4 === 0;
          const isLastField = i === cfg.detailFields.length - 1;
          const isNewRow = i >= 4 && i % 4 === 0;
          let value: string = "";
          let mono = true;
          if (f.key === "employee") { value = name || entry.id; mono = false; }
          else if (f.key === "started") { value = startTime; }
          else if (f.key === "elapsed") { value = elapsed || duration || "\u2014"; }
          else if (f.key === "email") { value = entry.data?.email || entry.id; }
          else { value = entry.data?.[f.key] || "\u2014"; }
          const isRunningElapsed = f.key === "elapsed" && runStatus === "running";
          const hasBottomBorder = i < cfg.detailFields.length - 4 ? "border-b border-border" : "";
          return (
            <div
              key={f.key}
              className={cn(
                "px-6 py-3.5",
                !isLastInRow && !isLastField && "border-r border-border",
                hasBottomBorder,
                isNewRow && "border-t border-border/40",
              )}
            >
              <div className="text-[11px] uppercase tracking-wider text-muted-foreground font-medium mb-1">
                {f.label}
              </div>
              {showSkeleton ? (
                <Skeleton className="h-4 w-20 mt-1" />
              ) : (
                <div className={cn(
                  "text-sm truncate",
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
          steps={cfg.steps}
          currentStep={runStep}
          status={runStatus}
        />
      )}

      <LogStream logs={logs} loading={logsLoading} />
    </div>
  );
}
