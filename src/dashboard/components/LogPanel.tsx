import { useState, useEffect } from "react";
import { TerminalSquare } from "lucide-react";
import { StepPipeline } from "./StepPipeline";
import { LogStream } from "./LogStream";
import { RunSelector } from "./RunSelector";
import { EmptyState } from "./EmptyState";
import { useLogs } from "./hooks/useLogs";
import { useElapsed } from "./hooks/useElapsed";
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
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const cfg = getConfig(workflow);

  // Fetch runs when entry changes
  useEffect(() => {
    if (!entry) {
      setRuns([]);
      setActiveRunId(null);
      return;
    }
    fetch(`/api/runs?workflow=${encodeURIComponent(workflow)}&id=${encodeURIComponent(entry.id)}`)
      .then((r) => r.json())
      .then((data: RunInfo[]) => {
        setRuns(data);
        setActiveRunId(data.length > 0 ? data[data.length - 1].runId : entry.runId || null);
      })
      .catch(() => setRuns([]));
  }, [entry?.id, workflow]);

  const { logs, loading: logsLoading } = useLogs(workflow, entry?.id || null, activeRunId, date);
  const elapsed = useElapsed(entry?.status === "running" ? entry.timestamp : null);

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
  const startTime = entry.timestamp
    ? new Date(entry.timestamp).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", second: "2-digit" })
    : "";

  return (
    <div className="flex-1 flex flex-col bg-card min-w-0">
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-4 border-b border-border flex-shrink-0">
        <div className="flex items-center gap-3.5">
          <span className="font-bold text-lg">{name || entry.id}</span>
          <span className={cn("text-[10px] font-semibold px-2.5 py-0.5 rounded-xl uppercase tracking-wide font-mono", badgeStyles[entry.status])}>
            {entry.status}
          </span>
          {name && <span className="font-mono text-[13px] text-muted-foreground">{entry.id}</span>}
        </div>
        <RunSelector runs={runs} activeRunId={activeRunId} onSelect={setActiveRunId} />
      </div>

      {/* Detail grid */}
      <div className="grid grid-cols-4 border-b border-border flex-shrink-0">
        <div className="px-6 py-3.5 border-r border-border">
          <div className="text-[11px] uppercase tracking-wider text-muted-foreground font-medium mb-1">
            {cfg.detailFields[0]?.label || "ID"}
          </div>
          <div className="text-sm font-medium">{name || entry.id}</div>
        </div>
        <div className="px-6 py-3.5 border-r border-border">
          <div className="text-[11px] uppercase tracking-wider text-muted-foreground font-medium mb-1">
            {cfg.detailFields[1]?.label || "ID"}
          </div>
          <div className="text-sm font-mono">{entry.id}</div>
        </div>
        <div className="px-6 py-3.5 border-r border-border">
          <div className="text-[11px] uppercase tracking-wider text-muted-foreground font-medium mb-1">Started</div>
          <div className="text-sm font-mono">{startTime}</div>
        </div>
        <div className="px-6 py-3.5">
          <div className="text-[11px] uppercase tracking-wider text-muted-foreground font-medium mb-1">Elapsed</div>
          <div className={cn("text-sm font-mono", entry.status === "running" && "text-primary")}>
            {elapsed || "\u2014"}
          </div>
        </div>
      </div>

      {/* Step pipeline */}
      <StepPipeline
        steps={cfg.steps}
        currentStep={entry.step || null}
        status={entry.status}
      />

      {/* Log stream + filters + footer */}
      <LogStream logs={logs} loading={logsLoading} />
    </div>
  );
}
