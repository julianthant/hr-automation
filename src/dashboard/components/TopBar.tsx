import { ChevronLeft, ChevronRight, Terminal as TerminalIcon } from "lucide-react";
import type { ReactNode } from "react";
import { useClock } from "./hooks/useClock";
import { useTerminalDrawer } from "./hooks/useTerminalDrawer";
import { cn, dateLocal } from "@/lib/utils";
import { Popover, PopoverTrigger, PopoverContent } from "./ui/popover";
import { Tooltip, TooltipTrigger, TooltipContent } from "./ui/tooltip";
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
   * Optional slot rendered at the far end of the stream zone, to the right
   * of the clock + terminal toggle. Reserved for a future workflow launcher;
   * the topbar stays focused on navigation regardless of what mounts here.
   */
  rightSlot?: ReactNode;
  /**
   * Fired when a historical search result is picked. Parent is responsible
   * for switching workflow/date/selectedId accordingly.
   */
  onSearchSelect?: (row: SearchResultRow) => void;
}

/**
 * Three-zone navbar that mirrors the panel split below it. Column widths
 * match WorkflowRail (200) + QueuePanel exactly, so the vertical dividers
 * line up pixel-for-pixel with the panel column boundaries.
 *
 *   BRAND zone   ↦ scopes WorkflowRail   (RRSS HR brand + live pill)
 *   QUEUE zone   ↦ scopes QueuePanel     (QuickRunPanel when wired, else blank)
 *   STREAM zone  ↦ scopes LogPanel       (search · date nav · clock · drawer toggle · rightSlot)
 *
 * The former SESSION zone is gone — its content lives in the bottom
 * `TerminalDrawer` now. The terminal-icon button at the end of the
 * STREAM zone toggles that drawer.
 */
export function TopBar({
  date, onDateChange, availableDates,
  connected,
  queueZoneContent,
  rightSlot,
  onSearchSelect,
}: TopBarProps) {
  const clock = useClock();
  const { open: drawerOpen, toggle: toggleDrawer } = useTerminalDrawer();
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
        // Grid widths match WorkflowRail (200) + QueuePanel pixel-for-pixel
        // so vertical dividers line up with panel boundaries below. The
        // STREAM zone (1fr) covers the rest, scoping LogPanel.
        "grid border-b border-border bg-card flex-shrink-0",
        "grid-cols-[200px_300px_1fr]",
        "min-[1440px]:grid-cols-[200px_380px_1fr]",
        "2xl:grid-cols-[200px_460px_1fr]",
      )}
    >
      {/* ── BRAND zone — scopes WorkflowRail. Hosts the live-connection
            pill at the far end so the green/red dot is the first thing the
            operator sees in the navbar's reading order. ── */}
      <div className="flex items-center justify-between gap-2 px-4 py-2 border-r border-border min-w-0">
        <span className="text-[16px] font-bold tracking-tight whitespace-nowrap leading-none">
          RRSS HR
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

      {/* ── STREAM zone — scopes LogPanel. Hosts search + date nav and,
            at the right edge, the clock + drawer toggle button (terminal
            icon) that opens/closes the bottom session drawer. ── */}
      <div className="flex items-center gap-3 px-6 py-2 min-w-0">
        {/* Search — fills the available width up to the date cluster. */}
        {onSearchSelect && (
          <div className="flex-1 min-w-0">
            <SearchBar onSelect={onSearchSelect} />
          </div>
        )}

        {/* Date navigator. */}
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

        <span className="font-mono text-[12px] text-muted-foreground font-medium tabular-nums leading-none hidden min-[1440px]:inline flex-shrink-0">
          {clock}
        </span>

        {/* Terminal-icon button — toggles the bottom session drawer. Active
            state mirrors `useTerminalDrawer().open` so the button reads
            "pressed" while the drawer is up. Keyboard shortcut (⌃J / ⌘J)
            is registered globally inside the drawer hook. */}
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={toggleDrawer}
              aria-expanded={drawerOpen}
              aria-controls="terminal-drawer"
              aria-label="Toggle session drawer"
              className={cn(
                "h-8 w-8 rounded-md border bg-secondary flex items-center justify-center cursor-pointer transition-colors flex-shrink-0",
                "outline-none focus-visible:ring-2 focus-visible:ring-primary",
                drawerOpen
                  ? "bg-accent text-accent-foreground border-accent-foreground/40"
                  : "border-border text-muted-foreground hover:bg-accent hover:text-foreground",
              )}
            >
              <TerminalIcon className="w-4 h-4" strokeWidth={2} />
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom" sideOffset={6}>
            Toggle session drawer (⌃J)
          </TooltipContent>
        </Tooltip>

        {rightSlot}
      </div>
    </div>
  );
}
