import { useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { Bell, RotateCw, CheckCircle2, Info, AlertTriangle, XOctagon, type LucideIcon } from "lucide-react";
import { toast } from "@/lib/notify";
import {
  NOTIFY_KINDS,
  mergeNotificationLists,
  countUnread,
  useNotificationFeed,
  type AppNotification,
  type NotificationEntityRef,
  type NotificationSeverity,
} from "@/lib/notifications";
import {
  ALL_FILTER,
  buildNotificationFilters,
  filterNotifications,
} from "./notification-filters";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import { useWorkflows, autoLabel } from "@/lib/workflows-context";
import { useWorkflowActionDispatcher } from "@/components/hooks/useWorkflowActionDispatcher";
import type { FailureRow } from "@/components/shared/types";

export interface NotificationBellProps {
  /** From useEntries — Record<workflow, count> of failures for the navbar date. */
  failureCounts: Record<string, number>;
  /** Current navbar date (YYYY-MM-DD). */
  date: string;
  /** Deep-link to the row a notification is about. */
  onOpen: (ref: NotificationEntityRef) => void;
}

const LAST_SEEN_KEY = "notification-bell-last-seen";
const FAILURES_ACK_KEY = "notification-bell-failures-ack";

const shortId = (id: string): string => id.slice(0, 8);

/** Per-severity card icon + tone — token classes only (no palette/hex). */
const SEVERITY_CARD: Record<NotificationSeverity, { Icon: LucideIcon; icon: string; dot: string }> = {
  success: { Icon: CheckCircle2, icon: "text-success", dot: "bg-success/80" },
  info: { Icon: Info, icon: "text-info", dot: "bg-info/80" },
  warning: { Icon: AlertTriangle, icon: "text-warning", dot: "bg-warning/80" },
  error: { Icon: XOctagon, icon: "text-destructive", dot: "bg-destructive/80" },
  message: { Icon: Bell, icon: "text-muted-foreground", dot: "bg-muted-foreground/60" },
};

/** Map a backend `/api/failures` row onto the shared notification shape. */
function failureRowToNotification(row: FailureRow): AppNotification {
  const hasTitle = Boolean(row.title);
  return {
    id: `fail-${row.workflow}:${row.id}:${row.runId}`,
    kind: NOTIFY_KINDS.runFailed,
    severity: "error",
    title: hasTitle ? row.title : row.error,
    description: hasTitle ? row.error : undefined,
    source: row.workflow,
    entityRef: { workflow: row.workflow, id: row.id, runId: row.runId, date: row.date },
    traceId: row.traceId,
    dedupeKey: `${row.workflow}:${row.id}:${row.runId}:${NOTIFY_KINDS.runFailed}`,
    ts: Date.parse(row.ts) || 0,
    rerunnable: true,
  };
}

function readNumber(key: string): number {
  try {
    const raw = localStorage.getItem(key);
    return raw ? parseInt(raw, 10) || 0 : 0;
  } catch {
    return 0;
  }
}

function writeNumber(key: string, value: number): void {
  try {
    localStorage.setItem(key, String(value));
  } catch {
    /* ignore localStorage errors */
  }
}

/**
 * Hover-revealed Re-run for a single failed notification — re-enqueues via the
 * shared dispatcher (`POST /api/retry` with the persisted input), the same
 * transport the queue-row `RetryButton` uses. Disables + spins during the
 * roundtrip and reports through sonner. Stops propagation so it never triggers
 * the card's open-the-row click.
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

/**
 * Navbar notification center. Aggregates the live in-session notification feed
 * (everything routed through `notify()` — see `@/lib/notifications`) with an
 * on-open `/api/failures` backfill (cross-workflow + historical failures),
 * deduped by key. The unread badge tracks two streams without double-counting:
 * unseen failures (`failureCounts` − ack, the original failure-bell behaviour)
 * plus unseen non-failure notifications (a `lastSeenAt` timestamp watermark).
 */
export function NotificationBell({ failureCounts, date, onOpen }: NotificationBellProps) {
  const [open, setOpen] = useState(false);
  const [backfill, setBackfill] = useState<AppNotification[]>([]);
  const [loading, setLoading] = useState(false);
  // Distinguishes "confirmed no historical failures" from "the /api/failures
  // backfill fetch failed" — both would otherwise settle `backfill` to an
  // empty array and read identically as "You're all caught up" (fail-loud:
  // see root CLAUDE.md).
  const [backfillError, setBackfillError] = useState(false);
  const [lastSeenAt, setLastSeenAt] = useState<number>(() => readNumber(LAST_SEEN_KEY));
  const [failureAck, setFailureAck] = useState<number>(() => readNumber(FAILURES_ACK_KEY));
  const [filter, setFilter] = useState<string>(ALL_FILTER);

  const live = useNotificationFeed();
  const registered = useWorkflows();
  const labelFor = (wf: string): string => registered.find((r) => r.name === wf)?.label ?? autoLabel(wf);

  const failureTotal = Object.values(failureCounts).reduce((s, n) => s + n, 0);

  // Unread = unseen failures (count-tracked, cross-workflow) + unseen non-failure
  // notifications (timestamp-tracked). Failures are excluded from the timestamp
  // count so a live `run.failed` is not also counted by the failure tally.
  const unreadOther = useMemo(
    () => countUnread(live.filter((n) => n.kind !== NOTIFY_KINDS.runFailed), lastSeenAt),
    [live, lastSeenAt],
  );
  const unreadFailures = Math.max(0, failureTotal - failureAck);
  const unread = unreadOther + unreadFailures;

  const feed = useMemo(() => mergeNotificationLists(live, backfill), [live, backfill]);
  const total = feed.length;

  // Adaptive filter chips (All / Errors / per-category), built from the feed.
  const filterChips = useMemo(() => buildNotificationFilters(feed), [feed]);
  // Self-heal: if the active chip vanishes (its notifications cleared), reset to All.
  useEffect(() => {
    if (filter !== ALL_FILTER && !filterChips.some((c) => c.id === filter)) {
      setFilter(ALL_FILTER);
    }
  }, [filterChips, filter]);
  const visible = useMemo(() => filterNotifications(feed, filter), [feed, filter]);

  // Snapshot the read watermarks at open time (frozen, like the failure total).
  const failureTotalRef = useRef(failureTotal);
  failureTotalRef.current = failureTotal;

  useEffect(() => {
    if (!open) return;
    // Mark everything currently visible as read.
    const now = Date.now();
    setLastSeenAt(now);
    writeNumber(LAST_SEEN_KEY, now);
    setFailureAck(failureTotalRef.current);
    writeNumber(FAILURES_ACK_KEY, failureTotalRef.current);

    let cancelled = false;
    setLoading(true);
    fetch(`/api/failures?date=${encodeURIComponent(date)}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((body: FailureRow[]) => {
        if (cancelled) return;
        setBackfill(body.map(failureRowToNotification));
        setBackfillError(false);
      })
      .catch(() => {
        if (!cancelled) {
          setBackfill([]);
          setBackfillError(true);
        }
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
        {unread > 0 ? `${unread} unread notification${unread === 1 ? "" : "s"}` : ""}
      </span>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={
            unread === 0
              ? "Notifications — nothing new"
              : `Notifications — ${unread} new`
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
          {unread > 0 && (
            <span
              aria-hidden
              className={cn(
                "absolute -top-1 -right-1 min-w-[18px] h-[18px] px-1",
                "rounded-full ring-2 ring-card",
                "font-mono text-[10px] font-bold leading-[18px] text-center",
                unreadFailures > 0
                  ? "bg-destructive text-destructive-foreground"
                  : "bg-primary text-primary-foreground",
              )}
            >
              {unread > 99 ? "99+" : unread}
            </span>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="p-0 w-[420px]">
        {/* Header — title + count, then an adaptive filter-chip row. */}
        <div className="px-4 py-3 border-b border-border/70">
          <div className="flex items-center justify-between gap-2">
            <span className="text-[13px] font-semibold text-foreground tracking-tight">Notifications</span>
            <span className="flex items-center gap-1.5">
              {backfillError && (
                <AlertTriangle
                  aria-label="Couldn't load notification history — showing the live feed only"
                  className="h-3 w-3 text-warning"
                />
              )}
              {total > 0 && (
                <span className="text-[11px] text-muted-foreground">{total} recent</span>
              )}
            </span>
          </div>
          {filterChips.length > 1 && (
            <div
              className="mt-2.5 flex flex-wrap items-center gap-1.5"
              role="group"
              aria-label="Filter notifications"
            >
              {filterChips.map((chip) => {
                const active = chip.id === filter;
                return (
                  <button
                    key={chip.id}
                    type="button"
                    aria-pressed={active}
                    onClick={() => setFilter(chip.id)}
                    className={cn(
                      "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium cursor-pointer",
                      "outline-none focus-visible:ring-2 focus-visible:ring-ring transition-colors",
                      active
                        ? chip.tone === "error"
                          ? "border-destructive bg-destructive text-destructive-foreground"
                          : "border-primary bg-primary text-primary-foreground"
                        : chip.tone === "error"
                          ? "border-destructive/40 text-destructive hover:bg-destructive/10"
                          : "border-border text-muted-foreground hover:bg-muted hover:text-foreground",
                    )}
                  >
                    <span>{chip.label}</span>
                    <span
                      className={cn(
                        "font-mono tabular-nums text-[10px]",
                        active ? "opacity-90" : "opacity-70",
                      )}
                    >
                      {chip.count}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {total === 0 ? (
          <div className="px-4 py-6 text-center">
            <div
              className={cn(
                "text-[13px] font-medium",
                backfillError ? "text-warning" : "text-foreground",
              )}
            >
              {loading ? "Loading…" : backfillError ? "Couldn't load notification history" : "No notifications"}
            </div>
            <div className="text-[12px] text-muted-foreground mt-1">
              {loading
                ? "Fetching recent activity."
                : backfillError
                  ? "The live feed is current, but past failures may be missing — try reopening."
                  : "You're all caught up."}
            </div>
          </div>
        ) : (
          <ScrollArea className="max-h-[440px]">
            <ul className="p-2 space-y-1.5">
              {visible.map((n) => {
                const sev = SEVERITY_CARD[n.severity];
                const SevIcon = sev.Icon;
                const ref = n.entityRef;
                return (
                  <li
                    key={n.id}
                    className={cn(
                      "group rounded-lg border border-border/60 bg-card/40 shadow-sm transition-colors",
                      "hover:border-border hover:bg-accent/30",
                    )}
                  >
                    <div className="p-3">
                      <div className="flex items-center justify-between gap-2">
                        <span className="flex items-center gap-1.5 min-w-0">
                          <SevIcon className={cn("h-3 w-3 shrink-0", sev.icon)} aria-hidden />
                          {n.source && (
                            <span className="text-[10.5px] uppercase tracking-wider text-muted-foreground font-medium shrink-0">
                              {labelFor(n.source)}
                            </span>
                          )}
                        </span>
                        <span className="font-mono text-[10px] text-muted-foreground shrink-0">
                          {shortTime(n.ts)}
                        </span>
                      </div>
                      {/* Title is the focal line — and the open target when deep-linkable. */}
                      {ref ? (
                        <button
                          type="button"
                          onClick={() => {
                            onOpen(ref);
                            setOpen(false);
                          }}
                          className={cn(
                            "mt-1.5 block w-full text-left text-[13px] leading-relaxed text-foreground line-clamp-2",
                            "cursor-pointer outline-none focus-visible:underline",
                          )}
                        >
                          {n.title}
                        </button>
                      ) : (
                        <div className="mt-1.5 text-[13px] leading-relaxed text-foreground line-clamp-2">
                          {n.title}
                        </div>
                      )}
                      {n.description && (
                        <div className="mt-1 text-[12px] leading-relaxed text-muted-foreground line-clamp-2">
                          {n.description}
                        </div>
                      )}
                      <div className="mt-2 flex items-center justify-between gap-2">
                        <span className="font-mono text-[10px] text-muted-foreground/60" title={ref?.id}>
                          {n.traceId ?? (ref ? shortId(ref.id) : "")}
                        </span>
                        {n.rerunnable && ref && (
                          <div className="opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
                            <RerunButton
                              workflow={ref.workflow}
                              id={ref.id}
                              runId={ref.runId ?? ""}
                              date={ref.date ?? date}
                            />
                          </div>
                        )}
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          </ScrollArea>
        )}
      </PopoverContent>
    </Popover>
  );
}

function shortTime(ms: number): string {
  try {
    return new Date(ms).toLocaleTimeString("en-US", {
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return "";
  }
}
