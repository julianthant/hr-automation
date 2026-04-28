import { ChevronLeft, ChevronRight, Monitor } from "lucide-react";
import type { ReactNode } from "react";
import { useClock } from "./hooks/useClock";
import { cn, dateLocal } from "@/lib/utils";
import { Popover, PopoverTrigger, PopoverContent } from "./ui/popover";
import { Calendar } from "./ui/calendar";
import { SearchBar } from "./SearchBar";
import type { SearchResultRow } from "./types";

interface TopBarProps {
  date: string;
  onDateChange: (date: string) => void;
  availableDates: string[];
  connected: boolean;
  /**
   * Optional content rendered inside the QUEUE zone (above QueuePanel).
   * Today: the QuickRunPanel input + run + retry-all cluster, mounted by
   * App.tsx. Renders nothing for workflows without a quick-run config, so
   * the zone falls back to blank.
   */
  queueZoneContent?: ReactNode;
  /**
   * Optional slot rendered at the far end of the SESSION zone, to the right
   * of the clock. Reserved for a future workflow launcher; the topbar stays
   * focused on navigation regardless of what mounts here.
   */
  rightSlot?: ReactNode;
  /**
   * Fired when a historical search result is picked. Parent is responsible
   * for switching workflow/date/selectedId accordingly.
   */
  onSearchSelect?: (row: SearchResultRow) => void;
}

/**
 * Four-zone navbar that mirrors the panel split below it. Column widths
 * match WorkflowRail (200) + QueuePanel + SessionPanel exactly, so the
 * vertical dividers in the navbar line up pixel-for-pixel with the panel
 * column boundaries.
 *
 *   BRAND zone   ↦ scopes WorkflowRail   (Triton HR brand)
 *   QUEUE zone   ↦ scopes QueuePanel     (QuickRunPanel when wired, else blank)
 *   STREAM zone  ↦ scopes LogPanel       (date nav · cross-workflow search)
 *   SESSION zone ↦ scopes SessionPanel   (live indicator · clock · rightSlot)
 */
export function TopBar({
  date, onDateChange, availableDates,
  connected,
  queueZoneContent,
  rightSlot,
  onSearchSelect,
}: TopBarProps) {
  const clock = useClock();
  void availableDates;

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
    onDateChange(dateLocal(d));
  };

  const handleCalendarSelect = (dateStr: string) => {
    onDateChange(dateStr);
  };

  return (
    <div
      className={cn(
        // Grid widths match WorkflowRail (200) + QueuePanel + SessionPanel
        // pixel-for-pixel so vertical dividers line up with panel boundaries.
        "grid border-b border-border bg-card flex-shrink-0",
        "grid-cols-[200px_300px_1fr_200px]",
        "min-[1440px]:grid-cols-[200px_380px_1fr_240px]",
        "2xl:grid-cols-[200px_460px_1fr_280px]",
      )}
    >
      {/* ── BRAND zone — scopes WorkflowRail. Hosts the live-connection
            pill at the far end so the green/red dot is the first thing the
            operator sees in the navbar's reading order. ── */}
      <div className="flex items-center justify-between gap-2 px-4 py-2 border-r border-border min-w-0">
        <span className="text-[16px] font-bold tracking-tight whitespace-nowrap leading-none">
          Triton HR
        </span>
        <div
          role="status"
          aria-live="polite"
          className={cn(
            "flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[11px] font-mono font-medium leading-none flex-shrink-0",
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
          Live
        </div>
      </div>

      {/* ── QUEUE zone — scopes QueuePanel. Hosts QuickRunPanel when the
            current workflow is wired in src/dashboard/lib/quick-run-registry.ts;
            otherwise blank. ──────────────────────────────────── */}
      <div className="flex items-center px-3 py-2 border-r border-border min-w-0">
        {queueZoneContent}
      </div>

      {/* ── STREAM zone — scopes LogPanel ───────────────────── */}
      <div className="flex items-center gap-3 px-6 py-2 border-r border-border min-w-0">
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
            className="h-8 w-8 rounded-md border border-border bg-secondary flex items-center justify-center text-muted-foreground cursor-pointer hover:bg-accent hover:text-foreground transition-colors outline-none focus-visible:ring-2 focus-visible:ring-primary"
          >
            <ChevronLeft className="w-3.5 h-3.5" />
          </button>

          <Popover>
            <PopoverTrigger asChild>
              <button
                aria-label={`Calendar — currently ${dateDisplay}`}
                className="h-8 px-3 rounded-md border border-border bg-secondary font-mono text-[12px] font-medium tabular-nums min-w-[126px] text-center cursor-pointer hover:bg-accent transition-colors outline-none focus-visible:ring-2 focus-visible:ring-primary data-[state=open]:border-primary"
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
            className="h-8 w-8 rounded-md border border-border bg-secondary flex items-center justify-center text-muted-foreground cursor-pointer hover:bg-accent hover:text-foreground transition-colors outline-none focus-visible:ring-2 focus-visible:ring-primary"
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
      <div className="flex items-center justify-between gap-2 px-4 py-2 min-w-0">
        <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-wider font-semibold text-muted-foreground min-w-0 leading-none">
          <Monitor aria-hidden className="w-3.5 h-3.5 flex-shrink-0" />
          <span className="truncate leading-none">Sessions</span>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          <span className="font-mono text-[12px] text-muted-foreground font-medium tabular-nums leading-none hidden min-[1440px]:inline">
            {clock}
          </span>

          {rightSlot}
        </div>
      </div>
    </div>
  );
}
