import { useEffect, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { Bell, RotateCw } from "lucide-react";
import { toast } from "sonner";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { useWorkflows, autoLabel } from "@/lib/workflows-context";
import { useWorkflowActionDispatcher } from "@/components/hooks/useWorkflowActionDispatcher";
import type { FailureRow } from "@/components/shared/types";

export interface FailureBellProps {
  /** From useEntries — Record<workflow, count> for current navbar date. */
  failureCounts: Record<string, number>;
  /** Current navbar date (YYYY-MM-DD). */
  date: string;
  onSelect: (row: FailureRow) => void;
  /**
   * Optional control rendered at the right edge of the popover header,
   * opposite the "Failures" title (e.g. the desktop-notification settings
   * gear). Nested popovers stack correctly under Radix's dismiss layers.
   */
  headerSlot?: ReactNode;
}

const FAILURE_BELL_STORAGE_KEY = "failure-bell-read-count";

const shortId = (id: string): string => id.slice(0, 8);

/**
 * Hover-revealed Re-run for a single failed row — re-enqueues via the shared
 * dispatcher (`POST /api/retry` with the persisted input), the same transport
 * the queue-row `RetryButton` uses. Disables + spins during the roundtrip and
 * reports through sonner. Stops propagation so it never triggers the card's
 * open-the-row click.
 */
function RerunButton({
  workflow,
  id,
  runId,
  date,
}: {
  workflow: string;
  id: string;
  runId: string;
  date: string;
}) {
  const [pending, setPending] = useState(false);
  const { dispatchWorkflowAction } = useWorkflowActionDispatcher();

  const onClick = async (e: MouseEvent) => {
    e.stopPropagation();
    if (pending) return;
    setPending(true);
    const t = toast.loading(`Retrying ${id}…`);
    try {
      const result = await dispatchWorkflowAction<{ ok?: boolean; error?: string }>({
        transport: "retry",
        kind: "retry",
        fallbackTarget: { workflowId: workflow, id, runId, date },
      });
      if (result.ok) {
        toast.success("Retry scheduled", { id: t, description: id });
      } else {
        toast.error("Couldn't retry", { id: t, description: result.error ?? `HTTP ${result.status}` });
      }
    } catch (err) {
      toast.error("Couldn't retry", {
        id: t,
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setPending(false);
    }
  };

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={pending}
      aria-label={`Re-run failed run ${id}`}
      className={cn(
        "inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium cursor-pointer",
        "text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors",
        "outline-none focus-visible:ring-2 focus-visible:ring-ring",
        "disabled:opacity-50 disabled:cursor-default",
      )}
    >
      <RotateCw className={cn("h-3 w-3", pending && "motion-safe:animate-spin")} aria-hidden />
      Re-run
    </button>
  );
}

export function FailureBell({ failureCounts, date, onSelect, headerSlot }: FailureBellProps) {
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
      <PopoverContent align="end" className="p-0 w-[420px]">
        {/* Header */}
        <div className="px-4 py-3 border-b border-border/70 flex items-center justify-between gap-2">
          <span className="text-[13px] font-semibold text-foreground tracking-tight">Failures</span>
          <div className="flex items-center gap-2">
            {total > 0 && <span className="text-[11px] text-muted-foreground">{total} unresolved</span>}
            {headerSlot}
          </div>
        </div>

        {total === 0 ? (
          <div className="px-4 py-6 text-center">
            <div className="text-[13px] text-foreground font-medium">No failures</div>
            <div className="text-[12px] text-muted-foreground mt-1">Nothing failed on {date}.</div>
          </div>
        ) : loading && rows.length === 0 ? (
          <div className="px-4 py-6 text-center text-[12px] text-muted-foreground">Loading…</div>
        ) : (
          <ul className="max-h-[440px] overflow-y-auto p-2 space-y-1.5">
            {rows.map((row) => (
              <li
                key={`${row.workflow}::${row.id}::${row.runId}`}
                className={cn(
                  "group rounded-lg border border-border/60 bg-card/40 shadow-sm transition-colors",
                  "hover:border-border hover:bg-accent/30",
                )}
              >
                <div className="p-3">
                  <div className="flex items-center justify-between gap-2">
                    <span className="flex items-baseline gap-1.5 min-w-0">
                      <span className="w-1.5 h-1.5 rounded-full bg-destructive/80 shrink-0 self-center" aria-hidden />
                      <span className="text-[10.5px] uppercase tracking-wider text-muted-foreground font-medium shrink-0">
                        {labelFor(row.workflow)}
                      </span>
                      {row.title && (
                        <>
                          <span className="text-muted-foreground/40 shrink-0" aria-hidden>
                            ·
                          </span>
                          <span className="text-[11px] text-muted-foreground/80 truncate">{row.title}</span>
                        </>
                      )}
                    </span>
                    <span className="font-mono text-[10px] text-muted-foreground shrink-0">
                      {shortTime(row.ts)}
                    </span>
                  </div>
                  {/* The error is the focal line — full text (2-line clamp), the click target. */}
                  <button
                    type="button"
                    onClick={() => {
                      onSelect(row);
                      setOpen(false);
                    }}
                    className={cn(
                      "mt-1.5 block w-full text-left text-[13px] leading-relaxed text-foreground line-clamp-2",
                      "cursor-pointer outline-none focus-visible:underline",
                    )}
                  >
                    {row.error}
                  </button>
                  <div className="mt-2 flex items-center justify-between gap-2">
                    <span className="font-mono text-[10px] text-muted-foreground/60" title={row.id}>
                      {row.traceId ?? shortId(row.id)}
                    </span>
                    <div className="opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
                      <RerunButton workflow={row.workflow} id={row.id} runId={row.runId} date={date} />
                    </div>
                  </div>
                </div>
              </li>
            ))}
          </ul>
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
