import { useMemo } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useClock } from "./hooks/useClock";
import { cn } from "@/lib/utils";
import { TAB_ORDER, getConfig } from "./types";

interface TopBarProps {
  workflow: string;
  workflows: string[];
  onWorkflowChange: (wf: string) => void;
  date: string;
  onDateChange: (date: string) => void;
  availableDates: string[];
  connected: boolean;
  entryCounts: Record<string, number>;
}

export function TopBar({
  workflow, workflows, onWorkflowChange,
  date, onDateChange, availableDates,
  connected, entryCounts,
}: TopBarProps) {
  const clock = useClock();

  const allWfs = useMemo(() => {
    const ordered = TAB_ORDER.filter((wf) => wf === workflow || workflows.includes(wf));
    workflows.forEach((wf) => {
      if (!ordered.includes(wf)) ordered.push(wf);
    });
    if (!ordered.includes(workflow)) ordered.unshift(workflow);
    return ordered;
  }, [workflow, workflows]);

  const dateDisplay = (() => {
    try {
      const d = new Date(date + "T00:00:00");
      return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
    } catch {
      return date;
    }
  })();

  const navigate = (dir: -1 | 1) => {
    const idx = availableDates.indexOf(date);
    const next = availableDates[idx - dir]; // dates are desc, so -dir
    if (next) onDateChange(next);
  };

  return (
    <div className="flex items-center justify-between px-6 py-3.5 border-b border-border bg-card flex-shrink-0">
      <div className="flex items-center gap-5">
        <span className="text-base font-bold tracking-tight whitespace-nowrap">HR Dashboard</span>
        <div className="w-px h-6 bg-border" />

        {/* Workflow dropdown */}
        <div className="relative group">
          <button className="flex items-center gap-2.5 px-3.5 py-2 rounded-lg border border-border bg-secondary cursor-pointer w-[220px] transition-colors hover:border-primary">
            <span className="flex-1 text-left font-semibold text-sm">{getConfig(workflow).label}</span>
            <span className="text-xs text-muted-foreground font-mono font-medium">{entryCounts[workflow] || 0}</span>
            <span className="text-muted-foreground text-[10px]">&#9662;</span>
          </button>
          <div className="absolute top-[calc(100%+6px)] left-0 w-[220px] bg-card border border-border rounded-xl shadow-xl z-50 p-1 hidden group-focus-within:block">
            {allWfs.map((wf) => (
              <button
                key={wf}
                onClick={() => onWorkflowChange(wf)}
                className={cn(
                  "flex items-center justify-between w-full px-3 py-2.5 rounded-md text-[13px] cursor-pointer transition-colors",
                  "hover:bg-accent",
                  wf === workflow && "bg-accent",
                )}
              >
                <span className={cn("font-medium", wf === workflow && "font-semibold text-primary")}>{getConfig(wf).label}</span>
                <span className={cn("font-mono text-[11px]", (entryCounts[wf] || 0) > 0 ? "text-primary font-semibold" : "text-muted-foreground")}>
                  {entryCounts[wf] || 0}
                </span>
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="flex items-center gap-4">
        {/* Date nav */}
        <div className="flex items-center gap-1">
          <button onClick={() => navigate(-1)} className="w-8 h-8 rounded-md border border-border bg-secondary flex items-center justify-center text-muted-foreground cursor-pointer hover:bg-accent hover:text-foreground transition-colors">
            <ChevronLeft className="w-4 h-4" />
          </button>
          <div className="px-4 py-1.5 rounded-md border border-border bg-secondary font-mono text-[13px] font-medium min-w-[120px] text-center cursor-pointer hover:bg-accent transition-colors">
            {dateDisplay}
          </div>
          <button onClick={() => navigate(1)} className="w-8 h-8 rounded-md border border-border bg-secondary flex items-center justify-center text-muted-foreground cursor-pointer hover:bg-accent hover:text-foreground transition-colors">
            <ChevronRight className="w-4 h-4" />
          </button>
        </div>

        <div className="w-px h-6 bg-border" />

        {/* Live indicator */}
        <div className={cn(
          "flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-mono font-medium",
          connected
            ? "bg-[#4ade80]/8 border border-[#4ade80]/20 text-[#4ade80]"
            : "bg-destructive/8 border border-destructive/20 text-destructive",
        )}>
          <div className={cn("w-[7px] h-[7px] rounded-full", connected ? "bg-[#4ade80] animate-pulse" : "bg-destructive")} />
          {connected ? "Live" : "Disconnected"}
        </div>

        <span className="font-mono text-[13px] text-muted-foreground font-medium">{clock}</span>
      </div>
    </div>
  );
}
