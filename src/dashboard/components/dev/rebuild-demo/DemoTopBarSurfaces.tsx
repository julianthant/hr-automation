import { useEffect, useMemo, useRef, useState } from "react";
import {
  Bell,
  BellOff,
  Calendar,
  ChevronLeft,
  ChevronRight,
  Clock,
  Inbox,
  Mail,
  MailOpen,
  Search,
  SearchX,
  ShieldAlert,
  Siren,
  TriangleAlert,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  Badge,
  Banner,
  Button,
  Chip,
  CountBadge,
  Dialog,
  DialogBody,
  DialogContent,
  Drawer,
  DrawerContent,
  EmptyState,
  IconButton,
  Kbd,
  SearchInput,
  StatusPill,
  TBody,
  TD,
  TH,
  THead,
  TR,
  Table,
  dsFocus,
  dsText,
  useToasts,
} from "./demo-ui";
import { DEMO_DAY, fmtClock } from "./demo-wire";
import { ALL_DEMO_ROWS, DEMO_DAYS, dayCounts, dayIndex, dayLabelWithToday } from "./demo-days";
import {
  DEMO_NOTIFICATIONS,
  NOTIFICATION_FILTERS,
  NOTIFICATION_TRIGGER_LABEL,
  SEARCH_EXAMPLES,
  deliveryOf,
  isSnoozed,
  notificationAge,
  searchDemoRows,
  snoozeRemaining,
  snoozeUntil,
  type DemoNotification,
  type DemoSearchOutcome,
  type NotificationFilterKey,
} from "./demo-flows-wire";

/**
 * DEV-ONLY — the three Top Bar surfaces that were dead: SEARCH, the DATE
 * navigator, and the notification BELL.
 *
 * Each was a control with no behaviour behind it, which is worse than absent:
 * the date pill said one day while the queue held another, and the bell showed
 * a badge that opened nothing. What they have in common is that all three
 * change WHICH ROWS the operator is looking at, so all three are built here
 * against the same corpus functions the queue uses.
 */

export interface DemoNavigateTo {
  (workflow: string, runId: string, day: string): void;
}

// ===========================================================================
// Date navigation
// ===========================================================================

/**
 * ‹ Fri, Jul 25 · today ›. The date is not decoration: it selects the day
 * partition the whole app reads. The rail badges, the Status Bar pills and the
 * rows all recompute from `topLevelRowsForDay(day)`, so they move together —
 * there is no second corpus for any of them to disagree about.
 */
export function DemoDateNav({ day, onDay }: { day: string; onDay: (day: string) => void }) {
  const idx = dayIndex(day);
  const counts = useMemo(() => dayCounts(), []);
  const older = DEMO_DAYS[idx - 1];
  const newer = DEMO_DAYS[idx + 1];
  return (
    <span className="flex shrink-0 items-center gap-0.5">
      <IconButton
        label={older ? `Previous day — ${dayLabelWithToday(older)}` : "No earlier day in the tracker"}
        size="sm"
        disabled={!older}
        onClick={() => older && onDay(older)}
        icon={<ChevronLeft aria-hidden className="size-3.5" />}
      />
      <span
        title={`${counts[day]} rows on this day · the tracker holds ${DEMO_DAYS.length} days`}
        className={cn("inline-flex items-center gap-1.5 px-1.5", dsText.ui, "text-[color:var(--ds-fg)]")}
      >
        <Calendar aria-hidden className="size-3 text-[color:var(--ds-fg-muted)]" />
        {dayLabelWithToday(day)}
        <CountBadge value={counts[day] ?? 0} tone={day === DEMO_DAY ? "info" : "neutral"} />
      </span>
      <IconButton
        label={newer ? `Next day — ${dayLabelWithToday(newer)}` : "Today is the newest day"}
        size="sm"
        disabled={!newer}
        onClick={() => newer && onDay(newer)}
        icon={<ChevronRight aria-hidden className="size-3.5" />}
      />
    </span>
  );
}

// ===========================================================================
// Search
// ===========================================================================

export function DemoSearchControl({ onNavigate }: { onNavigate: DemoNavigateTo }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const outcome: DemoSearchOutcome = useMemo(() => searchDemoRows(query), [query]);

  // `/` focuses search from anywhere, the way the legend has always claimed.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
      if (e.key === "/" && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        setOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (open) window.setTimeout(() => inputRef.current?.focus(), 0);
  }, [open]);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Search runs"
        className={cn(
          "ml-auto flex h-7 min-w-0 max-w-[240px] flex-1 items-center gap-1.5 rounded-md border border-border bg-secondary/40 px-2 text-left",
          dsFocus,
        )}
      >
        <Search aria-hidden className="size-3 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-[11.5px] text-muted-foreground">Search people, files, trace ids…</span>
        <Kbd>/</Kbd>
      </button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          size="xl"
          title="Search runs"
          description="Name, EID, trace id, workflow or confirmation number — across every day the tracker holds."
        >
          <div className="border-b border-[color:var(--ds-border)] px-[var(--ds-space-loose)] py-[var(--ds-space-cozy)]">
            <SearchInput
              ref={inputRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onClear={() => setQuery("")}
              placeholder="Rosa · 10633092 · se-134755-c2d7 · TXN-0884019"
              aria-label="Search query"
            />
            <div className="mt-[var(--ds-space-base)] flex flex-wrap items-center gap-[var(--ds-space-tight)]">
              <span className={cn(dsText.meta, "text-[color:var(--ds-fg-muted)]")}>Try:</span>
              {SEARCH_EXAMPLES.map((ex) => (
                <Chip key={ex.query} tone="neutral" selected={query === ex.query} onSelect={() => setQuery(ex.query)}>
                  {ex.label}
                </Chip>
              ))}
            </div>
          </div>

          <DialogBody className="p-0">
            <SearchOutcomeView
              outcome={outcome}
              onPick={(rowId) => {
                const row = ALL_DEMO_ROWS[rowId];
                if (!row) return;
                onNavigate(row.wfLabel, rowId, row.enqueuedAt.slice(0, 10));
                setOpen(false);
              }}
            />
          </DialogBody>
        </DialogContent>
      </Dialog>
    </>
  );
}

function SearchOutcomeView({ outcome, onPick }: { outcome: DemoSearchOutcome; onPick: (rowId: string) => void }) {
  if (outcome.state === "idle") {
    return (
      <EmptyState
        icon={<SearchX aria-hidden className="size-5" />}
        title="Nothing typed yet"
        description={`Search reads every run the tracker holds — ${DEMO_DAYS.length} days. Pick one of the examples above to see a result set, a genuine zero-hit answer, and a lookup that fails.`}
      />
    );
  }

  // Fail loud. A lookup that could not run is an ERROR, never "no matches" —
  // the two answers mean opposite things and only one of them is safe to act on.
  if (outcome.state === "failed") {
    return (
      <div className="p-[var(--ds-space-loose)]">
        <Banner tone="danger" title={outcome.headline} icon={<ShieldAlert aria-hidden className="size-4" />}>
          <span className="block">{outcome.detail}</span>
          <span className={cn(dsText.meta, "mt-[var(--ds-space-tight)] block font-mono text-[color:var(--ds-fg-muted)]")}>
            code {outcome.code} · query “{outcome.query}” · no corpus was scanned
          </span>
        </Banner>
      </div>
    );
  }

  if (outcome.state === "empty") {
    return (
      <EmptyState
        icon={<SearchX aria-hidden className="size-5" />}
        title={`No run matches “${outcome.query}”`}
        description={`This is an answer, not a failure: ${outcome.scan.rows} rows across ${outcome.scan.days} days were read and none matched. If the lookup itself had failed you would see a red error instead.`}
      />
    );
  }

  return (
    <div className="flex flex-col">
      <div className={cn("px-[var(--ds-space-loose)] py-[var(--ds-space-base)]", dsText.meta, "text-[color:var(--ds-fg-muted)]")}>
        {outcome.hits.length} match{outcome.hits.length === 1 ? "" : "es"} · {outcome.scan.rows} rows read across {outcome.scan.days} days
      </div>
      <div className="min-h-0 overflow-x-auto px-[var(--ds-space-loose)] pb-[var(--ds-space-loose)]">
        <Table label={`Search results for ${outcome.query}`}>
          <THead>
            <TR>
              <TH>Row</TH>
              <TH>Workflow</TH>
              <TH>Matched</TH>
              <TH>Day</TH>
              <TH>Status</TH>
            </TR>
          </THead>
          <TBody>
            {outcome.hits.map((hit) => (
              <TR key={hit.rowId} interactive onClick={() => onPick(hit.rowId)}>
                <TD>
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate text-[color:var(--ds-fg)]">{hit.title}</span>
                    <span className={cn(dsText.meta, dsText.nums, "text-[color:var(--ds-fg-muted)]")}>{hit.trace}</span>
                  </span>
                </TD>
                <TD>{hit.workflowLabel}</TD>
                <TD>
                  <span className="flex min-w-0 items-center gap-[var(--ds-space-tight)]">
                    <Badge tone="neutral">{hit.matchedField}</Badge>
                    <span className={cn(dsText.nums, "truncate text-[color:var(--ds-fg)]")}>{hit.matchedValue}</span>
                  </span>
                </TD>
                <TD numeric>{hit.day}</TD>
                <TD>
                  <StatusPill status={hit.status} size="sm" />
                </TD>
              </TR>
            ))}
          </TBody>
        </Table>
      </div>
    </div>
  );
}

// ===========================================================================
// Notifications — the bell, the inbox, and the ping
// ===========================================================================

const SEVERITY_TONE: Record<DemoNotification["severity"], { badge: "danger" | "warning" | "neutral"; icon: typeof Siren }> = {
  critical: { badge: "danger", icon: Siren },
  attention: { badge: "warning", icon: TriangleAlert },
  info: { badge: "neutral", icon: Inbox },
};

interface InboxState {
  readIds: ReadonlySet<string>;
  snoozed: ReadonlyMap<string, string>;
  arrived: ReadonlySet<string>;
}

export function DemoNotificationBell({ onNavigate, tick }: { onNavigate: DemoNavigateTo; tick: number }) {
  const { toast } = useToasts();
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState<NotificationFilterKey>("all");
  const [state, setState] = useState<InboxState>(() => ({
    readIds: new Set(DEMO_NOTIFICATIONS.filter((n) => n.read).map((n) => n.notificationId)),
    snoozed: new Map(),
    arrived: new Set(DEMO_NOTIFICATIONS.filter((n) => n.arrivesAtTick === undefined).map((n) => n.notificationId)),
  }));

  /**
   * A push arriving on the wire. The PING is the delivery — a toast here, a
   * desktop notification in production — and it is silent by ratified policy.
   * The durable record lands in the inbox either way, which is why the toast
   * and the unread badge are driven from the same arrival, not from each other.
   */
  useEffect(() => {
    const due = DEMO_NOTIFICATIONS.filter((n) => n.arrivesAtTick !== undefined && tick >= n.arrivesAtTick && !state.arrived.has(n.notificationId));
    if (due.length === 0) return;
    setState((prev) => ({ ...prev, arrived: new Set([...prev.arrived, ...due.map((n) => n.notificationId)]) }));
    for (const n of due) {
      toast({
        tone: n.severity === "critical" ? "danger" : "warning",
        title: `Ping · ${n.title}`,
        description: `${n.body}${n.count > 1 ? ` (${n.count}× on this fingerprint)` : ""}`,
        action: n.link
          ? {
              label: n.link.label,
              onAction: () => {
                const row = ALL_DEMO_ROWS[n.link!.runId];
                if (row) onNavigate(n.link!.workflow, n.link!.runId, row.enqueuedAt.slice(0, 10));
              },
            }
          : undefined,
      });
    }
  }, [tick, state.arrived, toast, onNavigate]);

  const live = useMemo(() => DEMO_NOTIFICATIONS.filter((n) => state.arrived.has(n.notificationId)), [state.arrived]);
  const backfill = live.find((n) => n.trigger === "backfill-failed");
  const listed = live.filter((n) => n.trigger !== "backfill-failed");

  const isRead = (n: DemoNotification) => state.readIds.has(n.notificationId);
  const snoozedUntilOf = (n: DemoNotification) => state.snoozed.get(n.notificationId);
  const snoozedNow = (n: DemoNotification) => isSnoozed(snoozedUntilOf(n), tick);

  // The badge counts what is UNREAD and not snoozed, plus the backfill gap —
  // which can never be snoozed away, because we do not know what it hides.
  const unread = live.filter((n) => !isRead(n) && !snoozedNow(n)).length;
  const critical = live.some((n) => !isRead(n) && !snoozedNow(n) && n.severity === "critical");

  // Counted over EVERY live record, including the pinned backfill gap, so the
  // bell's badge and these chips can never disagree about how many exist.
  const counts: Record<NotificationFilterKey, number> = {
    all: live.length,
    unread: live.filter((n) => !isRead(n) && !snoozedNow(n)).length,
    ping: live.filter((n) => deliveryOf(n) === "ping").length,
    inbox: live.filter((n) => deliveryOf(n) === "inbox").length,
    snoozed: live.filter((n) => snoozedNow(n)).length,
  };

  const shown = listed.filter((n) => {
    if (filter === "all") return true;
    if (filter === "unread") return !isRead(n) && !snoozedNow(n);
    if (filter === "snoozed") return snoozedNow(n);
    return deliveryOf(n) === filter;
  });

  const setRead = (id: string, read: boolean) =>
    setState((prev) => {
      const next = new Set(prev.readIds);
      if (read) next.add(id);
      else next.delete(id);
      return { ...prev, readIds: next };
    });

  const setSnooze = (id: string, until: string | null) =>
    setState((prev) => {
      const next = new Map(prev.snoozed);
      if (until) next.set(id, until);
      else next.delete(id);
      return { ...prev, snoozed: next };
    });

  return (
    <>
      <button
        type="button"
        aria-label={`Notifications — ${unread} unread`}
        onClick={() => setOpen(true)}
        className={cn("relative rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground", dsFocus)}
      >
        <Bell aria-hidden className="size-3.5" />
        {unread > 0 && (
          <span
            className={cn(
              "absolute -right-0.5 -top-0.5 flex size-3.5 items-center justify-center rounded-full text-[8.5px] font-bold text-background",
              critical ? "bg-destructive" : "bg-warning",
            )}
          >
            {unread}
          </span>
        )}
      </button>

      <Drawer open={open} onOpenChange={setOpen}>
        <DrawerContent
          title="Notifications"
          description={`${unread} unread · pings are silent · a record survives a failed desktop delivery`}
          size="480px"
        >
          <div className="flex min-h-0 flex-1 flex-col">
            {/* The backfill gap is pinned and cannot be filtered, snoozed or
                dismissed: it is the one record that says we DO NOT KNOW what
                you missed, and hiding it would be the lie it exists to prevent. */}
            {backfill?.gap && (
              <div className="border-b border-[color:var(--ds-border)] p-[var(--ds-space-cozy)]">
                <Banner tone="danger" title={backfill.title} icon={<BellOff aria-hidden className="size-4" />}>
                  <span className="block">{backfill.body}</span>
                  <span className={cn(dsText.meta, "mt-[var(--ds-space-tight)] block font-mono text-[color:var(--ds-fg-muted)]")}>
                    gap {fmtClock(backfill.gap.from)} → {fmtClock(backfill.gap.to)} · code {backfill.gap.code}
                  </span>
                  <span className={cn(dsText.meta, "mt-[var(--ds-space-tight)] block text-[color:var(--ds-fg-muted)]")}>
                    {backfill.gap.reason} · pinned: this one record cannot be filtered, snoozed or dismissed
                  </span>
                </Banner>
              </div>
            )}

            <div className="flex flex-wrap items-center gap-[var(--ds-space-tight)] border-b border-[color:var(--ds-border)] px-[var(--ds-space-cozy)] py-[var(--ds-space-base)]">
              {NOTIFICATION_FILTERS.map((f) => (
                <Chip key={f.key} selected={filter === f.key} onSelect={() => setFilter(f.key)} tone="neutral">
                  {`${f.label} ${counts[f.key]}`}
                </Chip>
              ))}
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto">
              {shown.length === 0 ? (
                <EmptyState
                  icon={<Inbox aria-hidden className="size-5" />}
                  title="Nothing under this filter"
                  description="The records still exist — switch the filter to see them. A count that reads zero here never means a notification was deleted."
                />
              ) : (
                shown.map((n) => (
                  <NotificationRow
                    key={n.notificationId}
                    n={n}
                    read={isRead(n)}
                    snoozedUntil={snoozedUntilOf(n)}
                    tick={tick}
                    onRead={(read) => setRead(n.notificationId, read)}
                    onSnooze={() => setSnooze(n.notificationId, snoozedNow(n) ? null : snoozeUntil(60, tick))}
                    onOpen={() => {
                      if (!n.link) return;
                      const row = ALL_DEMO_ROWS[n.link.runId];
                      if (!row) return;
                      setRead(n.notificationId, true);
                      onNavigate(n.link.workflow, n.link.runId, row.enqueuedAt.slice(0, 10));
                      setOpen(false);
                    }}
                  />
                ))
              )}
            </div>

            <footer
              className={cn(
                "border-t border-[color:var(--ds-border)] bg-[var(--ds-surface-2)] px-[var(--ds-space-cozy)] py-[var(--ds-space-base)]",
                dsText.meta,
                "text-[color:var(--ds-fg-muted)]",
              )}
            >
              Failed · gate · parked · repeating · storage ping. A clean finish is inbox-only. A notification is a durable record
              first and a desktop delivery second — a failed delivery still leaves an unread item here.
            </footer>
          </div>
        </DrawerContent>
      </Drawer>
    </>
  );
}

function NotificationRow({
  n,
  read,
  snoozedUntil,
  tick,
  onRead,
  onSnooze,
  onOpen,
}: {
  n: DemoNotification;
  read: boolean;
  snoozedUntil?: string;
  tick: number;
  onRead: (read: boolean) => void;
  onSnooze: () => void;
  onOpen: () => void;
}) {
  const delivery = deliveryOf(n);
  const spec = SEVERITY_TONE[n.severity];
  const Icon = spec.icon;
  const snoozing = isSnoozed(snoozedUntil, tick);
  return (
    <article
      className={cn(
        "flex flex-col gap-[var(--ds-space-tight)] border-b border-[color:var(--ds-border-subtle)] px-[var(--ds-space-cozy)] py-[var(--ds-space-base)]",
        snoozing && "opacity-60",
      )}
    >
      <div className="flex min-w-0 items-center gap-[var(--ds-space-snug)]">
        {!read && <span aria-label="unread" className="size-1.5 shrink-0 rounded-full bg-[var(--ds-accent)]" />}
        <Icon aria-hidden className={cn("size-3.5 shrink-0", n.severity === "critical" ? "text-[color:var(--ds-danger)]" : "text-[color:var(--ds-fg-muted)]")} />
        <span className={cn(dsText.ui, "min-w-0 flex-1 truncate", read ? "text-[color:var(--ds-fg-secondary)]" : "font-semibold text-[color:var(--ds-fg)]")}>
          {n.title}
        </span>
        <span className={cn(dsText.meta, dsText.nums, "shrink-0 text-[color:var(--ds-fg-muted)]")}>{notificationAge(n, tick)} ago</span>
      </div>

      <p className={cn(dsText.body, "text-[color:var(--ds-fg-muted)]")}>{n.body}</p>

      <div className="flex flex-wrap items-center gap-[var(--ds-space-tight)]">
        <Badge tone={spec.badge}>{NOTIFICATION_TRIGGER_LABEL[n.trigger]}</Badge>
        <Badge tone={delivery === "ping" ? "info" : "neutral"}>{delivery === "ping" ? "Ping" : "Inbox only"}</Badge>
        {n.count > 1 && <Chip label="repeats">{`+${n.count - 1} more like this`}</Chip>}
        {!n.desktopDelivered && (
          <Badge tone="warning" title="The desktop notification never appeared. The record is here anyway — that is the point of durability.">
            delivery failed
          </Badge>
        )}
        {snoozing && snoozedUntil && <Chip label="snoozed">{`${snoozeRemaining(snoozedUntil, tick)} left`}</Chip>}
      </div>

      <div className="flex flex-wrap items-center gap-[var(--ds-space-tight)]">
        {n.link && (
          <Button size="sm" variant="secondary" onClick={onOpen}>
            {n.link.label}
          </Button>
        )}
        <Button
          size="sm"
          variant="ghost"
          icon={read ? <Mail aria-hidden className="size-3" /> : <MailOpen aria-hidden className="size-3" />}
          onClick={() => onRead(!read)}
        >
          {read ? "Mark unread" : "Mark read"}
        </Button>
        <Button size="sm" variant="ghost" icon={<Clock aria-hidden className="size-3" />} onClick={onSnooze}>
          {snoozing ? "Un-snooze" : "Snooze 1h"}
        </Button>
      </div>
    </article>
  );
}
