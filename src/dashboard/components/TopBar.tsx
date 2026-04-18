import { useMemo } from "react";
import { ChevronLeft, ChevronRight, ChevronDown } from "lucide-react";
import { useClock } from "./hooks/useClock";
import { cn } from "@/lib/utils";
import { useWorkflows, autoLabel } from "../workflows-context";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "./ui/dropdown-menu";
import { Popover, PopoverTrigger, PopoverContent } from "./ui/popover";
import { Calendar } from "./ui/calendar";
import { SearchBar } from "./SearchBar";
import type { SearchResultRow } from "./types";

/**
 * Preferred display order for the workflow dropdown. Workflows not in the list
 * are appended in registration order (stable because the registry is a Map).
 * Kept small and local because it's pure display preference.
 */
const PREFERRED_ORDER = [
  "onboarding",
  "separations",
  "kronos-reports",
  "eid-lookup",
  "work-study",
  "emergency-contact",
];

interface TopBarProps {
  workflow: string;
  workflows: string[];
  onWorkflowChange: (wf: string) => void;
  date: string;
  onDateChange: (date: string) => void;
  availableDates: string[];
  connected: boolean;
  entryCounts: Record<string, number>;
  /**
   * Optional slot rendered between the live indicator and the clock —
   * used by App.tsx to mount the runner launcher button. Kept as a slot
   * (rather than hard-coding the launcher) so the topbar stays focused on
   * navigation and the runner stays self-contained.
   */
  rightSlot?: React.ReactNode;
  /**
   * Fired when a historical search result is picked. Parent is responsible
   * for switching workflow/date/selectedId accordingly.
   */
  onSearchSelect?: (row: SearchResultRow) => void;
}

export function TopBar({
  workflow, workflows, onWorkflowChange,
  date, onDateChange, availableDates,
  connected, entryCounts,
  rightSlot,
  onSearchSelect,
}: TopBarProps) {
  const clock = useClock();
  const registered = useWorkflows();
  const labelFor = (wf: string): string =>
    registered.find((r) => r.name === wf)?.label ?? autoLabel(wf);

  // Union: registry workflows + any extras seen via SSE (files on disk the
  // backend registry doesn't know about). Preferred-order list wins, then
  // anything else falls in behind in discovery order.
  const allWfs = useMemo(() => {
    const union = new Set<string>();
    for (const name of PREFERRED_ORDER) union.add(name);
    for (const r of registered) union.add(r.name);
    for (const wf of workflows) union.add(wf);
    const ordered = PREFERRED_ORDER.filter((n) => union.has(n));
    for (const n of union) if (!ordered.includes(n)) ordered.push(n);
    return ordered;
  }, [registered, workflows]);

  const dateObj = new Date(date + "T00:00:00");

  const dateDisplay = (() => {
    try {
      return dateObj.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
    } catch {
      return date;
    }
  })();

  // Chevrons navigate by day (not limited to available dates)
  const navigateDay = (dir: -1 | 1) => {
    const d = new Date(dateObj);
    d.setDate(d.getDate() + dir);
    onDateChange(d.toISOString().slice(0, 10));
  };

  const handleCalendarSelect = (dateStr: string) => {
    onDateChange(dateStr);
  };

  return (
    <div className="flex items-center justify-between px-6 py-3.5 border-b border-border bg-card flex-shrink-0">
      <div className="flex items-center gap-5">
        <span className="text-base font-bold tracking-tight whitespace-nowrap">HR Dashboard</span>
        <div className="w-px h-6 bg-border" />

        {/* Workflow dropdown */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button className="flex items-center gap-2.5 px-3.5 py-2 rounded-lg border border-border bg-secondary cursor-pointer w-[220px] transition-colors hover:border-primary data-[state=open]:border-primary outline-none">
              <span className="flex-1 text-left font-semibold text-sm">{labelFor(workflow)}</span>
              <span className="text-xs text-muted-foreground font-mono font-medium">{entryCounts[workflow] || 0}</span>
              <ChevronDown className="w-3.5 h-3.5 text-muted-foreground transition-transform data-[state=open]:rotate-180" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-[220px]">
            {allWfs.map((wf) => (
              <DropdownMenuItem
                key={wf}
                onClick={() => onWorkflowChange(wf)}
                className={cn(wf === workflow && "bg-accent")}
              >
                <span className="flex items-center justify-between w-full">
                  <span className={cn("font-medium", wf === workflow && "font-semibold text-primary")}>
                    {labelFor(wf)}
                  </span>
                  <span className={cn("font-mono text-[11px]", (entryCounts[wf] || 0) > 0 ? "text-primary font-semibold" : "text-muted-foreground")}>
                    {entryCounts[wf] || 0}
                  </span>
                </span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>

        {onSearchSelect && (
          <>
            <div className="w-px h-6 bg-border" />
            <SearchBar onSelect={onSearchSelect} />
          </>
        )}
      </div>

      <div className="flex items-center gap-4">
        {/* Date nav */}
        <div className="flex items-center gap-1">
          <button
            onClick={() => navigateDay(-1)}
            className="w-8 h-8 rounded-md border border-border bg-secondary flex items-center justify-center text-muted-foreground cursor-pointer hover:bg-accent hover:text-foreground transition-colors"
          >
            <ChevronLeft className="w-4 h-4" />
          </button>

          <Popover>
            <PopoverTrigger asChild>
              <button className="px-4 py-1.5 rounded-md border border-border bg-secondary font-mono text-[13px] font-medium min-w-[130px] text-center cursor-pointer hover:bg-accent transition-colors outline-none data-[state=open]:border-primary">
                {dateDisplay}
              </button>
            </PopoverTrigger>
            <PopoverContent align="center" className="p-4">
              <Calendar
                selected={date}
                onSelect={handleCalendarSelect}
              />
            </PopoverContent>
          </Popover>

          <button
            onClick={() => navigateDay(1)}
            className="w-8 h-8 rounded-md border border-border bg-secondary flex items-center justify-center text-muted-foreground cursor-pointer hover:bg-accent hover:text-foreground transition-colors"
          >
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

        {rightSlot}

        <span className="font-mono text-[13px] text-muted-foreground font-medium">{clock}</span>
      </div>
    </div>
  );
}
