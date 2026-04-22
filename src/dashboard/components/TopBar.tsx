import { useMemo } from "react";
import { ChevronLeft, ChevronRight, ChevronDown, Monitor } from "lucide-react";
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
  "sharepoint-download",
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
   * Optional slot rendered at the far end of the SESSION zone, to the right
   * of the clock. Reserved for a future workflow launcher; the topbar stays
   * focused on navigation regardless of what mounts here.
   */
  rightSlot?: React.ReactNode;
  /**
   * Fired when a historical search result is picked. Parent is responsible
   * for switching workflow/date/selectedId accordingly.
   */
  onSearchSelect?: (row: SearchResultRow) => void;
}

/**
 * Three-zone navbar that mirrors the panel split below it. Column widths
 * match QueuePanel (left) and SessionPanel (right) exactly, so the vertical
 * dividers in the navbar line up pixel-for-pixel with the panel column
 * boundaries — making it visually obvious which control scopes which panel.
 *
 *   QUEUE zone   ↦ scopes QueuePanel    (brand · workflow chooser)
 *   STREAM zone  ↦ scopes LogPanel       (date nav · cross-workflow search)
 *   SESSION zone ↦ scopes SessionPanel   (live indicator · clock · rightSlot)
 */
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
    <div
      className={cn(
        // Grid widths match QueuePanel + SessionPanel below pixel-for-pixel
        // so vertical dividers line up with panel column boundaries.
        "grid border-b border-border bg-card flex-shrink-0",
        "grid-cols-[320px_1fr_240px]",
        "min-[1440px]:grid-cols-[400px_1fr_280px]",
        "2xl:grid-cols-[480px_1fr_320px]",
      )}
    >
      {/* ── QUEUE zone — scopes QueuePanel ──────────────────── */}
      <div className="flex items-center gap-3 px-4 py-3 border-r border-border min-w-0">
        <span className="text-[13px] font-bold tracking-tight whitespace-nowrap">
          HR Dashboard
        </span>
        <div className="w-px h-5 bg-border flex-shrink-0" />

        {/* Workflow dropdown — primary scope control for the queue */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              aria-label={`Workflow: ${labelFor(workflow)}`}
              className="flex items-center gap-2 px-3 py-1.5 rounded-md border border-border bg-secondary cursor-pointer flex-1 min-w-0 transition-colors hover:border-primary data-[state=open]:border-primary outline-none focus-visible:ring-2 focus-visible:ring-primary"
            >
              <span className="flex-1 text-left font-semibold text-[13px] truncate">
                {labelFor(workflow)}
              </span>
              <span className="text-[11px] text-muted-foreground font-mono font-medium tabular-nums flex-shrink-0">
                {entryCounts[workflow] || 0}
              </span>
              <ChevronDown className="w-3.5 h-3.5 text-muted-foreground transition-transform data-[state=open]:rotate-180 flex-shrink-0" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-[240px]">
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
                  <span className={cn("font-mono text-[11px] tabular-nums", (entryCounts[wf] || 0) > 0 ? "text-primary font-semibold" : "text-muted-foreground")}>
                    {entryCounts[wf] || 0}
                  </span>
                </span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* ── STREAM zone — scopes LogPanel ───────────────────── */}
      <div className="flex items-center gap-3 px-6 py-3 border-r border-border min-w-0">
        {/* Search — fills the full width of the stream zone up to the
             date navigator. Picking a result swaps the LogPanel below. */}
        {onSearchSelect && (
          <div className="flex-1 min-w-0">
            <SearchBar onSelect={onSearchSelect} />
          </div>
        )}

        {/* Date navigator — right-aligned inside the stream zone. Picks
             which day's entries the stream shows. */}
        <div className="flex items-center gap-1 flex-shrink-0">
          <button
            onClick={() => navigateDay(-1)}
            aria-label="Previous day"
            className="w-7 h-7 rounded-md border border-border bg-secondary flex items-center justify-center text-muted-foreground cursor-pointer hover:bg-accent hover:text-foreground transition-colors outline-none focus-visible:ring-2 focus-visible:ring-primary"
          >
            <ChevronLeft className="w-3.5 h-3.5" />
          </button>

          <Popover>
            <PopoverTrigger asChild>
              <button
                aria-label={`Calendar — currently ${dateDisplay}`}
                className="px-3 py-1 rounded-md border border-border bg-secondary font-mono text-[12px] font-medium tabular-nums min-w-[126px] text-center cursor-pointer hover:bg-accent transition-colors outline-none focus-visible:ring-2 focus-visible:ring-primary data-[state=open]:border-primary"
              >
                {dateDisplay}
              </button>
            </PopoverTrigger>
            <PopoverContent align="center" className="p-4">
              <Calendar selected={date} onSelect={handleCalendarSelect} />
            </PopoverContent>
          </Popover>

          <button
            onClick={() => navigateDay(1)}
            aria-label="Next day"
            className="w-7 h-7 rounded-md border border-border bg-secondary flex items-center justify-center text-muted-foreground cursor-pointer hover:bg-accent hover:text-foreground transition-colors outline-none focus-visible:ring-2 focus-visible:ring-primary"
          >
            <ChevronRight className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* ── SESSION zone — scopes SessionPanel. Hosts the SESSIONS label
            (formerly inside SessionPanel's own 60px header) so the panel
            below can start directly with content + sit flush with the
            QueuePanel + LogPanel content rows. Every child uses
            `leading-none` so flex `items-center` aligns geometric centers
            without line-height padding throwing baselines off. ── */}
      <div className="flex items-center justify-between gap-2 px-4 py-3 min-w-0">
        <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-wider font-semibold text-muted-foreground min-w-0 leading-none">
          <Monitor aria-hidden className="w-3.5 h-3.5 flex-shrink-0" />
          <span className="truncate leading-none">Sessions</span>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          <div
            role="status"
            aria-live="polite"
            className={cn(
              "flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[11px] font-mono font-medium leading-none",
              connected
                ? "bg-[#4ade80]/8 border border-[#4ade80]/20 text-[#4ade80]"
                : "bg-destructive/8 border border-destructive/20 text-destructive",
            )}
          >
            <div
              aria-hidden
              className={cn(
                "w-[6px] h-[6px] rounded-full",
                connected ? "bg-[#4ade80] animate-pulse" : "bg-destructive",
              )}
            />
            {connected ? "Live" : "Disconnected"}
          </div>

          <span className="font-mono text-[12px] text-muted-foreground font-medium tabular-nums leading-none hidden min-[1440px]:inline">
            {clock}
          </span>

          {rightSlot}
        </div>
      </div>
    </div>
  );
}
