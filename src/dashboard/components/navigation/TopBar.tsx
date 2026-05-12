import { ChevronLeft, ChevronRight } from "lucide-react";
import type { ReactNode } from "react";

import { cn, dateLocal } from "@/lib/utils";
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover";
import { Calendar } from "@/components/ui/calendar";
import { SearchBar } from "./SearchBar";
import { FailureBell } from "./FailureBell";
import type { SearchResultRow, FailureRow } from "@/components/shared/types";

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
  /** Fired when a failure-bell row is clicked. */
  onFailureSelect?: (row: FailureRow) => void;
  /** Per-workflow failure counts for the navbar bell badge. */
  failureCounts?: Record<string, number>;
}

/**
 * Three-region navbar:
 *
 *   [ Brand ]   [ Search spans queue + half log panel ]        [ Date nav ]
 *
 * The search box is positioned against the same horizontal grid as the main
 * dashboard: rail (200px), queue (responsive width), then the log panel. Its
 * width reaches the first detail-cell boundary in the log panel, matching the
 * right edge of the Employee detail cell.
 *
 * Connection state (the green/red Live pill) lives in the TerminalDrawer
 * bar at the bottom right — the dashboard reserves its right edge for
 * "ambient state" indicators (clock, live), and the navbar for navigation.
 *
 * Quick-run enqueue (`QuickRunPanel`) lives in the QueuePanel footer. PDF upload
 * (`TopBarRunButton`) and photo Capture (`TopBarCaptureButton`) mount in the queue
 * toolbar beside Retry when enabled for the active workflow.
 */
export function TopBar({
  date, onDateChange, availableDates,
  rightSlot,
  onSearchSelect,
  onFailureSelect,
  failureCounts,
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
        "relative z-20 flex items-center justify-between gap-4 px-6 py-2 bg-card flex-shrink-0 border-b border-border",
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
        <div
          className={cn(
            "absolute top-1/2 -translate-y-1/2 left-[200px]",
            "w-[calc(300px+((100vw-200px-300px)/4))]",
            "min-[1440px]:w-[calc(380px+((100vw-200px-380px)/4))]",
            "2xl:w-[calc(460px+((100vw-200px-460px)/4))]",
          )}
        >
          <SearchBar onSelect={onSearchSelect} />
        </div>
      ) : (
        <div />
      )}

      {/* ── Date navigator + rightSlot — right edge ────────────── */}
      <div className="flex items-center gap-1 justify-self-end">
        {onFailureSelect && failureCounts && (
          <FailureBell
            failureCounts={failureCounts}
            date={date}
            onSelect={onFailureSelect}
          />
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
