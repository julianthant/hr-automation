import { useState, type ReactNode } from "react";
import {
  AlertTriangle,
  ArrowRight,
  ArrowUpRight,
  Ban,
  Camera,
  Check,
  CheckCircle2,
  ChevronsUp,
  CircleHelp,
  ClipboardList,
  Clock,
  CornerDownRight,
  Eye,
  Hourglass,
  KeyRound,
  LayoutGrid,
  Loader2,
  Pause,
  Plus,
  RotateCcw,
  RotateCw,
  SearchX,
  Trash2,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { TooltipProvider } from "@/components/ui/tooltip";
import { IconActionButton } from "@/components/shared/IconActionButton";
import { StatusCounts } from "@/components/queue-panel/StatusCounts";
import { DemoRowCard, type DemoQueueHandlers, type DemoQueueState } from "./rebuild-demo/DemoQueue";
import { DemoLogPanel } from "./rebuild-demo/DemoLogPanel";
import { PANEL_KINDS, ROW_VARIANTS } from "./rebuild-demo/demo-catalog";
import { PROPOSED_STATUS, StatusBadge, type ProposedStatus } from "./rebuild-demo/demo-status";
import { DEMO_ROWS, groupCounts } from "./rebuild-demo/demo-data";

/**
 * DEV-ONLY — `?view=ui-gallery`.
 *
 * The dashboard's **specimen catalog**: every named surface of the rebuild,
 * one at a time, with its name, what it is, and where it is used. This is the
 * reference you point at when you say "make it look like X" — the demo
 * (`?view=rebuild-demo`) shows the surfaces WORKING TOGETHER, this shows them
 * INDIVIDUALLY and names them.
 *
 * Specimens render the demo's own components against the demo's world model,
 * so the catalog cannot drift from the thing it documents. The old "Proposals"
 * tab is retired — its 26 toggle mocks were a decision surface for choices that
 * are now built and visible here.
 */

const NOOP = () => {};

const STATIC_STATE: DemoQueueState = {
  view: { kind: "queue" },
  filter: "all",
  selectedId: "",
  checkedIds: new Set(),
  expandedGroups: new Set(["oath-summer", "oath-batch"]),
  tick: 0,
};

const STATIC_HANDLERS: DemoQueueHandlers = {
  onSelect: NOOP,
  onFilter: NOOP,
  onDrillIn: NOOP,
  onBack: NOOP,
  onToggleGroup: NOOP,
};

// ===========================================================================
// Catalog chrome
// ===========================================================================

function Specimen({
  name,
  kind,
  what,
  where,
  width,
  children,
}: {
  name: string;
  kind: string;
  what: string;
  where?: string;
  width?: number;
  children: ReactNode;
}) {
  return (
    <section className="overflow-hidden rounded-lg border border-border bg-card/30">
      <header className="border-b border-border/60 bg-secondary/20 px-3 py-2">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <h3 className="text-[13.5px] font-semibold text-foreground">{name}</h3>
          <span className="rounded border border-border px-1.5 py-px text-[9.5px] uppercase tracking-wider text-muted-foreground">{kind}</span>
        </div>
        <p className="mt-1 text-[11.5px] leading-relaxed text-muted-foreground">{what}</p>
        {where && <p className="mt-0.5 font-mono text-[10.5px] text-muted-foreground/80">{where}</p>}
      </header>
      <div className="p-3" style={width ? { width: `min(100%, ${width}px)` } : undefined}>
        {children}
      </div>
    </section>
  );
}

function Section({ title, sub }: { title: string; sub: string }) {
  return (
    <div className="col-span-full mt-8 first:mt-0">
      <h2 className="text-[16px] font-bold text-foreground">{title}</h2>
      <p className="mt-0.5 text-[12px] text-muted-foreground">{sub}</p>
    </div>
  );
}

/** a labelled swatch for the small named pieces */
function Chip({ name, note, children }: { name: string; note?: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5 rounded-md border border-border/60 bg-card/40 px-2.5 py-2">
      <div className="flex min-h-[26px] items-center">{children}</div>
      <div>
        <div className="text-[11.5px] font-medium text-foreground">{name}</div>
        {note && <div className="text-[10.5px] leading-snug text-muted-foreground">{note}</div>}
      </div>
    </div>
  );
}

// ===========================================================================
// TAB 1 — Queue Rows
// ===========================================================================

function QueueRowsTab() {
  return (
    <div className="grid grid-cols-1 gap-3 min-[1500px]:grid-cols-2">
      <Section
        title="Queue Rows — 8 named variants over 3 types"
        sub="The row TYPE is structural (Run / Group / Member). The VARIANT is what the row is about, and it decides the title rule, what the body carries, and which Log Panel you land in."
      />
      {ROW_VARIANTS.map((v) => {
        const row = v.exampleId ? DEMO_ROWS[v.exampleId] : undefined;
        if (!row) return null;
        return (
          <Specimen
            key={v.key}
            name={v.name}
            kind={v.rowType}
            what={v.subject}
            where={v.workflows.map((w) => `${w.code} ${w.label}`).join(" · ")}
            width={480}
          >
            <DemoRowCard row={row} state={STATIC_STATE} handlers={STATIC_HANDLERS} />
            <p className="mt-2 rounded-md border border-warning/30 bg-warning/6 px-2.5 py-1.5 text-[11px] leading-relaxed text-warning">{v.gotcha}</p>
          </Specimen>
        );
      })}

      <Section title="Row states" sub="The same row across all eight statuses — the whole status vocabulary of the rebuild, replacing six near-identical status maps and three resolvers that decoded status out of step strings." />
      <div className="col-span-full grid grid-cols-2 gap-2 min-[1100px]:grid-cols-4">
        {(Object.keys(PROPOSED_STATUS) as ProposedStatus[]).map((s) => {
          const spec = PROPOSED_STATUS[s];
          const Icon = spec.icon;
          return (
            <Chip key={s} name={spec.label} note={spec.meaning}>
              <span className="flex items-center gap-2">
                <Icon aria-hidden className={cn("size-3.5", spec.iconClass)} />
                <StatusBadge status={s} />
              </span>
            </Chip>
          );
        })}
      </div>

      <Section title="Group density ladder" sub="Member count is a continuous property, so scale is presentation — never a fourth row type." />
      <Specimen
        name="Member list"
        kind="≤ 20 members"
        what="Compact person lines inline under the group, attention-first, first four then Show all. Each line is the one fact that distinguishes that person's outcome."
        where="Packet Group Row · small Roster Group Row"
        width={480}
      >
        <DemoRowCard row={DEMO_ROWS["oath-batch"]} state={STATIC_STATE} handlers={STATIC_HANDLERS} />
      </Specimen>
      <Specimen
        name="Status matrix + attention band"
        kind="20+ members"
        what="One cell per person as the general lookup, plus a band naming exactly who needs you and a Start review that walks them one at a time. The matrix is never the review."
        where="Roster Group Row — I-9 Check quarterly retention"
        width={480}
      >
        <DemoRowCard row={DEMO_ROWS["i9-batch"]} state={STATIC_STATE} handlers={STATIC_HANDLERS} />
      </Specimen>
    </div>
  );
}

// ===========================================================================
// TAB 2 — Log Panels
// ===========================================================================

function LogPanelsTab() {
  return (
    <div className="grid grid-cols-1 gap-3">
      <Section
        title="Log Panels — 4 kinds, tabs derived not fixed"
        sub="One Log Panel surface; the tab set comes from the row you selected. Screenshots is not a tab — evidence is a bar above the tabs. Review exists only where records exist."
      />
      {PANEL_KINDS.map((p) => {
        const row = p.exampleId ? DEMO_ROWS[p.exampleId] : undefined;
        if (!row) return null;
        return (
          <Specimen key={p.key} name={p.name} kind={`tabs: ${p.tabs.join(" · ")}`} what={p.forRows} where={`Opens on: ${p.defaultTab}`}>
            <div className="h-[580px] overflow-hidden rounded-lg border border-border">
              <DemoLogPanel row={row} tab={null} onTab={NOOP} onSelect={NOOP} checkedIds={new Set()} onToggleChecked={NOOP} tick={0} liveCount={0} />
            </div>
            <ul className="mt-2 flex flex-col gap-0.5">
              {p.specifics.map((s) => (
                <li key={s} className="flex gap-1.5 text-[11px] text-muted-foreground">
                  <span aria-hidden className="mt-[6px] size-1 shrink-0 rounded-full bg-muted-foreground/60" />
                  <span>{s}</span>
                </li>
              ))}
            </ul>
          </Specimen>
        );
      })}
    </div>
  );
}

// ===========================================================================
// TAB 3 — Session Cards
// ===========================================================================

const TILE_STATES = {
  ready: { label: "Ready", cls: "border-success/30 bg-success/10 text-success", icon: Check },
  authing: { label: "Authing", cls: "border-info/30 bg-info/10 text-info", icon: Loader2 },
  duo: { label: "Duo", cls: "border-warning/40 bg-warning/10 text-warning", icon: KeyRound },
  pending: { label: "Pending", cls: "border-border/60 bg-muted/20 text-muted-foreground", icon: Hourglass },
  refreshing: { label: "Refreshing", cls: "border-info/40 bg-info/10 text-info", icon: RotateCw },
  unhealthy: { label: "Unhealthy", cls: "border-warning/40 bg-warning/10 text-warning", icon: AlertTriangle },
  failed: { label: "Failed", cls: "border-destructive/50 bg-destructive/10 text-destructive", icon: AlertTriangle },
  paused: { label: "Paused", cls: "border-log-violet/45 bg-log-violet/10 text-log-violet", icon: Pause },
  unknown: { label: "Not checked", cls: "border-border bg-secondary/20 text-muted-foreground", icon: CircleHelp },
} as const;

type TileState = keyof typeof TILE_STATES;

interface CardSpec {
  name: string;
  what: string;
  phase: "Running" | "Authenticating" | "Idle" | "Keep-alive" | "Complete" | "Failed" | "Launch failed";
  tone: string;
  workflow: string;
  subline: string;
  mono?: boolean;
  elapsed: string;
  step?: string;
  queued?: number;
  tiles: { label: string; state: TileState }[];
  steps?: ("done" | "current" | "pending")[];
  crashed?: boolean;
}

const CARD_SPECS: CardSpec[] = [
  {
    name: "Running · item in flight",
    what: "The only state where the subtitle is a trace id — the id of the run this daemon is executing right now, identical to that run's queue-row subtitle. That is how you correlate a card to a row.",
    phase: "Running",
    tone: "text-success",
    workflow: "Separations",
    subline: "se-140211-9f3a",
    mono: true,
    elapsed: "18m 44s",
    step: "UCPath transaction",
    queued: 2,
    steps: ["done", "done", "done", "done", "current", "pending"],
    tiles: [
      { label: "kuali", state: "ready" },
      { label: "ucpath", state: "ready" },
      { label: "kronos", state: "refreshing" },
    ],
  },
  {
    name: "Authenticating",
    what: "Alive but has not reported a phase yet — still in serial Duo prompts, browser launch, login retries. Bucketing this as idle is what makes you think capacity is free when it isn't.",
    phase: "Authenticating",
    tone: "text-warning",
    workflow: "Oath Signature",
    subline: "Authenticating 1/2",
    elapsed: "53s",
    tiles: [
      { label: "crm", state: "duo" },
      { label: "ucpath", state: "authing" },
    ],
  },
  {
    name: "Idle",
    what: "Authenticated, browsers warm, nothing to do. The retained trace id is deliberately NOT shown — a stale id on an idle card reads as a leftover bug.",
    phase: "Idle",
    tone: "text-muted-foreground",
    workflow: "OCR",
    subline: "idle — waiting for work",
    elapsed: "6m 36s",
    tiles: [{ label: "i9", state: "ready" }],
  },
  {
    name: "Idle · work waiting",
    what: "Same daemon, but the shared queue has items. The queued chip is the cue to add a worker rather than wait — a new worker joins the same queue and absorbs what is already there.",
    phase: "Idle",
    tone: "text-muted-foreground",
    workflow: "I-9 Check",
    subline: "6 queued — ready",
    elapsed: "40m 22s",
    queued: 6,
    tiles: [{ label: "ucpath", state: "unknown" }],
  },
  {
    name: "Keep-alive",
    what: "Between items, touching each browser so the session does not time out. Distinct from idle because it is doing something.",
    phase: "Keep-alive",
    tone: "text-info",
    workflow: "Emergency Contact",
    subline: "keepalive — checking browsers",
    elapsed: "1h 12m",
    tiles: [
      { label: "ucpath", state: "ready" },
      { label: "crm", state: "paused" },
    ],
  },
  {
    name: "Complete",
    what: "The daemon finished its run and exited cleanly. Dimmed, kept on screen so the outcome stays legible.",
    phase: "Complete",
    tone: "text-muted-foreground",
    workflow: "Kronos Pay Rule",
    subline: "Run complete",
    elapsed: "4m 02s",
    tiles: [{ label: "kronos", state: "ready" }],
  },
  {
    name: "Failed",
    what: "The daemon ended on an error. A clean idle shutdown must never render like this — a phantom failed-end event used to inflate the notification bell.",
    phase: "Failed",
    tone: "text-destructive",
    workflow: "OnBase",
    subline: "Run failed",
    elapsed: "2m 55s",
    tiles: [{ label: "onbase", state: "failed" }],
  },
  {
    name: "Crashed on launch",
    what: "A different object: no tiles, no timer, nothing to stop, because the browser never opened. Stays visible after the process is gone so the failure is actually learned.",
    phase: "Launch failed",
    tone: "text-destructive",
    workflow: "CRM Doc Download",
    subline: "Check the queue row for details",
    elapsed: "—",
    tiles: [],
    crashed: true,
  },
];

function GalleryTile({ label, state }: { label: string; state: TileState }) {
  const spec = TILE_STATES[state];
  const Icon = spec.icon;
  const spins = state === "refreshing" || state === "authing";
  return (
    <div className={cn("flex w-full min-w-0 flex-col gap-0.5 rounded-md border px-2 py-1", spec.cls)}>
      <span className="flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider">
        <Icon aria-hidden className={cn("size-3 shrink-0", spins && "animate-spin motion-reduce:animate-none")} />
        {label}
      </span>
      <span className="truncate text-[10px] opacity-80">{spec.label}</span>
    </div>
  );
}

const PHASE_DOT: Record<CardSpec["phase"], string> = {
  Running: "bg-success",
  Authenticating: "bg-warning animate-pulse motion-reduce:animate-none",
  Idle: "bg-muted-foreground/60",
  "Keep-alive": "bg-info",
  Complete: "bg-success/60",
  Failed: "bg-destructive",
  "Launch failed": "bg-destructive",
};

function GalleryCard({ s }: { s: CardSpec }) {
  if (s.crashed) {
    return (
      <article className="flex w-[268px] flex-col gap-1 rounded-lg border border-destructive/40 bg-destructive/5 p-2.5">
        <div className="flex items-center gap-2">
          <span aria-hidden className="size-2 shrink-0 rounded-full bg-destructive" />
          <span className="min-w-0 flex-1 truncate text-[12.5px] font-semibold text-foreground">{s.workflow}</span>
          <span className="shrink-0 text-[10px] font-semibold uppercase tracking-wider text-destructive">Launch failed</span>
        </div>
        <p className="text-[10.5px] leading-tight text-destructive/80">{s.subline}</p>
      </article>
    );
  }
  const dim = s.phase === "Complete" || s.phase === "Failed";
  return (
    <article
      className={cn(
        "flex w-[268px] flex-col rounded-lg border bg-card p-2.5",
        s.phase === "Failed" ? "border-destructive/40" : "border-border",
        dim && "opacity-70",
      )}
    >
      <div className="flex items-center gap-2">
        <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", PHASE_DOT[s.phase])} />
        <span className="min-w-0 truncate text-[12.5px] font-semibold text-foreground">{s.workflow}</span>
        {s.queued ? (
          <span className="shrink-0 rounded bg-primary/10 px-1.5 py-px text-[10px] leading-none text-primary">
            <span className="font-medium">{s.queued}</span> queued
          </span>
        ) : null}
        <span className={cn("ml-auto shrink-0 text-[10px] font-semibold uppercase tracking-wider", s.tone)}>{s.phase}</span>
      </div>
      <span className={cn("mt-0.5 truncate text-[10.5px] text-muted-foreground", s.mono && "font-mono")}>{s.subline}</span>

      {s.tiles.length > 0 && (
        <div className="mt-1.5 grid grid-cols-2 gap-1">
          {s.tiles.map((t) => (
            <GalleryTile key={t.label} {...t} />
          ))}
        </div>
      )}

      {s.steps && (
        <div aria-hidden className="mt-1.5 flex items-center gap-0">
          {s.steps.map((st, i) => (
            <span key={i} className="flex flex-1 items-center last:flex-none">
              <span
                className={cn(
                  "size-1.5 shrink-0 rounded-full",
                  st === "done" && "bg-success/85",
                  st === "current" && "bg-primary shadow-[0_0_0_2px_color-mix(in_srgb,var(--primary)_18%,transparent)]",
                  st === "pending" && "border border-border bg-muted",
                )}
              />
              {i < (s.steps?.length ?? 0) - 1 && <span className={cn("h-px min-w-[3px] flex-1", st === "done" ? "bg-success/30" : "bg-border")} />}
            </span>
          ))}
        </div>
      )}

      <div className="mt-1.5 flex items-center gap-2 border-t border-border/60 pt-1.5 text-[10px] text-muted-foreground">
        <span className="font-mono tabular-nums">{s.elapsed}</span>
        <span className="min-w-0 flex-1 truncate">{s.step ?? ""}</span>
        <button
          type="button"
          onClick={NOOP}
          className="shrink-0 rounded border border-destructive/30 px-1.5 py-px text-[10px] text-destructive/85 outline-none hover:bg-destructive/10 focus-visible:ring-2 focus-visible:ring-ring"
        >
          × stop
        </button>
      </div>
    </article>
  );
}

function SessionCardsTab() {
  return (
    <div className="grid grid-cols-1 gap-3 min-[1400px]:grid-cols-2">
      <Section
        title="Session Cards — one per daemon, 8 states"
        sub="A Session Card is a WORKER, not a run. It answers: is this thing alive, is it stuck on Duo, which browser broke, and what is it doing right now."
      />
      {CARD_SPECS.map((s) => (
        <Specimen key={s.name} name={s.name} kind="Session Card" what={s.what}>
          <GalleryCard s={s} />
        </Specimen>
      ))}

      <Section
        title="Browser tiles — 9 states"
        sub="One tile per browser the daemon owns, bound by browser id and never by position. Zero chrome at rest: the state word owns the full tile width, and every action lives behind a right-click menu."
      />
      <div className="col-span-full grid grid-cols-2 gap-2 min-[900px]:grid-cols-3 min-[1400px]:grid-cols-5">
        {(Object.keys(TILE_STATES) as TileState[]).map((k) => (
          <Chip
            key={k}
            name={TILE_STATES[k].label}
            note={
              k === "unknown"
                ? "Never probed. Must NOT read as healthy — a stalled monitor would look forever fine."
                : k === "paused"
                  ? "You turned auto-recovery off so you could inspect it."
                  : k === "duo"
                    ? "Blocking on the MFA prompt."
                    : k === "refreshing"
                      ? "Recovery rung 1 — reloading the page."
                      : undefined
            }
          >
            <span className="w-[132px]">
              <GalleryTile label="ucpath" state={k} />
            </span>
          </Chip>
        ))}
      </div>

      <Section title="Session Panel bar" sub="Collapsed, this is the whole daemon fleet in one line — plus a browser-health rollup that only appears when something is wrong." />
      <div className="col-span-full">
        <Specimen
          name="Session Panel bar"
          kind="collapsed"
          what="Three-way daemon split — never two-way. Alive-but-no-phase means authenticating, not idle; calling it idle is what makes free capacity look available when there is none."
        >
          <div className="flex flex-wrap items-center gap-3 rounded-lg border border-border bg-card px-3 py-2">
            <span className="text-[11.5px] font-medium text-foreground">Sessions</span>
            <span className="flex items-center gap-2.5 text-[11px] text-muted-foreground">
              <span className="inline-flex items-center gap-1">
                <span aria-hidden className="size-1.5 rounded-full bg-success" />2 running
              </span>
              <span className="inline-flex items-center gap-1">
                <span aria-hidden className="size-1.5 rounded-full bg-warning animate-pulse motion-reduce:animate-none" />1 authenticating
              </span>
              <span className="inline-flex items-center gap-1">
                <span aria-hidden className="size-1.5 rounded-full bg-muted-foreground/60" />1 idle
              </span>
              <span className="inline-flex items-center gap-1 text-destructive">
                <span aria-hidden className="size-1.5 rounded-full bg-destructive" />1 failed
              </span>
            </span>
            <span className="inline-flex items-center gap-1 rounded border border-warning/40 bg-warning/10 px-1.5 py-px text-[10px] text-warning">
              <AlertTriangle aria-hidden className="size-3" />5 browsers need attention
            </span>
            <span className="ml-auto flex items-center gap-1.5">
              <Plus aria-hidden className="size-3.5 text-muted-foreground" />
              <span className="inline-flex items-center gap-1 text-[10.5px] text-success">
                <span aria-hidden className="size-1.5 rounded-full bg-success animate-pulse motion-reduce:animate-none" />
                Live
              </span>
            </span>
          </div>
        </Specimen>
      </div>
    </div>
  );
}

// ===========================================================================
// TAB 4 — Controls
// ===========================================================================

const PILLS: { key: string; label: string; n: number; icon: typeof Eye; tone: string; on?: boolean }[] = [
  { key: "all", label: "All", n: 15, icon: LayoutGrid, tone: "text-muted-foreground", on: true },
  { key: "attention", label: "Needs you", n: 7, icon: Eye, tone: "text-warning" },
  { key: "running", label: "Running", n: 3, icon: Loader2, tone: "text-primary" },
  { key: "queued", label: "Queued", n: 1, icon: Clock, tone: "text-muted-foreground" },
  { key: "done", label: "Done", n: 5, icon: CheckCircle2, tone: "text-success" },
  { key: "failed", label: "Failed", n: 1, icon: AlertTriangle, tone: "text-destructive" },
  { key: "cancelled", label: "Cancelled", n: 0, icon: Ban, tone: "text-warning" },
];

const RAIL_ROWS = [
  { label: "Separations", total: 2, queued: 0, on: true, note: "Active — 3px primary accent, bold label, primary count." },
  { label: "I-9 Check", total: 1, queued: 6, on: false, note: "Queued work waiting behind the running item." },
  { label: "Person Match", total: 0, queued: 0, on: false, note: "Nothing today — the count dims rather than vanishing, so the set of entries is stable." },
];

const MATRIX_CELL: Record<ProposedStatus, string> = {
  verifiedDone: "bg-success/75",
  doneWarnings: "bg-warning/80",
  running: "bg-primary/80",
  queued: "bg-secondary",
  failed: "bg-destructive",
  waiting: "bg-warning",
  parked: "bg-log-violet",
  cancelled: "bg-warning/60",
};

function ControlsTab() {
  const i9 = groupCounts("i9-batch");
  return (
    <div className="grid grid-cols-1 gap-3 min-[1500px]:grid-cols-2">
      <Section
        title="Status Bar"
        sub="The count pills. Every number here comes from the same server projection as the Workflow Panel badges and the queue itself — so two surfaces can never disagree."
      />
      <div className="col-span-full">
        <Specimen name="Status Bar" kind="filter + summary" what="Clicking a pill filters; clicking the active pill clears it. A zero count dims rather than disappearing, so the buckets stay in the same place.">
          <div className="flex flex-wrap items-center gap-1">
            {PILLS.map((p) => {
              const Icon = p.icon;
              return (
                <button
                  key={p.key}
                  type="button"
                  aria-pressed={p.on}
                  onClick={NOOP}
                  className={cn(
                    "inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-[11px] outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    p.on ? "border-primary/45 bg-primary/12 font-semibold text-foreground" : "border-border bg-card text-muted-foreground",
                    p.n === 0 && !p.on && "opacity-45",
                  )}
                >
                  <Icon aria-hidden className={cn("size-3", p.tone)} />
                  {p.label}
                  <span className="font-mono tabular-nums">{p.n}</span>
                </button>
              );
            })}
          </div>
        </Specimen>
      </div>

      <Section title="Row footer actions" sub="Which buttons exist is decided by status, in the projection — never by a client-side branch. That is why the queue can never offer an action that fails." />
      <Specimen name="Running" kind="footer cluster" what="Only cancel. You cannot bump something already in flight, and retry or delete would race the worker.">
        <div className="flex items-center gap-1">
          <IconActionButton tone="muted" icon={<X aria-hidden className="size-3.5" />} label="Cancel" onClick={NOOP} />
        </div>
      </Specimen>
      <Specimen name="Queued" kind="footer cluster" what="Bump to the front, or cancel. No delete — cancel it first, which makes it terminal, and then delete appears.">
        <div className="flex items-center gap-1">
          <IconActionButton tone="primary" icon={<ChevronsUp aria-hidden className="size-3.5" />} label="Bump" onClick={NOOP} />
          <IconActionButton tone="muted" icon={<X aria-hidden className="size-3.5" />} label="Cancel" onClick={NOOP} />
        </div>
      </Specimen>
      <Specimen name="Terminal" kind="footer cluster" what="Retry replays the same input as a new attempt; delete removes the history. Both are safe only once nothing is running.">
        <div className="flex items-center gap-1">
          <IconActionButton tone="primary" icon={<RotateCcw aria-hidden className="size-3.5" />} label="Retry" onClick={NOOP} />
          <IconActionButton tone="destructive" icon={<Trash2 aria-hidden className="size-3.5" />} label="Delete" onClick={NOOP} />
        </div>
      </Specimen>
      <Specimen name="Rejected member" kind="footer cluster" what="Delete only — and structurally absent rather than disabled, because there is no task behind this row to replay.">
        <div className="flex items-center gap-1">
          <IconActionButton tone="destructive" icon={<Trash2 aria-hidden className="size-3.5" />} label="Delete" onClick={NOOP} />
        </div>
      </Specimen>
      <Specimen name="Cancel remaining" kind="group footer" what="Tree-scoped: cancels the coordinator, its OCR review and every non-terminal member in one act. Row-scoped group cancel is what used to leave orphaned OCR reviews behind.">
        <span className="flex items-center gap-1">
          <span className="mr-1 text-[10px] text-muted-foreground">Cancel remaining</span>
          <IconActionButton tone="muted" icon={<X aria-hidden className="size-3.5" />} label="Cancel remaining" onClick={NOOP} />
        </span>
      </Specimen>

      <Section title="Group indicators" sub="How a group reports its members without you opening anything." />
      <Specimen name="Status counts" kind="group header" what="Per-status member tallies. Icon shape carries the meaning, not colour alone; a retried member counts once even though both attempts stay in the list.">
        {/* StatusCounts renders a FRAGMENT on purpose — the caller owns the
            flex row, which is why one tally fits both a group header and a
            count strip. Forget the wrapper and the numbers collide. */}
        <span className="flex items-center gap-2.5 whitespace-nowrap font-mono text-[10.5px]">
          <StatusCounts counts={{ done: i9.done + i9.warnings, running: i9.running, queued: i9.queued, failed: i9.failed }} />
        </span>
      </Specimen>
      <Specimen name="Attention band" kind="group body" what="Named, derived counts under a matrix — the difference between 'something is wrong' and knowing exactly what.">
        <div className="flex items-center gap-2 rounded-md border border-warning/35 bg-warning/6 px-2.5 py-1.5">
          <AlertTriangle aria-hidden className="size-3.5 shrink-0 text-warning" />
          <span className="min-w-0 flex-1 truncate text-[11.5px] text-warning">4 need attention — 2 failed · 1 waiting on you · 1 with warnings</span>
          <button
            type="button"
            onClick={NOOP}
            className="shrink-0 rounded-md border border-warning/45 bg-warning/12 px-2.5 py-0.5 text-[10.5px] font-semibold text-warning outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            Start review
          </button>
        </div>
      </Specimen>
      <Specimen name="Rejected count" kind="group header" what="Pages or rows that can never become work are counted separately and excluded from the rollup, so a packet with rejections never reads as clean.">
        <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
          <SearchX aria-hidden className="size-3" />1 rejected
        </span>
      </Specimen>
      <Specimen name="Checked by you" kind="group header" what="Your own review progress. Nobody else is tracking that you looked at each person — this is the only thing that does.">
        <span className="inline-flex items-center gap-1 text-[11px] text-success">
          <CheckCircle2 aria-hidden className="size-3" />
          10/50 checked
        </span>
      </Specimen>

      <Section title="Delegation" sub="A linked child keeps its own row in its own panel; the two point at each other with one chip each, never a duplicated run." />
      <Specimen name="Forward link" kind="on the parent" what="From the packet to the OCR review that owns the records, carrying the child's live status so you know whether it needs you.">
        <button type="button" onClick={NOOP} className="inline-flex items-center gap-1.5 rounded-md border border-info/35 bg-info/8 px-2 py-0.5 text-[10.5px] text-info">
          <ClipboardList aria-hidden className="size-3 shrink-0" />
          OCR review · waiting on you
          <ArrowUpRight aria-hidden className="size-3 shrink-0" />
        </button>
      </Specimen>
      <Specimen name="Back link" kind="on the child" what="From the delegated run home to its parent. One level of back — there is only ever one parent worth returning to, so there is no breadcrumb trail.">
        <button type="button" onClick={NOOP} className="inline-flex items-center gap-1.5 rounded-md border border-info/35 bg-info/8 px-2 py-0.5 text-[10.5px] text-info">
          <CornerDownRight aria-hidden className="size-3 shrink-0" />
          Delegated by Oath_Packet_Summer.pdf
        </button>
      </Specimen>

      <Section title="Log Panel bars" sub="The pinned surfaces above the tabs — visible whichever tab you are on." />
      <div className="col-span-full">
        <Specimen name="Gate banner" kind="pinned, all tabs" what="The decision itself, with its age and its actions. Not a tab, because a pending decision must be visible from wherever you happen to be looking.">
          <div className="rounded-lg border border-warning/30 bg-warning/8 px-3 py-2">
            <div className="flex items-center gap-2">
              <ClipboardList aria-hidden className="size-3.5 shrink-0 text-warning" />
              <span className="min-w-0 truncate text-[12px] font-semibold text-warning">Waiting on you — approve the people to sign</span>
              <span className="ml-auto shrink-0 font-mono text-[10px] text-warning/80">open 10m · since 2:22 PM</span>
            </div>
            <p className="mt-1 pl-5 text-[11px] leading-relaxed text-muted-foreground">
              Review each person against their page, then approve. Diego Diaz is blocked (inactive) and is excluded from the count.
            </p>
            <div className="mt-1.5 flex flex-wrap gap-1.5 pl-5">
              <button type="button" onClick={NOOP} className="rounded-md border border-warning/55 bg-warning/15 px-2.5 py-0.5 text-[11px] font-semibold text-warning">
                Open review
              </button>
              <button type="button" onClick={NOOP} className="rounded-md border border-border bg-card px-2.5 py-0.5 text-[11px] font-semibold text-secondary-foreground">
                Approve 5 of 6
              </button>
              <button type="button" onClick={NOOP} className="rounded-md border border-border bg-card px-2.5 py-0.5 text-[11px] font-semibold text-secondary-foreground">
                Discard packet
              </button>
            </div>
          </div>
        </Specimen>
      </div>
      <div className="col-span-full">
        <Specimen
          name="Evidence bar"
          kind="pinned, all tabs"
          what="Every capture the run took, always one glance away. This replaces the Screenshots tab — just the images; a capture taken at a failure carries a red frame."
        >
          <div className="flex gap-1.5 overflow-x-auto rounded-lg border border-border bg-card px-3 py-1.5">
            {["Kuali doc", "Identity check", "Job summary", "Kronos timeout", "Kronos search", "Paused at gate"].map((l, i) => (
                <button
                  key={l}
                  type="button"
                  onClick={NOOP}
                  className={cn(
                    "flex h-10 w-[4.75rem] shrink-0 flex-col items-center justify-center gap-0.5 rounded-md border bg-secondary/40",
                    i === 3 ? "border-destructive/45" : "border-border",
                  )}
                >
                  <Camera aria-hidden className={cn("size-3", i === 3 ? "text-destructive" : "text-muted-foreground")} />
                  <span className="max-w-full truncate px-1 text-[8.5px] text-muted-foreground">{l}</span>
                </button>
              ))}
          </div>
        </Specimen>
      </div>
      <div className="col-span-full">
        <Specimen name="Approve bar" kind="Review Panel" what="The gate on the whole set. Approve stays disabled until every person has been looked at — you cannot approve what you have not seen.">
          <div className="flex items-center gap-2 rounded-lg border border-border bg-secondary/20 px-3 py-1.5">
            <span className="font-mono text-[11px] tabular-nums text-foreground">2/6 reviewed</span>
            <span aria-hidden className="flex h-1 w-24 overflow-hidden rounded-full bg-secondary">
              <span className="bg-success/70" style={{ flexGrow: 2 }} />
              <span className="bg-border" style={{ flexGrow: 4 }} />
            </span>
            <span className="text-[11px] text-muted-foreground">1 approved · 1 blocked</span>
            <button
              type="button"
              disabled
              onClick={NOOP}
              className="ml-auto inline-flex items-center gap-1.5 rounded-md border border-success/50 bg-success/15 px-2.5 py-1 text-[11px] font-semibold text-success opacity-40"
            >
              <CheckCircle2 aria-hidden className="size-3" />
              Approve 5 of 6
            </button>
          </div>
        </Specimen>
      </div>
      <div className="col-span-full">
        <Specimen name="Conveyor header" kind="Member + Review Panel" what="How you walk a set without losing your place: position, prev/next, and a jump straight to the next person who needs something.">
          <div className="flex items-center gap-1.5 rounded-lg border border-border bg-card px-2.5 py-1.5">
            <IconActionButton tone="muted" icon={<ArrowRight aria-hidden className="size-3.5 rotate-180" />} label="Previous person" onClick={NOOP} />
            <span className="font-mono text-[10.5px] tabular-nums text-muted-foreground">3/6</span>
            <IconActionButton tone="muted" icon={<ArrowRight aria-hidden className="size-3.5" />} label="Next person" onClick={NOOP} />
            <span className="ml-1 text-[13px] font-semibold text-foreground">Carla Chen</span>
            <span className="font-mono text-[10.5px] text-muted-foreground">10552018</span>
            <span className="rounded-md border border-success/40 bg-success/12 px-1.5 py-px text-[10px] font-semibold text-success">Ready</span>
            <button type="button" onClick={NOOP} className="ml-auto inline-flex items-center gap-1 rounded-md border border-warning/45 bg-warning/10 px-2 py-0.5 text-[10.5px] font-semibold text-warning">
              Next flagged
              <ArrowRight aria-hidden className="size-3" />
            </button>
          </div>
        </Specimen>
      </div>

      <Section title="Provenance" sub="Where a value came from, on the card you approve from. Colour alone never carries this — the chip is a word." />
      <div className="col-span-full grid grid-cols-2 gap-2 min-[900px]:grid-cols-4">
        <Chip name="Paper" note="Read off the scanned form by the vision model.">
          <span className="rounded border border-log-violet/35 px-1 text-[9px] font-semibold uppercase text-log-violet">paper</span>
        </Chip>
        <Chip name="Roster" note="Matched from the roster spreadsheet.">
          <span className="rounded border border-log-teal/35 px-1 text-[9px] font-semibold uppercase text-log-teal">roster</span>
        </Chip>
        <Chip name="UCPath" note="Looked up live in the system of record.">
          <span className="rounded border border-log-cyan/35 px-1 text-[9px] font-semibold uppercase text-log-cyan">UCPath</span>
        </Chip>
        <Chip name="Low confidence" note="Below the review threshold — the number is shown, not hidden, so you check it against the image.">
          <span className="font-mono text-[10px] tabular-nums text-warning">0.44</span>
        </Chip>
      </div>

      <Section title="Record verdicts" sub="Per-person state inside a review, and whether it can be approved at all." />
      <div className="col-span-full grid grid-cols-2 gap-2 min-[900px]:grid-cols-3">
        <Chip name="Ready" note="Everything checks out. Included in Approve.">
          <span className="rounded-md border border-success/40 bg-success/12 px-1.5 py-px text-[10px] font-semibold text-success">Ready</span>
        </Chip>
        <Chip name="Flagged" note="Approvable, but something wants your eyes first — a weak read, a missing signature.">
          <span className="rounded-md border border-warning/45 bg-warning/12 px-1.5 py-px text-[10px] font-semibold text-warning">Flagged</span>
        </Chip>
        <Chip name="Blocked" note="Cannot be approved, and says why in plain language. Excluded from the count rather than silently approved.">
          <span className="rounded-md border border-destructive/45 bg-destructive/12 px-1.5 py-px text-[10px] font-semibold text-destructive">Blocked</span>
        </Chip>
      </div>

      <Section title="Workflow Panel rows" sub="The left rail. The amber sub-badge is queued work — the cue to add a worker." />
      <div className="col-span-full grid grid-cols-1 gap-2 min-[900px]:grid-cols-3">
        {RAIL_ROWS.map((e) => (
          <Chip key={e.label} name={e.label} note={e.note}>
            <span className={cn("flex h-10 w-full items-stretch gap-2 rounded-md py-0 pl-1 pr-2.5", e.on && "bg-accent/40")}>
              <span aria-hidden className={cn("my-1.5 w-[3px] rounded-r-full", e.on ? "bg-primary" : "bg-transparent")} />
              <span className="flex min-w-0 flex-1 items-center">
                <span className={cn("truncate text-[13px]", e.on ? "font-semibold text-foreground" : "font-medium text-foreground/90")}>{e.label}</span>
              </span>
              <span className="flex shrink-0 items-center gap-1.5">
                {e.queued > 0 && (
                  <span className="rounded-sm bg-warning/15 px-1 py-0.5 font-mono text-[9px] font-semibold leading-none tabular-nums text-warning">{e.queued}</span>
                )}
                <span
                  className={cn(
                    "font-mono text-[11px] leading-none tabular-nums",
                    e.total === 0 ? "text-muted-foreground/50" : e.on ? "font-semibold text-primary" : "text-foreground",
                  )}
                >
                  {e.total}
                </span>
              </span>
            </span>
          </Chip>
        ))}
      </div>

      <Section title="Matrix cells" sub="One cell per person at 20+ members. Hover names the person and their outcome; click opens them." />
      <div className="col-span-full grid grid-cols-3 gap-2 min-[900px]:grid-cols-5 min-[1400px]:grid-cols-9">
        {(Object.keys(PROPOSED_STATUS) as ProposedStatus[]).map((s) => (
          <Chip key={s} name={PROPOSED_STATUS[s].label}>
            <span className={cn("size-3.5 rounded-[3px]", MATRIX_CELL[s])} />
          </Chip>
        ))}
        <Chip name="Rejected" note="Not a person — a page that named nobody searchable.">
          <span className="size-3.5 rounded-[3px] bg-muted-foreground/40" />
        </Chip>
      </div>

      <Section title="Row qualifier chips" sub="Small facts that ride the row header without changing its status." />
      <div className="col-span-full grid grid-cols-2 gap-2 min-[900px]:grid-cols-4">
        <Chip name="Dry run" note="A rehearsal — the irreversible submit is skipped. The only visual separator from a real transaction.">
          <span className="rounded-md border border-warning/40 bg-warning/12 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-warning">Dry run</span>
        </Chip>
        <Chip name="Attempt" note="This is a retry. Hover names when the prior attempt failed and why.">
          <span className="inline-flex items-center gap-1 rounded-md border border-warning/40 bg-warning/12 px-1.5 py-0.5 text-[10px] font-semibold text-warning">
            <RotateCcw aria-hidden className="size-3" />
            attempt 2
          </span>
        </Chip>
        <Chip name="Warning count" note="How many warnings, with the first one in the hover.">
          <span className="inline-flex items-center gap-1 rounded-md border border-warning/40 bg-warning/12 px-1.5 py-0.5 text-[10px] font-semibold text-warning">
            <AlertTriangle aria-hidden className="size-3" />1
          </span>
        </Chip>
        <Chip name="Gate age" note="How long a decision has been waiting — the most actionable fact in the queue.">
          <span className="inline-flex items-center gap-1 rounded-md bg-warning/10 px-1.5 py-0.5 text-[10px] font-medium text-warning">
            <Clock aria-hidden className="size-3" />
            waiting 18m
          </span>
        </Chip>
      </div>
    </div>
  );
}

// ===========================================================================
// Shell
// ===========================================================================

type TabKey = "rows" | "panels" | "sessions" | "controls";

const TABS: { key: TabKey; label: string }[] = [
  { key: "rows", label: "Queue Rows" },
  { key: "panels", label: "Log Panels" },
  { key: "sessions", label: "Session Cards" },
  { key: "controls", label: "Controls" },
];

export function UiGallery() {
  const [tab, setTab] = useState<TabKey>("rows");
  return (
    <TooltipProvider delayDuration={200}>
      <div className="flex h-screen flex-col overflow-y-auto bg-background text-foreground">
        <header className="sticky top-0 z-20 border-b border-border bg-background/95 px-5 py-3 backdrop-blur">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <h1 className="text-[17px] font-bold">UI catalog</h1>
            <span className="rounded-full border border-info/40 bg-info/10 px-2 py-px text-[9.5px] font-semibold uppercase tracking-wider text-info">
              rebuild design · synthetic data
            </span>
            <p className="text-[12px] text-muted-foreground">
              Every named surface, one at a time. Open <span className="font-mono">?view=rebuild-demo</span> to see them working together.
            </p>
          </div>
          <div role="tablist" className="mt-2.5 flex gap-1">
            {TABS.map((t) => (
              <button
                key={t.key}
                type="button"
                role="tab"
                aria-selected={tab === t.key}
                onClick={() => setTab(t.key)}
                className={cn(
                  "rounded-md px-3 py-1 text-[12.5px] outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  tab === t.key ? "bg-accent font-semibold text-foreground" : "text-muted-foreground hover:text-foreground",
                )}
              >
                {t.label}
              </button>
            ))}
          </div>
        </header>
        <main className="px-5 py-4">
          {tab === "rows" && <QueueRowsTab />}
          {tab === "panels" && <LogPanelsTab />}
          {tab === "sessions" && <SessionCardsTab />}
          {tab === "controls" && <ControlsTab />}
        </main>
      </div>
    </TooltipProvider>
  );
}
