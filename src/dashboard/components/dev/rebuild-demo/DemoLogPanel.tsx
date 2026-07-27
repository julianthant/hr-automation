import { useEffect, useMemo, useState, type ReactNode } from "react";
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
  Eye,
  FileText,
  GitBranch,
  Loader2,
  Pause,
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
import { BannerActions, OutcomeActionButton, ParkResolutions, type DemoActionHandler } from "./DemoActions";
import { ContextRail, ContextRailSpine, useContextRail } from "./DemoContextRail";
import { fmtClock, tabsFor as tabsForKind, type DemoTab } from "./demo-wire";
import {
  Button,
  Kbd,
  dsBorder,
  dsFocus,
  dsIcon,
  dsMotion,
  dsRadius,
  dsSize,
  dsText,
} from "./demo-ui";
import { ReceiptView, runReceiptFor } from "./DemoReceipt";
import { FailureRecordBlock, failureRecordFor } from "./DemoFailure";
import { ParkResolveDialog, SettlingPanel, isParkResolution, type ParkResolveState } from "./DemoParkResolve";
import type { DemoCommandSettling } from "./demo-commands";
import {
  DEMO_ROWS,
  effectiveStatus,
  fmtElapsed,
  gateAge,
  gateWaitSec,
  LIVE_SEQUENCE,
  memberAttentionIds,
  orderedMemberIds,
  sharedMemberPipeline,
  SYSTEM_ACCENT,
  type DemoDataPoint,
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

export type { DemoTab } from "./demo-wire";

const TERMINAL: ProposedStatus[] = ["verifiedDone", "doneWarnings", "failed", "cancelled"];

/**
 * Tabs are derived from the PANEL KIND, not fixed at five.
 *  - Review exists only on the Review Run Row (the only row that owns records).
 *  - People exists only on a Group Row.
 *  - Screenshots is not a tab at all — evidence rides the bar above the tabs.
 */
/**
 * The tabs a row gets are SERVED (`detailSurfaces`), not decided here. The
 * derivation still lives in `demo-wire` so the mock server and the client agree
 * by construction; this reads the row's own field.
 */
export function tabsFor(row: DemoRow): DemoTab[] {
  return row.detailSurfaces ?? tabsForKind(row);
}

export function defaultTabFor(row: DemoRow): DemoTab {
  const kind = panelKindOf(row);
  const status = effectiveStatus(row);
  if (kind === "review") return "review";
  if (kind === "group") {
    const attention = (row.memberIds ?? []).some((id) => {
      const m = DEMO_ROWS[id];
      return m && m.containment !== "rejected" && (m.status === "failed" || m.status === "waiting" || m.status === "doneWarnings");
    });
    if (attention || status === "waiting") return "people";
    return TERMINAL.includes(status) ? "receipt" : "logs";
  }
  return TERMINAL.includes(status) ? "receipt" : "logs";
}

export interface DemoLogPanelProps {
  row: DemoRow;
  tab: DemoTab | null;
  onTab: (t: DemoTab) => void;
  onSelect: (id: string) => void;
  /** jump to another Workflow Panel entry and select a row inside it */
  onOpenPanel: (workflow: string, id: string) => void;
  checkedIds: ReadonlySet<string>;
  onToggleChecked: (id: string) => void;
  /** every control in the panel goes through here — see `DemoActions` */
  onAction: DemoActionHandler;
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

/**
 * The log stream is the noisiest surface in the product, so it is the one that
 * had to give colour back. `--log-*` are no longer four CATEGORICAL hues — each
 * now resolves to a step on a neutral ink ramp (see `ds/tokens.css`), except
 * `--log-violet`, which resolves to the warning amber because "unconfirmed
 * write" was never a category in the first place. Direction is carried by the
 * arrow icon and by weight: a WRITE (`log-teal` → the base foreground) is the
 * load-bearing one, a READ (`log-cyan`) sits a step back, and navigation
 * (`log-slate`) is quieter still. Do not re-introduce a hue here.
 */
const LINE_ICON: Record<LineKind, { icon: typeof Check; cls: string }> = {
  nav: { icon: ArrowRight, cls: "text-log-slate" },
  search: { icon: Search, cls: "text-log-slate" },
  read: { icon: ArrowDownToLine, cls: "text-log-cyan" },
  write: { icon: ArrowUpFromLine, cls: "text-log-teal" },
  ok: { icon: Check, cls: "text-success" },
  error: { icon: X, cls: "text-destructive" },
  warn: { icon: TriangleAlert, cls: "text-warning" },
  pause: { icon: Pause, cls: "text-warning" },
  event: { icon: Zap, cls: "text-[color:var(--ds-fg-muted)]" },
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

function GateCardView({ row, wide, onAction }: { row: DemoRow; wide?: boolean; onAction: DemoActionHandler }) {
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
              {s.unconfirmed ? (
                <span
                  title="Sent to UCPath, but we never read the outcome back"
                  className="shrink-0 rounded border border-log-violet/45 px-1 text-[9.5px] font-semibold text-log-violet"
                >
                  unconfirmed
                </span>
              ) : (
                <span className="shrink-0 rounded border border-warning/40 px-1 text-[9.5px] font-semibold text-warning">staged</span>
              )}
            </div>
          ))}
        </div>
      )}
      <ParkResolutions row={row} onAction={onAction} />
      <BannerActions row={row} onAction={onAction} />
      {wide && <div className="mt-2 border-t border-border/40 pt-2 text-[11px] leading-relaxed text-muted-foreground">{gate.note}</div>}
    </div>
  );
}

/**
 * The in-stream failure marker. It stays SHORT — the full `FailureRecord` is
 * pinned above the tabs, where it is visible from every one of them, so this
 * card's job is to mark the line the run died on and point at it.
 */
function FailureCardView({ row, onOpenFailure }: { row: DemoRow; onOpenFailure?: () => void }) {
  if (!row.failCard) return null;
  return (
    <div className="mx-3 my-1.5 ml-11 rounded-lg border border-destructive/40 bg-destructive/6 px-3 py-2 text-[12px]">
      <div className="mb-0.5 text-[11.5px] font-semibold text-destructive">{row.failCard.title}</div>
      <div className="text-[11px] text-muted-foreground">{row.failCard.meta}</div>
      {onOpenFailure && (
        <button
          type="button"
          onClick={onOpenFailure}
          className="mt-1 rounded-md border border-destructive/45 px-2 py-0.5 text-[10.5px] font-semibold text-destructive outline-none hover:bg-destructive/10 focus-visible:ring-2 focus-visible:ring-ring"
        >
          Open the full failure record
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// strip + waterfall + filmstrip
// ---------------------------------------------------------------------------

/**
 * Timeline — the run's shape, one segment per step, ALL THE SAME WIDTH.
 *
 * This reverses the earlier proportional design, on the operator's explicit
 * instruction ("all the timeline elements should have equal sizes doesn't
 * matter the time"). Proportional widths were honest — the width WAS the
 * data — but a 34-minute gate beside three minutes of work is a true 91% of
 * the track, and at 91% the step labels crush to `3.¹2 4..`. A timeline whose
 * labels cannot be read tells you nothing about where the time went either.
 *
 * Equal widths make no claim about duration, because the duration is PRINTED
 * as a number under every segment and the run's totals are on the axis below.
 * That is legibility over literalism, not fabrication: nothing here implies a
 * length it does not state in words. A step with no recorded time prints no
 * time, and a step not yet reached stays dashed and empty.
 */
const STEP_TONE: Record<DemoStep["state"], { bar: string; text: string; dot: string }> = {
  done: { bar: "bg-success/55", text: "text-success", dot: "bg-success" },
  current: { bar: "bg-primary/70", text: "text-primary", dot: "bg-primary" },
  waiting: { bar: "bg-warning/60", text: "text-warning", dot: "bg-warning" },
  failed: { bar: "bg-destructive/65", text: "text-destructive", dot: "bg-destructive" },
  cancelled: { bar: "bg-warning/40", text: "text-warning", dot: "bg-warning" },
  pending: { bar: "bg-border", text: "text-muted-foreground", dot: "bg-border" },
};

function Timeline({ row, tick }: { row: DemoRow; tick: number }) {
  const steps = row.steps;
  if (steps.length === 0) return null;

  const active = steps.reduce((a, s) => a + (s.durationSec ?? 0), 0);
  // The wait is as long as the wait REALLY is: now minus the instant the gate
  // opened. It is no longer a width — it is the number printed under the
  // hatched segment, which is the only place it was ever unambiguous.
  const gateSec = gateWaitSec(row, tick) ?? 0;
  const total = steps.length + (row.gate ? 1 : 0);

  return (
    <div className="px-[var(--ds-space-cozy)] py-[var(--ds-space-base)]">
      <div className="flex items-stretch gap-[var(--ds-space-hair)]">
        {steps.map((s, i) => {
          const tone = STEP_TONE[s.state];
          const timed = s.durationSec !== undefined;
          // The hover card is 240px wide in a segment that may be 60px wide, so
          // it anchors to whichever edge keeps it on screen.
          const anchorRight = total > 2 && i >= total - 2;
          return (
            <div key={s.label} className="group relative min-w-0 flex-1 basis-0">
              {/* label rail — truncates hard; the hover card carries the detail */}
              <div className="flex min-w-0 items-center gap-1">
                <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", tone.dot, s.state === "current" && "animate-pulse motion-reduce:animate-none")} />
                <span className={cn("min-w-0 truncate text-[10.5px]", s.state === "pending" ? "text-muted-foreground" : tone.text)}>{s.label}</span>
              </div>
              {/* the track segment — one step, one slot, every time */}
              <button
                type="button"
                onClick={NOOP}
                aria-label={`${s.label} — ${s.state}${timed ? `, ${fmtElapsed(s.durationSec ?? 0)}` : ""}`}
                className={cn(
                  // A hover tint, and deliberately NO press dip: this segment is
                  // a disclosure trigger, not a command. Without the tint nobody
                  // discovers the detail card; with a dip it would promise a
                  // commit that never happens.
                  "mt-1 block h-2 w-full rounded-[3px] outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  dsMotion.fast,
                  "hover:brightness-125",
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
                <span
                  className={cn(
                    "absolute top-full z-50 mt-1 hidden w-60 rounded-lg border border-border bg-popover p-2.5 text-left shadow-lg group-hover:block group-focus-within:block",
                    anchorRight ? "right-0" : "left-0",
                  )}
                >
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

        {/* the wait is part of the run's time, so it is part of the timeline —
            one segment like any other, with the TRUE age printed under it */}
        {row.gate && (
          <div className="group relative min-w-0 flex-1 basis-0">
            <div className="flex min-w-0 items-center gap-1">
              <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-warning animate-pulse motion-reduce:animate-none" />
              <span className="min-w-0 truncate text-[10.5px] text-warning">Waiting on you</span>
            </div>
            <span
              aria-hidden
              title={`Waiting ${fmtElapsed(gateSec)}`}
              className="mt-1 block h-2 w-full rounded-[3px] bg-[repeating-linear-gradient(45deg,var(--color-warning)_0_4px,transparent_4px_8px)] opacity-70"
            />
            <span className="mt-0.5 block truncate font-mono text-[9.5px] tabular-nums text-warning">{gateAge(row, tick)}</span>
          </div>
        )}
      </div>

      {/* axis — when it started, how long it has been, where the time went.
          With equal segments this line is where duration lives, so it names
          both halves rather than only the total. */}
      <div className="mt-1.5 flex items-baseline gap-2 border-t border-border/40 pt-1 font-mono text-[9.5px] text-muted-foreground">
        <span>{row.time}</span>
        <span aria-hidden className="h-px flex-1 bg-border/50" />
        <span className="tabular-nums">
          {fmtElapsed(active)} working{row.gate ? ` · ${gateAge(row, tick)} waiting on you` : ""}
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
/**
 * The one legitimate case of a group strip being a member AGGREGATE: a typed
 * list (S5) whose members all run the identical step list. Each segment is a
 * fill bar — `Identity check 3/5` — so the group answers "how far is everyone"
 * without opening a single member. `sharedMemberPipeline` returns null the
 * moment two members disagree about their steps, so this can never be drawn
 * over pipelines that are not actually the same.
 */
function SharedPipelineStrip({ row }: { row: DemoRow }) {
  const fills = sharedMemberPipeline(row);
  if (!fills) return null;
  return (
    <div className={cn("border-t px-[var(--ds-space-cozy)] py-[var(--ds-space-base)]", dsBorder.subtle)}>
      <div
        className={cn(
          dsText.caps,
          "mb-[var(--ds-space-snug)] flex items-center gap-[var(--ds-space-snug)] text-[color:var(--ds-fg-muted)]",
        )}
      >
        Shared member pipeline
        <span className={cn(dsText.nums, "normal-case tracking-normal")}>{fills[0].total} people · identical steps</span>
      </div>
      <div className="flex items-stretch gap-[3px]">
        {fills.map((f) => (
          <div key={f.label} className="min-w-0 flex-1">
            {/* the count hugs its own label — floated right it reads as the
                NEXT segment's count, which is the kind of small lie a dense
                strip makes very easy */}
            <div className="flex min-w-0 items-baseline gap-[var(--ds-space-tight)]">
              <span className={cn(dsText.micro, dsText.nums, "shrink-0 text-[color:var(--ds-fg-muted)]")}>
                {f.done}/{f.total}
              </span>
              <span className={cn(dsText.meta, "min-w-0 truncate text-[color:var(--ds-fg-secondary)]")}>{f.label}</span>
            </div>
            <span
              aria-label={`${f.label} — ${f.done} of ${f.total} done${f.attention > 0 ? `, ${f.attention} needing you` : ""}`}
              className={cn("mt-[var(--ds-space-tight)] flex h-2 w-full overflow-hidden bg-[var(--ds-surface-2)]", dsRadius.xs)}
            >
              <span className="bg-[var(--ds-success-fg)] opacity-75" style={{ flexGrow: Math.max(f.done, 0.001) }} />
              <span className="bg-[var(--ds-status-waiting-fg)]" style={{ flexGrow: Math.max(f.attention, 0.001) }} />
              <span className="bg-[var(--ds-status-running-fg)] opacity-80" style={{ flexGrow: Math.max(f.running, 0.001) }} />
              <span className="bg-transparent" style={{ flexGrow: Math.max(f.total - f.done - f.attention - f.running, 0.001) }} />
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * Gate banner — pinned above the tabs whenever the run is waiting on the
 * operator, so the decision is visible from EVERY tab instead of hiding behind
 * a Review tab that most rows should not have.
 */
function GateBanner({ row, tick, onAction }: { row: DemoRow; tick: number; onAction: DemoActionHandler }) {
  const gate = row.gate;
  if (!gate) return null;
  // Parked is not a gate you answer with a click — it is an unknown you resolve
  // by looking. It gets its own tone so the two never read as the same thing.
  const parked = gate.kind === "parked";
  const Icon = parked ? Pause : ClipboardList;
  return (
    <div
      className={cn(
        "border-b px-[var(--ds-space-cozy)] py-[var(--ds-space-base)]",
        parked
          ? "border-[color:var(--ds-status-parked-border)] bg-[var(--ds-status-parked-bg)]"
          : "border-[color:var(--ds-status-waiting-border)] bg-[var(--ds-status-waiting-bg)]",
      )}
    >
      {/* icon 14 + gap 6 = 20px, which is exactly the hanging indent below.
          At gap-2 the note sat 2px left of the title it belongs to. */}
      <div className="flex items-center gap-[var(--ds-space-snug)]">
        <Icon
          aria-hidden
          className={cn(
            dsIcon.md,
            "shrink-0",
            parked ? "text-[color:var(--ds-status-parked-fg)]" : "text-[color:var(--ds-status-waiting-fg)]",
          )}
        />
        <span
          className={cn(
            dsText.ui,
            "min-w-0 truncate font-semibold",
            parked ? "text-[color:var(--ds-status-parked-fg)]" : "text-[color:var(--ds-status-waiting-fg)]",
          )}
        >
          {gate.title}
        </span>
        <span
          className={cn(
            dsText.meta,
            dsText.nums,
            "ml-auto shrink-0 whitespace-nowrap opacity-85",
            parked ? "text-[color:var(--ds-status-parked-fg)]" : "text-[color:var(--ds-status-waiting-fg)]",
          )}
        >
          open {gateAge(row, tick)} · since {fmtClock(gate.openedAt)}
        </span>
      </div>
      <p className={cn(dsText.body, "mt-[var(--ds-space-tight)] pl-5 leading-relaxed text-[color:var(--ds-fg-muted)]")}>{gate.note}</p>
      <div className="pl-5">
        <ParkResolutions row={row} onAction={onAction} />
        <BannerActions row={row} onAction={onAction} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// tab bodies
// ---------------------------------------------------------------------------

function LogsTab({
  row,
  liveCount,
  onAction,
  onOpenFailure,
}: {
  row: DemoRow;
  liveCount: number;
  onAction: DemoActionHandler;
  onOpenFailure?: () => void;
}) {
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
              {line.card === "gate" && <GateCardView row={row} onAction={onAction} />}
              {line.card === "failure" && <FailureCardView row={row} onOpenFailure={onOpenFailure} />}
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

/**
 * Provenance is NEUTRAL. Three sources used to be three hues, in a panel that
 * already spends its colour on status — and the chip spells the source out, so
 * the hue was decoration. They stay apart by weight: paper is what a human
 * wrote, so it reads strongest; a system read is quieter.
 */
const SOURCE_CHIP: Record<DemoRecordField["source"], { label: string; cls: string }> = {
  paper: { label: "paper", cls: "border-[color:var(--ds-border-loud)] text-[color:var(--ds-fg)]" },
  roster: { label: "roster", cls: "border-[color:var(--ds-border)] text-[color:var(--ds-fg-secondary)]" },
  ucpath: { label: "UCPath", cls: "border-[color:var(--ds-border)] text-[color:var(--ds-fg-muted)]" },
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
  const [edits, setEdits] = useState<Record<string, string>>({});
  useEffect(() => {
    setIdx(0);
    setReviewed(new Set());
    setApproved(new Set());
    setEdits({});
  }, [row.id]);

  if (records.length === 0) {
    return row.status === "failed" ? (
      <EmptyTab
        icon={TriangleAlert}
        text="Nothing to review — the extraction failed before it produced a single record, so there is no person and no page to look at. Re-upload a better scan."
      />
    ) : (
      <EmptyTab
        icon={ClipboardList}
        text="No records on this row. Only an OCR review row carries people to review — other rows show their decision in the banner above."
      />
    );
  }

  const rec = records[Math.min(idx, records.length - 1)];
  const approvable = records.filter((r) => r.state !== "blocked");
  const blocked = records.length - approvable.length;
  /**
   * A STANDALONE OCR run (S6) is a read-only report: approval IS delegation, so
   * a run nobody delegated has nothing to approve. `reviewOf` is the served
   * fact that says whether a parent is waiting on this decision — the read-only
   * surface is derived from it, never from a workflow name.
   */
  const readOnly = !row.reviewOf;
  const gaps = records.reduce((n, r) => n + r.checks.filter((c) => c.state !== "ok").length, 0);
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
          {readOnly
            ? `${gaps} completeness ${gaps === 1 ? "gap" : "gaps"} across ${records.length} people`
            : `${approved.size} approved · ${blocked > 0 ? `${blocked} blocked` : "none blocked"}`}
        </span>
        {/* No approve control exists on a standalone run — it is not disabled,
            it is absent, because the contract sends no approval gate for a run
            with nothing downstream. */}
        {readOnly ? (
          <span className="ml-auto inline-flex items-center gap-1.5 rounded-md border border-border bg-secondary/40 px-2.5 py-1 text-[11px] font-medium text-muted-foreground">
            <Eye aria-hidden className="size-3" />
            Read-only report — nothing to approve
          </span>
        ) : (
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
        )}
      </div>

      {/* conveyor */}
      <div className="flex items-center gap-1.5 border-b border-border/60 px-2.5 py-1.5">
        <IconActionButton tone="muted" icon={<ChevronLeft aria-hidden className="size-3.5" />} label="Previous person" onClick={() => go(-1)} />
        <span className="font-mono text-[10.5px] tabular-nums text-muted-foreground">
          {idx + 1} of {records.length}
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

      {/* page  ↔  extraction — a CONTAINER query, because what has to fit is
          the centre column, not the window.
          TWO rungs, and the split moves between them. The fields column has a
          hard floor: a label, a value, a provenance chip and a confidence
          number have to sit on one line or the value starts truncating, which
          is ~290px, which puts the centre column's floor at 464px. The page is
          a picture and scales to whatever is left. So from 464px they go side
          by side with the page at the smaller share,
          and at 680px — where both can be comfortable — the page takes the
          share back. Stacking is the last resort, not the 1280px default it
          became: an extraction the operator has to scroll to reach is the exact
          complaint this surface exists to answer. */}
      <div className="grid min-h-0 flex-1 grid-cols-1 gap-0 overflow-y-auto @min-[29rem]:grid-cols-[minmax(0,0.62fr)_minmax(0,1fr)] @min-[42.5rem]:grid-cols-[minmax(0,0.85fr)_minmax(0,1fr)]">
        <div className="flex flex-col gap-1.5 border-b border-border/60 p-3 @min-[29rem]:border-b-0 @min-[29rem]:border-r">
          <span className="text-[10px] uppercase tracking-wider text-muted-foreground">{rec.pageNote}</span>
          <div className="flex min-h-[13rem] flex-1 flex-col items-center justify-center gap-1.5 rounded-md border border-border bg-secondary/30">
            <FileText aria-hidden className="size-6 text-muted-foreground/60" />
            <span className="text-[11px] text-muted-foreground">Page {rec.page} — source image</span>
            <span className="text-[10px] text-muted-foreground/70">click to open full size</span>
          </div>
        </div>

        <div className="flex flex-col p-3">
          <span className="mb-1.5 text-[10px] uppercase tracking-wider text-muted-foreground">
            {readOnly ? "Read from this page — nothing here is editable" : "Extracted from this page — editable here, and only here"}
          </span>
          {rec.fields.map((f) => {
            const key = `${rec.id}:${f.label}`;
            const value = edits[key] ?? f.value;
            const dirty = value !== f.value;
            return (
              <div key={f.label} className="flex items-baseline gap-2 border-b border-border/40 py-[5px] text-[12px] last:border-b-0">
                {/* 96px, not 112: the four things on this line are the label,
                    the value, where it came from and how sure we are, and the
                    VALUE is the one being checked against the page. The label
                    gives up the width. */}
                <span className="flex w-24 shrink-0 items-center gap-1.5 text-muted-foreground">
                  {f.label}
                  {dirty && <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-warning" />}
                </span>
                {/* A value may only change with its page on screen — which is
                    why the packet row offers bulk approve but never an edit,
                    and why the input lives beside the scan rather than in a
                    form somewhere else. */}
                {f.editable ? (
                  <input
                    aria-label={`${f.label} — correct against the page shown beside it`}
                    value={value}
                    onChange={(e) => setEdits((prev) => ({ ...prev, [key]: e.target.value }))}
                    className={cn(
                      "min-w-0 flex-1 rounded border bg-transparent px-1.5 py-0.5 font-mono text-[11.5px] outline-none focus-visible:ring-2 focus-visible:ring-ring",
                      dirty ? "border-warning/50 bg-warning/5 text-warning" : "border-transparent text-foreground hover:border-border focus:border-border",
                    )}
                  />
                ) : (
                  <span className={cn("min-w-0 flex-1 font-mono text-[11.5px]", f.warn ? "text-warning" : "text-foreground")}>{f.value}</span>
                )}
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
            );
          })}
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
                <span className="w-28 shrink-0 text-muted-foreground">{c.label}</span>
                <span className={cn("min-w-0 flex-1 truncate", c.state === "ok" ? "text-secondary-foreground" : spec.cls)}>{c.value}</span>
                {/* A read-only report cannot be approved, so the only thing to
                    DO about a gap is to look again. */}
                {readOnly && c.state !== "ok" && (
                  <button
                    type="button"
                    onClick={NOOP}
                    className="shrink-0 rounded border border-border bg-card px-1.5 py-px text-[10px] font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    Re-check
                  </button>
                )}
              </div>
            );
          })}

          {/* Depth 2 — the person lookup this record delegated. It is shown on
              the row that owns the record and nowhere else: the packet group
              lists people, not the runs those people spawned. */}
          {rec.lookup && (
            <>
              <span className="mb-1 mt-3 text-[10px] uppercase tracking-wider text-muted-foreground">Delegated lookup (depth 2)</span>
              <div className="flex items-center gap-2 rounded-md border border-border/60 bg-secondary/25 px-2.5 py-1.5 text-[11.5px]">
                <GitBranch aria-hidden className="size-3 shrink-0 text-muted-foreground" />
                <span className="shrink-0 text-muted-foreground">Person Lookup</span>
                <span className="min-w-0 flex-1 truncate text-secondary-foreground">{rec.lookup.note}</span>
                <span className="shrink-0 font-mono text-[10px] text-muted-foreground">{rec.lookup.trace}</span>
                <StatusBadge status={rec.lookup.status} />
              </div>
            </>
          )}

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

      {/* per-person decision — absent entirely on a read-only report */}
      <div className="flex items-center gap-1.5 border-t border-border/60 bg-secondary/20 px-3 py-2">
        {readOnly ? (
          <>
            <button
              type="button"
              onClick={() => go(1)}
              className="inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-2.5 py-1 text-[11px] font-medium text-secondary-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <ArrowRight aria-hidden className="size-3" />
              Next person
            </button>
            <span className="ml-auto text-[10.5px] text-muted-foreground">
              Nothing is delegated to this run, so approval would release nothing — the report IS the outcome.
            </span>
          </>
        ) : (
          <>
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
          </>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// People tab — the Group Panel's per-person work surface.
// One filtered list — the same member lines the Group Row shows, with room to
// work through the set one person at a time.
// ---------------------------------------------------------------------------

const PEOPLE_FILTERS = [
  { key: "attention", label: "Needs you" },
  { key: "all", label: "All" },
  { key: "done", label: "Finished" },
] as const;

/**
 * A packet that has not been approved has no member rows — but it does know the
 * people it read. Showing them here (read-only, straight off the review row)
 * beats an empty list that implies the extraction found nobody. The rows are
 * flat text on purpose: there is no run behind them yet to open.
 */
function ExtractedPeoplePreview({ row, onOpenPanel }: { row: DemoRow; onOpenPanel: (workflow: string, id: string) => void }) {
  const reviewRow = row.reviewRunId ? DEMO_ROWS[row.reviewRunId] : undefined;
  const records = reviewRow?.records ?? [];
  if (records.length === 0) return <EmptyTab icon={Users} text="No people yet — this group has not fanned out." />;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-border/60 px-3 py-1.5 text-[11px]">
        <span className="inline-flex items-center gap-1.5 font-medium text-foreground">
          <Users aria-hidden className="size-3 text-muted-foreground" />
          {records.length} people extracted
        </span>
        <span className="text-muted-foreground">
          Member rows do not exist yet — approving is what creates them, one run per approved person.
        </span>
        {reviewRow && (
          <button
            type="button"
            onClick={() => onOpenPanel(reviewRow.wfLabel, reviewRow.id)}
            className="ml-auto inline-flex shrink-0 items-center gap-1 rounded-md border border-primary/45 bg-primary/12 px-2 py-0.5 text-[10.5px] font-semibold text-primary outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            Open review
            <ArrowRight aria-hidden className="size-3" />
          </button>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {records.map((r) => (
          <div key={r.id} className="flex w-full items-center gap-2 border-b border-border/40 px-3 py-1.5">
            <FileText aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="w-40 shrink-0 truncate text-[12.5px] font-medium text-foreground">{r.name}</span>
            <span className="w-20 shrink-0 font-mono text-[10.5px] text-muted-foreground">{r.eid ?? "—"}</span>
            <span className="min-w-0 flex-1 truncate text-[11.5px] text-muted-foreground">{r.note ?? r.pageNote}</span>
            <span className={cn("shrink-0 rounded-md border px-1.5 py-px text-[10px] font-semibold", RECORD_STATE[r.state].cls)}>
              {RECORD_STATE[r.state].label}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function PeopleTab({
  row,
  onSelect,
  onOpenPanel,
  checkedIds,
}: {
  row: DemoRow;
  onSelect: (id: string) => void;
  onOpenPanel: (workflow: string, id: string) => void;
  checkedIds: ReadonlySet<string>;
}) {
  // default to the attention lane only when there IS one — otherwise the tab
  // opens on an empty list, which reads as "nothing here" on a full packet
  const startFilter = memberAttentionIds(row.id).length > 0 ? "attention" : "all";
  const [filter, setFilter] = useState<(typeof PEOPLE_FILTERS)[number]["key"]>(startFilter);
  useEffect(() => setFilter(startFilter), [row.id, startFilter]);
  const ordered = orderedMemberIds(row.id);
  if (ordered.length === 0) {
    return <ExtractedPeoplePreview row={row} onOpenPanel={onOpenPanel} />;
  }
  const attention = memberAttentionIds(row.id);
  const shown = ordered.filter((id) => {
    const m = DEMO_ROWS[id];
    if (filter === "all") return true;
    // a rejected page is always in the attention lane — it is the one thing
    // stopping the packet from reading as clean
    if (filter === "attention") return attention.includes(id) || m.containment === "rejected";
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
          const rejected = m.containment === "rejected";
          const spec = MEMBER_ROW_ICON[m.status];
          const Icon = rejected ? CircleSlash : spec.icon;
          return (
            <button
              key={id}
              type="button"
              onClick={() => onSelect(id)}
              className="flex w-full items-center gap-2 border-b border-border/40 px-3 py-1.5 text-left outline-none hover:bg-accent/30 focus-visible:ring-2 focus-visible:ring-ring"
            >
              <Icon aria-hidden className={cn("size-3.5 shrink-0", rejected ? "text-muted-foreground" : spec.cls)} />
              <span className={cn("w-40 shrink-0 truncate text-[12.5px] font-medium text-foreground", rejected && "italic font-normal text-muted-foreground")}>
                {m.title}
              </span>
              <span className="w-20 shrink-0 font-mono text-[10.5px] text-muted-foreground">{m.eid ?? "—"}</span>
              <span className={cn("min-w-0 flex-1 truncate text-[11.5px]", m.status === "failed" ? "text-destructive" : "text-muted-foreground")}>
                {m.memberFact ?? m.outcome.text}
              </span>
              {checkedIds.has(id) && <Check aria-hidden className="size-3 shrink-0 text-success" />}
              {/* a rejected page is not a failed person — it never became work */}
              <StatusBadge status={m.status} label={rejected ? "Rejected" : undefined} />
            </button>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Receipt tab.
 *
 * When the row's `evidence.receiptId` resolves, this renders the FULL
 * `RunEvidenceReceipt` — confirmation numbers, the read-back that proved each
 * one, the identity observed at the commit, and the per-member confirmation
 * list inline (D17). The acceptance test is that the operator can double-check
 * the run without opening UCPath.
 *
 * When it does not resolve, the row's own short verdict stands — and every one
 * of those is an honest "no receipt" state (pending, cancelled before any write,
 * the write could not be verified). A pending run is not given a fabricated
 * receipt to fill the tab.
 */
function ReceiptTab({ row }: { row: DemoRow }) {
  const full = runReceiptFor(row);
  const staged = row.data.filter((d) => d.staged || d.unconfirmed);
  if (full) {
    return (
      <div className="min-h-0 flex-1 overflow-y-auto">
        <ReceiptView receipt={full} row={row} />
        {staged.length > 0 && <StagedBlock points={staged} />}
      </div>
    );
  }
  return <ShortReceipt row={row} />;
}

/** the values that are filled but not submitted, or submitted but never read back */
function StagedBlock({ points }: { points: DemoDataPoint[] }) {
  const unconfirmed = points.some((d) => d.unconfirmed);
  return (
    <div className="px-3 pb-3">
      <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        {unconfirmed ? "Unconfirmed — resolve present or absent" : "Staged — goes live when the run continues"}
      </div>
      <div className={cn("rounded-lg border px-3 py-1.5", unconfirmed ? "border-log-violet/35 bg-log-violet/6" : "border-border bg-secondary/20")}>
        {points.map((d) => (
          <div key={d.field} className="flex items-center gap-2 py-[3px] text-[12px]">
            <ArrowUpFromLine aria-hidden className="size-3 text-log-teal" />
            <span className="w-36 shrink-0 text-muted-foreground">{d.field}</span>
            <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-foreground">{d.value}</span>
            <SystemChip system={d.system} />
          </div>
        ))}
      </div>
    </div>
  );
}

function ShortReceipt({ row }: { row: DemoRow }) {
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
  const staged = row.data.filter((d) => d.staged || d.unconfirmed);
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
          {/* Per-member confirmation numbers, INLINE. The alternative — a link
              per person — turns filing one packet into opening twelve rows and
              copying twelve numbers out of them. */}
          {r.members && (
            <div className={cn("mt-2 border-t pt-2", r.tone === "success" ? "border-success/20" : "border-border/50")}>
              <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                Per-person confirmations ({r.members.length})
              </div>
              {r.members.map((m) => (
                <div key={m.name} className="flex items-center gap-2 py-[2px] text-[12px]">
                  {m.failed ? (
                    <X aria-hidden className="size-3 shrink-0 text-destructive" />
                  ) : (
                    <Check aria-hidden className="size-3 shrink-0 text-success" />
                  )}
                  <span className="w-36 shrink-0 truncate text-muted-foreground">{m.name}</span>
                  <span className={cn("min-w-0 flex-1 truncate font-mono text-[11.5px]", m.failed ? "text-destructive" : "text-foreground")}>
                    {m.value}
                  </span>
                  {m.verified && <span className="shrink-0 text-[10px] font-semibold text-success">read-back</span>}
                </div>
              ))}
            </div>
          )}
          {r.note && <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground">{r.note}</p>}
        </div>
      </div>
      {staged.length > 0 && <StagedBlock points={staged} />}
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
          {idx + 1} of {total}
        </span>
        <IconActionButton
          tone="muted"
          icon={<ChevronRight aria-hidden className="size-3.5" />}
          label="Next member"
          onClick={() => onSelect(siblings[(idx + 1) % total])}
        />
        <span className="ml-1 min-w-0 truncate text-[13px] font-semibold text-foreground">{row.title}</span>
        <StatusBadge status={row.status} label={row.containment === "rejected" ? "Rejected" : undefined} />
        {nextAttention && nextAttention !== row.id && (
          <button
            type="button"
            onClick={() => onSelect(nextAttention)}
            title="Jump to the next member needing you — the n key does the same"
            className="ml-auto inline-flex shrink-0 items-center gap-1 rounded-md border border-warning/45 bg-warning/10 px-2 py-0.5 text-[10.5px] font-semibold text-warning outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            Next attention
            <kbd className="rounded border border-warning/45 px-1 font-mono text-[9px]">n</kbd>
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

/**
 * The detail REGION: run shape · run detail · run context.
 *
 * The problem it solves is vertical, not decorative. Nine bands used to stack
 * above one scrolling body, and only the body carried `min-h-0 flex-1
 * overflow-y-auto` — so at 1280×720 the log stream, the reason the panel is
 * open at all, was left about 125px of a 542px panel. Splitting the region on
 * READING PATTERN (live state in the centre, reference in the rail) gives the
 * stream back everything the moved bands were eating.
 *
 * Three placements, and the middle one is the operator's own call:
 *
 *  - **< 1180px** — one column: shape, then detail, then context, and the
 *    region scrolls. The rail degrades to a section, never to nothing; Data
 *    and Evidence stay reachable.
 *  - **1180–1479px** — three columns, but the run's shape spans the full
 *    region width. Equal-width segments need width, and at 1280 the centre
 *    column alone is ~420px — six steps in 420px is six illegible stubs.
 *  - **≥ 1480px** — the centre column is wide enough to hold the shape on its
 *    own, so the rail rises beside it and gets the full height for its ledger.
 *
 * 1480 is measured, not chosen: 470 queue + 348 rail + 2 gaps + the region's
 * padding leaves the centre column ~590px there, which is the width at which
 * a six-segment timeline still prints readable labels.
 */
function PanelRegion({
  row,
  tick,
  onOpenPanel,
  onAction,
  isMember,
  children,
}: {
  row: DemoRow;
  tick: number;
  onOpenPanel: (workflow: string, id: string) => void;
  onAction: DemoActionHandler;
  isMember: boolean;
  children: ReactNode;
}) {
  const { collapsed, setOpen: setRailOpen } = useContextRail();
  const hasShape = row.steps.length > 0 || Boolean(sharedMemberPipeline(row));

  return (
    <div
      className={cn(
        // Below the three-column threshold the region is a scrolling stack, so
        // the rail sits under the panel instead of squeezing it to nothing.
        "flex min-h-0 flex-col gap-[var(--ds-space-cozy)] overflow-y-auto",
        "min-[1280px]:grid min-[1280px]:h-full min-[1280px]:overflow-hidden",
        "min-[1280px]:grid-rows-[auto_minmax(0,1fr)]",
        collapsed
          ? "min-[1280px]:grid-cols-[minmax(0,1fr)_var(--ds-w-context-spine)]"
          : "min-[1280px]:grid-cols-[minmax(0,1fr)_var(--ds-w-context-rail)]",
      )}
    >
      {hasShape && (
        <section
          aria-label="Run shape"
          className={cn(
            // NOT `overflow-hidden`, on purpose: a step's hover card hangs
            // below the strip, and an 87px strip that clips its own overlay
            // renders the detail unreachable. Nothing inside paints to the
            // corner, so the radius needs no clip.
            "min-w-0 shrink-0 border",
            "border-[color:var(--ds-border)] bg-[var(--ds-surface-1)]",
            dsRadius.lg,
            // full region width until the centre column can hold it alone
            "min-[1280px]:col-span-2 min-[1280px]:row-start-1",
            "min-[1480px]:col-span-1 min-[1480px]:col-start-1",
          )}
        >
          <Timeline row={row} tick={tick} />
          <SharedPipelineStrip row={row} />
        </section>
      )}

      <section
        aria-label="Run detail"
        className={cn(
          // A CONTAINER, not a viewport reader. The centre column's width is
          // now a function of the rail's state as well as the window's — the
          // same 1280px window gives it 414px with the rail open and 728px
          // with it collapsed — so any layout inside that used to switch on a
          // `min-[Npx]:` viewport query would switch at the wrong moment.
          "@container flex min-h-[24rem] min-w-0 flex-col overflow-hidden rounded-lg border border-border bg-card",
          "min-[1280px]:col-start-1 min-[1280px]:row-start-2 min-[1280px]:min-h-0",
        )}
      >
        {children}
      </section>

      {collapsed ? (
        <ContextRailSpine
          row={row}
          onOpen={() => setRailOpen(true)}
          className={cn(
            "min-[1280px]:col-start-2 min-[1280px]:row-start-2",
            "min-[1480px]:row-start-1 min-[1480px]:row-span-2",
          )}
        />
      ) : (
        <ContextRail
          row={row}
          tick={tick}
          isMember={isMember}
          onOpenPanel={onOpenPanel}
          onAction={onAction}
          onClose={() => setRailOpen(false)}
          className={cn(
            "shrink-0",
            "min-[1280px]:col-start-2 min-[1280px]:row-start-2 min-[1280px]:shrink",
            "min-[1480px]:row-start-1 min-[1480px]:row-span-2",
          )}
        />
      )}
    </div>
  );
}

export function DemoLogPanel({ row, tab, onTab, onSelect, onOpenPanel, checkedIds, onToggleChecked, onAction, tick, liveCount }: DemoLogPanelProps) {
  /**
   * The two Write-parked resolutions are the only commands that need a FORM
   * before they can be submitted — a proof to parse, or an evidence note and an
   * observation count to check against the fence. They are intercepted here and
   * routed to the resolution dialog; everything else goes straight through.
   */
  const [parkPending, setParkPending] = useState<ParkResolveState | null>(null);
  const [settling, setSettling] = useState<DemoCommandSettling | null>(null);
  /** the full FailureRecord is a lot of surface — it opens on demand */
  const [failureOpen, setFailureOpen] = useState(false);
  useEffect(() => {
    setParkPending(null);
    setSettling(null);
    setFailureOpen(false);
  }, [row.id]);

  const failure = failureRecordFor(row);

  const handleAction: DemoActionHandler = (target, action) => {
    if (action.kind === "command" && isParkResolution(action)) {
      setParkPending({ row: target, action });
      return;
    }
    // "Open failure" is navigation to THIS row's own record — it opens the
    // pinned block rather than travelling anywhere, so the outcome bar's one
    // action does the thing it says.
    if (action.kind === "navigation" && action.key === "open-failure" && failure) {
      setFailureOpen(true);
      return;
    }
    return onAction(target, action);
  };

  const available = tabsFor(row);
  const fallback = defaultTabFor(row);
  const effectiveTab = tab && available.includes(tab) ? tab : fallback;
  const panel = panelKindSpec(row);
  const variant = rowVariantSpec(row);
  const isMember = row.rowType === "member";
  const status = effectiveStatus(row);
  const tone = OUTCOME_TONE[row.outcome.tone];
  const elapsed = row.elapsedSec !== undefined ? fmtElapsed(row.elapsedSec + tick) : undefined;
  const attentionMember = isMember && (status === "failed" || status === "waiting" || status === "doneWarnings");
  /**
   * The gate banner and the outcome line were saying the same sentence twice —
   * "Waiting on you — approve 5 of 6 people, or open the review" one band above
   * a banner that says it at length and carries the buttons. Where the banner
   * renders, the banner wins; the outcome line keeps its real job, which is the
   * runs that have NO gate and would otherwise state their result nowhere but a
   * status chip.
   */
  const gateBannerShown = Boolean(row.gate) && panelKindOf(row) !== "review";

  return (
    <PanelRegion row={row} tick={tick} onOpenPanel={onOpenPanel} onAction={handleAction} isMember={isMember}>
      {isMember ? (
        <>
          <ConveyorHeader row={row} onSelect={onSelect} checkedIds={checkedIds} />
          <MemberSourceBlock row={row} onSelect={onSelect} />
        </>
      ) : (
        <div
          className={cn(
            "flex items-center border-b",
            dsBorder.subtle,
            "gap-[var(--ds-space-base)] px-[var(--ds-space-cozy)] py-[var(--ds-space-base)]",
          )}
        >
          <span className={cn(dsText.title, "min-w-0 truncate font-semibold text-[color:var(--ds-fg)]")}>{row.title}</span>
          <StatusBadge status={status} age={gateAge(row)} />
          {/* A ticking duration may never wrap: at a narrow window "5m 48s"
              was breaking across two lines and shoving the header off its
              baseline every time the panel got tight. */}
          {elapsed && (
            <span className={cn(dsText.meta, dsText.nums, "shrink-0 whitespace-nowrap text-[color:var(--ds-fg-secondary)]")}>
              {elapsed}
            </span>
          )}
          <span
            title={`${variant.name} → ${panel.name}`}
            className={cn(
              // The narrow-width casualty, on purpose. The panel kind is also
              // named on the tab bar below, and the row's own title is worth
              // more than a second copy of it — without this the title was
              // truncating to a single letter. Keyed to the COLUMN now, since
              // the column's width no longer follows the window's.
              "ml-auto hidden shrink-0 border px-[var(--ds-space-snug)] @min-[34rem]:inline-flex",
              dsRadius.sm,
              dsText.caps,
              dsBorder.base,
              "text-[color:var(--ds-fg-muted)]",
            )}
          >
            {panel.name}
          </span>
          <span className={cn(dsText.meta, dsText.nums, "shrink-0 text-[color:var(--ds-fg-muted)]")}>{row.trace}</span>
        </div>
      )}

      {/* The outcome line — one sentence of "so what". It is suppressed when the
          gate banner below is already carrying that sentence AND the buttons
          that answer it; two bands saying the same thing is how a dense panel
          teaches an operator to skim past both. */}
      {!gateBannerShown && (
        <div
          className={cn(
            "flex items-center border-b",
            "gap-[var(--ds-space-base)] px-[var(--ds-space-cozy)] py-[var(--ds-space-snug)]",
            tone.bar,
          )}
        >
          <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", tone.dot)} />
          <span className={cn(dsText.body, "min-w-0 truncate")}>{row.outcome.text}</span>
          <OutcomeActionButton row={row} onAction={handleAction} className="ml-auto" />
        </div>
      )}

      {/* Requeue-while-settling: an absence observation was accepted, the row
          went back into work to earn the second one, and it is neither finished
          nor failed until they agree. */}
      {settling && (
        <div className="border-b border-border/60 px-3 py-2">
          <SettlingPanel settling={settling} tick={tick} />
        </div>
      )}

      {/* the gate is pinned above the tabs — visible from every tab, on every
          panel kind, instead of hiding inside a Review tab most rows lack. It
          NEVER moves to the rail and is never behind a disclosure: a decision
          the run is blocked on has to be the loudest thing in the panel. */}
      {gateBannerShown && <GateBanner row={row} tick={tick} onAction={handleAction} />}

      {/* the failure record is pinned in the same slot as the gate, for the same
          reason: what broke, what is half-done and what is safe to retry must be
          readable from every tab — not just from the one the logs are on */}
      {failure && (
        <FailureRecordBlock failure={failure} open={failureOpen} onOpen={setFailureOpen} onOpenRow={onSelect} />
      )}

      {/* tabs — derived from the panel kind, never a fixed five */}
      {/* The ratified tab treatment: a 2px underline on the active tab, not a
          filled pill — same as `Tab` in the kit, so the panel's tabs and every
          other tab set in the product read as one control. */}
      <div
        role="tablist"
        aria-label="Run detail sections"
        className={cn(
          "flex shrink-0 items-center border-b",
          dsSize.hBar,
          dsBorder.base,
          "gap-[var(--ds-space-tight)] px-[var(--ds-space-base)]",
        )}
      >
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
                "relative -mb-px inline-flex cursor-pointer items-center border-b-2 border-transparent",
                "h-[var(--ds-h-bar)] gap-[var(--ds-space-snug)] px-[var(--ds-space-base)]",
                dsText.ui,
                dsFocus,
                dsMotion.base,
                active
                  ? "border-b-[color:var(--ds-accent)] font-semibold text-[color:var(--ds-fg)]"
                  : "text-[color:var(--ds-fg-muted)] hover:text-[color:var(--ds-fg)]",
              )}
            >
              <Icon aria-hidden className={cn(dsIcon.sm, "shrink-0")} />
              {meta.label}
              {dot && (
                <span
                  aria-hidden
                  className="absolute right-[var(--ds-space-hair)] top-[var(--ds-space-snug)] size-1.5 rounded-full bg-[var(--ds-status-waiting-fg)]"
                />
              )}
            </button>
          );
        })}
        <span className={cn(dsText.caps, "ml-auto min-w-0 truncate pl-[var(--ds-space-base)] text-[color:var(--ds-fg-faint)]")}>
          {tab && available.includes(tab) ? panel.name : `${panel.name} · state default`}
        </span>
      </div>

      {effectiveTab === "logs" && (
        <LogsTab
          row={row}
          liveCount={liveCount}
          onAction={handleAction}
          onOpenFailure={failure ? () => setFailureOpen(true) : undefined}
        />
      )}
      {effectiveTab === "review" && <ReviewTab row={row} />}
      {effectiveTab === "people" && <PeopleTab row={row} onSelect={onSelect} onOpenPanel={onOpenPanel} checkedIds={checkedIds} />}
      {effectiveTab === "receipt" && <ReceiptTab row={row} />}

      {/* member action bar — a rejected row gets none of it: there is no task
          behind it to retry, so the buttons are structurally absent, not
          disabled. Delete lives on the row footer. */}
      {isMember && row.containment !== "rejected" && (
        <div
          className={cn(
            "mt-auto flex items-center border-t bg-[var(--ds-surface-2)]",
            dsBorder.subtle,
            "gap-[var(--ds-space-snug)] px-[var(--ds-space-cozy)] py-[var(--ds-space-base)]",
          )}
        >
          {(status === "failed" || status === "doneWarnings") && (
            <Button size="sm" variant="secondary" onClick={NOOP} icon={<RotateCcw aria-hidden className={dsIcon.sm} />}>
              Retry
            </Button>
          )}
          {/* The one affirmative action on this bar, so it is the one primary.
              Its pressed state is carried by the icon AND the word, not by the
              fill alone. */}
          <Button
            size="sm"
            variant={checkedIds.has(row.id) ? "primary" : "secondary"}
            onClick={() => onToggleChecked(row.id)}
            aria-pressed={checkedIds.has(row.id)}
            icon={
              checkedIds.has(row.id) ? (
                <CheckCircle2 aria-hidden className={dsIcon.sm} />
              ) : (
                <Check aria-hidden className={cn(dsIcon.sm, "text-[color:var(--ds-success-fg)]")} />
              )
            }
          >
            {checkedIds.has(row.id) ? "Checked" : "Mark checked"}
          </Button>
          {attentionMember && (
            <Button size="sm" variant="outline" onClick={NOOP} icon={<Ban aria-hidden className={dsIcon.sm} />}>
              Skip
            </Button>
          )}
          <span className={cn(dsText.meta, "ml-auto inline-flex items-center gap-[var(--ds-space-tight)] text-[color:var(--ds-fg-muted)]")}>
            <Kbd>c</Kbd> checks · <Kbd>n</Kbd> next attention
          </span>
        </div>
      )}

      {/* The two typed exits from Write parked. There is no third. */}
      <ParkResolveDialog
        pending={parkPending}
        onClose={() => setParkPending(null)}
        onAction={onAction}
        onSettling={setSettling}
        tick={tick}
      />
    </PanelRegion>
  );
}
