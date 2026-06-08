import { ChevronLeft, ChevronRight, History } from "lucide-react";
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
   * Optional slot rendered at the far right of the right cluster, after the
   * date navigator — the home for utility affordances (keyboard help,
   * notification settings). The topbar's primary purpose is brand +
   * cross-workflow search + date navigation.
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
  /** Control rendered in the failures popover header (e.g. notification settings gear). */
  failureBellHeaderSlot?: ReactNode;
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
 * Input-run enqueue (`InputRunPanel`) lives in the QueuePanel footer. PDF upload
 * (`TopBarRunButton`) and photo Capture (`TopBarCaptureButton`) mount in the queue
 * toolbar beside Retry when enabled for the active workflow.
 */
export function TopBar({
  date, onDateChange, availableDates,
  rightSlot,
  onSearchSelect,
  onFailureSelect,
  failureCounts,
  failureBellHeaderSlot,
}: TopBarProps) {
  void availableDates;

  const today = dateLocal();
  const isToday = date === today;
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
        "relative z-20 flex items-center justify-between gap-4 px-6 py-2 bg-card shrink-0 border-b border-border",
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

      {/* ── Failures + date navigator + utility slot — right edge ─ */}
      <div className="flex items-center gap-1 justify-self-end">
        {onFailureSelect && failureCounts && (
          <FailureBell
            failureCounts={failureCounts}
            date={date}
            onSelect={onFailureSelect}
            headerSlot={failureBellHeaderSlot}
          />
        )}
        {/* Viewing-history cue — only when off today. The Live pill in the
            drawer is downgraded in parallel so "not live" is unmistakable. */}
        {!isToday && (
          <span
            className="inline-flex h-8 items-center gap-1.5 rounded-md border border-warning/30 bg-warning/10 px-2.5 text-[11px] font-medium text-warning"
            role="status"
          >
            <History aria-hidden className="h-3.5 w-3.5" />
            History
          </span>
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

        {!isToday && (
          <button
            onClick={() => onDateChange(today)}
            aria-label="Jump to today"
            title="Jump to today"
            className="h-8 rounded-md border border-info/40 bg-info/10 px-3 text-[12px] font-semibold text-info cursor-pointer hover:bg-info/20 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-info"
          >
            Today
          </button>
        )}

        {rightSlot}
      </div>
    </div>
  );
}
