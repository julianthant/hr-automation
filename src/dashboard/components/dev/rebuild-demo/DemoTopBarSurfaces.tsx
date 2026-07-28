import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowUpRight,
  Bell,
  Calendar,
  ChevronLeft,
  ChevronRight,
  Clock,
  Inbox,
  Keyboard,
  Mail,
  MailOpen,
  Search,
  SearchX,
  Siren,
  TriangleAlert,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  Badge,
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
  Popover,
  PopoverContent,
  PopoverTrigger,
  SearchInput,
  MetaLine,
  Refusal,
  StatusPill,
  TBody,
  TD,
  TH,
  THead,
  TR,
  Table,
  dsBorder,
  dsFocus,
  dsIcon,
  dsMotion,
  dsRadius,
  dsText,
  useToasts,
} from "./demo-ui";
import { DEMO_DAY, fmtClock } from "./demo-wire";
import {
  ALL_DEMO_ROWS,
  DEMO_DAYS,
  buildDemoMonth,
  dayCounts,
  dayIndex,
  dayLabelWithToday,
  demoMonthRange,
  monthLabel,
  monthOfDay,
  moveCalendarFocus,
  shiftMonth,
} from "./demo-days";
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
import { DemoShortcutsLegend } from "./demo-shortcuts";

/**
 * DEV-ONLY — the Top Bar surfaces that were dead: SEARCH, the DATE navigator,
 * the notification BELL, and the SHORTCUTS button.
 *
 * Each was a control with no behaviour behind it, which is worse than absent:
 * the date pill said one day while the queue held another, the bell showed a
 * badge that opened nothing, and the help button did nothing at all while the
 * keyboard legend it should have held took a 36px band of its own across the
 * top of the queue. The first three have one thing in common — all change
 * WHICH ROWS the operator is looking at, so all three are built here against
 * the same corpus functions the queue uses.
 */

export interface DemoNavigateTo {
  (workflow: string, runId: string, day: string): void;
}

// ===========================================================================
// Keyboard shortcuts
// ===========================================================================

/**
 * The Top Bar's route to the keyboard flow — the one control that was already
 * sitting there doing nothing.
 *
 * It used to be a permanent legend strip beside the view title — five key
 * groups the operator reads once and then scrolls past every day, holding a
 * row that the queue and the log panel both wanted. A Popover is the sanctioned
 * home for something that has to be REACHABLE rather than visible: it opens on
 * click, so pointer, touch and keyboard all get to it, unlike the hover-only
 * tooltip DESIGN.md forbids for anything load-bearing.
 *
 * The LIST itself is `demo-shortcuts.tsx`, shared with Settings → Help. This
 * control keeps its own footnote — a popover the operator opened mid-task is
 * exactly where "not while you are typing" is worth one line — while the Help
 * page states the same rule where somebody reading the product would look.
 */
export function DemoShortcutsPopover({ onOpenHelp }: { onOpenHelp?: () => void }) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <IconButton size="sm" label="Keyboard shortcuts" icon={<Keyboard aria-hidden className={dsIcon.md} />} />
      </PopoverTrigger>
      <PopoverContent
        title="Keyboard"
        description="Nothing here fires while the caret is in a field."
        width="lg"
        align="end"
      >
        <DemoShortcutsLegend />
        {/* The other route to the same registry. A popover is where you check
            one key mid-task; the Help page is where you read the set — and a
            page nobody can find from the control that shows the same list is a
            page nobody opens. */}
        {onOpenHelp && (
          <div className="mt-[var(--ds-space-base)] border-t border-[color:var(--ds-border-subtle)] pt-[var(--ds-space-snug)]">
            <Button
              variant="ghost"
              size="sm"
              onClick={onOpenHelp}
              icon={<ArrowUpRight aria-hidden className={dsIcon.md} />}
              className="w-full justify-start"
            >
              Help
            </Button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}

// ===========================================================================
// Date navigation
// ===========================================================================

const WEEKDAY_HEADS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];

/**
 * The month grid behind the date pill.
 *
 * It is a real picker and it is honest about what it can offer: the queue is
 * day-partitioned on disk, so a day the tracker holds no file for is DRAWN and
 * DISABLED with its reason rather than skipped — a calendar with holes in it
 * teaches the operator that the month is missing days.
 *
 * Every enabled cell carries its own row count, off `topLevelRowsForDay` — the
 * same function the pill's badge, the rail badges and the Status Bar all read.
 * The number you press and the number you land on cannot differ.
 *
 * Keyboard: one roving tab stop, arrows move within the grid (clamped, never
 * wrapped), Home/End take the week's edges, Enter/Space select. Radix owns
 * Escape and returning focus to the trigger.
 */
function DateCalendar({ day, onPick }: { day: string; onPick: (day: string) => void }) {
  const [month, setMonth] = useState(() => monthOfDay(day));
  const cells = useMemo(() => buildDemoMonth(month), [month]);
  const range = useMemo(() => demoMonthRange(), []);
  const prev = month > range.first ? shiftMonth(month, -1) : undefined;
  const next = month < range.last ? shiftMonth(month, 1) : undefined;

  // The roving tab stop starts on the selected day when it is in view, and on
  // the first selectable cell otherwise — never on a disabled one, which would
  // put the caret somewhere Enter does nothing.
  const initial = cells.findIndex((c) => c.day === day);
  const [focus, setFocus] = useState(initial >= 0 ? initial : cells.findIndex((c) => c.available));
  const gridRef = useRef<HTMLDivElement>(null);

  const moveTo = (index: number) => {
    setFocus(index);
    // The cells are real buttons in DOM order, so the nth button IS the nth cell.
    gridRef.current?.querySelectorAll<HTMLButtonElement>("button[data-demo-day]")[index]?.focus();
  };

  return (
    <div className="flex flex-col gap-[var(--ds-space-snug)]">
      <div className="flex items-center gap-[var(--ds-space-snug)]">
        <IconButton
          size="sm"
          disabled={!prev}
          label={prev ? `Previous month — ${monthLabel(prev)}` : `The tracker holds nothing before ${monthLabel(range.first)}`}
          onClick={() => prev && setMonth(prev)}
          icon={<ChevronLeft aria-hidden className={dsIcon.md} />}
        />
        <span className={cn(dsText.ui, "min-w-0 flex-1 text-center font-semibold text-[color:var(--ds-fg)]")}>
          {monthLabel(month)}
        </span>
        <IconButton
          size="sm"
          disabled={!next}
          label={next ? `Next month — ${monthLabel(next)}` : `The tracker holds nothing after ${monthLabel(range.last)}`}
          onClick={() => next && setMonth(next)}
          icon={<ChevronRight aria-hidden className={dsIcon.md} />}
        />
      </div>

      <div aria-hidden className={cn(dsText.caps, "grid grid-cols-7 text-center text-[color:var(--ds-fg-muted)]")}>
        {WEEKDAY_HEADS.map((w) => (
          <span key={w} className="py-[var(--ds-space-hair)]">
            {w}
          </span>
        ))}
      </div>

      <div
        ref={gridRef}
        role="grid"
        aria-label="Pick a day"
        onKeyDown={(e) => {
          const to = moveCalendarFocus(focus, e.key);
          if (to === null) return;
          e.preventDefault();
          moveTo(to);
        }}
        className="grid grid-cols-7 gap-[var(--ds-space-hair)]"
      >
        {cells.map((c, i) => {
          const selected = c.day === day;
          return (
            <button
              key={c.day}
              type="button"
              data-demo-day={c.day}
              role="gridcell"
              aria-selected={selected}
              aria-current={c.isToday ? "date" : undefined}
              disabled={!c.available}
              tabIndex={i === focus ? 0 : -1}
              onFocus={() => setFocus(i)}
              onClick={() => onPick(c.day)}
              aria-label={`${dayLabelWithToday(c.day)}${c.available ? ` — ${c.count} rows` : " — the tracker holds no rows"}`}
              title={c.available ? undefined : "The tracker holds no partition for this day"}
              className={cn(
                "relative flex cursor-pointer flex-col items-center justify-center",
                "h-[var(--ds-h-md)] w-full",
                dsRadius.sm,
                dsText.meta,
                dsText.nums,
                dsFocus,
                dsMotion.fast,
                "disabled:cursor-default",
                selected
                  ? cn(dsBorder.loud, "border bg-[var(--ds-surface-selected)] font-semibold text-[color:var(--ds-fg)]")
                  : c.available
                    ? "text-[color:var(--ds-fg)] hover:bg-[var(--ds-surface-3)]"
                    : c.inMonth
                      ? "text-[color:var(--ds-fg-faint)]"
                      : "text-[color:var(--ds-fg-faint)] opacity-50",
              )}
            >
              {c.dayOfMonth}
              {/* A DOT, not the count: 42 numbers plus 42 counts is a wall, and
                  the count the operator is acting on is already on the pill.
                  It is `--ds-accent-mark` — a mark, never text. */}
              {c.available && (
                <span
                  aria-hidden
                  className={cn(
                    "absolute bottom-[var(--ds-space-hair)] size-1 rounded-full",
                    c.count > 0 ? "bg-[var(--ds-accent-mark)]" : "bg-[var(--ds-fg-faint)]",
                  )}
                />
              )}
            </button>
          );
        })}
      </div>

      {/* TODAY IN ONE ACTION, from anywhere in the calendar. It moves the month
          AND the day, so a picker parked three months out is one press from
          live rather than three. */}
      <div className={cn("flex items-center border-t pt-[var(--ds-space-snug)]", dsBorder.subtle)}>
        <Button
          size="sm"
          variant="secondary"
          disabled={day === DEMO_DAY}
          onClick={() => {
            setMonth(monthOfDay(DEMO_DAY));
            onPick(DEMO_DAY);
          }}
        >
          Today
        </Button>
        <span className={cn(dsText.meta, "ml-auto text-[color:var(--ds-fg-muted)]")}>
          <span className={dsText.nums}>{DEMO_DAYS.length}</span> days on disk
        </span>
      </div>
    </div>
  );
}

/**
 * ‹ 📅 Fri, Jul 25 · today [38] ›. The date is not decoration: it selects the
 * day partition the whole app reads. The rail badges, the Status Bar pills and
 * the rows all recompute from `topLevelRowsForDay(day)`, so they move together
 * — there is no second corpus for any of them to disagree about.
 *
 * The pill in the middle used to be a `<span>`: a calendar glyph, a date and a
 * count, none of which did anything. It is the picker's trigger now, and the
 * ‹ › day steps stay beside it because stepping one day is the common move and
 * should not cost an overlay.
 */
export function DemoDateNav({ day, onDay }: { day: string; onDay: (day: string) => void }) {
  const idx = dayIndex(day);
  const counts = useMemo(() => dayCounts(), []);
  const older = DEMO_DAYS[idx - 1];
  const newer = DEMO_DAYS[idx + 1];
  const [open, setOpen] = useState(false);
  return (
    <span className="flex shrink-0 items-center gap-0.5">
      <IconButton
        label={older ? `Previous day — ${dayLabelWithToday(older)}` : "No earlier day in the tracker"}
        size="sm"
        disabled={!older}
        onClick={() => older && onDay(older)}
        icon={<ChevronLeft aria-hidden className={dsIcon.md} />}
      />
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label={`Pick a day — showing ${dayLabelWithToday(day)}, ${counts[day] ?? 0} rows`}
            title={`${counts[day] ?? 0} rows on this day · the tracker holds ${DEMO_DAYS.length} days`}
            className={cn(
              "inline-flex cursor-pointer items-center border border-transparent",
              "h-[var(--ds-h-sm)] gap-1.5 px-1.5",
              dsRadius.md,
              dsText.ui,
              dsFocus,
              dsMotion.fast,
              "text-[color:var(--ds-fg)] hover:bg-[var(--ds-surface-3)] active:translate-y-px",
              "data-[state=open]:border-[color:var(--ds-border-loud)] data-[state=open]:bg-[var(--ds-surface-selected)]",
            )}
          >
            <Calendar aria-hidden className={cn(dsIcon.sm, "text-[color:var(--ds-fg-muted)]")} />
            {dayLabelWithToday(day)}
            <CountBadge value={counts[day] ?? 0} tone={day === DEMO_DAY ? "info" : "neutral"} />
          </button>
        </PopoverTrigger>
        <PopoverContent title="Pick a day" hideTitle width="md" align="center" side="bottom">
          <DateCalendar
            day={day}
            onPick={(next) => {
              setOpen(false);
              if (next !== day) onDay(next);
            }}
          />
        </PopoverContent>
      </Popover>
      <IconButton
        label={newer ? `Next day — ${dayLabelWithToday(newer)}` : "Today is the newest day"}
        size="sm"
        disabled={!newer}
        onClick={() => newer && onDay(newer)}
        icon={<ChevronRight aria-hidden className={dsIcon.md} />}
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
          "ml-auto flex min-w-0 max-w-[240px] flex-1 items-center gap-[var(--ds-space-snug)] border px-[var(--ds-space-base)] text-left",
          "h-[var(--ds-h-md)] rounded-[var(--ds-radius-md)] border-[color:var(--ds-border-strong)] bg-[var(--ds-surface-2)]",
          dsFocus,
          dsMotion.base,
          "hover:border-[color:var(--ds-border-loud)]",
        )}
      >
        <Search aria-hidden className={cn(dsIcon.sm, "shrink-0 text-[color:var(--ds-fg-muted)]")} />
        <span className={cn(dsText.meta, "min-w-0 flex-1 truncate text-[color:var(--ds-fg-muted)]")}>
          Search people, files, trace ids…
        </span>
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
        icon={<SearchX aria-hidden className={dsIcon.lg} />}
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
        <Refusal
          title={outcome.headline}
          code={outcome.code}
          meta={[`query “${outcome.query}”`]}
          outcome="no corpus was scanned"
        >
          {outcome.detail}
        </Refusal>
      </div>
    );
  }

  if (outcome.state === "empty") {
    return (
      <EmptyState
        icon={<SearchX aria-hidden className={dsIcon.lg} />}
        title={`No run matches “${outcome.query}”`}
        description={`This is an answer, not a failure: ${outcome.scan.rows} rows across ${outcome.scan.days} days were read and none matched. If the lookup itself had failed you would see a red error instead.`}
      />
    );
  }

  return (
    <div className="flex flex-col">
      <div className="px-[var(--ds-space-loose)] py-[var(--ds-space-base)]">
        <MetaLine
          items={[
            `${outcome.hits.length} match${outcome.hits.length === 1 ? "" : "es"}`,
            `${outcome.scan.rows} rows read across ${outcome.scan.days} days`,
          ]}
        />
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
        className={cn(
          "relative rounded-[var(--ds-radius-md)] p-[var(--ds-space-snug)] text-[color:var(--ds-fg-muted)]",
          "hover:bg-[var(--ds-surface-3)] hover:text-[color:var(--ds-fg)]",
          dsFocus,
          dsMotion.base,
        )}
      >
        <Bell aria-hidden className={dsIcon.md} />
        {unread > 0 && (
          // Dark ink on a bright fill — the same contract the two LOUD statuses
          // use (DESIGN.md). White numerals on this red fail AA at 10px.
          <span
            aria-hidden
            className={cn(
              "absolute -right-0.5 -top-0.5 flex items-center justify-center rounded-full",
              "size-[var(--ds-space-cozy)] font-semibold",
              dsText.micro,
              dsText.nums,
              critical
                ? "bg-[var(--ds-status-failed-solid-bg)] text-[color:var(--ds-status-failed-solid-fg)]"
                : "bg-[var(--ds-status-waiting-solid-bg)] text-[color:var(--ds-status-waiting-solid-fg)]",
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
                <Refusal
                  title={backfill.title}
                  code={backfill.gap.code}
                  meta={[`gap ${fmtClock(backfill.gap.from)} → ${fmtClock(backfill.gap.to)}`]}
                >
                  <span className="flex flex-col gap-[var(--ds-space-tight)]">
                    <span>{backfill.body}</span>
                    <span className={cn(dsText.meta, "text-[color:var(--ds-fg-muted)]")}>
                      {backfill.gap.reason} · pinned: this one record cannot be filtered, snoozed or dismissed
                    </span>
                  </span>
                </Refusal>
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
                  icon={<Inbox aria-hidden className={dsIcon.lg} />}
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
        <Icon aria-hidden className={cn(dsIcon.md, "shrink-0", n.severity === "critical" ? "text-[color:var(--ds-danger)]" : "text-[color:var(--ds-fg-muted)]")} />
        <span className={cn(dsText.ui, "min-w-0 flex-1 truncate", read ? "text-[color:var(--ds-fg-secondary)]" : "font-semibold text-[color:var(--ds-fg)]")}>
          {n.title}
        </span>
        <MetaLine className="shrink-0" items={[`${notificationAge(n, tick)} ago`]} />
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
          icon={read ? <Mail aria-hidden className={dsIcon.sm} /> : <MailOpen aria-hidden className={dsIcon.sm} />}
          onClick={() => onRead(!read)}
        >
          {read ? "Mark unread" : "Mark read"}
        </Button>
        <Button size="sm" variant="ghost" icon={<Clock aria-hidden className={dsIcon.sm} />} onClick={onSnooze}>
          {snoozing ? "Un-snooze" : "Snooze 1h"}
        </Button>
      </div>
    </article>
  );
}
