import { useEffect, useRef, useState } from "react";
import { Bell } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { useWorkflows, autoLabel } from "@/lib/workflows-context";
import { statusBadgeClass } from "@/components/shared/status-styles";
import type { FailureRow } from "@/components/shared/types";

export interface FailureBellProps {
  /** From useEntries — Record<workflow, count> for current navbar date. */
  failureCounts: Record<string, number>;
  /** Current navbar date (YYYY-MM-DD). */
  date: string;
  onSelect: (row: FailureRow) => void;
}

const FAILURE_BELL_STORAGE_KEY = "failure-bell-read-count";

export function FailureBell({ failureCounts, date, onSelect }: FailureBellProps) {
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<FailureRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [readCount, setReadCount] = useState<number>(() => {
    try {
      const stored = localStorage.getItem(FAILURE_BELL_STORAGE_KEY);
      return stored ? parseInt(stored, 10) : 0;
    } catch {
      return 0;
    }
  });
  const registered = useWorkflows();
  const labelFor = (wf: string): string =>
    registered.find((r) => r.name === wf)?.label ?? autoLabel(wf);

  const total = Object.values(failureCounts).reduce((s, n) => s + n, 0);
  const unreadCount = Math.max(0, total - readCount);
  const totalRef = useRef(total);
  totalRef.current = total;

  useEffect(() => {
    if (!open) return;
    const openedTotal = totalRef.current;
    // Mark as read when popover opens
    try {
      localStorage.setItem(FAILURE_BELL_STORAGE_KEY, String(openedTotal));
    } catch {
      // Ignore localStorage errors
    }
    setReadCount(openedTotal);

    let cancelled = false;
    setLoading(true);
    fetch(`/api/failures?date=${encodeURIComponent(date)}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((body: FailureRow[]) => {
        if (!cancelled) setRows(body);
      })
      .catch(() => {
        if (!cancelled) setRows([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, date]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <span className="sr-only" aria-live="polite" aria-atomic="true">
        {unreadCount > 0 ? `${unreadCount} unread failure${unreadCount === 1 ? "" : "s"}` : ""}
      </span>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={
            unreadCount === 0
              ? "Failure bell — no new failures"
              : `Failure bell — ${unreadCount} new failure${unreadCount === 1 ? "" : "s"}`
          }
          className={cn(
            "h-8 w-8 rounded-md border border-border bg-secondary",
            "flex items-center justify-center relative cursor-pointer",
            "text-muted-foreground hover:bg-accent hover:text-foreground",
            "outline-none focus-visible:ring-2 focus-visible:ring-primary",
            "transition-colors",
          )}
        >
          <Bell className="h-3.5 w-3.5" aria-hidden />
          {unreadCount > 0 && (
            <span
              aria-hidden
              className={cn(
                "absolute -top-1 -right-1 min-w-[18px] h-[18px] px-1",
                "bg-destructive text-destructive-foreground rounded-full",
                "font-mono text-[10px] font-bold leading-[18px] text-center",
                "ring-2 ring-card",
              )}
            >
              {unreadCount > 99 ? "99+" : unreadCount}
            </span>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="p-0 w-[460px]">
        {total === 0 ? (
          <div className="px-4 py-6 text-center">
            <div className="text-sm text-foreground font-medium">No failures</div>
            <div className="text-xs text-muted-foreground mt-1">
              Nothing failed on {date}.
            </div>
          </div>
        ) : (
          <div className="max-h-[460px] overflow-y-auto">
            {loading && rows.length === 0 ? (
              <div className="px-4 py-6 text-center text-xs text-muted-foreground">
                Loading…
              </div>
            ) : (
              rows.map((row) => (
                <button
                  key={`${row.workflow}::${row.id}::${row.runId}`}
                  type="button"
                  onClick={() => {
                    onSelect(row);
                    setOpen(false);
                  }}
                  className={cn(
                    "w-full text-left px-3.5 py-2.5 cursor-pointer transition-colors",
                    "border-b border-border last:border-b-0",
                    "hover:bg-accent focus-visible:bg-accent outline-none",
                  )}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[11px] uppercase tracking-wider text-muted-foreground font-semibold">
                      {labelFor(row.workflow)}
                    </span>
                    <span
                      className={cn(
                        "text-[10px] font-semibold px-2 py-0.5 rounded-xl uppercase tracking-wide font-mono",
                        statusBadgeClass("failed") || "bg-destructive text-destructive-foreground",
                      )}
                    >
                      failed
                    </span>
                  </div>
                  <div className="mt-1 text-sm font-semibold text-foreground truncate">
                    {row.summary}
                  </div>
                  <div className="mt-0.5 text-[12px] font-mono text-destructive truncate">
                    {row.error}
                  </div>
                  <div className="mt-0.5 flex items-center justify-between gap-2 text-[11px] font-mono text-muted-foreground">
                    <span className="truncate">{row.id}</span>
                    <span>{shortTime(row.ts)}</span>
                  </div>
                </button>
              ))
            )}
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}

function shortTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString("en-US", {
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return "";
  }
}
