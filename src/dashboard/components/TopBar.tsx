import { ChevronLeft, ChevronRight } from "lucide-react";
import type { ReactNode } from "react";

import { cn, dateLocal } from "@/lib/utils";
import { Popover, PopoverTrigger, PopoverContent } from "./ui/popover";
import { Calendar } from "./ui/calendar";
import { SearchBar } from "./SearchBar";
import { ApprovalInbox } from "./ApprovalInbox";
import type { SearchResultRow, PreviewInboxRow } from "./types";

interface TopBarProps {
  date: string;
  onDateChange: (date: string) => void;
  availableDates: string[];
  /**
   * Optional slot rendered at the far right of the navbar, after the date
   * navigator. Reserved for future top-level affordances; the topbar's
   * primary purpose is brand + cross-workflow search + date navigation.
   */
  rightSlot?: ReactNode;
  /**
   * Fired when a historical search result is picked. Parent is responsible
   * for switching workflow/date/selectedId accordingly.
   */
  onSearchSelect?: (row: SearchResultRow) => void;
  /** Fired when an approval-inbox row is clicked. */
  onPreviewSelect?: (row: PreviewInboxRow) => void;
}

/**
 * Three-region centered navbar:
 *
 *   [ Brand ]                [ centered Search ]               [ Date nav ]
 *
 * Implemented as a 3-column grid with `1fr · auto · 1fr` so the search
 * bar is *truly* centered on the page regardless of the brand or date
 * cluster widths. Each side cluster is justified to the screen edge so
 * the navbar reads as a clean, symmetric container.
 *
 * Connection state (the green/red Live pill) lives in the TerminalDrawer
 * bar at the bottom right — the dashboard reserves its right edge for
 * "ambient state" indicators (clock, live), and the navbar for navigation.
 *
 * The previous BRAND·QUEUE·STREAM grid (with run controls in the queue
 * zone) was retired so the operator's run cluster sits closer to the
 * queue it acts on, in QueuePanel's footer.
 */
export function TopBar({
  date, onDateChange, availableDates,
  rightSlot,
  onSearchSelect,
  onPreviewSelect,
}: TopBarProps) {
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
        "grid items-center gap-4 px-6 py-2 bg-card flex-shrink-0 border-b border-border",
        // Outer 1fr columns let the centered search stay centered while
        // the brand/date clusters anchor to the screen edges.
        "grid-cols-[1fr_auto_1fr]",
      )}
    >
      {/* ── Brand — left edge ──────────────────────────────────── */}
      <div className="flex items-center justify-self-start min-w-0">
        <span className="text-[16px] font-bold tracking-tight whitespace-nowrap leading-none">
          RRSS HR
        </span>
      </div>

      {/* ── Search — centered ──────────────────────────────────── */}
      {onSearchSelect ? (
        <div className="w-[480px] max-w-full">
          <SearchBar onSelect={onSearchSelect} />
        </div>
      ) : (
        <div />
      )}

      {/* ── Date navigator + rightSlot — right edge ────────────── */}
      <div className="flex items-center gap-1 justify-self-end">
        {onPreviewSelect && (
          <>
            <ApprovalInbox onSelect={onPreviewSelect} />
            <span aria-hidden className="w-2.5 inline-block" />
          </>
        )}
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

        {rightSlot}
      </div>
    </div>
  );
}
