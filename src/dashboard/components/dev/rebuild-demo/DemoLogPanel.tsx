import { useEffect, useMemo, useState } from "react";
import {
  ArrowDownToLine,
  ArrowRight,
  ArrowUpFromLine,
  Ban,
  Camera,
  Check,
  CheckCircle2,
  ChevronDown,
  Clock3,
  ChevronLeft,
  ChevronRight,
  CircleSlash,
  ClipboardList,
  Database,
  FileText,
  History,
  Loader2,
  Pause,
  Play,
  Receipt,
  RotateCcw,
  ScrollText,
  Search,
  ShieldCheck,
  TriangleAlert,
  Users,
  X,
  Zap,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { IconActionButton } from "@/components/shared/IconActionButton";
import { StatusBadge, type ProposedStatus } from "./demo-status";
import { panelKindOf, panelKindSpec, rowVariantSpec } from "./demo-catalog";
import {
  DEMO_ROWS,
  fmtElapsed,
  LIVE_SEQUENCE,
  memberAttentionIds,
  orderedMemberIds,
  SYSTEM_ACCENT,
  type DemoLine,
  type DemoRecord,
  type DemoRecordCheck,
  type DemoRecordField,
  type DemoRow,
  type DemoStep,
  type LineKind,
  type SystemKey,
} from "./demo-data";

/**
 * DEV-ONLY — the rebuild demo's log panel. EVERYTHING here derives from the
 * selected row's own model: outcome bar, step strip + hover, waterfall,
 * filmstrip, and the 5 ratified tabs (state-driven default). Members get the
 * conveyor header (prev/next/next-attention) + a per-member action bar with a
 * working Mark-checked.
 */

const NOOP = () => {};

export type DemoTab = "logs" | "data" | "review" | "receipt" | "people";

const TERMINAL: ProposedStatus[] = ["verifiedDone", "doneWarnings", "failed", "cancelled"];

/**
 * Tabs are derived from the PANEL KIND, not fixed at five.
 *  - Review exists only on the Review Run Row (the only row that owns records).
 *  - People exists only on a Group Row.
 *  - Screenshots is not a tab at all — evidence rides the bar above the tabs.
 */
export function tabsFor(row: DemoRow): DemoTab[] {
  const kind = panelKindOf(row);
  if (kind === "review") return ["review", "logs", "data", "receipt"];
  if (kind === "group") return ["people", "logs", "data", "receipt"];
  return ["logs", "data", "receipt"];
}

export function defaultTabFor(row: DemoRow): DemoTab {
  const kind = panelKindOf(row);
  if (kind === "review") return "review";
  if (kind === "group") {
    const attention = (row.memberIds ?? []).some((id) => {
      const m = DEMO_ROWS[id];
      return m && !m.displayOnly && (m.status === "failed" || m.status === "waiting" || m.status === "doneWarnings");
    });
    if (attention || row.status === "waiting") return "people";
    return TERMINAL.includes(row.status) ? "receipt" : "logs";
  }
  return TERMINAL.includes(row.status) ? "receipt" : "logs";
}

export interface DemoLogPanelProps {
  row: DemoRow;
  tab: DemoTab | null;
  onTab: (t: DemoTab) => void;
  onSelect: (id: string) => void;
  checkedIds: ReadonlySet<string>;
  onToggleChecked: (id: string) => void;
  tick: number;
  liveCount: number;
}

// ---------------------------------------------------------------------------
// atoms
// ---------------------------------------------------------------------------

function SystemChip({ system }: { system: SystemKey }) {
  return (
    <span className={cn("mr-1.5 inline-block rounded px-1 align-[1px] text-[9px] font-bold tracking-wider", SYSTEM_ACCENT[system])}>
      {system.toUpperCase()}
    </span>
  );
}

const LINE_ICON: Record<LineKind, { icon: typeof Check; cls: string }> = {
  nav: { icon: ArrowRight, cls: "text-log-slate" },
  search: { icon: Search, cls: "text-log-slate" },
  read: { icon: ArrowDownToLine, cls: "text-log-cyan" },
  write: { icon: ArrowUpFromLine, cls: "text-log-teal" },
  ok: { icon: Check, cls: "text-success" },
  error: { icon: X, cls: "text-destructive" },
  warn: { icon: TriangleAlert, cls: "text-warning" },
  pause: { icon: Pause, cls: "text-warning" },
  event: { icon: Zap, cls: "text-log-violet" },
};

const MEMBER_ROW_ICON: Record<ProposedStatus, { icon: typeof Check; cls: string }> = {
  verifiedDone: { icon: CheckCircle2, cls: "text-success" },
  doneWarnings: { icon: TriangleAlert, cls: "text-warning" },
  running: { icon: Loader2, cls: "text-primary animate-spin motion-reduce:animate-none" },
  queued: { icon: Clock3, cls: "text-muted-foreground" },
  waiting: { icon: ClipboardList, cls: "text-warning" },
  parked: { icon: Pause, cls: "text-log-violet" },
  failed: { icon: X, cls: "text-destructive" },
  cancelled: { icon: Ban, cls: "text-warning" },
};

const LINE_TONE: Partial<Record<LineKind, string>> = {
  ok: "text-success",
  error: "text-destructive",
  warn: "text-warning",
};

function Pill({ dir, label, value }: { dir: "read" | "write"; label: string; value: string }) {
  const read = dir === "read";
  const Icon = read ? ArrowDownToLine : ArrowUpFromLine;
  return (
    <span
      className={cn(
        "mr-1 inline-flex items-center gap-1 rounded-[5px] border px-1.5 py-px text-[10.5px]",
        read ? "border-log-cyan/30 bg-log-cyan/8 text-log-cyan" : "border-log-teal/30 bg-log-teal/8 text-log-teal",
      )}
    >
      <Icon aria-hidden className="size-2.5" />
      {label} <span className="font-mono">{value}</span>
    </span>
  );
}

function GateCardView({ row, wide }: { row: DemoRow; wide?: boolean }) {
  const gate = row.gate;
  if (!gate) return null;
  const violet = gate.kind === "parked";
  return (
    <div
      className={cn(
        "rounded-lg border px-3 py-2.5 text-[12px]",
        violet ? "border-log-violet/45 bg-log-violet/6" : "border-warning/45 bg-warning/6",
        !wide && "mx-3 my-1.5 ml-11",
      )}
    >
      <div className={cn("mb-1.5 text-[11.5px] font-semibold", violet ? "text-log-violet" : "text-warning")}>{gate.title}</div>
      {gate.candidates && (
        <div className="grid grid-cols-2 gap-2">
          {gate.candidates.map((c) => (
            <div key={c.heading} className="rounded-md border border-border/60 bg-card/60 px-2.5 py-1.5">
              <div className="text-[9.5px] font-semibold uppercase tracking-wider text-muted-foreground">{c.heading}</div>
              <div className="text-[12px] font-semibold text-foreground">{c.name}</div>
              <div className="text-[10.5px] text-muted-foreground">{c.sub}</div>
            </div>
          ))}
        </div>
      )}
      {gate.staged && (
        <div className="rounded-md border border-border/60 bg-card/60 px-2.5 py-1.5">
          {gate.staged.map((s) => (
            <div key={s.field} className="flex items-center gap-2 py-[2px]">
              <ArrowUpFromLine aria-hidden className="size-3 text-log-teal" />
              <span className="w-32 shrink-0 text-[11px] text-muted-foreground">{s.field}</span>
              <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-foreground">{s.value}</span>
              <SystemChip system={s.system} />
              <span className="shrink-0 rounded border border-warning/40 px-1 text-[9.5px] font-semibold text-warning">staged</span>
            </div>
          ))}
        </div>
      )}
      <div className="mt-2 flex flex-wrap gap-1.5">
        {gate.actions.map((a, i) => (
          <button
            key={a}
            type="button"
            onClick={NOOP}
            className={cn(
              "rounded-md border px-2.5 py-0.5 text-[11px] outline-none focus-visible:ring-2 focus-visible:ring-ring",
              i === 0
                ? "border-primary bg-primary font-semibold text-primary-foreground"
                : "border-border bg-card font-medium text-secondary-foreground",
            )}
          >
            {a}
          </button>
        ))}
      </div>
      {wide && <div className="mt-2 border-t border-border/40 pt-2 text-[11px] leading-relaxed text-muted-foreground">{gate.note}</div>}
    </div>
  );
}

function FailureCardView({ row }: { row: DemoRow }) {
  if (!row.failCard) return null;
  return (
    <div className="mx-3 my-1.5 ml-11 rounded-lg border border-destructive/40 bg-destructive/6 px-3 py-2 text-[12px]">
      <div className="mb-0.5 text-[11.5px] font-semibold text-destructive">{row.failCard.title}</div>
      <div className="text-[11px] text-muted-foreground">
        {row.failCard.meta} <span className="text-info">Screenshot at failure →</span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// strip + waterfall + filmstrip
// ---------------------------------------------------------------------------

/**
 * Timeline — the run's real shape, to scale.
 *
 * Replaces the old pill strip + separate progress bar. Those told you the
 * ORDER of the steps and, separately, how much bar was filled; neither told you
 * where the time actually went. Here each step is a track segment sized by its
 * REAL recorded duration, so a 1-minute Kronos search dwarfs a 12-second
 * identity check the way it does in life, and an 18-minute wait at a gate is
 * visibly the whole run. Nothing is fabricated: a step with no duration yet
 * (pending, or currently running) gets a minimum slot and a hatched fill rather
 * than an invented width.
 */
const STEP_TONE: Record<DemoStep["state"], { bar: string; text: string; dot: string }> = {
  done: { bar: "bg-success/55", text: "text-success", dot: "bg-success" },
  current: { bar: "bg-primary/70", text: "text-primary", dot: "bg-primary" },
  waiting: { bar: "bg-warning/60", text: "text-warning", dot: "bg-warning" },
  failed: { bar: "bg-destructive/65", text: "text-destructive", dot: "bg-destructive" },
  cancelled: { bar: "bg-warning/40", text: "text-warning", dot: "bg-warning" },
  pending: { bar: "bg-border", text: "text-muted-foreground", dot: "bg-border" },
};

/** a step with no recorded time still needs a visible slot — this is its floor */
const MIN_SLOT_SEC = 8;

function Timeline({ row }: { row: DemoRow }) {
  const steps = row.steps;
  if (steps.length === 0) return null;

  const active = steps.reduce((a, s) => a + (s.durationSec ?? 0), 0);
  const gateSec = row.gate ? Math.max(active, 90) : 0;
  const slot = (s: DemoStep) => Math.max(s.durationSec ?? 0, MIN_SLOT_SEC);
  const total = steps.reduce((a, s) => a + slot(s), 0) + gateSec;

  return (
    <div className="border-b border-border/60 px-3 py-2">
      <div className="flex items-stretch gap-[3px]">
        {steps.map((s) => {
          const tone = STEP_TONE[s.state];
          const width = `${(slot(s) / total) * 100}%`;
          const timed = s.durationSec !== undefined;
          return (
            <div key={s.label} className="group relative min-w-0" style={{ width }}>
              {/* label rail — truncates hard; the hover card carries the detail */}
              <div className="flex min-w-0 items-center gap-1">
                <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", tone.dot, s.state === "current" && "animate-pulse motion-reduce:animate-none")} />
                <span className={cn("min-w-0 truncate text-[10.5px]", s.state === "pending" ? "text-muted-foreground" : tone.text)}>{s.label}</span>
              </div>
              {/* the track segment — width IS the duration */}
              <button
                type="button"
                onClick={NOOP}
                aria-label={`${s.label} — ${s.state}${timed ? `, ${fmtElapsed(s.durationSec ?? 0)}` : ""}`}
                className={cn(
                  "mt-1 block h-2 w-full rounded-[3px] outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  tone.bar,
                  !timed && s.state !== "pending" && "opacity-70",
                  s.state === "pending" && "border border-dashed border-border bg-transparent",
                )}
              />
              <div className="mt-0.5 flex min-w-0 items-baseline gap-1">
                <span className="truncate font-mono text-[9.5px] tabular-nums text-muted-foreground">{timed ? fmtElapsed(s.durationSec ?? 0) : ""}</span>
                {s.attempts && s.attempts > 1 && <span className="shrink-0 font-mono text-[9px] font-bold text-warning">×{s.attempts}</span>}
              </div>

              {(s.keyLines || timed) && (
                <span className="absolute left-0 top-full z-50 mt-1 hidden w-60 rounded-lg border border-border bg-popover p-2.5 text-left shadow-lg group-hover:block group-focus-within:block">
                  <span className="mb-1 block text-[11.5px] font-semibold text-foreground">{s.label}</span>
                  <span className="flex items-center justify-between text-[10.5px]">
                    <span className="text-muted-foreground">Status</span>
                    <span className={cn("font-mono", tone.text)}>{s.state}</span>
                  </span>
                  {timed && (
                    <span className="flex items-center justify-between text-[10.5px]">
                      <span className="text-muted-foreground">Took</span>
                      <span className="font-mono text-secondary-foreground">{fmtElapsed(s.durationSec ?? 0)}</span>
                    </span>
                  )}
                  {s.system && (
                    <span className="flex items-center justify-between text-[10.5px]">
                      <span className="text-muted-foreground">System</span>
                      <span className="font-mono text-secondary-foreground">{s.system}</span>
                    </span>
                  )}
                  {s.attempts && s.attempts > 1 && (
                    <span className="flex items-center justify-between text-[10.5px]">
                      <span className="text-muted-foreground">Attempts</span>
                      <span className="font-mono text-warning">{s.attempts}</span>
                    </span>
                  )}
                  {s.keyLines && (
                    <span className="mt-1.5 flex flex-col border-t border-border/60 pt-1.5 font-mono text-[10px] leading-relaxed text-secondary-foreground">
                      {s.keyLines.map((l) => (
                        <span key={l}>{l}</span>
                      ))}
                    </span>
                  )}
                  {s.hasShot && <span className="mt-1 block text-[10.5px] text-info">Step screenshot →</span>}
                </span>
              )}
            </div>
          );
        })}

        {/* the wait is part of the run's time, so it is part of the timeline */}
        {row.gate && (
          <div className="group relative min-w-0" style={{ width: `${(gateSec / total) * 100}%` }}>
            <div className="flex min-w-0 items-center gap-1">
              <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-warning animate-pulse motion-reduce:animate-none" />
              <span className="min-w-0 truncate text-[10.5px] text-warning">Waiting on you</span>
            </div>
            <span
              aria-hidden
              className="mt-1 block h-2 w-full rounded-[3px] bg-[repeating-linear-gradient(45deg,var(--color-warning)_0_4px,transparent_4px_8px)] opacity-70"
            />
            <span className="mt-0.5 block truncate font-mono text-[9.5px] tabular-nums text-warning">{row.gate.waiting}</span>
          </div>
        )}
      </div>

      {/* axis — when it started, how long it has been, where the time went */}
      <div className="mt-1.5 flex items-baseline gap-2 border-t border-border/40 pt-1 font-mono text-[9.5px] text-muted-foreground">
        <span>{row.time}</span>
        <span aria-hidden className="h-px flex-1 bg-border/50" />
        <span className="tabular-nums">
          {fmtElapsed(active)} working{row.gate ? ` · ${row.gate.waiting} waiting on you` : ""}
        </span>
      </div>
    </div>
  );
}

/**
 * Evidence bar — the operator's replacement for the Screenshots TAB. Every
 * capture this run took, always visible above the tabs, so proof is one glance
 * away from whatever you are reading. Clicking opens the full-size viewer
 * (the thumbnail rail there is the old grid).
 */
function EvidenceBar({ row }: { row: DemoRow }) {
  if (row.shots.length === 0) return null;
  return (
    <div className="flex gap-1.5 overflow-x-auto border-b border-border/60 px-3 py-1.5">
      {row.shots.map((s) => (
        <button
          key={s.label}
          type="button"
          onClick={NOOP}
          title={`Open screenshot — ${s.label}`}
          className={cn(
            "flex h-10 w-[4.75rem] shrink-0 flex-col items-center justify-center gap-0.5 rounded-md border bg-secondary/40 outline-none focus-visible:ring-2 focus-visible:ring-ring",
            s.kind === "error" ? "border-destructive/45 hover:border-destructive" : "border-border hover:border-info/50",
          )}
        >
          <Camera aria-hidden className={cn("size-3", s.kind === "error" ? "text-destructive" : "text-muted-foreground")} />
          <span className="max-w-full truncate px-1 text-[8.5px] text-muted-foreground">{s.label}</span>
        </button>
      ))}
    </div>
  );
}

/**
 * Gate banner — pinned above the tabs whenever the run is waiting on the
 * operator, so the decision is visible from EVERY tab instead of hiding behind
 * a Review tab that most rows should not have.
 */
function GateBanner({ row }: { row: DemoRow }) {
  const gate = row.gate;
  if (!gate) return null;
  return (
    <div className="border-b border-warning/30 bg-warning/8 px-3 py-2">
      <div className="flex items-center gap-2">
        <ClipboardList aria-hidden className="size-3.5 shrink-0 text-warning" />
        <span className="min-w-0 truncate text-[12px] font-semibold text-warning">{gate.title}</span>
        <span className="ml-auto shrink-0 font-mono text-[10px] text-warning/80">
          open {gate.waiting} · since {gate.openedAt}
        </span>
      </div>
      <p className="mt-1 pl-5 text-[11px] leading-relaxed text-muted-foreground">{gate.note}</p>
      <div className="mt-1.5 flex flex-wrap gap-1.5 pl-5">
        {gate.actions.map((a, i) => (
          <button
            key={a}
            type="button"
            onClick={NOOP}
            className={cn(
              "rounded-md border px-2.5 py-0.5 text-[11px] font-semibold outline-none focus-visible:ring-2 focus-visible:ring-ring",
              i === 0 ? "border-warning/55 bg-warning/15 text-warning" : "border-border bg-card text-secondary-foreground",
            )}
          >
            {a}
          </button>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// tab bodies
// ---------------------------------------------------------------------------

function LogsTab({ row, liveCount }: { row: DemoRow; liveCount: number }) {
  const [query, setQuery] = useState("");
  useEffect(() => setQuery(""), [row.id]);
  const lines = useMemo<DemoLine[]>(
    () => (row.id === "pl-daniel" ? [...row.lines, ...LIVE_SEQUENCE.slice(0, liveCount)] : row.lines),
    [row, liveCount],
  );
  const q = query.trim().toLowerCase();
  const matches = (line: DemoLine) =>
    q.length > 0 &&
    ((line.text ?? "").toLowerCase().includes(q) || (line.pills ?? []).some((p) => `${p.label} ${p.value}`.toLowerCase().includes(q)));
  const matchCount = q ? lines.filter(matches).length : 0;

  let lastStep: string | undefined;
  return (
    <>
      <div className="min-h-0 flex-1 overflow-y-auto pb-2 pt-1">
        {lines.map((line, i) => {
          const divider = line.step && line.step !== lastStep;
          lastStep = line.step ?? lastStep;
          const spec = LINE_ICON[line.kind];
          const Icon = spec.icon;
          const hit = matches(line);
          const dim = q.length > 0 && !hit;
          return (
            <div key={i}>
              {divider && (
                <div className="sticky top-0 z-10 flex items-center gap-2 bg-card px-3 pb-1 pt-2 text-[11px] font-semibold text-secondary-foreground">
                  {line.step}
                  <span aria-hidden className="h-px flex-1 bg-border/60" />
                </div>
              )}
              <div className={cn("flex items-start gap-2 px-3 py-[3px] pl-5 text-[12px]", line.kind === "pause" && "bg-info/6", dim && "opacity-35")}>
                <span className="mt-0.5 shrink-0 font-mono text-[10.5px] text-muted-foreground tabular-nums">{line.ts}</span>
                <span className="mt-0.5 w-3.5 shrink-0 text-center">
                  <Icon aria-hidden className={cn("size-3", spec.cls)} />
                </span>
                <span className={cn("min-w-0 break-words", LINE_TONE[line.kind] ?? "text-secondary-foreground", hit && "rounded-sm bg-info/15")}>
                  {line.system && <SystemChip system={line.system} />}
                  {line.text}
                  {line.pills?.map((p, pi) => <Pill key={pi} {...p} />)}
                  {line.attempt && (
                    <span className="ml-1.5 rounded border border-warning/40 px-1 text-[9.5px] font-bold text-warning">attempt {line.attempt}</span>
                  )}
                  {line.duration && <span className="ml-1.5 font-mono text-[10px] text-muted-foreground">{line.duration}</span>}
                </span>
              </div>
              {line.card === "gate" && <GateCardView row={row} />}
              {line.card === "failure" && <FailureCardView row={row} />}
            </div>
          );
        })}
        {row.id === "pl-daniel" && (
          <div className="flex items-center gap-2 px-5 py-1 text-[10.5px] text-muted-foreground">
            <span aria-hidden className="size-1.5 rounded-full bg-primary animate-pulse motion-reduce:animate-none" />
            live — streaming
          </div>
        )}
      </div>
      <div className="flex items-center gap-2 border-t border-border/60 px-3 py-1.5 text-[11.5px] text-muted-foreground">
        <label className="sr-only" htmlFor="demo-log-search">
          Search logs
        </label>
        <input
          id="demo-log-search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search logs…"
          className="w-40 rounded-md border border-border bg-secondary/40 px-2 py-0.5 text-[11.5px] text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
        {q && (
          <span className="font-mono text-[10.5px] tabular-nums">
            {matchCount} match{matchCount === 1 ? "" : "es"}
          </span>
        )}
        <span className="ml-auto inline-flex items-center gap-1.5">
          <span className="inline-flex items-center gap-0.5 rounded-md border border-border px-1.5 py-0.5">
            System <ChevronDown aria-hidden className="size-3" />
          </span>
          <span aria-hidden className={cn("size-1.5 rounded-full", row.status === "running" ? "bg-success" : "bg-muted-foreground/40")} />
        </span>
      </div>
    </>
  );
}

/**
 * Data tab — ONE surface, not two modes.
 *
 * Every value the run touched, in order, grouped by step, with where it came
 * from and when. The values the run READ are editable in place: change one and
 * the footer offers to start a fresh run from these values. So the audit view
 * and the "the extraction was wrong, fix it and go" path are the same screen —
 * you never have to switch modes to see what you are about to change, and you
 * never retype a whole input into the Run modal to correct one field.
 *
 * Writes are shown but never editable: what a run put into UCPath is a record
 * of what happened, not a form.
 */
function DataTab({ row }: { row: DemoRow }) {
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [seededFrom, setSeededFrom] = useState<number | null>(null);
  useEffect(() => {
    setEdits({});
    setSeededFrom(null);
  }, [row.id]);

  if (row.data.length === 0) {
    return <EmptyTab icon={Database} text="No data points recorded — this run has not read or written anything yet." />;
  }

  const reads = row.data.filter((d) => d.dir === "read");
  const writes = row.data.filter((d) => d.dir === "write");
  const staged = writes.filter((d) => d.staged).length;
  const steps = [...new Set(row.data.map((d) => d.step))];
  const changed = reads.filter((d) => edits[d.field] !== undefined && edits[d.field] !== d.value);
  const live = row.status === "running" || row.status === "queued";

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border/40 px-3 py-2 text-[11px] text-muted-foreground">
        <span className="inline-flex items-center gap-1 text-log-cyan">
          <ArrowDownToLine aria-hidden className="size-3" />
          {reads.length} read
        </span>
        {writes.length > 0 && (
          <span className="inline-flex items-center gap-1 text-log-teal">
            <ArrowUpFromLine aria-hidden className="size-3" />
            {writes.length} written
            {staged > 0 && <span className="rounded border border-warning/40 px-1 text-[9.5px] font-semibold text-warning">{staged} staged</span>}
          </span>
        )}
        <span className="ml-auto">
          {live ? "Values appear as the run reads them." : "Read values are editable — change one to launch a new run from it."}
        </span>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto pb-3">
        {steps.map((step) => (
          <div key={step}>
            <div className="flex items-center gap-2 px-3 pb-0.5 pt-2.5 text-[11px] font-semibold text-secondary-foreground">
              {step}
              <span aria-hidden className="h-px flex-1 bg-border/60" />
            </div>
            {row.data
              .filter((d) => d.step === step)
              .map((d, i) => {
                const editable = d.dir === "read" && !live;
                const value = edits[d.field] ?? d.value;
                const dirty = value !== d.value;
                return (
                  <div key={`${d.field}-${i}`} className="flex items-center gap-2.5 px-3 py-[5px] text-[12px] hover:bg-accent/30">
                    {d.dir === "read" ? (
                      <ArrowDownToLine aria-hidden className="size-3 shrink-0 text-log-cyan" />
                    ) : (
                      <ArrowUpFromLine aria-hidden className="size-3 shrink-0 text-log-teal" />
                    )}
                    <span className="flex w-36 shrink-0 items-center gap-1.5 truncate text-muted-foreground">
                      {d.field}
                      {dirty && <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-warning" />}
                    </span>
                    {editable ? (
                      <input
                        aria-label={`${d.field} — edit to launch a new run from this value`}
                        value={value}
                        onChange={(e) => setEdits((prev) => ({ ...prev, [d.field]: e.target.value }))}
                        className={cn(
                          "min-w-0 flex-1 rounded border bg-transparent px-1.5 py-0.5 font-mono text-[11.5px] text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring",
                          dirty ? "border-warning/50 bg-warning/5" : "border-transparent hover:border-border focus:border-border",
                        )}
                      />
                    ) : (
                      <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-foreground">{d.value}</span>
                    )}
                    {d.staged && <span className="shrink-0 rounded border border-warning/40 px-1 text-[9.5px] font-semibold text-warning">staged</span>}
                    <SystemChip system={d.system} />
                    <span className="w-14 shrink-0 text-right font-mono text-[10px] tabular-nums text-muted-foreground">{d.ts}</span>
                  </div>
                );
              })}
          </div>
        ))}
      </div>

      {!live && reads.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 border-t border-border/60 bg-secondary/20 px-3 py-2">
          <button
            type="button"
            onClick={() => {
              setSeededFrom(Math.max(row.run - 1, 1));
              setEdits(Object.fromEntries(reads.slice(0, 2).map((f) => [f.field, f.value])));
            }}
            className="inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-2.5 py-1 text-[11px] font-medium text-secondary-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <History aria-hidden className="size-3" />
            Load a prior run
          </button>
          <span className="text-[11px] text-muted-foreground">
            {seededFrom !== null && changed.length === 0
              ? `Loaded run #${seededFrom} — edit anything above.`
              : changed.length === 0
                ? "Unchanged — a new run would use exactly these values."
                : `${changed.length} value${changed.length === 1 ? "" : "s"} changed`}
          </span>
          <button
            type="button"
            onClick={() => {
              setEdits({});
              setSeededFrom(null);
            }}
            disabled={changed.length === 0 && seededFrom === null}
            className="ml-auto inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-2.5 py-1 text-[11px] font-medium text-secondary-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40"
          >
            <RotateCcw aria-hidden className="size-3" />
            Reset
          </button>
          <button
            type="button"
            onClick={NOOP}
            className="inline-flex items-center gap-1.5 rounded-md border border-primary/50 bg-primary/15 px-2.5 py-1 text-[11px] font-semibold text-primary outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Play aria-hidden className="size-3" />
            {changed.length > 0 ? "Start run with these values" : "Start a run from this data"}
          </button>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Review tab — ONE person at a time, page beside extraction.
// This is the surface the operator signs off from: every person is looked at
// individually before anything is approved, and Approve is gated on having
// actually walked the set.
// ---------------------------------------------------------------------------

const RECORD_STATE: Record<DemoRecord["state"], { label: string; cls: string }> = {
  ready: { label: "Ready", cls: "border-success/40 bg-success/12 text-success" },
  warn: { label: "Flagged", cls: "border-warning/45 bg-warning/12 text-warning" },
  blocked: { label: "Blocked", cls: "border-destructive/45 bg-destructive/12 text-destructive" },
};

const SOURCE_CHIP: Record<DemoRecordField["source"], { label: string; cls: string }> = {
  paper: { label: "paper", cls: "border-log-violet/35 text-log-violet" },
  roster: { label: "roster", cls: "border-log-teal/35 text-log-teal" },
  ucpath: { label: "UCPath", cls: "border-log-cyan/35 text-log-cyan" },
};

const CHECK_ICON: Record<DemoRecordCheck["state"], { icon: typeof Check; cls: string }> = {
  ok: { icon: Check, cls: "text-success" },
  warn: { icon: TriangleAlert, cls: "text-warning" },
  fail: { icon: X, cls: "text-destructive" },
};

function ReviewTab({ row }: { row: DemoRow }) {
  const records = row.records ?? [];
  const [idx, setIdx] = useState(0);
  const [reviewed, setReviewed] = useState<ReadonlySet<string>>(new Set());
  const [approved, setApproved] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => {
    setIdx(0);
    setReviewed(new Set());
    setApproved(new Set());
  }, [row.id]);

  if (records.length === 0) {
    return (
      <EmptyTab
        icon={ClipboardList}
        text="No records on this row. Only an OCR review row carries people to review — other rows show their decision in the banner above."
      />
    );
  }

  const rec = records[Math.min(idx, records.length - 1)];
  const approvable = records.filter((r) => r.state !== "blocked");
  const blocked = records.length - approvable.length;
  const nextFlagged = records.findIndex((r, i) => i > idx && r.state !== "ready");
  const mark = (set: ReadonlySet<string>, id: string) => new Set([...set, id]);
  const go = (n: number) => {
    setReviewed((s) => mark(s, rec.id));
    setIdx((c) => (c + n + records.length) % records.length);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* approve bar — the gate on the whole set */}
      <div className="flex items-center gap-2 border-b border-border/60 bg-secondary/20 px-3 py-1.5">
        <span aria-live="polite" className="font-mono text-[11px] tabular-nums text-foreground">
          {reviewed.size}/{records.length} reviewed
        </span>
        <span aria-hidden className="flex h-1 w-24 overflow-hidden rounded-full bg-secondary">
          <span className="bg-success/70" style={{ flexGrow: Math.max(reviewed.size, 0.001) }} />
          <span className="bg-border" style={{ flexGrow: Math.max(records.length - reviewed.size, 0.001) }} />
        </span>
        <span className="text-[11px] text-muted-foreground">
          {approved.size} approved · {blocked > 0 ? `${blocked} blocked` : "none blocked"}
        </span>
        <button
          type="button"
          onClick={NOOP}
          disabled={reviewed.size < records.length}
          title={reviewed.size < records.length ? "Look at every person first" : undefined}
          className="ml-auto inline-flex items-center gap-1.5 rounded-md border border-success/50 bg-success/15 px-2.5 py-1 text-[11px] font-semibold text-success outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40"
        >
          <CheckCircle2 aria-hidden className="size-3" />
          Approve {approvable.length} of {records.length}
        </button>
      </div>

      {/* conveyor */}
      <div className="flex items-center gap-1.5 border-b border-border/60 px-2.5 py-1.5">
        <IconActionButton tone="muted" icon={<ChevronLeft aria-hidden className="size-3.5" />} label="Previous person" onClick={() => go(-1)} />
        <span className="font-mono text-[10.5px] tabular-nums text-muted-foreground">
          {idx + 1}/{records.length}
        </span>
        <IconActionButton tone="muted" icon={<ChevronRight aria-hidden className="size-3.5" />} label="Next person" onClick={() => go(1)} />
        <span className="ml-1 min-w-0 truncate text-[13px] font-semibold text-foreground">{rec.name}</span>
        <span className="shrink-0 font-mono text-[10.5px] text-muted-foreground">{rec.eid}</span>
        <span className={cn("shrink-0 rounded-md border px-1.5 py-px text-[10px] font-semibold", RECORD_STATE[rec.state].cls)}>
          {RECORD_STATE[rec.state].label}
        </span>
        {reviewed.has(rec.id) && (
          <span className="inline-flex shrink-0 items-center gap-1 text-[10px] font-semibold text-success">
            <Check aria-hidden className="size-3" />
            reviewed
          </span>
        )}
        {nextFlagged >= 0 && (
          <button
            type="button"
            onClick={() => {
              setReviewed((s) => mark(s, rec.id));
              setIdx(nextFlagged);
            }}
            className="ml-auto inline-flex shrink-0 items-center gap-1 rounded-md border border-warning/45 bg-warning/10 px-2 py-0.5 text-[10.5px] font-semibold text-warning outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            Next flagged
            <ArrowRight aria-hidden className="size-3" />
          </button>
        )}
      </div>

      {/* page  ↔  extraction */}
      <div className="grid min-h-0 flex-1 grid-cols-1 gap-0 overflow-y-auto min-[860px]:grid-cols-[minmax(0,0.85fr)_minmax(0,1fr)]">
        <div className="flex flex-col gap-1.5 border-b border-border/60 p-3 min-[860px]:border-b-0 min-[860px]:border-r">
          <span className="text-[10px] uppercase tracking-wider text-muted-foreground">{rec.pageNote}</span>
          <div className="flex min-h-[13rem] flex-1 flex-col items-center justify-center gap-1.5 rounded-md border border-border bg-secondary/30">
            <FileText aria-hidden className="size-6 text-muted-foreground/60" />
            <span className="text-[11px] text-muted-foreground">Page {rec.page} — source image</span>
            <span className="text-[10px] text-muted-foreground/70">click to open full size</span>
          </div>
        </div>

        <div className="flex flex-col p-3">
          <span className="mb-1.5 text-[10px] uppercase tracking-wider text-muted-foreground">Extracted from this page</span>
          {rec.fields.map((f) => (
            <div key={f.label} className="flex items-baseline gap-2 border-b border-border/40 py-[5px] text-[12px] last:border-b-0">
              <span className="w-28 shrink-0 text-muted-foreground">{f.label}</span>
              <span className={cn("min-w-0 flex-1 font-mono text-[11.5px]", f.warn ? "text-warning" : "text-foreground")}>{f.value}</span>
              <span className={cn("shrink-0 rounded border px-1 text-[9px] font-semibold uppercase", SOURCE_CHIP[f.source].cls)}>
                {SOURCE_CHIP[f.source].label}
              </span>
              {f.confidence !== undefined && (
                <span
                  className={cn(
                    "w-8 shrink-0 text-right font-mono text-[10px] tabular-nums",
                    f.confidence < 0.6 ? "text-warning" : "text-muted-foreground",
                  )}
                >
                  {f.confidence.toFixed(2)}
                </span>
              )}
            </div>
          ))}
          {rec.fields.some((f) => f.warn) && (
            <p className="mt-1.5 text-[11px] leading-relaxed text-warning">{rec.fields.find((f) => f.warn)?.warn}</p>
          )}

          <span className="mb-1 mt-3 text-[10px] uppercase tracking-wider text-muted-foreground">Checks</span>
          {rec.checks.map((c) => {
            const spec = CHECK_ICON[c.state];
            const Icon = spec.icon;
            return (
              <div key={c.label} className="flex items-center gap-2 py-[3px] text-[12px]">
                <Icon aria-hidden className={cn("size-3 shrink-0", spec.cls)} />
                <span className="w-32 shrink-0 text-muted-foreground">{c.label}</span>
                <span className={cn("min-w-0 flex-1 truncate", c.state === "ok" ? "text-secondary-foreground" : spec.cls)}>{c.value}</span>
              </div>
            );
          })}

          {rec.note && (
            <p
              className={cn(
                "mt-2.5 rounded-md border px-2.5 py-1.5 text-[11px] leading-relaxed",
                rec.state === "blocked" ? "border-destructive/35 bg-destructive/6 text-destructive" : "border-warning/35 bg-warning/6 text-warning",
              )}
            >
              {rec.note}
            </p>
          )}
        </div>
      </div>

      {/* per-person decision */}
      <div className="flex items-center gap-1.5 border-t border-border/60 bg-secondary/20 px-3 py-2">
        <button
          type="button"
          disabled={rec.state === "blocked"}
          onClick={() => {
            setApproved((s) => mark(s, rec.id));
            setReviewed((s) => mark(s, rec.id));
          }}
          aria-pressed={approved.has(rec.id)}
          className={cn(
            "inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-[11px] font-semibold outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40",
            approved.has(rec.id) ? "border-success/60 bg-success/20 text-success" : "border-success/45 bg-success/10 text-success",
          )}
        >
          {approved.has(rec.id) ? <CheckCircle2 aria-hidden className="size-3" /> : <Check aria-hidden className="size-3" />}
          {approved.has(rec.id) ? "Approved" : "Approve this person"}
        </button>
        <button
          type="button"
          onClick={() => go(1)}
          className="inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-2.5 py-1 text-[11px] font-medium text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Ban aria-hidden className="size-3" />
          Skip for now
        </button>
        <span className="ml-auto text-[10.5px] text-muted-foreground">
          {rec.state === "blocked" ? "Blocked records are excluded from Approve." : "Approve releases only this person's work."}
        </span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// People tab — the Group Panel's per-person work surface.
// The matrix is the general lookup; the list beneath it is how you actually
// work through the set, one person at a time.
// ---------------------------------------------------------------------------

const PEOPLE_FILTERS = [
  { key: "attention", label: "Needs you" },
  { key: "all", label: "All" },
  { key: "done", label: "Finished" },
] as const;

function PeopleTab({
  row,
  onSelect,
  checkedIds,
}: {
  row: DemoRow;
  onSelect: (id: string) => void;
  checkedIds: ReadonlySet<string>;
}) {
  // default to the attention lane only when there IS one — otherwise the tab
  // opens on an empty list, which reads as "nothing here" on a full packet
  const startFilter = memberAttentionIds(row.id).length > 0 ? "attention" : "all";
  const [filter, setFilter] = useState<(typeof PEOPLE_FILTERS)[number]["key"]>(startFilter);
  useEffect(() => setFilter(startFilter), [row.id, startFilter]);
  const ordered = orderedMemberIds(row.id);
  if (ordered.length === 0) {
    return <EmptyTab icon={Users} text="No people yet — this group has not fanned out." />;
  }
  const attention = memberAttentionIds(row.id);
  const shown = ordered.filter((id) => {
    const m = DEMO_ROWS[id];
    if (filter === "all") return true;
    if (filter === "attention") return attention.includes(id) || m.displayOnly;
    return m.status === "verifiedDone";
  });
  const checkedCount = ordered.filter((id) => checkedIds.has(id)).length;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b border-border/60 px-3 py-1.5">
        <div className="inline-flex rounded-md border border-border bg-secondary/40 p-0.5">
          {PEOPLE_FILTERS.map((f) => (
            <button
              key={f.key}
              type="button"
              aria-pressed={filter === f.key}
              onClick={() => setFilter(f.key)}
              className={cn(
                "rounded px-2 py-0.5 text-[11px] outline-none focus-visible:ring-2 focus-visible:ring-ring",
                filter === f.key ? "bg-card font-semibold text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
              )}
            >
              {f.label}
              {f.key === "attention" && attention.length > 0 && <span className="ml-1 font-mono text-warning">{attention.length}</span>}
            </button>
          ))}
        </div>
        <span className="font-mono text-[10.5px] tabular-nums text-muted-foreground">
          {checkedCount}/{ordered.length} checked by you
        </span>
        <button
          type="button"
          onClick={() => onSelect(attention[0] ?? ordered[0])}
          className="ml-auto inline-flex items-center gap-1 rounded-md border border-primary/45 bg-primary/12 px-2 py-0.5 text-[10.5px] font-semibold text-primary outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          Review each person
          <ArrowRight aria-hidden className="size-3" />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {shown.map((id) => {
          const m = DEMO_ROWS[id];
          const spec = MEMBER_ROW_ICON[m.status];
          const Icon = m.displayOnly ? CircleSlash : spec.icon;
          return (
            <button
              key={id}
              type="button"
              onClick={() => onSelect(id)}
              className="flex w-full items-center gap-2 border-b border-border/40 px-3 py-1.5 text-left outline-none hover:bg-accent/30 focus-visible:ring-2 focus-visible:ring-ring"
            >
              <Icon aria-hidden className={cn("size-3.5 shrink-0", m.displayOnly ? "text-muted-foreground" : spec.cls)} />
              <span className="w-40 shrink-0 truncate text-[12.5px] font-medium text-foreground">{m.title}</span>
              <span className="w-20 shrink-0 font-mono text-[10.5px] text-muted-foreground">{m.eid ?? "—"}</span>
              <span className={cn("min-w-0 flex-1 truncate text-[11.5px]", m.status === "failed" ? "text-destructive" : "text-muted-foreground")}>
                {m.memberFact ?? m.outcome.text}
              </span>
              {checkedIds.has(id) && <Check aria-hidden className="size-3 shrink-0 text-success" />}
              <StatusBadge status={m.status} />
            </button>
          );
        })}
      </div>
    </div>
  );
}

function ReceiptTab({ row }: { row: DemoRow }) {
  const r = row.receipt;
  const toneCls =
    r.tone === "success"
      ? "border-success/35 bg-success/5"
      : r.tone === "warning"
        ? "border-warning/35 bg-warning/5"
        : r.tone === "destructive"
          ? "border-destructive/35 bg-destructive/5"
          : "border-border bg-secondary/20";
  const headCls =
    r.tone === "success" ? "text-success" : r.tone === "warning" ? "text-warning" : r.tone === "destructive" ? "text-destructive" : "text-secondary-foreground";
  const staged = row.data.filter((d) => d.staged);
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="flex flex-col gap-3 px-3 py-3">
        <div className={cn("rounded-lg border px-3 py-2.5", toneCls)}>
          <div className={cn("flex items-center gap-2 text-[12px] font-semibold", headCls)}>
            <ShieldCheck aria-hidden className="size-3.5" />
            {r.headline}
            {r.tone === "success" && (
              <span className="ml-auto rounded border border-success/40 px-1.5 text-[9.5px] font-semibold uppercase">verified</span>
            )}
          </div>
          {r.lines && (
            <div className={cn("mt-1.5 border-t pt-1.5", r.tone === "success" ? "border-success/20" : "border-border/50")}>
              {r.lines.map((l) => (
                <div key={l.label} className="flex items-center gap-2 py-[3px] text-[12px]">
                  <span className="w-36 shrink-0 text-muted-foreground">{l.label}</span>
                  <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-foreground">{l.value}</span>
                  {l.verified && (
                    <span className="inline-flex shrink-0 items-center gap-1 text-[10px] font-semibold text-success">
                      <Check aria-hidden className="size-3" />
                      read-back
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}
          {r.note && <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground">{r.note}</p>}
        </div>
        {staged.length > 0 && (
          <div>
            <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Staged — goes live on resume</div>
            <div className="rounded-lg border border-border bg-secondary/20 px-3 py-1.5">
              {staged.map((d) => (
                <div key={d.field} className="flex items-center gap-2 py-[3px] text-[12px]">
                  <ArrowUpFromLine aria-hidden className="size-3 text-log-teal" />
                  <span className="w-36 shrink-0 text-muted-foreground">{d.field}</span>
                  <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-foreground">{d.value}</span>
                  <SystemChip system={d.system} />
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function EmptyTab({ icon: Icon, text }: { icon: typeof Camera; text: string }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-6 py-10 text-center">
      <Icon aria-hidden className="size-5 text-muted-foreground/60" />
      <p className="max-w-[36ch] text-[11.5px] text-muted-foreground">{text}</p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// conveyor header (members)
// ---------------------------------------------------------------------------

function ConveyorHeader({
  row,
  onSelect,
  checkedIds,
}: {
  row: DemoRow;
  onSelect: (id: string) => void;
  checkedIds: ReadonlySet<string>;
}) {
  const siblings = orderedMemberIds(row.parentId ?? "");
  const idx = siblings.indexOf(row.id);
  const attention = memberAttentionIds(row.parentId ?? "");
  const nextAttention = attention.find((id) => siblings.indexOf(id) > idx) ?? attention[0];
  const total = siblings.length;
  const checkedCount = siblings.filter((id) => checkedIds.has(id)).length;
  return (
    <>
      <div className="flex items-center gap-1.5 border-b border-border/60 px-2.5 py-2">
        <IconActionButton
          tone="muted"
          icon={<ChevronLeft aria-hidden className="size-3.5" />}
          label="Previous member"
          onClick={() => onSelect(siblings[(idx - 1 + total) % total])}
        />
        <span className="font-mono text-[10.5px] text-muted-foreground tabular-nums">
          {idx + 1}/{total}
        </span>
        <IconActionButton
          tone="muted"
          icon={<ChevronRight aria-hidden className="size-3.5" />}
          label="Next member"
          onClick={() => onSelect(siblings[(idx + 1) % total])}
        />
        <span className="ml-1 min-w-0 truncate text-[13px] font-semibold text-foreground">{row.title}</span>
        <StatusBadge status={row.status} />
        {nextAttention && nextAttention !== row.id && (
          <button
            type="button"
            onClick={() => onSelect(nextAttention)}
            className="ml-auto inline-flex shrink-0 items-center gap-1 rounded-md border border-warning/45 bg-warning/10 px-2 py-0.5 text-[10.5px] font-semibold text-warning outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            Next attention
            <ArrowRight aria-hidden className="size-3" />
          </button>
        )}
      </div>
      <div className="flex items-center gap-2 border-b border-border/60 px-3 py-1.5 text-[10.5px] text-muted-foreground">
        <span aria-hidden className="flex h-1 flex-1 overflow-hidden rounded-full bg-secondary">
          <span className="bg-success/70" style={{ flexGrow: Math.max(checkedCount, 1) }} />
          <span className="bg-border" style={{ flexGrow: Math.max(total - checkedCount, 1) }} />
        </span>
        <span className="shrink-0 font-mono tabular-nums">
          {checkedCount}/{total} checked
        </span>
      </div>
    </>
  );
}

/**
 * Where this member came from. A packet member is a person the operator read off
 * a page — so the member panel carries a one-line provenance strip back to that
 * page and record, rather than making them hunt for it in the group.
 */
function MemberSourceBlock({ row, onSelect }: { row: DemoRow; onSelect: (id: string) => void }) {
  const parent = row.parentId ? DEMO_ROWS[row.parentId] : undefined;
  if (!parent) return null;
  const reviewRow = parent.reviewRunId ? DEMO_ROWS[parent.reviewRunId] : undefined;
  const record = reviewRow?.records?.find((r) => r.id === row.recordId);
  return (
    <div className="flex items-center gap-2 border-b border-border/60 bg-secondary/15 px-3 py-1.5 text-[11px]">
      <FileText aria-hidden className="size-3 shrink-0 text-muted-foreground" />
      <button
        type="button"
        onClick={() => onSelect(parent.id)}
        className="min-w-0 truncate text-left text-muted-foreground underline-offset-2 outline-none hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring"
      >
        {parent.title}
      </button>
      {record && (
        <>
          <span aria-hidden className="text-muted-foreground/50">·</span>
          <span className="shrink-0 text-muted-foreground">{record.pageNote}</span>
          <button
            type="button"
            onClick={() => onSelect(reviewRow!.id)}
            className="ml-auto shrink-0 rounded-md border border-info/40 px-2 py-0.5 text-[10.5px] font-semibold text-info outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            Open this person&apos;s record
          </button>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// the panel
// ---------------------------------------------------------------------------

const TAB_META: Record<DemoTab, { label: string; icon: typeof ScrollText }> = {
  people: { label: "People", icon: Users },
  review: { label: "Review", icon: ClipboardList },
  logs: { label: "Logs", icon: ScrollText },
  data: { label: "Data", icon: Database },
  receipt: { label: "Receipt", icon: Receipt },
};

const OUTCOME_TONE: Record<DemoRow["outcome"]["tone"], { bar: string; dot: string; btn: string }> = {
  warning: { bar: "border-warning/30 bg-warning/6 text-warning", dot: "bg-warning", btn: "border-warning/45 bg-warning/12 text-warning" },
  violet: { bar: "border-log-violet/30 bg-log-violet/6 text-log-violet", dot: "bg-log-violet", btn: "border-log-violet/45 bg-log-violet/12 text-log-violet" },
  info: { bar: "border-info/25 bg-info/5 text-info", dot: "bg-info", btn: "border-info/45 bg-info/12 text-info" },
  success: { bar: "border-success/25 bg-success/5 text-success", dot: "bg-success", btn: "border-success/45 bg-success/12 text-success" },
  destructive: { bar: "border-destructive/30 bg-destructive/6 text-destructive", dot: "bg-destructive", btn: "border-destructive/45 bg-destructive/12 text-destructive" },
  muted: { bar: "border-border bg-secondary/20 text-muted-foreground", dot: "bg-muted-foreground", btn: "border-border bg-card text-secondary-foreground" },
};

export function DemoLogPanel({ row, tab, onTab, onSelect, checkedIds, onToggleChecked, tick, liveCount }: DemoLogPanelProps) {
  const available = tabsFor(row);
  const fallback = defaultTabFor(row);
  const effectiveTab = tab && available.includes(tab) ? tab : fallback;
  const panel = panelKindSpec(row);
  const variant = rowVariantSpec(row);
  const isMember = row.rowType === "member";
  const tone = OUTCOME_TONE[row.outcome.tone];
  const elapsed = row.elapsedSec !== undefined ? fmtElapsed(row.elapsedSec + tick) : undefined;
  const attentionMember = isMember && (row.status === "failed" || row.status === "waiting" || row.status === "doneWarnings");

  return (
    <section aria-label="Run detail" className="flex min-h-0 flex-col overflow-hidden rounded-lg border border-border bg-card">
      {isMember ? (
        <>
          <ConveyorHeader row={row} onSelect={onSelect} checkedIds={checkedIds} />
          <MemberSourceBlock row={row} onSelect={onSelect} />
        </>
      ) : (
        <div className="flex items-center gap-2 border-b border-border/60 px-3 py-2.5">
          <span className="min-w-0 truncate text-[13.5px] font-semibold text-foreground">{row.title}</span>
          <StatusBadge status={row.status} />
          {elapsed && <span className="font-mono text-[10.5px] text-primary/85 tabular-nums">{elapsed}</span>}
          <span
            title={`${variant.name} → ${panel.name}`}
            className="ml-auto shrink-0 rounded border border-border px-1.5 py-px text-[9.5px] uppercase tracking-wider text-muted-foreground"
          >
            {panel.name}
          </span>
          <span className="shrink-0 font-mono text-[10.5px] text-muted-foreground">{row.trace}</span>
        </div>
      )}

      {/* cross-panel delegation link — the parent packet and its OCR review row
          point at each other instead of duplicating the run (D4). */}
      {(row.reviewRunId || row.reviewOf) && (
        <button
          type="button"
          onClick={() => onSelect((row.reviewRunId ?? row.reviewOf) as string)}
          className="flex items-center gap-2 border-b border-info/25 bg-info/6 px-3 py-1.5 text-left text-[11.5px] text-info outline-none hover:bg-info/10 focus-visible:ring-2 focus-visible:ring-ring"
        >
          <ClipboardList aria-hidden className="size-3.5 shrink-0" />
          <span className="min-w-0 truncate">
            {row.reviewRunId
              ? `Records live on the OCR review row — ${DEMO_ROWS[row.reviewRunId]?.records?.length ?? 0} people to review`
              : `Part of ${DEMO_ROWS[row.reviewOf as string]?.title ?? "the packet"} — open the packet row`}
          </span>
          <ArrowRight aria-hidden className="ml-auto size-3 shrink-0" />
        </button>
      )}

      {/* pinned outcome bar */}
      <div className={cn("flex items-center gap-2 border-b px-3 py-1.5", tone.bar)}>
        <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", tone.dot)} />
        <span className="min-w-0 truncate text-[11.5px]">{row.outcome.text}</span>
        {row.outcome.action && (
          <button
            type="button"
            onClick={NOOP}
            className={cn("ml-auto shrink-0 rounded-md border px-2.5 py-0.5 text-[10.5px] font-semibold outline-none focus-visible:ring-2 focus-visible:ring-ring", tone.btn)}
          >
            {row.outcome.action}
          </button>
        )}
      </div>


      {/* the gate is pinned above the tabs — visible from every tab, on every
          panel kind, instead of hiding inside a Review tab most rows lack */}
      {row.gate && panelKindOf(row) !== "review" && <GateBanner row={row} />}

      <Timeline row={row} />
      <EvidenceBar row={row} />

      {/* tabs — derived from the panel kind, never a fixed five */}
      <div role="tablist" className="flex items-center gap-0.5 border-b border-border/60 px-2.5 py-1.5 text-[12px]">
        {available.map((key, i) => {
          const active = effectiveTab === key;
          const meta = TAB_META[key];
          const Icon = meta.icon;
          const dot = (key === "review" && Boolean(row.records)) || (key === "people" && memberAttentionIds(row.id).length > 0);
          return (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => onTab(key)}
              title={`${meta.label} — press ${i + 1}`}
              className={cn(
                "relative inline-flex items-center gap-1.5 rounded-md px-2.5 py-0.5 outline-none focus-visible:ring-2 focus-visible:ring-ring",
                active ? "bg-accent font-semibold text-foreground" : "text-muted-foreground hover:text-foreground",
              )}
            >
              <Icon aria-hidden className="size-3" />
              {meta.label}
              {dot && <span aria-hidden className="absolute right-0.5 top-0.5 size-1.5 rounded-full bg-warning" />}
            </button>
          );
        })}
        <span className="ml-auto text-[9.5px] uppercase tracking-wider text-muted-foreground/70">
          {tab && available.includes(tab) ? panel.name : `${panel.name} · state default`}
        </span>
      </div>

      {effectiveTab === "logs" && <LogsTab row={row} liveCount={liveCount} />}
      {effectiveTab === "data" && <DataTab row={row} />}
      {effectiveTab === "review" && <ReviewTab row={row} />}
      {effectiveTab === "people" && <PeopleTab row={row} onSelect={onSelect} checkedIds={checkedIds} />}
      {effectiveTab === "receipt" && <ReceiptTab row={row} />}

      {/* member action bar */}
      {isMember && !row.displayOnly && (
        <div className="mt-auto flex items-center gap-1.5 border-t border-border/60 bg-secondary/20 px-3 py-2">
          {(row.status === "failed" || row.status === "doneWarnings") && (
            <button
              type="button"
              onClick={NOOP}
              className="inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-2.5 py-1 text-[11px] font-medium text-secondary-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <RotateCcw aria-hidden className="size-3" />
              Retry
            </button>
          )}
          <button
            type="button"
            onClick={() => onToggleChecked(row.id)}
            aria-pressed={checkedIds.has(row.id)}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-[11px] font-semibold outline-none focus-visible:ring-2 focus-visible:ring-ring",
              checkedIds.has(row.id)
                ? "border-success/60 bg-success/20 text-success"
                : "border-success/45 bg-success/10 text-success",
            )}
          >
            {checkedIds.has(row.id) ? <CheckCircle2 aria-hidden className="size-3" /> : <Check aria-hidden className="size-3" />}
            {checkedIds.has(row.id) ? "Checked" : "Mark checked"}
          </button>
          {attentionMember && (
            <button
              type="button"
              onClick={NOOP}
              className="inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-2.5 py-1 text-[11px] font-medium text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <Ban aria-hidden className="size-3" />
              Skip
            </button>
          )}
          <span className="ml-auto font-mono text-[10px] text-muted-foreground">
            <kbd className="rounded border border-border bg-card px-1">c</kbd> checks ·{" "}
            <kbd className="rounded border border-border bg-card px-1">n</kbd> next attention
          </span>
        </div>
      )}
    </section>
  );
}
