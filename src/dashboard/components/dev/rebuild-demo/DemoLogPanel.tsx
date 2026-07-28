import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
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
  CornerDownRight,
  Eye,
  FileText,
  GitBranch,
  ImageOff,
  Info,
  Loader2,
  Pause,
  Receipt,
  RotateCcw,
  ScrollText,
  Search,
  ShieldCheck,
  TriangleAlert,
  UserRoundSearch,
  Users,
  X,
  Zap,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { IconActionButton } from "@/components/shared/IconActionButton";
import { MemberOutcomePending, MemberOutcomeWord, StatusBadge, type ProposedStatus } from "./demo-status";
import { panelKindOf, panelKindSpec, rowVariantSpec } from "./demo-catalog";
import { BannerActions, OutcomeActionButton, ParkResolutions, type DemoActionHandler } from "./DemoActions";
import { ContextRail, ContextRailSpine, useContextRail } from "./DemoContextRail";
import { CaptureLightbox, SystemChip } from "./DemoEvidence";
import { RunProvenanceBar } from "./DemoRunIdentity";
import { candidateCaptureFor, type DemoCapture, type DemoFailureRecord } from "./demo-evidence-wire";
import {
  actionsAt,
  agoSeconds,
  buildRecordCorrections,
  fmtClock,
  tabsFor as tabsForKind,
  type ActionDescriptorWire,
  type DemoTab,
  type GateCandidateSpec,
  type RecordCorrectionWire,
} from "./demo-wire";
import {
  Badge,
  Button,
  CardBase,
  FloatingSurface,
  IconButton,
  Kbd,
  LockedValue,
  MetaLine,
  Popover,
  PopoverContent,
  PopoverTrigger,
  ValueField,
  dsBorder,
  dsClip,
  dsFocus,
  dsIcon,
  dsLayer,
  dsMotion,
  dsRadius,
  dsSize,
  dsText,
  useDsBottomRightClaim,
  useDsEnterTransition,
} from "./demo-ui";
import { ReceiptView, runReceiptFor } from "./DemoReceipt";
import { InlineFailureRecord, failureRecordFor } from "./DemoFailure";
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
  type DemoDataPoint,
  type DemoLine,
  type DemoRecord,
  type DemoRecordCheck,
  type DemoRecordField,
  type DemoRow,
  type DemoStep,
  type LineKind,
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
  // A failed run's record now lives in the STREAM, at the line it died on — so
  // the panel opens there, ahead of every other default. Without this, moving
  // the record off the panel top would have hidden it behind a tab, which is
  // the one thing that must never happen to a failure. It outranks the review
  // default too: a review run that failed has nothing to approve, and its
  // empty Review tab is not where "what did this leave behind" is answered.
  if (status === "failed" && failureRecordFor(row)) return "logs";
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

/**
 * The log stream is the noisiest surface in the product, so it is the one that
 * had to give colour back — but only where colour is INFORMATION.
 *
 * The four categorical `--log-*` hues stay retired: `nav` and `search` are
 * chrome and read as a step on the neutral ink ramp, because "this line was a
 * navigation" is not a fact an operator needs to spot from across the panel.
 *
 * DIRECTION is different, and it is the one axis that gets its hue back
 * (`--ds-read-*` / `--ds-write-*`, see `ds/tokens.css`). It is the same pair
 * the Data ledger uses, so blue means "the run read this" and purple means "the
 * run changed something" on BOTH surfaces — a colour that means one thing in
 * one panel and nothing in the next is worse than no colour at all. The arrow
 * glyphs stay: colour is never the only differentiator.
 */
const LINE_ICON: Record<LineKind, { icon: typeof Check; cls: string }> = {
  nav: { icon: ArrowRight, cls: "text-log-slate" },
  search: { icon: Search, cls: "text-log-slate" },
  read: { icon: ArrowDownToLine, cls: "text-[color:var(--ds-read-fg)]" },
  write: { icon: ArrowUpFromLine, cls: "text-[color:var(--ds-write-fg)]" },
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
        // Was `rounded-[5px] px-1.5 py-px text-[10.5px]` and able to WRAP — the
        // most-drifted token in the folder, on a radius, a space and a type size
        // that exist nowhere else in the system. It is a chip; it is now shaped
        // like every other chip.
        "mr-[var(--ds-space-tight)] inline-flex shrink-0 items-center border",
        dsClip.token,
        "h-[var(--ds-h-xs)] gap-[var(--ds-space-tight)] px-[var(--ds-space-snug)]",
        dsRadius.sm,
        dsText.micro,
        read
          ? "border-[color:var(--ds-read-border)] bg-[var(--ds-read-bg)] text-[color:var(--ds-read-fg)]"
          : "border-[color:var(--ds-write-border)] bg-[var(--ds-write-bg)] text-[color:var(--ds-write-fg)]",
      )}
    >
      <Icon aria-hidden className={cn(dsIcon.sm, "shrink-0")} />
      {label} <span className={cn(dsText.nums, dsClip.text)}>{value}</span>
    </span>
  );
}

/**
 * ONE candidate on an identity gate, with the capture that proves it is a
 * person rather than a string.
 *
 * The capture is fetched by id (`candidateCaptureFor`), so a candidate whose id
 * resolves to nothing renders as a candidate with no capture and SAYS SO — it
 * never borrows the neighbouring one, and it never draws a stand-in of a system
 * page. Whether the bytes exist is a fact about the run, not a rendering
 * problem to smooth over.
 */
function CandidateCard({
  candidate,
  onOpenCapture,
}: {
  candidate: GateCandidateSpec;
  onOpenCapture: (capture: DemoCapture) => void;
}) {
  const capture = candidateCaptureFor(candidate.captureId);
  return (
    <div
      className={cn(
        "flex min-w-0 flex-col gap-[var(--ds-space-hair)] border p-[var(--ds-space-base)]",
        dsRadius.md,
        "border-[color:var(--ds-border)] bg-[var(--ds-surface-1)]",
      )}
    >
      <span className={cn(dsText.caps, "text-[color:var(--ds-fg-muted)]")}>{candidate.heading}</span>
      <span className={cn(dsText.ui, "min-w-0 truncate font-semibold text-[color:var(--ds-fg)]")} title={candidate.name}>
        {candidate.name}
      </span>
      <span className={cn(dsText.meta, dsText.nums, "min-w-0 truncate text-[color:var(--ds-fg-secondary)]")} title={candidate.sub}>
        {candidate.sub}
      </span>
      {candidate.matchedOn && (
        <span className={cn(dsText.meta, "text-[color:var(--ds-fg-muted)]")}>matched on {candidate.matchedOn}</span>
      )}
      {/* The way to the proof sits on the ROW's bottom edge, not on this card's.
          One candidate's description wraps to two lines and its neighbour's does
          not, so a fixed `mt-*` put one button a line below the other — on the
          one surface where the operator is comparing two people side by side.
          BOTH branches are pinned: a candidate with no capture is a shorter card
          still, and leaving that branch unpinned just moves the ragged edge. */}
      <CardBase className="pt-[var(--ds-space-tight)]">
        {capture ? (
          <Button
            size="sm"
            variant="outline"
            className="w-full"
            onClick={() => onOpenCapture(capture)}
            icon={<Camera aria-hidden className={dsIcon.sm} />}
          >
            See this candidate
          </Button>
        ) : (
          <span
            className={cn(
              dsText.meta,
              "inline-flex items-center gap-[var(--ds-space-tight)] text-[color:var(--ds-fg-faint)]",
            )}
          >
            <ImageOff aria-hidden className={cn(dsIcon.sm, "shrink-0")} />
            No capture — this was never on a page
          </span>
        )}
      </CardBase>
    </div>
  );
}

/**
 * THE DECISION, in the stream, where the lines that led to it are.
 *
 * It used to be drawn twice: a tall banner pinned above the tabs AND this card
 * at the moment the run stopped, with the same title, the same copy and the
 * same buttons. The operator asked for the banner to go, and removing it
 * removes a duplicate rather than a fact — the log lines above this card are
 * the argument for the decision, so this is where the buttons belong. What the
 * banner used to carry alone (the `note`, the age, the staged writes) now lands
 * here, and the panel header's status pill plus the floating notice keep the
 * decision reachable from anywhere else.
 *
 * It is the loudest element in the panel on purpose (DESIGN.md rule 1) and it
 * is never behind a disclosure.
 */
function InlineDecision({
  row,
  tick,
  onAction,
  anchorRef,
}: {
  row: DemoRow;
  tick: number;
  onAction: DemoActionHandler;
  anchorRef?: (node: HTMLElement | null) => void;
}) {
  const gate = row.gate;
  const [capture, setCapture] = useState<DemoCapture | null>(null);
  if (!gate) return null;

  const parked = gate.kind === "parked";
  const Icon = parked ? Pause : gate.kind === "identity" ? UserRoundSearch : ClipboardList;
  const fg = parked ? "text-[color:var(--ds-status-parked-fg)]" : "text-[color:var(--ds-status-waiting-fg)]";
  const staged = row.data.filter((d) => d.dir === "write" && d.staged).length;

  return (
    <div
      ref={anchorRef}
      tabIndex={-1}
      data-demo-decision={gate.kind}
      aria-label={`Decision — ${gate.title}`}
      className={cn(
        "mx-[var(--ds-space-cozy)] my-[var(--ds-space-base)] ml-5 border p-[var(--ds-space-cozy)]",
        dsRadius.lg,
        dsFocus,
        "border-[length:var(--ds-border-w-rail)]",
        parked
          ? "border-[color:var(--ds-status-parked-border)] bg-[var(--ds-status-parked-bg)]"
          : "border-[color:var(--ds-status-waiting-border)] bg-[var(--ds-status-waiting-bg)]",
      )}
    >
      {/* icon 14 + gap 6 = 20px, which is exactly the hanging indent below */}
      <div className="flex items-center gap-[var(--ds-space-snug)]">
        <Icon aria-hidden className={cn(dsIcon.md, "shrink-0", fg)} />
        <span className={cn(dsText.ui, "min-w-0 truncate font-semibold", fg)}>{gate.title}</span>
        <span className={cn(dsText.meta, dsText.nums, "ml-auto shrink-0 whitespace-nowrap opacity-85", fg)}>
          open {gateAge(row, tick)} · since {fmtClock(gate.openedAt)}
        </span>
      </div>

      <p className={cn(dsText.body, "mt-[var(--ds-space-tight)] pl-5 leading-relaxed text-[color:var(--ds-fg-muted)]")}>
        {gate.note}
      </p>

      <div className="flex flex-col gap-[var(--ds-space-base)] pl-5">
        {gate.candidates && gate.candidates.length > 0 && (
          <>
            {/* A LIST, sized by how many there are — two is the common case,
                never the contract. At a narrow centre column they stack, which
                keeps a name and its EID on one line each. */}
            <div className="mt-[var(--ds-space-base)] grid gap-[var(--ds-space-snug)] @min-[30rem]:grid-cols-2 @min-[52rem]:grid-cols-3">
              {gate.candidates.map((c) => (
                <CandidateCard key={c.heading} candidate={c} onOpenCapture={setCapture} />
              ))}
            </div>
            {/* Says the quiet part: this run is STOPPED, and it is stopped
                before the write rather than after it. */}
            <span className={cn(dsText.meta, "text-[color:var(--ds-fg-muted)]")}>
              {staged > 0
                ? `The run is held here. ${staged} write${staged === 1 ? "" : "s"} ${staged === 1 ? "is" : "are"} staged and ${staged === 1 ? "goes" : "go"} nowhere until you pick.`
                : "The run is held here and has written nothing. It cannot go past this step until you pick."}
            </span>
          </>
        )}

        {gate.staged && (
          <div
            className={cn(
              "mt-[var(--ds-space-base)] border p-[var(--ds-space-base)]",
              dsRadius.md,
              "border-[color:var(--ds-border)] bg-[var(--ds-surface-1)]",
            )}
          >
            {gate.staged.map((s) => (
              <div key={s.field} className="flex items-center gap-[var(--ds-space-snug)] py-[var(--ds-space-hair)]">
                <ArrowUpFromLine aria-hidden className={cn(dsIcon.sm, "shrink-0 text-[color:var(--ds-fg-muted)]")} />
                <span className={cn(dsText.meta, "w-32 shrink-0 truncate text-[color:var(--ds-fg-muted)]")}>{s.field}</span>
                <span className={cn(dsText.body, dsText.nums, "min-w-0 flex-1 truncate text-[color:var(--ds-fg)]")}>{s.value}</span>
                <SystemChip system={s.system} />
                {s.unconfirmed ? (
                  <Badge tone="warning" title="Sent to UCPath, but we never read the outcome back">
                    unconfirmed
                  </Badge>
                ) : (
                  <Badge tone="warning">staged</Badge>
                )}
              </div>
            ))}
          </div>
        )}

        <ParkResolutions row={row} onAction={onAction} />
        <BannerActions row={row} onAction={onAction} />
      </div>

      {capture && (
        <CaptureLightbox
          captures={[capture]}
          index={0}
          onIndex={NOOP}
          onClose={() => setCapture(null)}
          subject={{ label: row.displayName ?? row.title, trace: row.trace }}
        />
      )}
    </div>
  );
}

/**
 * The in-stream failure MARKER, for a step that broke and was retried — a run
 * that ended is served a real `FailureRecord` and renders `InlineFailureRecord`
 * here instead. This one has no record behind it and nothing to open, so it is
 * exactly what it looks like: a note on the line where something went wrong.
 */
function FailureCardView({ row }: { row: DemoRow }) {
  if (!row.failCard) return null;
  return (
    <div className="mx-3 my-1.5 ml-11 rounded-lg border border-destructive/40 bg-destructive/6 px-3 py-2 text-[12px]">
      <div className="mb-0.5 text-[11.5px] font-semibold text-destructive">{row.failCard.title}</div>
      <div className="text-[11px] text-muted-foreground">{row.failCard.meta}</div>
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
 *
 * **A WAIT IS A STATE OF A STEP, NOT A STEP OF ITS OWN.** The gate used to take
 * a whole extra segment at the end of the track while the step it was waiting
 * ON kept a solid bar of its own — so `Your review` occupied two of six slots
 * and read as two separate things, one of them apparently finished. Now the
 * step the operator is being waited on RENDERS the wait: its own bar goes
 * hatched amber and prints the true wait age beneath it, and the trailing
 * segment is gone. A step that is merely running keeps its solid bar, so
 * "working" and "waiting on you" are told apart by the bar's FILL rather than
 * by a slot count, and the timeline gets a sixth of its width back.
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
  // opened. It is not a width — it is the number printed under the hatched
  // bar, which is the only place it was ever unambiguous.
  const gateSec = gateWaitSec(row, tick) ?? 0;
  // WHICH step is being waited on. A gated run's own steps carry it (`waiting`),
  // so the gate has a bar to sit on; the index is what stops a run with two
  // waiting steps painting the age twice.
  const waitingIndex = row.gate ? steps.findIndex((s) => s.state === "waiting") : -1;
  // A gate whose run records no waiting step still has to be drawn — it is not
  // permitted to vanish because the shape did not line up. It keeps the old
  // trailing segment, which is the same true fact in the only slot left.
  const orphanGate = Boolean(row.gate) && waitingIndex === -1;
  const total = steps.length + (orphanGate ? 1 : 0);

  return (
    <div className="px-[var(--ds-space-cozy)] py-[var(--ds-space-base)]">
      <div className="flex items-stretch gap-[var(--ds-space-hair)]">
        {steps.map((s, i) => {
          const tone = STEP_TONE[s.state];
          const timed = s.durationSec !== undefined;
          // THIS is the segment the operator is being waited on. Its bar is
          // hatched rather than solid and the number under it is the wait, not
          // a duration the step never recorded.
          const isWait = i === waitingIndex;
          // The hover card is 240px wide in a segment that may be 60px wide, so
          // it anchors to whichever edge keeps it on screen.
          const anchorRight = total > 2 && i >= total - 2;
          return (
            <div key={s.label} className="group relative min-w-0 flex-1 basis-0">
              {/* label rail — truncates hard; the hover card carries the detail */}
              <div className="flex min-w-0 items-center gap-1">
                <span
                  aria-hidden
                  className={cn(
                    "size-1.5 shrink-0 rounded-full",
                    tone.dot,
                    (s.state === "current" || isWait) && "animate-pulse motion-reduce:animate-none",
                  )}
                />
                <span className={cn("min-w-0 truncate text-[10.5px]", s.state === "pending" ? "text-muted-foreground" : tone.text)}>{s.label}</span>
              </div>
              {/* the track segment — one step, one slot, every time */}
              <button
                type="button"
                onClick={NOOP}
                aria-label={
                  isWait
                    ? `${s.label} — waiting on you, ${fmtElapsed(gateSec)}`
                    : `${s.label} — ${s.state}${timed ? `, ${fmtElapsed(s.durationSec ?? 0)}` : ""}`
                }
                className={cn(
                  // A hover tint, and deliberately NO press dip: this segment is
                  // a disclosure trigger, not a command. Without the tint nobody
                  // discovers the detail card; with a dip it would promise a
                  // commit that never happens.
                  "mt-1 block h-2 w-full rounded-[3px] outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  dsMotion.fast,
                  "hover:brightness-125",
                  // HATCHED = the run is stopped ON this step, waiting for you.
                  // SOLID = it is doing the work itself. Same slot either way.
                  isWait
                    ? "bg-[repeating-linear-gradient(45deg,var(--color-warning)_0_4px,transparent_4px_8px)] opacity-70"
                    : tone.bar,
                  !isWait && !timed && s.state !== "pending" && "opacity-70",
                  s.state === "pending" && "border border-dashed border-border bg-transparent",
                )}
              />
              <div className="mt-0.5 flex min-w-0 items-baseline gap-1">
                <span
                  className={cn(
                    "truncate font-mono text-[9.5px] tabular-nums",
                    isWait ? "text-warning" : "text-muted-foreground",
                  )}
                >
                  {isWait ? gateAge(row, tick) : timed ? fmtElapsed(s.durationSec ?? 0) : ""}
                </span>
                {s.attempts && s.attempts > 1 && <span className="shrink-0 font-mono text-[9px] font-bold text-warning">×{s.attempts}</span>}
              </div>

              {(s.keyLines || timed || isWait) && (
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
                  {isWait ? (
                    <span className="flex items-center justify-between text-[10.5px]">
                      <span className="text-muted-foreground">Waiting</span>
                      <span className="font-mono text-warning">{fmtElapsed(gateSec)}</span>
                    </span>
                  ) : (
                    timed && (
                      <span className="flex items-center justify-between text-[10.5px]">
                        <span className="text-muted-foreground">Took</span>
                        <span className="font-mono text-secondary-foreground">{fmtElapsed(s.durationSec ?? 0)}</span>
                      </span>
                    )
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

        {/* THE ORPHAN CASE, and only that. A run that is gated but records no
            `waiting` step has no bar for the wait to ride, and a wait that
            silently disappears because the shape did not line up is the one
            thing this timeline may not do — so it keeps the segment it used to
            always have. On every fixture the demo holds, this does not render. */}
        {orphanGate && (
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
 * The panel's own ⓘ — where the demo's scaffolding vocabulary lives now.
 *
 * The row VARIANT and the panel KIND are how this demo talks about itself; they
 * are not facts about the run in front of the operator, so they cost the header
 * a 20px glyph at rest and nothing else. Same size, same slot and same
 * behaviour as the ⓘ on every queue row, so the two read as one affordance.
 */
function PanelKindInfo({
  row,
  variantName,
  panelName,
}: {
  row: DemoRow;
  variantName: string;
  panelName: string;
}) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <IconButton
          size="xs"
          variant="ghost"
          label={`What kind of row and panel this is — ${variantName} in a ${panelName}`}
          icon={<Info aria-hidden className={dsIcon.sm} />}
          onClick={(e) => e.stopPropagation()}
          className="shrink-0 data-[state=open]:bg-[var(--ds-surface-3)] data-[state=open]:text-[color:var(--ds-fg)]"
        />
      </PopoverTrigger>
      <PopoverContent title={variantName} description={`Opens in a ${panelName}`} side="bottom" align="end" width="md">
        <MetaLine items={[row.wfLabel, row.trace]} tone="faint" />
      </PopoverContent>
    </Popover>
  );
}

/**
 * The floating decision notice — the small, dismissable square that replaced
 * the gate banner in the corner of the panel.
 *
 * It is a LOCATOR, not a second copy of the decision: it appears only while the
 * inline decision is out of reach (a different tab, or scrolled past), it says
 * what is waiting and how long it has waited, and pressing it takes you there.
 * Dismissing it dismisses the reminder and nothing else — the decision keeps
 * its status pill in the header, its line in the outcome bar and its card in
 * the stream, and the notice comes back the moment the decision goes out of
 * reach again.
 *
 * It deliberately sits at `dsLayer.sticky`, BELOW the toast layer: a `danger`
 * toast never auto-dismisses, and a reminder must never cover a failure.
 *
 * WHERE IT SITS, and why that took a registry. It used to be pinned TOP-right
 * of the tab body, where it covered the People tab's own filter controls and
 * clipped the detail column underneath it — it was floating over the work the
 * operator had just switched tabs to do. Bottom-right is the corner a floating
 * reminder belongs in, and it is also the corner the TOAST viewport owns; a
 * `danger` toast never auto-dismisses, so "we will position them so they miss"
 * is not a fix when the two live in different coordinate systems and the
 * panel's width changes with the context rail. `useDsBottomRightClaim` makes
 * the miss STRUCTURAL: while this is mounted the toast viewport steps to
 * bottom-left — the same move it already makes for a modal — and stays fully
 * live, because a reminder does not outrank a failure. It only gets not to be
 * covered by one.
 */
function DecisionNotice({
  row,
  tick,
  onGo,
  onDismiss,
}: {
  row: DemoRow;
  tick: number;
  onGo: () => void;
  onDismiss: () => void;
}) {
  // Held for as long as this is mounted — keyed to mount, exactly like
  // `useDsModalPresence`, so there is no open/closed flag to get out of step.
  // Both hooks run BEFORE the early return: a hook behind a conditional return
  // is a hook whose count changes between renders.
  useDsBottomRightClaim();
  const entering = useDsEnterTransition();
  const gate = row.gate;
  if (!gate) return null;
  const parked = gate.kind === "parked";
  const Icon = parked ? Pause : gate.kind === "identity" ? UserRoundSearch : ClipboardList;
  const fg = parked ? "text-[color:var(--ds-status-parked-fg)]" : "text-[color:var(--ds-status-waiting-fg)]";

  return (
    // The status tint goes on an INNER layer, never on the floating surface
    // itself: `--ds-status-*-bg` is a colour-mix against transparent, so
    // painting it straight onto the floating element leaves the log stream
    // legible THROUGH the notice. A floating thing has to be opaque or it reads
    // as a rendering fault rather than as a surface.
    <FloatingSurface
      role="status"
      className={cn(
        "absolute bottom-[var(--ds-space-cozy)] right-[var(--ds-space-cozy)] overflow-hidden",
        // `md`, not `sm`. At 240px the ask truncated mid-word — `approve the
        // pe…` — which is the one line on this surface that has to survive: the
        // status is already on the header pill, so what is left here is WHAT IS
        // WANTED, and a reminder that cannot say what it is reminding you of is
        // a coloured rectangle.
        "w-[var(--ds-w-popover-md)] max-w-[calc(100%-2*var(--ds-space-cozy))]",
        dsLayer.sticky,
        // It ARRIVES — a reminder that blinks into the corner reads as a render
        // fault. Origin-aware: it rises out of the edge it is anchored to. No
        // reduced-motion branch, on purpose: the travel is `--ds-travel-md` and
        // the clock is `--ds-dur-enter`, and the preference zeroes both.
        dsMotion.enter,
        "data-[demo-enter=from]:translate-y-[var(--ds-travel-md)] data-[demo-enter=from]:opacity-0",
        parked ? "border-[color:var(--ds-status-parked-border)]" : "border-[color:var(--ds-status-waiting-border)]",
      )}
      {...entering}
    >
      <div
        className={cn(
          "flex items-start gap-[var(--ds-space-tight)] p-[var(--ds-space-snug)]",
          parked ? "bg-[var(--ds-status-parked-bg)]" : "bg-[var(--ds-status-waiting-bg)]",
        )}
      >
        {/*
          TWO LINES, not three, and the second one has two edges.

          It used to run title / `open 33m 50s — the run is held here` / `Go to
          the decision`: three lines of wildly unequal length stacked flush
          left, which is a ragged block rather than a card. The ask takes line
          one; line two carries the verb on the left and the age on the right,
          so the notice is a rectangle with a left edge and a right edge instead
          of a paragraph. `— the run is held here` went with it: it is a rule of
          the product, true of every gate, and the age already says it.
        */}
        <button
          type="button"
          onClick={onGo}
          className={cn(
            "flex min-w-0 flex-1 cursor-pointer flex-col gap-[var(--ds-space-tight)] p-[var(--ds-space-tight)] text-left",
            dsRadius.sm,
            dsFocus,
            dsMotion.fast,
            "active:translate-y-px hover:brightness-110",
          )}
        >
          <span className={cn(dsText.meta, "flex min-w-0 items-center gap-[var(--ds-space-tight)] font-semibold", fg)}>
            <Icon aria-hidden className={cn(dsIcon.sm, "shrink-0")} />
            <span className="min-w-0 truncate">{gate.title}</span>
          </span>
          <span className={cn(dsText.micro, "flex min-w-0 items-center gap-[var(--ds-space-base)]")}>
            <span className={cn("inline-flex min-w-0 items-center gap-[var(--ds-space-hair)] truncate font-semibold", fg)}>
              <CornerDownRight aria-hidden className={cn(dsIcon.sm, "shrink-0")} />
              Go to the decision
            </span>
            <span className={cn(dsText.nums, "ml-auto shrink-0 text-[color:var(--ds-fg-muted)]")}>
              {`open ${gateAge(row, tick)}`}
            </span>
          </span>
        </button>
        <IconButton
          size="xs"
          label="Dismiss this reminder — the decision stays open"
          onClick={onDismiss}
          icon={<X aria-hidden className={dsIcon.sm} />}
        />
      </div>
    </FloatingSurface>
  );
}

/**
 * Where a pinned-in-the-stream surface is, and whether the operator can
 * currently see it. Used twice: by the decision, and by the failure record that
 * moved into the stream beside it.
 *
 * The anchor is a CALLBACK ref because the element it points at unmounts every
 * time the tab changes — a plain ref would hold a detached node and scroll to
 * nothing. `inView` is what keeps the floating notice from being a second copy
 * of a decision already on screen.
 */
function useSeekAnchor(active: boolean, block: ScrollLogicalPosition = "center") {
  const [node, setNode] = useState<HTMLElement | null>(null);
  const [inView, setInView] = useState(false);

  useEffect(() => {
    if (!active || !node) {
      setInView(false);
      return;
    }
    if (typeof IntersectionObserver === "undefined") {
      // No observer (old browser, test renderer): assume the decision is NOT
      // visible, so the notice shows. Failing toward "reachable" is the only
      // safe direction for something a run is blocked on.
      setInView(false);
      return;
    }
    const observer = new IntersectionObserver((entries) => setInView(entries.some((e) => e.isIntersecting)), {
      threshold: 0.3,
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [active, node]);

  const seek = useCallback(() => {
    if (!node) return;
    const reduced = typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    node.scrollIntoView({ block, behavior: reduced ? "auto" : "smooth" });
    node.focus({ preventScroll: true });
  }, [node, block]);

  return { setNode, inView, seek, mounted: Boolean(node) };
}

// ---------------------------------------------------------------------------
// tab bodies
// ---------------------------------------------------------------------------

function LogsTab({
  row,
  liveCount,
  onAction,
  onSelect,
  failure,
  failureOpen,
  onFailureOpen,
  failureRef,
  tick,
  decisionRef,
}: {
  row: DemoRow;
  liveCount: number;
  onAction: DemoActionHandler;
  onSelect: (id: string) => void;
  /** the served record, if this run has one — the whole thing renders inline */
  failure: DemoFailureRecord | null;
  failureOpen: boolean;
  onFailureOpen: (open: boolean) => void;
  failureRef?: (node: HTMLElement | null) => void;
  tick: number;
  decisionRef?: (node: HTMLElement | null) => void;
}) {
  const [query, setQuery] = useState("");
  useEffect(() => setQuery(""), [row.id]);
  const lines = useMemo<DemoLine[]>(
    () => (row.id === "pl-daniel" ? [...row.lines, ...LIVE_SEQUENCE.slice(0, liveCount)] : row.lines),
    [row, liveCount],
  );
  /**
   * Where the record hangs. A fixture that marked its own dying line gets it
   * there; one that did not gets it after the last line, which is where the run
   * ended. A served failure record is NEVER dropped for want of a marker —
   * that would make the most important surface on the panel depend on a fixture
   * remembering to flag a line.
   */
  const failureLine = lines.findIndex((l) => l.card === "failure");
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
              {line.card === "gate" && <InlineDecision row={row} tick={tick} onAction={onAction} anchorRef={decisionRef} />}
              {line.card === "failure" &&
                (failure && i === failureLine ? (
                  <InlineFailureRecord
                    failure={failure}
                    open={failureOpen}
                    onOpen={onFailureOpen}
                    onOpenRow={onSelect}
                    anchorRef={failureRef}
                  />
                ) : (
                  <FailureCardView row={row} />
                ))}
            </div>
          );
        })}
        {failure && failureLine < 0 && (
          <InlineFailureRecord
            failure={failure}
            open={failureOpen}
            onOpen={onFailureOpen}
            onOpenRow={onSelect}
            anchorRef={failureRef}
          />
        )}
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
          {/* The run's PROVENANCE sits on the bar under its own stream: the
              workflow version qualifies every line above it, so it belongs on
              the same surface rather than in a rail section three columns away
              that repeated it beside five facts that never change. */}
          <span aria-hidden className="h-[var(--ds-h-xs)] w-px shrink-0 bg-[var(--ds-border)]" />
          <RunProvenanceBar row={row} />
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
  /**
   * The one provenance the operator creates. It is amber, not neutral, because
   * it is the only value on the surface that no machine ever observed: a
   * corrected field must never keep reading as a 0.97 paper read after a human
   * typed over it.
   */
  operator: {
    label: "you",
    cls: "border-[color:var(--ds-status-waiting-border)] bg-[var(--ds-status-waiting-bg)] text-[color:var(--ds-status-waiting-fg)]",
  },
};

const CHECK_ICON: Record<DemoRecordCheck["state"], { icon: typeof Check; cls: string }> = {
  ok: { icon: Check, cls: "text-success" },
  warn: { icon: TriangleAlert, cls: "text-warning" },
  fail: { icon: X, cls: "text-destructive" },
};

function ReviewTab({
  row,
  tick,
  onAction,
  decisionRef,
}: {
  row: DemoRow;
  tick: number;
  onAction: DemoActionHandler;
  decisionRef?: (node: HTMLElement | null) => void;
}) {
  // Memoised because the corrections memo below depends on it: `?? []` mints a
  // fresh array every render, which would re-derive every correction on every
  // tick of the demo clock.
  const records = useMemo(() => row.records ?? [], [row.records]);
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

  /**
   * Every correction the operator has made across the whole packet, minted by
   * the ONE builder in the wire module — so the number on the approve bar and
   * the list the approve command carries are the same derivation, and a
   * correction cannot be shown but not sent.
   */
  const corrections = useMemo<RecordCorrectionWire[]>(
    () => records.flatMap((r) => buildRecordCorrections(r.id, r.fields, edits, agoSeconds(-tick))),
    [records, edits, tick],
  );
  const correctionsFor = useCallback(
    (recordId: string) => corrections.filter((c) => c.recordId === recordId),
    [corrections],
  );
  /** the gate's own approve descriptor — the client never invents this button */
  const approveAction = useMemo<ActionDescriptorWire | undefined>(
    () => actionsAt(row.actions, "banner").find((a) => a.resolution?.startsWith("approve:")),
    [row.actions],
  );

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
      {/* approve bar — the gate on the whole set, and the review row's own
          decision anchor: this is what the floating notice jumps to on a panel
          whose decision surface is Review rather than the log stream. */}
      <div
        ref={row.gate ? decisionRef : undefined}
        tabIndex={row.gate ? -1 : undefined}
        data-demo-decision={row.gate ? row.gate.kind : undefined}
        className={cn("flex flex-wrap items-center gap-2 border-b border-border/60 bg-secondary/20 px-3 py-1.5", dsFocus)}
      >
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
        {/* Corrections are counted here, on the control that sends them, so the
            operator can see that approving carries their typing and not the
            machine's reading. */}
        {corrections.length > 0 && (
          <Badge tone="warning" title={corrections.map((c) => `${c.field}: ${c.from} → ${c.to}`).join(" · ")}>
            {`${corrections.length} correction${corrections.length === 1 ? "" : "s"}`}
          </Badge>
        )}
        {/* No approve control exists on a standalone run — it is not disabled,
            it is absent, because the contract sends no approval gate for a run
            with nothing downstream. */}
        {readOnly || !approveAction ? (
          <span className="ml-auto inline-flex items-center gap-1.5 rounded-md border border-border bg-secondary/40 px-2.5 py-1 text-[11px] font-medium text-muted-foreground">
            <Eye aria-hidden className="size-3" />
            Read-only report — nothing to approve
          </span>
        ) : (
          <button
            type="button"
            onClick={() =>
              onAction(row, {
                ...approveAction,
                payload: {
                  approved: String(approvable.length),
                  corrections: String(corrections.length),
                  correctionsJson: JSON.stringify(corrections),
                },
              })
            }
            disabled={reviewed.size < records.length}
            title={reviewed.size < records.length ? "Look at every person first" : approveAction.detail}
            className="ml-auto inline-flex items-center gap-1.5 rounded-md border border-success/50 bg-success/15 px-2.5 py-1 text-[11px] font-semibold text-success outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40"
          >
            <CheckCircle2 aria-hidden className="size-3" />
            Approve {approvable.length} of {records.length}
            {corrections.length > 0 && ` with ${corrections.length} correction${corrections.length === 1 ? "" : "s"}`}
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
          is ~290px, which puts the centre column's floor at 464px.

          THE PAGE'S SHARE WENT UP (0.62 → 0.8, 0.85 → 1.0). It used to be a
          box of whatever height was left over, so its width could be anything;
          now it holds the real document ratio, which means its width IS its
          legibility — a 176px-wide letter page is 228px tall and unreadable at
          any of it. At the wide rung the two columns are equal, which puts a
          ~330 × 427 page beside the fields it was read from.

          Stacking is the last resort, not the 1280px default it became: an
          extraction the operator has to scroll to reach is the exact complaint
          this surface exists to answer. */}
      <div className="grid min-h-0 flex-1 grid-cols-1 gap-0 overflow-y-auto @min-[29rem]:grid-cols-[minmax(0,0.8fr)_minmax(0,1fr)] @min-[42.5rem]:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div className="flex flex-col gap-1.5 border-b border-border/60 p-3 @min-[29rem]:border-b-0 @min-[29rem]:border-r">
          <span className="text-[10px] uppercase tracking-wider text-muted-foreground">{rec.pageNote}</span>
          {/* THE SHAPE OF THE REAL DOCUMENT. US Letter, 612 × 792 pt, held as a
              ratio so it is correct at every width — the placeholder used to be
              a hand-picked min-height that produced a ~0.48 letterbox, i.e. a
              picture of a page shape that does not exist. `max-h-full` keeps a
              tall page inside the pane when the pane is the constraint. */}
          <div className="flex w-full flex-col items-center justify-center gap-1.5 self-center rounded-md border border-border bg-secondary/30 aspect-[var(--ds-aspect-page)]">
            <FileText aria-hidden className="size-6 text-muted-foreground/60" />
            <span className="text-[11px] text-muted-foreground">Page {rec.page} — source image</span>
          </div>
        </div>

        <div className="flex flex-col p-3">
          <span className="mb-1.5 text-[10px] uppercase tracking-wider text-muted-foreground">
            {readOnly ? "Read from this page — nothing here is editable" : "Extracted from this page — editable here, and only here"}
          </span>
          {rec.fields.map((f) => {
            const key = `${rec.id}:${f.label}`;
            const value = edits[key] ?? f.value;
            const corrected = value !== f.value;
            /**
             * THE HONEST BIT. A field the operator has typed over is no longer a
             * paper read: its provenance becomes `operator`, and the model
             * confidence that belonged to the value it replaced is DROPPED
             * rather than inherited. The machine's reading is not lost — it is
             * on the correction, and it is one hover away here.
             */
            const source: DemoRecordField["source"] = corrected ? "operator" : f.source;
            const chip = SOURCE_CHIP[source];
            return (
              <div key={f.label} className="flex items-baseline gap-2 border-b border-border/40 py-[5px] text-[12px] last:border-b-0">
                {/* 80px, not 96 and not 112: the four things on this line are
                    the label, the value, where it came from and how sure we
                    are, and the VALUE is the one being checked against the
                    page. The label gives up the width — and it gave up another
                    16px when the value became a visible field, because the
                    box's own padding has to come from somewhere and it must
                    not come from the value. */}
                <span className="flex w-20 shrink-0 items-center gap-1.5 text-muted-foreground">
                  {/* Truncates rather than wraps. A wrapping label makes every
                      row a different height the moment one field is corrected,
                      and a checklist you scan down is worth more than the last
                      two characters of a label the input also announces. */}
                  <span className="min-w-0 truncate" title={f.label}>
                    {f.label}
                  </span>
                  {corrected && <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-warning" />}
                </span>
                {/* A value may only change with its page on screen — which is
                    why the packet row offers bulk approve but never an edit,
                    and why the input lives beside the scan rather than in a
                    form somewhere else.

                    THE SHARED PAIR (2026-07-27, operator: the same "how do I
                    edit this" they hit on the Data ledger, hit again here). An
                    editable extracted field used to draw `border-transparent`
                    with the outline arriving only on HOVER, on the theory that
                    a page of outlined boxes reads as a form to fill in rather
                    than a reading to check. That theory cost more than it
                    bought: at rest the field was indistinguishable from the
                    locked `UCPath` value on the line below it, so it only
                    looked editable AFTER it had been edited. It now uses the
                    same `ValueField` / `LockedValue` pair as the Data ledger —
                    a box takes typing, flat text with a lock does not, and the
                    distinction is carried by SHAPE at rest rather than by a
                    pointer the operator has to think to move.

                    Nothing about the correction itself changed: provenance
                    still flips to `you`, the model confidence is still DROPPED
                    rather than inherited, the dirty dot still marks the label,
                    and the approve action still counts the corrections. */}
                {f.editable && !readOnly ? (
                  <ValueField
                    ariaLabel={`${f.label} — correct against the page shown beside it${corrected ? `. Corrected by you; read from the page as ${f.value}` : ""}`}
                    title={value}
                    value={value}
                    dirty={corrected}
                    onChange={(next) => setEdits((prev) => ({ ...prev, [key]: next }))}
                    className="flex-1"
                  />
                ) : (
                  <LockedValue
                    value={f.value}
                    tone={f.warn ? "warning" : "default"}
                    reason={
                      readOnly
                        ? "A read-only report records what was read; there is nothing downstream for a correction to reach."
                        : "Looked up in a system of record — not read off this page, so there is nothing here to correct."
                    }
                    className="flex-1"
                  />
                )}
                <span
                  title={corrected ? `You typed this. The page was read as “${f.value}”.` : undefined}
                  className={cn("shrink-0 rounded border px-1 text-[9px] font-semibold uppercase", chip.cls)}
                >
                  {chip.label}
                </span>
                {/* The confidence slot never collapses: a corrected value keeps
                    the column but prints an em dash, so the eye can see that the
                    number is GONE rather than that the row lost a cell. */}
                {(f.confidence !== undefined || corrected) && (
                  <span
                    title={corrected && f.confidence !== undefined ? `The machine read that value at ${f.confidence.toFixed(2)}; yours has no model confidence.` : undefined}
                    className={cn(
                      "w-8 shrink-0 text-right font-mono text-[10px] tabular-nums",
                      corrected
                        ? "text-muted-foreground"
                        : (f.confidence ?? 1) < 0.6
                          ? "text-warning"
                          : "text-muted-foreground",
                    )}
                  >
                    {corrected ? "—" : f.confidence?.toFixed(2)}
                  </span>
                )}
              </div>
            );
          })}
          {correctionsFor(rec.id).length > 0 && (
            <p className="mt-1.5 text-[11px] leading-relaxed text-warning">
              {`${correctionsFor(rec.id).length} value${correctionsFor(rec.id).length === 1 ? "" : "s"} corrected by you. Approving files ${correctionsFor(rec.id).length === 1 ? "it" : "them"} as ${correctionsFor(rec.id).length === 1 ? "an operator correction" : "operator corrections"} in this run's evidence, beside what the page was read as.`}
            </p>
          )}
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
          {rec.state === "blocked"
            ? "Blocked records are excluded from Approve."
            : correctionsFor(rec.id).length > 0
              ? `Approve releases only this person's work — with your ${correctionsFor(rec.id).length} correction${correctionsFor(rec.id).length === 1 ? "" : "s"}, not the machine's reading.`
              : "Approve releases only this person's work."}
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
  // Read off the WORKFLOW, never off its id: the next workflow that declares a
  // vocabulary gets the outcome column with nothing to change here.
  const hasOutcomes = Boolean(row.workflow.memberOutcomes);

  return (
    // `@container`, not a viewport query: this list lives in the centre column,
    // which is 414px with the context rail open and 728px with it collapsed at
    // the SAME 1280px viewport. A media query would fold the Detail column at
    // the wrong moment in both directions.
    <div className="@container flex min-h-0 flex-1 flex-col">
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
              {/* A DOT, not the number.

                  The number was the third rendering of one fact: the tab
                  itself carries an amber dot when this group needs you, this
                  chip printed `Needs you 3`, and pressing it shows a list whose
                  length IS the three. A count above a list of exactly that
                  length is not information — and it moved the chip's own width
                  every time a member settled, so the filter row reflowed while
                  the operator was reading it.

                  The dot is the same mark the tab carries, so "there is
                  something here" reads identically in both places, and the
                  quantity comes from the list. `--ds-status-waiting-mark` is
                  the swatch token: this is a dot, never text. */}
              {f.key === "attention" && attention.length > 0 && (
                <span
                  aria-hidden
                  className="ml-[var(--ds-space-tight)] inline-block size-1.5 shrink-0 rounded-full bg-[var(--ds-status-waiting-mark)] align-middle"
                />
              )}
              {/* Colour is never the only encoding, and a dot has no text for a
                  screen reader to read. The count survives here, where it costs
                  the surface nothing. */}
              {f.key === "attention" && attention.length > 0 && (
                <span className="sr-only">{`, ${attention.length} need you`}</span>
              )}
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

      {/* The column heads exist because the outcome and the detail are two
          different questions and the list is long enough that the eye needs to
          be told which column answers which. `Outcome` only appears for a
          workflow that declares a vocabulary — a group with no vocabulary has
          one free-text column and captioning it twice would be a lie.

          `Detail` folds below 40rem, in lockstep with the cells it captions.
          At 414px the fixed columns plus the status pill consume the whole row,
          so the detail cell was rendering at zero width under a caption that
          promised something — a heading over an empty column is the same lie in
          the other direction. Folded, the detail still rides each row's `title`
          and the outcome (the axis that decides what to do next) keeps its
          place. */}
      <div
        className={cn(
          "flex items-center gap-2 border-b px-3 py-1",
          "border-[color:var(--ds-border)] bg-[var(--ds-surface-2)]",
        )}
      >
        <span aria-hidden className="size-3.5 shrink-0" />
        <span className={cn(dsText.caps, "w-36 shrink-0 text-[color:var(--ds-fg-muted)]")}>Person</span>
        <span className={cn(dsText.caps, "w-20 shrink-0 text-[color:var(--ds-fg-muted)]")}>EID</span>
        {hasOutcomes && (
          <span className={cn(dsText.caps, "w-[var(--ds-w-member-detail)] shrink-0 text-[color:var(--ds-fg-muted)]")}>
            Outcome
          </span>
        )}
        <span className={cn(dsText.caps, "hidden min-w-0 flex-1 text-[color:var(--ds-fg-muted)] @min-[40rem]:block")}>
          Detail
        </span>
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
              title={m.memberFact ?? undefined}
              className="flex w-full items-center gap-2 border-b border-border/40 px-3 py-1.5 text-left outline-none hover:bg-accent/30 focus-visible:ring-2 focus-visible:ring-ring"
            >
              <Icon aria-hidden className={cn("size-3.5 shrink-0", rejected ? "text-muted-foreground" : spec.cls)} />
              <span className={cn("w-36 shrink-0 truncate text-[12.5px] font-medium text-foreground", rejected && "italic font-normal text-muted-foreground")}>
                {m.title}
              </span>
              <span className="w-20 shrink-0 font-mono text-[10.5px] text-muted-foreground">{m.eid ?? "—"}</span>
              {/* THE OUTCOME, in its own fixed column and in the vocabulary its
                  workflow declares — the same word, the same tone and the same
                  renderer the queue uses. Until this pass the People tab still
                  read the free-text `memberFact`, so the operator saw the typed
                  `Not found` in the queue and the crammed `no UCPath mat…` here,
                  on the same person, one click apart. */}
              {hasOutcomes &&
                (m.memberOutcomeSpec ? (
                  <MemberOutcomeWord outcome={m.memberOutcomeSpec} className="w-[var(--ds-w-member-detail)] shrink-0" />
                ) : (
                  <MemberOutcomePending className="w-[var(--ds-w-member-detail)] shrink-0" />
                ))}
              <span
                className={cn(
                  "hidden min-w-0 flex-1 truncate text-[11.5px] @min-[40rem]:block",
                  m.status === "failed" ? "text-destructive" : "text-muted-foreground",
                )}
              >
                {m.memberFact ?? (hasOutcomes ? "—" : m.outcome.text)}
              </span>
              {/* `ml-auto` so the status still lands on the right edge in the
                  narrow column, where the flex-1 detail cell is not there to
                  push it. It is a no-op at the wide rung. */}
              <span className="ml-auto flex shrink-0 items-center gap-2">
                {checkedIds.has(id) && <Check aria-hidden className="size-3 shrink-0 text-success" />}
                {/* a rejected page is not a failed person — it never became work */}
                <StatusBadge status={m.status} label={rejected ? "Rejected" : undefined} />
              </span>
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
            <ArrowUpFromLine aria-hidden className="size-3 text-[color:var(--ds-write-fg)]" />
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
  children,
}: {
  row: DemoRow;
  tick: number;
  onOpenPanel: (workflow: string, id: string) => void;
  onAction: DemoActionHandler;
  children: ReactNode;
}) {
  const { collapsed, setOpen: setRailOpen, dataExpanded, setDataExpanded } = useContextRail();
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
          : // Expanding Data borrows from the centre column and gives it back.
            // It is a deliberate, reversible trade the operator makes with one
            // press, not a layout the panel settles into.
            dataExpanded
            ? "min-[1280px]:grid-cols-[minmax(0,1fr)_var(--ds-w-context-rail-wide)]"
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
          onOpenPanel={onOpenPanel}
          onAction={onAction}
          onClose={() => setRailOpen(false)}
          dataExpanded={dataExpanded}
          onDataExpandedChange={setDataExpanded}
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

  const available = tabsFor(row);
  const fallback = defaultTabFor(row);
  const effectiveTab = tab && available.includes(tab) ? tab : fallback;

  /**
   * THE DECISION, and how to get to it from anywhere.
   *
   * The gate banner is gone: it drew the decision a second time, above the
   * tabs, with the same words and the same buttons as the card already in the
   * stream. What replaces it is not a smaller banner but a different KIND of
   * thing — the header keeps the status pill (so the state is never invisible),
   * the outcome bar keeps its one-line verdict and its jump, and a small
   * dismissable notice appears in the corner whenever the decision itself is
   * out of reach. A decision a run is blocked on may never become unreachable;
   * it may only stop being drawn twice.
   */
  const decisionTab: DemoTab = panelKindOf(row) === "review" ? "review" : "logs";
  const { setNode: setDecisionNode, inView: decisionInView, seek: seekDecision } = useSeekAnchor(Boolean(row.gate));
  const [noticeDismissed, setNoticeDismissed] = useState(false);
  const [seekNonce, setSeekNonce] = useState(0);
  useEffect(() => setNoticeDismissed(false), [row.id, effectiveTab]);
  // Scrolling is deferred to an effect rather than done in the click handler
  // because the anchor may not exist yet: pressing the notice from the Receipt
  // tab switches tabs first, and the decision only mounts on the next commit.
  //
  // The dependency is the STABLE `seek` callback, never the hook's return
  // object. That object is a fresh literal on every render, and this panel
  // re-renders once a second on the demo's heartbeat — so depending on it
  // re-ran the scroll every tick and made the stream impossible to scroll away
  // from once the operator had jumped to the decision. `seek` changes only when
  // its node does, which is exactly the deferred case above.
  useEffect(() => {
    if (seekNonce === 0) return;
    seekDecision();
  }, [seekNonce, seekDecision]);
  const goToDecision = () => {
    if (effectiveTab !== decisionTab) onTab(decisionTab);
    setSeekNonce((n) => n + 1);
  };
  const noticeShown = Boolean(row.gate) && !noticeDismissed && !decisionInView;

  /**
   * The same mechanism for the failure record, which now lives in the stream
   * too. The outcome bar's `Open failure` is the persistent, undismissable
   * route to it from any tab: it switches to the logs, expands the diagnostic
   * record and scrolls it into view. A failed run also OPENS on the logs
   * (`defaultTabFor`), so this is the way back rather than the way in.
   *
   * It lands on `nearest`, not `center`: an expanded failure record is taller
   * than the stream, and centring a tall block puts its own opening line — the
   * summary and the write state — above the fold, which is the opposite of what
   * the jump is for.
   */
  const { setNode: setFailureNode, seek: seekFailure } = useSeekAnchor(Boolean(failure), "nearest");
  const [failureSeekNonce, setFailureSeekNonce] = useState(0);
  useEffect(() => {
    if (failureSeekNonce === 0) return;
    seekFailure();
  }, [failureSeekNonce, seekFailure]);
  const goToFailure = () => {
    if (effectiveTab !== "logs") onTab("logs");
    setFailureOpen(true);
    setFailureSeekNonce((n) => n + 1);
  };

  const handleAction: DemoActionHandler = (target, action) => {
    if (action.kind === "command" && isParkResolution(action)) {
      setParkPending({ row: target, action });
      return;
    }
    // "Open failure" is navigation to THIS row's own record, which is now in
    // the log stream — so it travels there and expands it, rather than toggling
    // a block that used to sit above the tabs.
    if (action.kind === "navigation" && action.key === "open-failure" && failure) {
      goToFailure();
      return;
    }
    // Likewise the outcome bar's `Review` / `Resolve`: with no banner above the
    // tabs, this is the persistent, undismissable route to the decision, so it
    // has to actually travel there rather than post a result nobody asked for.
    if (action.kind === "navigation" && (action.key === "open-gate" || action.key === "open-park") && row.gate) {
      goToDecision();
      return;
    }
    return onAction(target, action);
  };
  const panel = panelKindSpec(row);
  const variant = rowVariantSpec(row);
  const isMember = row.rowType === "member";
  const status = effectiveStatus(row);
  const tone = OUTCOME_TONE[row.outcome.tone];
  const elapsed = row.elapsedSec !== undefined ? fmtElapsed(row.elapsedSec + tick) : undefined;
  const attentionMember = isMember && (status === "failed" || status === "waiting" || status === "doneWarnings");

  return (
    <PanelRegion row={row} tick={tick} onOpenPanel={onOpenPanel} onAction={handleAction}>
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
          {/* THE PANEL KIND MOVED INTO THE ⓘ. It was drawn twice on this one
              surface — a chip here beside the trace id, and again at the right
              of the tab bar below — and both were the demo naming its own panel
              KIND, which is scaffolding, not a fact about this run. A
              production dashboard does not label its own panels; a demo that
              needs to teach what a panel kind is has one sanctioned place to do
              it, and this is it. */}
          <span className="ml-auto" />
          <PanelKindInfo row={row} variantName={variant.name} panelName={panel.name} />
          <span className={cn(dsText.meta, dsText.nums, "shrink-0 text-[color:var(--ds-fg-muted)]")}>{row.trace}</span>
        </div>
      )}

      {/* The outcome line — one sentence of "so what", and, on a gated row, the
          one route to the decision that can never be dismissed. It used to be
          suppressed wherever the gate banner repeated it; with the banner gone
          there is nothing to duplicate, and this line becomes the persistent
          top-of-panel statement the operator asked to keep BRIEF. */}
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

      {/* Requeue-while-settling: an absence observation was accepted, the row
          went back into work to earn the second one, and it is neither finished
          nor failed until they agree. */}
      {settling && (
        <div className="border-b border-border/60 px-3 py-2">
          <SettlingPanel settling={settling} tick={tick} />
        </div>
      )}

      {/* NOTHING ELSE GOES HERE. The failure record used to be a sixth band
          above the tabs — outcome line, bold restatement, code chip, permanence
          chip, disclosure, write-state summary — sitting on top of the log
          stream the panel is opened to read. It is now inline in the stream at
          the line the run died on; the one line above and its action are the
          whole of the failure at the panel top, and the outcome bar's `Open
          failure` travels to the record. Same rule as the gate banner in
          wave 6: the top carries a state and its action, the substance lives
          where it happened. */}

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
        {/* NOTHING SITS AT THE END OF THE TAB BAR. This slot held the panel's
            own kind — the second of the two copies on this surface. An earlier
            pass stripped the other half of the same strip (`· state default`)
            and left this, which is how a duplicate survives a cleanup: the
            sweep removes the words it can defend removing and keeps the label
            that felt like information. It was not; the ⓘ in the header carries
            it now. */}
      </div>

      {/* The tab body, and the positioning context for the floating notice. The
          notice belongs to the BODY rather than to the whole panel so it can
          never sit over the header, the outcome line or the tab bar — the three
          bands that are already telling the operator the same thing. */}
      <div className="relative flex min-h-0 flex-1 flex-col">
        {effectiveTab === "logs" && (
          <LogsTab
            row={row}
            liveCount={liveCount}
            onAction={handleAction}
            onSelect={onSelect}
            failure={failure}
            failureOpen={failureOpen}
            onFailureOpen={setFailureOpen}
            failureRef={setFailureNode}
            tick={tick}
            decisionRef={setDecisionNode}
          />
        )}
        {effectiveTab === "review" && (
          <ReviewTab row={row} tick={tick} onAction={handleAction} decisionRef={setDecisionNode} />
        )}
        {effectiveTab === "people" && <PeopleTab row={row} onSelect={onSelect} onOpenPanel={onOpenPanel} checkedIds={checkedIds} />}
        {effectiveTab === "receipt" && <ReceiptTab row={row} />}

        {noticeShown && (
          <DecisionNotice row={row} tick={tick} onGo={goToDecision} onDismiss={() => setNoticeDismissed(true)} />
        )}
      </div>

      {/* member action bar — a rejected row gets none of it: there is no task
          behind it to retry, so the buttons are structurally absent, not
          disabled. Delete lives on the row footer. */}
      {isMember && row.containment !== "rejected" && (
        <div
          className={cn(
            "mt-auto flex items-center border-t bg-[var(--ds-recess-bg)]",
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
