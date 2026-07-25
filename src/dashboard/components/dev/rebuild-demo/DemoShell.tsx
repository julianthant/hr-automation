import { useMemo, useState } from "react";
import {
  Activity,
  AlertTriangle,
  Ban,
  Bell,
  Calendar,
  Camera,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Clock3,
  Eye,
  FileScan,
  FileSignature,
  FileStack,
  FolderDown,
  HelpCircle,
  LayoutDashboard,
  Loader2,
  Pause,
  Plus,
  RotateCw,
  Search,
  Settings,
  ShieldCheck,
  Timer,
  UserMinus,
  UserPlus,
  UserSearch,
  Users,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { DEMO_ROWS, fmtElapsed, type DemoRow } from "./demo-data";
import type { ProposedStatus } from "../proposals/proposal-rows";

/**
 * DEV-ONLY — the replica shell around the rebuild demo.
 *
 * The queue and log panel were already faithful; everything AROUND them was
 * missing, so the demo could not be used to plan the real dashboard. This file
 * adds the other four named surfaces — Top Bar, Workflow Panel, Status Bar and
 * Session Panel — at production fidelity.
 *
 * One rule is load-bearing here and is the fix for the legacy "badges always
 * error out" bug: the Workflow Panel badges, the Status Bar pills and the
 * Queue Panel rows all read from `countRows` below. There is exactly ONE
 * counting path, so two surfaces can never disagree.
 */

const NOOP = () => {};

// ---------------------------------------------------------------------------
// One counting path — the whole point
// ---------------------------------------------------------------------------

export type StatusBucket = "all" | "attention" | "running" | "queued" | "done" | "failed" | "cancelled";

const ATTENTION: ProposedStatus[] = ["waiting", "parked", "failed", "doneWarnings"];

/** every top-level row (members belong to their group, never to the counts) */
export function topLevelRows(): DemoRow[] {
  return Object.values(DEMO_ROWS).filter((r) => r.rowType !== "member");
}

export function countRows(rows: DemoRow[]): Record<StatusBucket, number> {
  const out: Record<StatusBucket, number> = { all: 0, attention: 0, running: 0, queued: 0, done: 0, failed: 0, cancelled: 0 };
  for (const r of rows) {
    out.all += 1;
    if (ATTENTION.includes(r.status)) out.attention += 1;
    if (r.status === "running") out.running += 1;
    if (r.status === "queued") out.queued += 1;
    if (r.status === "verifiedDone" || r.status === "doneWarnings") out.done += 1;
    if (r.status === "failed") out.failed += 1;
    if (r.status === "cancelled") out.cancelled += 1;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Top Bar
// ---------------------------------------------------------------------------

export function DemoTopBar({
  view,
  onView,
  attention,
}: {
  view: "queue" | "catalog";
  onView: (v: "queue" | "catalog") => void;
  attention: number;
}) {
  return (
    <header className="flex h-11 shrink-0 items-center gap-3 border-b border-border bg-card px-3">
      <span className="flex items-center gap-2">
        <span className="flex size-6 items-center justify-center rounded-md bg-primary/15">
          <ShieldCheck aria-hidden className="size-3.5 text-primary" />
        </span>
        <span className="text-[13px] font-semibold text-foreground">HR Automation</span>
      </span>
      <span className="rounded-full border border-info/40 bg-info/10 px-2 py-px text-[9.5px] font-semibold uppercase tracking-wider text-info">
        rebuild demo · synthetic data
      </span>

      <div className="ml-2 inline-flex rounded-md border border-border bg-secondary/40 p-0.5">
        {(["queue", "catalog"] as const).map((v) => (
          <button
            key={v}
            type="button"
            aria-pressed={view === v}
            onClick={() => onView(v)}
            className={cn(
              "rounded px-2.5 py-0.5 text-[11.5px] outline-none focus-visible:ring-2 focus-visible:ring-ring",
              view === v ? "bg-card font-semibold text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
            )}
          >
            {v === "queue" ? "Dashboard" : "Row & panel catalog"}
          </button>
        ))}
      </div>

      <label className="ml-auto flex h-7 min-w-0 max-w-[220px] flex-1 items-center gap-1.5 rounded-md border border-border bg-secondary/40 px-2">
        <Search aria-hidden className="size-3 shrink-0 text-muted-foreground" />
        <span className="sr-only">Search runs</span>
        <input
          placeholder="Search people, files, trace ids…"
          className="min-w-0 flex-1 bg-transparent text-[11.5px] text-foreground outline-none placeholder:text-muted-foreground"
        />
        <kbd className="shrink-0 rounded border border-border bg-card px-1 font-mono text-[9px] text-muted-foreground">/</kbd>
      </label>

      <span className="flex shrink-0 items-center gap-0.5">
        <button type="button" aria-label="Previous day" onClick={NOOP} className="rounded-md p-1 text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
          <ChevronLeft aria-hidden className="size-3.5" />
        </button>
        <button type="button" onClick={NOOP} className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[11.5px] text-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring">
          <Calendar aria-hidden className="size-3 text-muted-foreground" />
          Sat, Jul 25
        </button>
        <button type="button" aria-label="Next day" onClick={NOOP} className="rounded-md p-1 text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
          <ChevronRight aria-hidden className="size-3.5" />
        </button>
      </span>

      <span className="flex shrink-0 items-center gap-0.5">
        <button type="button" aria-label={`Notifications — ${attention} need you`} onClick={NOOP} className="relative rounded-md p-1.5 text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
          <Bell aria-hidden className="size-3.5" />
          {attention > 0 && (
            <span className="absolute -right-0.5 -top-0.5 flex size-3.5 items-center justify-center rounded-full bg-warning text-[8.5px] font-bold text-background">
              {attention}
            </span>
          )}
        </button>
        <button type="button" aria-label="Shortcuts" onClick={NOOP} className="rounded-md p-1.5 text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
          <HelpCircle aria-hidden className="size-3.5" />
        </button>
        <button type="button" aria-label="Settings" onClick={NOOP} className="rounded-md p-1.5 text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
          <Settings aria-hidden className="size-3.5" />
        </button>
      </span>
    </header>
  );
}

// ---------------------------------------------------------------------------
// Workflow Panel (left rail)
// ---------------------------------------------------------------------------

interface RailEntry {
  label: string;
  icon: typeof Users;
}

const RAIL_GROUPS: { label: string; entries: RailEntry[] }[] = [
  {
    label: "People",
    entries: [
      { label: "Separations", icon: UserMinus },
      { label: "Onboarding", icon: UserPlus },
      { label: "Person Lookup", icon: UserSearch },
      { label: "Work-Study", icon: Users },
      { label: "Kronos Pay Rule", icon: Timer },
    ],
  },
  {
    label: "Documents",
    entries: [
      { label: "OCR", icon: FileScan },
      { label: "Oath Signature", icon: FileSignature },
      { label: "Oath Upload", icon: FileStack },
      { label: "Emergency Contact", icon: ShieldCheck },
      { label: "OnBase", icon: FileStack },
      { label: "I-9 Check", icon: FileScan },
    ],
  },
  { label: "Data", entries: [{ label: "CRM Doc Download", icon: FolderDown }, { label: "Kronos Reports", icon: FolderDown }] },
];

export function DemoWorkflowPanel({ active, onActive }: { active: string; onActive: (label: string) => void }) {
  const counts = useMemo(() => {
    const map = new Map<string, { total: number; attention: number }>();
    for (const r of topLevelRows()) {
      const e = map.get(r.wfLabel) ?? { total: 0, attention: 0 };
      e.total += 1;
      if (ATTENTION.includes(r.status)) e.attention += 1;
      map.set(r.wfLabel, e);
    }
    return map;
  }, []);

  return (
    <nav aria-label="Workflow Panel" className="flex w-[190px] shrink-0 flex-col overflow-y-auto border-r border-border bg-sidebar/40 py-2">
      <button
        type="button"
        aria-pressed={active === "All"}
        onClick={() => onActive("All")}
        className={cn(
          "mx-2 mb-2 flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12.5px] outline-none focus-visible:ring-2 focus-visible:ring-ring",
          active === "All" ? "bg-accent font-semibold text-foreground shadow-[inset_2px_0_0_var(--primary)]" : "text-muted-foreground hover:text-foreground",
        )}
      >
        <LayoutDashboard aria-hidden className="size-3.5 shrink-0" />
        Dashboard
      </button>

      {RAIL_GROUPS.map((g) => (
        <div key={g.label} className="mb-1.5">
          <div className="px-4 pb-1 pt-1.5 text-[9.5px] font-semibold uppercase tracking-wider text-muted-foreground/70">{g.label}</div>
          {g.entries.map((e) => {
            const c = counts.get(e.label);
            const on = active === e.label;
            const Icon = e.icon;
            return (
              <button
                key={e.label}
                type="button"
                aria-pressed={on}
                onClick={() => onActive(e.label)}
                className={cn(
                  "mx-2 flex w-[calc(100%-1rem)] items-center gap-2 rounded-md px-2 py-1 text-left text-[12px] outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  on ? "bg-accent font-semibold text-foreground shadow-[inset_2px_0_0_var(--primary)]" : "text-muted-foreground hover:text-foreground",
                )}
              >
                <Icon aria-hidden className="size-3.5 shrink-0" />
                <span className="min-w-0 flex-1 truncate">{e.label}</span>
                {c && c.total > 0 && (
                  <span
                    className={cn(
                      "shrink-0 rounded px-1 font-mono text-[10px] tabular-nums",
                      c.attention > 0 ? "bg-warning/15 text-warning" : "bg-secondary text-muted-foreground",
                    )}
                  >
                    {c.total}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      ))}

      <p className="mt-auto px-4 pt-3 text-[9.5px] leading-relaxed text-muted-foreground/70">
        Badges, Status Bar pills and the queue all read one server projection — they cannot disagree.
      </p>
    </nav>
  );
}

// ---------------------------------------------------------------------------
// Status Bar (count pills)
// ---------------------------------------------------------------------------

const PILLS: { key: StatusBucket; label: string; icon: typeof Eye; tone: string }[] = [
  { key: "all", label: "All", icon: LayoutDashboard, tone: "text-muted-foreground" },
  { key: "attention", label: "Needs you", icon: Eye, tone: "text-warning" },
  { key: "running", label: "Running", icon: Loader2, tone: "text-primary" },
  { key: "queued", label: "Queued", icon: Clock3, tone: "text-muted-foreground" },
  { key: "done", label: "Done", icon: CheckCircle2, tone: "text-success" },
  { key: "failed", label: "Failed", icon: AlertTriangle, tone: "text-destructive" },
  { key: "cancelled", label: "Cancelled", icon: Ban, tone: "text-warning" },
];

export function DemoStatusBar({
  counts,
  active,
  onSelect,
}: {
  counts: Record<StatusBucket, number>;
  active: StatusBucket;
  onSelect: (b: StatusBucket) => void;
}) {
  return (
    <div role="group" aria-label="Status Bar" className="flex flex-wrap items-center gap-1 border-b border-border/60 px-2 py-1.5">
      {PILLS.map((p) => {
        const Icon = p.icon;
        const on = active === p.key;
        const n = counts[p.key];
        return (
          <button
            key={p.key}
            type="button"
            aria-pressed={on}
            onClick={() => onSelect(p.key)}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-[11px] outline-none focus-visible:ring-2 focus-visible:ring-ring",
              on ? "border-primary/45 bg-primary/12 font-semibold text-foreground" : "border-border bg-card text-muted-foreground hover:text-foreground",
              n === 0 && !on && "opacity-45",
            )}
          >
            <Icon aria-hidden className={cn("size-3", p.tone, p.key === "running" && n > 0 && "animate-spin motion-reduce:animate-none")} />
            {p.label}
            <span className="font-mono tabular-nums">{n}</span>
          </button>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Session Panel (bottom drawer)
// ---------------------------------------------------------------------------

type BrowserHealth = "healthy" | "refreshing" | "unhealthy" | "failed" | "paused";
type SessionPhase = "authenticating" | "running" | "idle" | "keepalive" | "complete" | "failed";

interface DemoBrowser {
  id: string;
  label: string;
  health: BrowserHealth;
  url: string;
}

interface DemoSession {
  id: string;
  workflow: string;
  phase: SessionPhase;
  /** shown only while an item is in flight — a retained trace id on an idle card reads as stale */
  traceId?: string;
  step?: string;
  subline: string;
  elapsedSec: number;
  browsers: DemoBrowser[];
}

const DEMO_SESSIONS: DemoSession[] = [
  {
    id: "s-sep",
    workflow: "Separations",
    phase: "running",
    traceId: "se-140211-9f3a",
    step: "UCPath transaction",
    subline: "se-140211-9f3a",
    elapsedSec: 1112,
    browsers: [
      { id: "b1", label: "kuali", health: "healthy", url: "kuali.ucsd.edu/space/HR" },
      { id: "b2", label: "ucpath", health: "healthy", url: "ucpath.universityofcalifornia.edu" },
      { id: "b3", label: "kronos", health: "refreshing", url: "kronos.ucsd.edu/timekeeping" },
    ],
  },
  {
    id: "s-i9",
    workflow: "I-9 Check",
    phase: "running",
    traceId: "ic-134001-m31",
    step: "Person lookup",
    subline: "ic-134001-m31",
    elapsedSec: 2410,
    browsers: [{ id: "b4", label: "ucpath", health: "healthy", url: "ucpath…/PersonSearch" }],
  },
  {
    id: "s-ocr",
    workflow: "OCR",
    phase: "idle",
    subline: "idle — waiting for work",
    elapsedSec: 384,
    browsers: [{ id: "b5", label: "i9", health: "healthy", url: "i9.ucsd.edu" }],
  },
  {
    id: "s-oath",
    workflow: "Oath Signature",
    phase: "authenticating",
    subline: "Authenticating 1/2",
    elapsedSec: 41,
    browsers: [
      { id: "b6", label: "crm", health: "unhealthy", url: "stuck on the SSO login page" },
      { id: "b7", label: "ucpath", health: "paused", url: "auto-recovery paused by you" },
    ],
  },
  {
    id: "s-crm",
    workflow: "CRM Doc Download",
    phase: "failed",
    subline: "Crashed on launch — browser never opened",
    elapsedSec: 0,
    browsers: [{ id: "b8", label: "crm", health: "failed", url: "about:blank" }],
  },
];

const PHASE_TONE: Record<SessionPhase, { dot: string; label: string; text: string }> = {
  running: { dot: "bg-success", label: "Running", text: "text-success" },
  authenticating: { dot: "bg-warning animate-pulse motion-reduce:animate-none", label: "Authenticating", text: "text-warning" },
  idle: { dot: "bg-muted-foreground/60", label: "Idle", text: "text-muted-foreground" },
  keepalive: { dot: "bg-info", label: "Keep-alive", text: "text-info" },
  complete: { dot: "bg-success/60", label: "Complete", text: "text-muted-foreground" },
  failed: { dot: "bg-destructive", label: "Failed", text: "text-destructive" },
};

const HEALTH_TONE: Record<BrowserHealth, { cls: string; icon: typeof Activity; label: string }> = {
  healthy: { cls: "border-border bg-secondary/40 text-muted-foreground", icon: CheckCircle2, label: "Ready" },
  refreshing: { cls: "border-info/45 bg-info/10 text-info", icon: RotateCw, label: "Refreshing" },
  unhealthy: { cls: "border-warning/45 bg-warning/10 text-warning", icon: AlertTriangle, label: "Unhealthy" },
  failed: { cls: "border-destructive/45 bg-destructive/10 text-destructive", icon: AlertTriangle, label: "Failed" },
  paused: { cls: "border-log-violet/45 bg-log-violet/10 text-log-violet", icon: Pause, label: "Paused" },
};

function BrowserTile({ b }: { b: DemoBrowser }) {
  const tone = HEALTH_TONE[b.health];
  const Icon = tone.icon;
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      {/* Zero chrome at rest — the state word owns the full tile width. An
          earlier design crammed six hover glyphs in here and crushed
          "Refreshing" to "R". Actions live behind a right-click menu. */}
      <div
        role="button"
        tabIndex={0}
        aria-haspopup="menu"
        aria-expanded={open}
        title={`${b.label} — ${tone.label} · ${b.url}\nRight-click (two-finger click) for browser actions`}
        onContextMenu={(e) => {
          e.preventDefault();
          setOpen((v) => !v);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setOpen((v) => !v);
          }
        }}
        className={cn(
          "flex w-[112px] cursor-pointer flex-col gap-0.5 rounded-md border px-2 py-1 outline-none focus-visible:ring-2 focus-visible:ring-ring",
          tone.cls,
          open && "ring-1 ring-ring/60",
        )}
      >
        <span className="flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider">
          <Icon aria-hidden className={cn("size-3 shrink-0", b.health === "refreshing" && "animate-spin motion-reduce:animate-none")} />
          {b.label}
        </span>
        <span className="truncate text-[10px] opacity-80">{tone.label}</span>
      </div>
      {open && (
        <div role="menu" className="absolute bottom-full left-0 z-20 mb-1 w-44 overflow-hidden rounded-md border border-border bg-popover py-1 shadow-lg">
          {["Peek (live screenshot)", "Check now", "Bring to front", "Refresh page", "Reopen tab", b.health === "paused" ? "Resume auto-recovery" : "Pause auto-recovery"].map(
            (item, i) => (
              <button
                key={item}
                type="button"
                role="menuitem"
                onClick={() => setOpen(false)}
                className={cn(
                  "flex w-full items-center gap-2 px-2.5 py-1 text-left text-[11.5px] text-secondary-foreground outline-none hover:bg-accent focus-visible:bg-accent",
                  (i === 1 || i === 5) && "border-t border-border/60",
                )}
              >
                {i === 0 && <Camera aria-hidden className="size-3" />}
                {item}
              </button>
            ),
          )}
        </div>
      )}
    </div>
  );
}

function SessionCard({ s, tick }: { s: DemoSession; tick: number }) {
  const tone = PHASE_TONE[s.phase];
  const inFlight = s.phase === "running";
  return (
    <article className={cn("flex w-[268px] shrink-0 flex-col rounded-lg border bg-card p-2.5", s.phase === "failed" ? "border-destructive/40" : "border-border")}>
      <div className="flex items-center gap-2">
        <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", tone.dot)} />
        {/* the trailing instance ordinal is always stripped from the title */}
        <span className="min-w-0 truncate text-[12.5px] font-semibold text-foreground">{s.workflow}</span>
        <span className={cn("ml-auto shrink-0 text-[10px] font-semibold uppercase tracking-wider", tone.text)}>{tone.label}</span>
      </div>
      <span className={cn("mt-0.5 truncate text-[10.5px]", inFlight ? "font-mono text-muted-foreground" : "text-muted-foreground")}>{s.subline}</span>

      <div className="mt-1.5 flex flex-wrap gap-1">
        {s.browsers.map((b) => (
          <BrowserTile key={b.id} b={b} />
        ))}
      </div>

      <div className="mt-1.5 flex items-center gap-2 border-t border-border/60 pt-1.5 text-[10px] text-muted-foreground">
        <span className="font-mono tabular-nums">{s.elapsedSec > 0 ? fmtElapsed(s.elapsedSec + tick) : "—"}</span>
        <span className="min-w-0 flex-1 truncate">{s.step ?? ""}</span>
        <button
          type="button"
          onClick={NOOP}
          className="shrink-0 rounded border border-border px-1.5 py-px text-[10px] text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        >
          stop
        </button>
      </div>
    </article>
  );
}

export function DemoSessionPanel({ tick }: { tick: number }) {
  const [open, setOpen] = useState(false);
  const running = DEMO_SESSIONS.filter((s) => s.phase === "running").length;
  const auth = DEMO_SESSIONS.filter((s) => s.phase === "authenticating").length;
  const idle = DEMO_SESSIONS.filter((s) => s.phase === "idle" || s.phase === "keepalive").length;
  const failed = DEMO_SESSIONS.filter((s) => s.phase === "failed").length;
  const sickBrowsers = DEMO_SESSIONS.flatMap((s) => s.browsers).filter((b) => b.health !== "healthy").length;

  return (
    <section aria-label="Session Panel" className="shrink-0 border-t border-border bg-card">
      <div className="flex h-9 items-center gap-3 px-3">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="flex min-w-0 flex-1 items-center gap-3 rounded-md px-1 py-1 text-left outline-none hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-ring"
        >
          {open ? <ChevronDown aria-hidden className="size-3.5 shrink-0 text-muted-foreground" /> : <ChevronUp aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />}
          <span className="text-[11.5px] font-medium text-foreground">Sessions</span>
          {/* 3-way split — a daemon that is alive but has not reported a phase is
              still AUTHENTICATING, never idle. Calling it idle misreads capacity. */}
          <span className="flex items-center gap-2.5 text-[11px] text-muted-foreground">
            <span className="inline-flex items-center gap-1">
              <span aria-hidden className="size-1.5 rounded-full bg-success" />
              {running} running
            </span>
            <span className="inline-flex items-center gap-1">
              <span aria-hidden className="size-1.5 rounded-full bg-warning animate-pulse motion-reduce:animate-none" />
              {auth} authenticating
            </span>
            <span className="inline-flex items-center gap-1">
              <span aria-hidden className="size-1.5 rounded-full bg-muted-foreground/60" />
              {idle} idle
            </span>
            {failed > 0 && (
              <span className="inline-flex items-center gap-1 text-destructive">
                <span aria-hidden className="size-1.5 rounded-full bg-destructive" />
                {failed} failed
              </span>
            )}
          </span>
          {sickBrowsers > 0 && (
            <span className="inline-flex items-center gap-1 rounded border border-warning/40 bg-warning/10 px-1.5 py-px text-[10px] text-warning">
              <AlertTriangle aria-hidden className="size-3" />
              {sickBrowsers} browsers need attention
            </span>
          )}
        </button>
        <span className="flex shrink-0 items-center gap-1.5">
          <button
            type="button"
            aria-label="Add a worker"
            onClick={NOOP}
            className="rounded-md p-1 text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Plus aria-hidden className="size-3.5" />
          </button>
          <span className="inline-flex items-center gap-1 text-[10.5px] text-success">
            <span aria-hidden className="size-1.5 rounded-full bg-success animate-pulse motion-reduce:animate-none" />
            Live
          </span>
        </span>
      </div>

      {open && (
        <div className="flex gap-2 overflow-x-auto border-t border-border/60 px-3 py-2.5">
          {DEMO_SESSIONS.map((s) => (
            <SessionCard key={s.id} s={s} tick={tick} />
          ))}
        </div>
      )}
    </section>
  );
}
