import type { MouseEvent as ReactMouseEvent, ReactNode } from "react";
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  ArrowUpRight,
  Camera,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  CircleAlert,
  ClipboardList,
  FileText,
  GitBranch,
  Info,
  Loader2,
  RotateCcw,
  ScanText,
  Search,
  SearchX,
  ShieldCheck,
  Users,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  MemberOutcomePending,
  MemberOutcomeWord,
  PROPOSED_STATUS,
  StatusBadge,
  statusText,
  type ProposedStatus,
} from "./demo-status";
import { panelKindSpec, rowExplanationOf, rowVariantSpec } from "./demo-catalog";
import {
  Button,
  Chip,
  ChipRow,
  IconButton,
  MetaLine,
  Popover,
  PopoverContent,
  PopoverTrigger,
  dsBorder,
  dsClip,
  dsFocus,
  dsIcon,
  dsMotion,
  dsRadius,
  dsSize,
  dsSurface,
  dsText,
} from "./demo-ui";
import { FooterActions, OutcomeActionButton, RowContextMenu, type DemoActionHandler } from "./DemoActions";
import { rowInBucket, type StatusBucket } from "./DemoShell";
import { DEMO_DAY, dayLabel } from "./demo-days";
import { fmtVersionTag, workflowVersionTag } from "./demo-wire";
import {
  bandsFor,
  DEMO_ROWS,
  effectiveStatus,
  fmtElapsed,
  gateAge,
  groupCounts,
  isSettledRow,
  linkedGroupSummary,
  recordStream,
  visibleMemberIds,
  orderedMemberIds,
  sortDemoRows,
  type DemoRecord,
  type DemoRow,
  type DemoSortKey,
} from "./demo-data";

/**
 * DEV-ONLY — the rebuild demo's queue panel. Attention bands, ONE member shape
 * at every count, the per-row ⓘ explanation, and the triage drill-in.
 *
 * The rows this panel receives are already scoped to the selected Workflow
 * Panel entry, and it filters them with the SAME predicate the Status Bar
 * counts with (`rowInBucket`). There is no second definition of "does this row
 * belong in this view", which is the only reason the badges and the rows are
 * structurally unable to disagree.
 */

export type DemoFilter = StatusBucket;
export type DemoView = { kind: "queue" } | { kind: "drill"; groupId: string };

export interface DemoQueueState {
  view: DemoView;
  filter: DemoFilter;
  selectedId: string;
  checkedIds: ReadonlySet<string>;
  /** which Group Rows are expanded — groups default collapsed (D5) */
  expandedGroups: ReadonlySet<string>;
  /** row order within the attention bands — never across them */
  sort: DemoSortKey;
  /** bulk-selection mode: checkboxes on top-level rows */
  selectMode: boolean;
  bulkIds: ReadonlySet<string>;
  tick: number;
  /**
   * The Workflow Panel entry this queue is scoped to. A row whose workflow IS
   * that entry does not print it again — the panel header, the rail badge and
   * the Status Bar have all already said it, and on a 400px column the chip was
   * costing a PDF row a hundred pixels of its own filename.
   *
   * Left undefined by a surface that mixes workflows (the component gallery,
   * and any future cross-workflow search), where the chip is the only thing
   * naming the owner — so the chip comes back on its own, with no flag.
   */
  panelWorkflow?: string;
}

export interface DemoQueueHandlers {
  onSelect: (id: string) => void;
  /** every control on a row goes through here — see `DemoActions` */
  onAction: DemoActionHandler;
  onFilter: (f: DemoFilter) => void;
  onDrillIn: (groupId: string) => void;
  onBack: () => void;
  onToggleGroup: (groupId: string) => void;
  /** jump to another Workflow Panel entry and select a row inside it */
  onOpenPanel: (workflow: string, id: string) => void;
  /** add/remove a row from the bulk target set */
  onToggleBulk: (id: string) => void;
}

/** the j/k traversal order for the current view — the SAME order the eye sees */
export function computeVisibleIds(
  rows: DemoRow[],
  state: Pick<DemoQueueState, "view" | "filter" | "expandedGroups" | "sort">,
): string[] {
  if (state.view.kind === "drill") return orderedMemberIds(state.view.groupId);
  const ids: string[] = [];
  for (const band of bandsFor(rows.filter((r) => rowInBucket(r, state.filter)))) {
    for (const row of sortDemoRows(band.rows, state.sort)) {
      ids.push(row.id);
      if (row.rowType === "group") ids.push(...visibleMemberIds(row, state.expandedGroups));
    }
  }
  return ids;
}

// ---------------------------------------------------------------------------
// Small row pieces
// ---------------------------------------------------------------------------

/**
 * A row's fact, on the `Chip` primitive.
 *
 * It used to be a local COPY of that primitive with the truncation left out,
 * which is exactly how `ticket · filed after signing` came to wrap to a second
 * line and paint itself outside its own border on the `ChipRow` track. The
 * primitive is a single-line token by construction — it truncates inside its
 * border and keeps the whole value on hover — so this is now a call, not a
 * fork, and every chip in the product inherits the same fix.
 *
 * The one thing a fact adds is DIRECTION: `old → new`. That is the row's own
 * arrow, and it renders as part of the value so the cut, when it comes, takes
 * the tail of the new value rather than the arrow that explains it.
 */
function FactChipView({ label, value, arrowTo, warn }: NonNullable<DemoRow["facts"]>[number]) {
  const full = [label, value, arrowTo && `→ ${arrowTo}`].filter(Boolean).join(" ");
  return (
    <Chip label={label} tone={warn ? "warning" : "neutral"} title={full} className="w-full">
      {arrowTo ? (
        <span className="inline-flex min-w-0 items-center gap-[var(--ds-space-tight)]">
          <span className="min-w-0 truncate">{value}</span>
          <ArrowRight aria-hidden className="size-2.5 shrink-0 text-[color:var(--ds-fg-muted)]" />
          <span className="truncate text-[color:var(--ds-fg)]">{arrowTo}</span>
        </span>
      ) : (
        value
      )}
    </Chip>
  );
}

/**
 * A group's member tally, read off the ONE status table.
 *
 * It replaces the production `StatusCounts`, which the demo had been importing
 * since wave 1. That component paints `queued` in `text-warning` and `running`
 * in `text-primary` — a direct contradiction of this design system, where
 * Queued and Running are deliberately HUELESS and amber is reserved for "a
 * human is involved". So the one strip in the queue that summarises eight
 * statuses was rendering four of them in colours the rest of the demo does not
 * use, which is a large part of why the operator said the row "doesn't look
 * like the rest of the ui". Same shape, same icons, one source of truth.
 */
function DemoStatusCounts({ counts }: { counts: ReturnType<typeof groupCounts> }) {
  const tallies: { key: ProposedStatus; n: number }[] = [
    { key: "verifiedDone", n: counts.done + counts.warnings },
    { key: "running", n: counts.running },
    { key: "queued", n: counts.queued },
    { key: "waiting", n: counts.waiting },
    { key: "parked", n: counts.parked },
    { key: "failed", n: counts.failed },
  ];
  return (
    <>
      {tallies.map(({ key, n }) => {
        // The three that are always true of a group are always shown, so the
        // strip does not reflow every time one crosses zero; the three that are
        // exceptions appear only when they happen.
        const always = key === "verifiedDone" || key === "running" || key === "queued";
        if (!always && n <= 0) return null;
        const spec = PROPOSED_STATUS[key];
        const Icon = spec.icon;
        return (
          <span
            key={key}
            aria-label={`${n} ${spec.label.toLowerCase()}`}
            title={spec.label}
            className={cn(
              "inline-flex shrink-0 items-center gap-[var(--ds-space-tight)] whitespace-nowrap",
              n === 0 ? "text-[color:var(--ds-fg-faint)]" : spec.iconClass,
            )}
          >
            <Icon
              aria-hidden
              className={cn(dsIcon.sm, key === "running" && n > 0 && "animate-spin motion-reduce:animate-none")}
            />
            <span className={dsText.nums}>{n}</span>
          </span>
        );
      })}
    </>
  );
}

function MicroSteps({ row }: { row: DemoRow }) {
  return (
    <span
      className="inline-flex shrink-0 items-center gap-[3px]"
      title={row.steps.map((s) => `${s.label}${s.durationSec ? ` ${fmtElapsed(s.durationSec)}` : ""} (${s.state})`).join(" · ")}
    >
      {row.steps.map((s, i) => (
        <span
          key={i}
          aria-hidden
          className={cn(
            "h-1 w-2.5 rounded-full",
            s.state === "done" && "bg-success",
            s.state === "current" && "bg-primary animate-pulse motion-reduce:animate-none",
            s.state === "pending" && "bg-border",
            s.state === "failed" && "bg-destructive",
            (s.state === "waiting" || s.state === "cancelled") && "bg-warning",
          )}
        />
      ))}
    </span>
  );
}

// ---------------------------------------------------------------------------
// The member line — one grid, three columns, every group
// ---------------------------------------------------------------------------

/**
 * The member line's column template, shared by the well and the drill-in.
 *
 * FIXED third and fourth columns are the whole point. The old line was a flex
 * row whose detail column sized itself to its own text, so the EIDs down a
 * 50-person roster landed in fifty different places and the longest member
 * decided where everyone else's name was cut. Fixing the two right-hand columns
 * gives the name every pixel that is left and puts the outcomes and the EIDs on
 * two straight edges.
 */
const MEMBER_GRID = "grid grid-cols-[1rem_minmax(0,1fr)_var(--ds-w-member-detail)_var(--ds-w-member-eid)]";

/**
 * What the detail column is CALLED for this group — `Outcome` when its workflow
 * declares an outcome vocabulary, `Detail` when the column holds free text.
 * Read off the workflow, never off the workflow's id.
 */
function memberDetailHeading(group: DemoRow): string {
  return group.workflow.memberOutcomes ? "Outcome" : "Detail";
}

/**
 * The third column of a member line.
 *
 * A workflow that declares a member-outcome vocabulary gets the typed OUTCOME
 * (drawn by the ONE shared renderer in `demo-status.tsx`, which the Log Panel's
 * People tab uses too); one that does not keeps the free-text fact it already
 * sends. Both land in the same fixed column, so the two kinds of group still
 * read as the same shape.
 */
function MemberDetailCell({ row }: { row: DemoRow }) {
  const outcome = row.memberOutcomeSpec;
  if (outcome) return <MemberOutcomeWord outcome={outcome} />;
  if (row.workflow.memberOutcomes) {
    // The workflow HAS a vocabulary and this member has not answered yet. The
    // column holds outcomes and only outcomes — dropping its free-text fact in
    // here would put `person-lookup…` under a heading that reads `Outcome`, and
    // the whole complaint was two axes sharing one column.
    return <MemberOutcomePending />;
  }
  return (
    <span
      className={cn(
        dsText.meta,
        dsText.nums,
        "min-w-0 truncate",
        row.status === "failed" && row.containment !== "rejected"
          ? "text-[color:var(--ds-status-failed-fg)]"
          : "text-[color:var(--ds-fg-muted)]",
      )}
    >
      {row.memberFact ?? "—"}
    </span>
  );
}

/**
 * A member line's leading glyph. Derived from the ONE status table, never a
 * second opinion about which icon or hue a status wears — that private copy is
 * how Queued and Cancelled came to be amber here while the design system called
 * them slate and neutral.
 */
const MEMBER_STATUS_ICON: Record<ProposedStatus, { icon: typeof CheckCircle2; cls: string }> = Object.fromEntries(
  (Object.keys(PROPOSED_STATUS) as ProposedStatus[]).map((s) => [
    s,
    { icon: PROPOSED_STATUS[s].icon, cls: PROPOSED_STATUS[s].iconClass },
  ]),
) as Record<ProposedStatus, { icon: typeof CheckCircle2; cls: string }>;

/**
 * ONE shell for every chip in a row header. There were six hand-rolled copies
 * of the same span here, differing only in tone and in whether they were
 * `font-semibold` — which is exactly how a queue ends up with six chip heights
 * on one line. Tone is the only thing a caller chooses.
 */
type RowChipTone = "neutral" | "info" | "warning" | "violet";

/** One recessed plane, four tones. A fill and no line — see `--ds-recess-*`. */
const ROW_CHIP_TONE: Record<RowChipTone, string> = {
  // `--ds-recess-fg-quiet`, not a hand-picked `--ds-fg-muted`: a row chip is a
  // MARKER you scan past (`test`, `dry run`, `v3.1`), which is a different job
  // from the recessed plane's other ink, the one that carries a value you read.
  neutral: "border-transparent bg-[var(--ds-recess-bg)] text-[color:var(--ds-recess-fg-quiet)]",
  info: "border-transparent bg-[var(--ds-info-bg)] text-[color:var(--ds-info-fg)]",
  warning: "border-transparent bg-[var(--ds-status-waiting-bg)] text-[color:var(--ds-status-waiting-fg)]",
  violet: "border-transparent bg-[var(--ds-status-parked-bg)] text-[color:var(--ds-status-parked-fg)]",
};

const rowChip = (tone: RowChipTone, extra?: string): string =>
  cn(
    // `max-w-full` + the truncating child below: a chip is a single-line token
    // at every width, and it truncates INSIDE its border rather than wrapping
    // outside it.
    // `text-ellipsis` is the half that was missing: `overflow-hidden` alone
    // cuts a value with no signal that anything was cut, which on a version tag
    // or an instance name is indistinguishable from a shorter value.
    "inline-flex shrink-0 items-center border text-ellipsis",
    dsClip.token,
    "h-[var(--ds-h-xs)] gap-[var(--ds-space-tight)] px-[var(--ds-space-snug)]",
    dsRadius.sm,
    dsText.micro,
    ROW_CHIP_TONE[tone],
    extra,
  );

function headerChips(row: DemoRow, checked: ReadonlySet<string>, tick: number): ReactNode {
  const status = effectiveStatus(row);
  // Only when the delegated runs have no row of their own to point at. Once
  // they do, the linked-set button in the body carries the count — two counts
  // of the same thing is exactly the divergence this rebuild exists to kill.
  const stream = recordStream(row, tick);
  const lookups = row.linkedGroup ? 0 : (stream.read ?? []).filter((r) => r.lookup).length;
  return (
    <>
      {/* Depth 2 lives here and nowhere else. The packet that delegated this
          run deliberately does not repeat it — two levels of run in a queue row
          is already the limit of what stays readable.

          While the document is still being READ the chip counts what has
          arrived against what the run says is there, because a bare `12` on a
          run that has reported five people is a number nobody can act on. */}
      {lookups > 0 && (
        <span
          title={
            stream.streaming
              ? `${lookups} delegated person lookups so far — one per person read. The rest arrive as the extraction reports them.`
              : `${lookups} delegated person lookups — one per record. Reachable only from this review row; the packet never lists them.`
          }
          className={rowChip("neutral")}
        >
          <GitBranch aria-hidden className={dsIcon.sm} />
          {stream.streaming ? `${lookups} of ${stream.total} lookups` : `${lookups} lookups`}
        </span>
      )}
      {/* a run started against a TEST instance can never be mistaken for a
          real filing, and a rehearsal says so before you read its receipt */}
      {Object.entries(row.resolvedInstance).some(([, v]) => v === "test") && (
        <span
          title={`Ran against the TEST instance of ${Object.entries(row.resolvedInstance)
            .filter(([, v]) => v === "test")
            .map(([k]) => k)
            .join(", ")} — nothing here reached production.`}
          className={rowChip("info", cn(dsText.caps, "tracking-[var(--ds-tracking-caps)]"))}
        >
          test
        </span>
      )}
      {row.dryRun && (
        <span
          title="Dry run — this rehearsal reads the systems and writes nothing."
          className={rowChip("violet", cn(dsText.caps, "tracking-[var(--ds-tracking-caps)]"))}
        >
          dry run
        </span>
      )}
      {/* MAJOR only: a run one MINOR behind renders identically, so flagging it
          would be a chip that never means anything. */}
      {row.workflowVersion !== row.workflow.version && (
        <span
          title={`Ran under ${row.workflow.label} ${fmtVersionTag({ major: row.workflowVersion, minor: row.workflowMinorVersion })}; runs are served by ${workflowVersionTag(row.workflow)} now. Its shape moved, so it is not comparable with today's.`}
          className={rowChip("neutral", dsText.nums)}
        >
          {fmtVersionTag({ major: row.workflowVersion, minor: row.workflowMinorVersion })}
        </span>
      )}
      {row.attemptHistory && (
        <span
          title={row.attemptHistory.prior}
          className={rowChip("warning", "font-semibold")}
        >
          <RotateCcw aria-hidden className={dsIcon.sm} />
          attempt {row.attemptHistory.n}
        </span>
      )}
      {row.warnings && (
        <span
          title={row.warnings.first}
          className={rowChip("warning", "font-semibold")}
        >
          <AlertTriangle aria-hidden className={dsIcon.sm} />
          {row.warnings.count}
        </span>
      )}
      {row.failShots && (
        <span
          title={`${row.failShots} failure screenshots`}
          className={rowChip("neutral")}
        >
          <Camera aria-hidden className={dsIcon.sm} />
          {row.failShots}
        </span>
      )}
      {row.receiptShield && (
        <span title={row.receiptShield} className="inline-flex shrink-0 items-center text-[color:var(--ds-success-fg)]">
          <ShieldCheck aria-hidden className={dsIcon.md} />
          <span className="sr-only">{row.receiptShield}</span>
        </span>
      )}
      {row.rowType === "member" && checked.has(row.id) && (
        <span title="Marked checked by you" className="inline-flex shrink-0 items-center text-[color:var(--ds-success-fg)]">
          <CheckCircle2 aria-hidden className={dsIcon.md} />
          <span className="sr-only">checked</span>
        </span>
      )}
      {status === "running" && row.rowType !== "group" && <MicroSteps row={row} />}
      {/* A collapsed row says how OLD the decision is, not only that there is
          one. Age is the whole triage signal. The icon is dropped here alone:
          the row already opens with this exact glyph beside the title, and one
          status wearing its icon twice on one line is noise, not a channel. */}
      <StatusBadge status={status} age={gateAge(row, tick)} hideIcon />
    </>
  );
}

/**
 * The ⓘ on every queue row.
 *
 * The operator's diagnosis, and it is the right one: *"i feel like we have too
 * much clutter right now. maybe its because i dont understand what is being
 * done."* Some of the felt clutter is UNEXPLAINED, not excessive — a row you
 * cannot name reads as noise even when every element on it is earning its
 * place. So each row can say what it is doing, what opening it will show, and
 * why it exists as its own row.
 *
 * Three rules hold it to that:
 *
 *  - **It is derived, never authored.** The sentences come off `demo-catalog`'s
 *    naming layer (row variant + panel kind), so a new fixture inherits a
 *    correct explanation with nothing to write, and the copy cannot drift from
 *    the row it describes.
 *  - **It explains; it never HIDES.** Nothing in here is a fact about this run.
 *    Status, gate age, counts, error, trace and every command stay on the row.
 *  - **It is a Popover, not a tooltip.** DESIGN.md forbids reachable content
 *    living behind hover alone — this opens on click, takes focus, returns it,
 *    and is reachable by keyboard and touch. And the trigger itself is always
 *    rendered rather than revealed on `:hover`, for the same reason. Quiet at
 *    rest is not the same as absent.
 */
function RowInfo({ row }: { row: DemoRow }) {
  const spec = rowVariantSpec(row);
  const panel = panelKindSpec(row);
  const ex = rowExplanationOf(row);
  return (
    <Popover>
      <PopoverTrigger asChild>
        <IconButton
          size="xs"
          label={`What is this row? — ${spec.name}`}
          icon={<Info aria-hidden className={dsIcon.sm} />}
          // Both stopped: the card root is itself a button, so without these a
          // press on the ⓘ also selects the row underneath it.
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") e.stopPropagation();
          }}
          // Quiet at rest, full contrast the moment it is hovered or focused —
          // and it STAYS lit while its popover is open (Radix stamps the
          // state), so the surface never floats free of the row that owns it.
          className="text-[color:var(--ds-fg-faint)] hover:text-[color:var(--ds-fg)] data-[state=open]:text-[color:var(--ds-fg)]"
        />
      </PopoverTrigger>
      {/* `md`, not `lg`: a 380px surface in a 380px queue column is
          collision-shifted on every open, which moves the point the entrance
          scales out of. 300px fits, so it always reads as coming from the ⓘ. */}
      <PopoverContent title={spec.name} side="bottom" align="start" width="md">
        <div className="flex flex-col gap-[var(--ds-space-base)]">
          <p className={cn(dsText.body, "leading-relaxed text-[color:var(--ds-fg)]")}>{ex.doing}</p>
          <p className={cn(dsText.body, "leading-relaxed text-[color:var(--ds-fg-secondary)]")}>{ex.panel}</p>
          <p className={cn(dsText.body, "leading-relaxed text-[color:var(--ds-fg-secondary)]")}>{ex.why}</p>
          {/* The rule the row's controls obey. It is here rather than on the
              row because it is the same rule on every packet — a sentence that
              never changes does not deserve four lines of a 400px column. */}
          {ex.constraint && (
            <p
              className={cn(
                dsText.body,
                "border-l pl-[var(--ds-space-base)] leading-relaxed",
                "border-[color:var(--ds-border-loud)] text-[color:var(--ds-fg-secondary)]",
              )}
            >
              {ex.constraint}
            </p>
          )}
          <MetaLine items={[spec.rowType, panel.name, `${row.wfLabel} · ${row.trace}`]} tone="faint" />
        </div>
      </PopoverContent>
    </Popover>
  );
}

/**
 * The subline is TEXT ONLY. The button beside it is the row's own
 * `outcome`-placement descriptor (`OutcomeActionButton`), so the queue and the
 * log panel offer literally the same command with the same label — and a row
 * that sends no outcome action simply has no button.
 */
function sublineFor(row: DemoRow): { tone: string; text: string } | null {
  const status = effectiveStatus(row);
  if (status === "failed" && row.error) return { tone: "text-[color:var(--ds-status-failed-fg)]", text: row.error };
  if (status === "waiting" && row.gate)
    return {
      tone: "text-[color:var(--ds-status-waiting-fg)]",
      text:
        row.gate.kind === "identity" && row.gate.candidates
          ? `${row.gate.title.replace("Waiting on you — ", "")} — ${row.gate.candidates[0].name} vs ${row.gate.candidates[1].name}`
          : row.gate.title,
    };
  // Parked is an UNKNOWN outcome, never a hold you resume.
  if (status === "parked") return { tone: "text-[color:var(--ds-status-parked-fg)]", text: row.outcome.text };
  if (status === "cancelled") return { tone: "text-[color:var(--ds-fg-muted)]", text: "Cancelled by you — nothing written" };
  if (status === "running" && row.liveText) return { tone: "text-[color:var(--ds-status-running-fg)]", text: row.liveText };
  if (row.rowType === "group" && row.ocrPhase) return { tone: "text-[color:var(--ds-fg-muted)]", text: row.ocrPhase };
  // A group's own decision lives on a member, so the group has no gate of its
  // own to quote — its rolled-up outcome is the sentence that says what is
  // blocked and what is at risk.
  //
  // CUT ON A SETTLED GROUP. On `ec-packet` that sentence read "5 done · 1
  // rejected — the packet stays at Done with warnings until the rejected page
  // is deleted or acknowledged": its first half is the status-counts strip two
  // bands below it, rendered again as prose, and its second half is a rule that
  // is true of every packet in the product. The full sentence is unchanged and
  // still rendered — by the panel's outcome line, which wave 6 made
  // unconditional — so nothing is lost, it is just not said twice on a row
  // nobody has to act on.
  if (row.rowType === "group" && !isSettledRow(row))
    return {
      tone: status === "waiting" ? "text-[color:var(--ds-status-waiting-fg)]" : "text-[color:var(--ds-fg-muted)]",
      text: row.outcome.text,
    };
  return null;
}

// ---------------------------------------------------------------------------
// The universal demo row card
// ---------------------------------------------------------------------------

/**
 * The row's FOOTER — the run's provenance line and its controls.
 *
 * WHY IT IS NOT THE PRODUCTION `RowFooter` ANY MORE. That footer packs
 * `time · #run · id · elapsed · queue note · buttons` onto ONE 11px line and
 * `truncate`s whatever loses, which at a 400px queue rendered
 * `2:24 PM · #5 · 1… · in queue 3m · 2 ahead · ⌃ ✕ ⋯` — a trace id cut to a
 * single character. It also drew itself in the SHIPPED dashboard's tokens
 * (`bg-secondary/20`, `text-[11px] font-mono`), which is a large part of why the
 * operator said the queue row "doesn't look like the rest of the ui".
 *
 * The rule here: **facts wrap, they never truncate.** The meta zone is one
 * wrapping provenance line at the row's own indent, and the controls are a
 * sibling pinned to the top-right — so when a run carries a queue note as well
 * as an id, the note takes a second line instead of eating the id, and the
 * buttons stay exactly where they were. A row with little to say stays one line
 * high; density is spent where there is something to be dense about.
 */
function RowFooterLine({
  row,
  handlers,
  elapsed,
}: {
  row: DemoRow;
  handlers: DemoQueueHandlers;
  elapsed?: string;
}) {
  const showId = row.subtitle && row.subtitle !== row.title;
  const timing = elapsed ?? row.duration ?? undefined;
  return (
    <div
      className={cn(
        // THE recessed plane, and the treatment every other recessed surface in
        // the product now copies: a fill, no line.
        "flex items-start gap-[var(--ds-space-base)] border-t px-[var(--ds-space-cozy)] py-[var(--ds-space-tight)]",
        dsBorder.subtle,
        "bg-[var(--ds-recess-bg)]",
      )}
    >
      <div
        className={cn(
          dsText.meta,
          dsText.nums,
          "flex min-h-[var(--ds-h-sm)] min-w-0 flex-1 flex-wrap items-center",
          "gap-x-[var(--ds-space-base)] gap-y-[var(--ds-space-hair)] text-[color:var(--ds-fg-muted)]",
        )}
      >
        <span className="whitespace-nowrap">{row.time}</span>
        <span
          className={cn(
            "inline-flex shrink-0 items-center border px-[var(--ds-space-tight)]",
            "h-[var(--ds-h-xs)]",
            dsRadius.sm,
            dsBorder.base,
            // The LAST outlined-and-lighter chip. It sat at `surface-1` on top
            // of the footer's `recess-bg` band — i.e. brighter than its own
            // parent, which is the one thing a recessed token can never be. It
            // reads as an inset in the band now: no fill of its own, the band's
            // ink, and its edge from the plane's border token.
            "border-[color:var(--ds-recess-border)] bg-transparent",
          )}
        >
          #{row.run}
        </span>
        {/* The trace id is the row's NAME in every log, every receipt and every
            support conversation, so it is the last thing that may be cut. It is
            `nowrap`: if the line runs out, the SEGMENTS AFTER IT wrap. */}
        {showId && (
          <span className="whitespace-nowrap text-[color:var(--ds-fg-secondary)]" title={row.subtitle}>
            {row.subtitle}
          </span>
        )}
        {timing && <span className="whitespace-nowrap">{timing}</span>}
        {row.queueNote && <span className="whitespace-nowrap">{row.queueNote}</span>}
      </div>
      {/* The frequent commands, inline. The full set is one right-click away —
          there is no `⋯`, because a button whose only job is to admit there are
          more buttons is a slot spent on every row in the queue. */}
      <div className="flex shrink-0 items-center gap-[var(--ds-space-hair)] pt-[var(--ds-space-hair)]">
        <FooterActions row={row} onAction={handlers.onAction} />
      </div>
      <span className="sr-only">{`Right-click or press m for every command on ${row.displayName ?? (row.title || row.trace)}`}</span>
    </div>
  );
}

export function DemoRowCard({
  row,
  state,
  handlers,
}: {
  row: DemoRow;
  state: DemoQueueState;
  handlers: DemoQueueHandlers;
}) {
  const selected = state.selectedId === row.id;
  const status = effectiveStatus(row);
  const sub = sublineFor(row);
  const elapsed = row.elapsedSec !== undefined ? fmtElapsed(row.elapsedSec + state.tick) : undefined;
  const isGroup = row.rowType === "group";
  const counts = isGroup ? groupCounts(row.id) : null;
  const memberCount = row.memberIds?.length ?? 0;
  const StatusIcon = PROPOSED_STATUS[status].icon;
  const linked = linkedGroupSummary(row);
  const settled = isSettledRow(row);
  // Whether the member LINES are on screen right now — the same condition
  // `GroupMemberList` uses to decide whether to draw the well. A settled group
  // shut by the operator draws none, so its name preview is still the only
  // place its composition appears.
  const membersVisible = isGroup && memberCount > 0 && !(settled && !state.expandedGroups.has(row.id));

  return (
    <div className="px-[var(--ds-space-cozy)] pt-[var(--ds-space-snug)] first:pt-[var(--ds-space-cozy)]">
      <RowContextMenu row={row} onAction={handlers.onAction}>
        <div
          onClick={() => handlers.onSelect(row.id)}
          role="button"
          tabIndex={0}
          aria-pressed={selected}
          aria-label={`${row.displayName ?? row.title} — ${statusText(status, gateAge(row, state.tick)).toLowerCase()}`}
          data-demo-row-id={row.id}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              handlers.onSelect(row.id);
            }
          }}
          className={cn(
            "group relative flex cursor-pointer flex-col overflow-hidden border",
            dsRadius.lg,
            dsMotion.base,
            dsSurface.card,
            dsFocus,
            selected ? dsBorder.strong : dsBorder.base,
            "hover:border-[color:var(--ds-border-strong)]",
            // Selection is a FILL plus a rail, never a glow: a shadow means
            // floating, and a selected row is not floating.
            //
            // The rail reads `--ds-ring`, not `--ds-accent`. On the dark theme
            // the accent is near-white, so a 2px accent rail down the selected
            // row was the brightest thing on the panel — louder than the amber
            // `Waiting on you` fill beside it. Selection is the lowest-stakes
            // state on screen; it belongs BELOW the two states allowed to
            // shout, and it now shares its ink with the focus ring because
            // "the system is pointing at this" is one statement, not two.
            selected && "bg-[var(--ds-surface-selected)] shadow-[inset_2px_0_0_var(--ds-ring)]",
            status === "running" && !selected && "border-[color:var(--ds-status-running-border)]",
          )}
        >
          {/*
            THE ROW'S RHYTHM, and the whole of it.

            One grid with a fixed leading track (`--ds-w-row-indent`) and ONE
            vertical gap. Every line under the title hangs off the same edge as
            the title, because the edge is a grid column rather than an `ml-5`
            re-typed on each of the six things that can appear here — which is
            how the old row came to have `mt-1.5` in four places, `mt-[snug]` in
            two, and a status tick sitting 8px from the name it belongs to while
            unrelated chips sat 6px apart.

            The tick binds to the name at `tight`; groups of content separate at
            `snug`. Two steps, on the 8px scale, the same two every other
            surface in this demo uses.
          */}
          <div
            className={cn(
              "grid min-w-0 grid-cols-[var(--ds-w-row-indent)_minmax(0,1fr)] items-start",
              "gap-y-[var(--ds-space-snug)] px-[var(--ds-space-cozy)] py-[var(--ds-space-snug)]",
            )}
          >
            <StatusIcon
              aria-hidden
              className={cn(dsIcon.md, "col-start-1 row-start-1 mt-px shrink-0", PROPOSED_STATUS[status].iconClass)}
            />
            <div className="col-start-2 row-start-1 flex min-w-0 items-center justify-between gap-[var(--ds-space-base)]">
              <div className="flex min-w-0 items-center gap-[var(--ds-space-snug)]">
                {/* Bulk selection is a TOP-LEVEL act: a member is acted on
                    through its group or on its own row, never half-selected
                    inside one. */}
                {state.selectMode && (
                  <input
                    type="checkbox"
                    checked={state.bulkIds.has(row.id)}
                    aria-label={`Select ${row.displayName || row.title || row.trace} for a bulk command`}
                    onClick={(e) => e.stopPropagation()}
                    onChange={() => handlers.onToggleBulk(row.id)}
                    className={cn("size-3.5 shrink-0 accent-[var(--ds-accent)]", dsFocus)}
                  />
                )}
                <span
                  title={row.displayName ? `Named by you — subject is ${row.title}` : undefined}
                  className={cn(
                    dsText.title,
                    "truncate font-semibold text-[color:var(--ds-fg)]",
                    row.containment === "rejected" && "italic font-normal text-[color:var(--ds-fg-muted)]",
                  )}
                >
                  {row.displayName ?? row.title}
                </span>
                {/* Which workflow owns this row — the only thing that tells a
                    packet apart from the OCR review row that shares its
                    filename. Printed the moment the surface mixes workflows,
                    and silent when every row on screen would say the same word. */}
                {row.wfLabel !== state.panelWorkflow && (
                  <span className={rowChip("neutral", cn(dsText.caps, "tracking-[var(--ds-tracking-caps)]"))}>{row.wfLabel}</span>
                )}
                {/* Sits on the chip line at the chip's own height, so explaining
                    a row costs the queue no vertical space at all. */}
                <RowInfo row={row} />
              </div>
              <div className="flex shrink-0 items-center gap-[var(--ds-space-snug)]">
                {headerChips(row, state.checkedIds, state.tick)}
              </div>
            </div>

            {/* A counted anchor ("5 separations") has no subject of its own, so
                the names ARE its identity — without them the row is a number.

                It is SUPPRESSED the moment the member list is on screen: the
                preview and the list are then the same names twice, on one
                card, and the preview is the copy that truncates. Two
                truncations on one card is one too many, and the second is a
                duplicate rather than a fact. */}
            {row.memberPreview && row.groupNoun && !membersVisible && (
              <div className={cn(dsText.meta, "col-start-2 truncate text-[color:var(--ds-fg-muted)]")} title={row.memberPreview}>
                {row.memberPreview}
              </div>
            )}

            {sub && (
              <div
                className={cn(
                  dsText.meta,
                  "col-start-2 flex min-w-0 items-center gap-[var(--ds-space-base)]",
                  sub.tone,
                )}
              >
                <span className="min-w-0 truncate">{sub.text}</span>
                <OutcomeActionButton row={row} onAction={handlers.onAction} className="ml-auto" />
              </div>
            )}

            {/* A SET of linked children — Oath Upload's signers. Still a chip,
                not a member list: each signer is an Oath Signature run with its
                own row in that panel, counted there exactly once. */}
            {linked && (
              <div className="col-start-2">
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    handlers.onOpenPanel(linked.panel, linked.targetId);
                  }}
                  title={`Open the ${linked.panel} panel — ${linked.total === 1 ? "this run lives" : "these runs live"} there, not under this row`}
                  className={linkChip("info")}
                >
                  <Users aria-hidden className={cn(dsIcon.sm, "shrink-0")} />
                  <span className="min-w-0 truncate">{linked.label}</span>
                  <ArrowUpRight aria-hidden className="size-3 shrink-0" />
                </button>
              </div>
            )}

            {/* THE BACK ROUTE, on the DESTINATION. One level, never a
                breadcrumb trail: maximum real depth is 2, so there is only ever
                one parent worth returning to.

                The `!row.reviewOf` guard is GONE. It existed because a review
                row drew its parent as a "Delegated by …" chip in the forward
                chip's slot and tone — a link that pointed backwards while
                looking like every link that points forwards. Following
                `OCR review ↗` from a packet therefore landed the operator on a
                row with no way back to the one they came from. Now the two
                delegated paths share ONE back chip: an arrow that points left,
                naming the panel and the row it returns to. */}
            {row.linkedParentId && DEMO_ROWS[row.linkedParentId] && (
              <div className="col-start-2">
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    const parent = DEMO_ROWS[row.linkedParentId as string];
                    handlers.onOpenPanel(parent.wfLabel, parent.id);
                  }}
                  title={`Back to ${DEMO_ROWS[row.linkedParentId].wfLabel} · ${DEMO_ROWS[row.linkedParentId].title} — the run that delegated this one`}
                  className={linkChip("neutral")}
                >
                  <ArrowLeft aria-hidden className={cn(dsIcon.sm, "shrink-0")} />
                  <span className="min-w-0 truncate">
                    {DEMO_ROWS[row.linkedParentId].wfLabel} · {DEMO_ROWS[row.linkedParentId].title}
                  </span>
                </button>
              </div>
            )}

            {/* The fact chips. A GRID, not a wrap: four facts of four different
                lengths on a flex row leave three on line one and `txn …`
                orphaned on line two, so the set reads as three-plus-one rather
                than as one block. */}
            {row.facts && (
              <ChipRow className="col-start-2">
                {row.facts.map((f, i) => (
                  <FactChipView key={i} {...f} />
                ))}
              </ChipRow>
            )}

            {isGroup && counts && (memberCount > 0 ? (
              <div className="col-start-2 flex flex-col gap-[var(--ds-space-snug)]">
                {/* THE COUNTS STRIP IS THE MEMBER LIST'S HEADER ROW, and it is
                    laid on the member list's OWN column tracks.

                    It used to be a free flex row with an `ml-auto` on the last
                    item, so the tallies sat wherever they stopped and
                    `0/12 checked` right-aligned to the CARD while the EIDs
                    below right-aligned to the WELL — two right edges a few
                    pixels apart, which reads as a mistake rather than as two
                    things. On `MEMBER_GRID` with the well's own horizontal
                    padding, the tallies sit over the names and the checked
                    counter sits over the EIDs. One grid, top to bottom. */}
                <div
                  className={cn(
                    MEMBER_GRID,
                    dsText.meta,
                    "items-center gap-x-[var(--ds-space-base)] px-[var(--ds-space-base)]",
                  )}
                >
                  <span aria-hidden className="col-start-1" />
                  <span className="col-start-2 flex min-w-0 items-center gap-[var(--ds-space-cozy)]">
                    <DemoStatusCounts counts={counts} />
                  </span>
                  {/* Rejected is its own tally. Folding it into done is how a
                      packet with an unreadable page comes to read as clean. */}
                  {counts.rejected > 0 && (
                    <span
                      className="col-start-3 inline-flex min-w-0 items-center gap-[var(--ds-space-tight)] truncate text-[color:var(--ds-fg-muted)]"
                      title={`${counts.rejected} rejected — never became work and excluded from the rollup`}
                    >
                      <SearchX aria-hidden className={cn(dsIcon.sm, "shrink-0")} />
                      <span className={dsText.nums}>{counts.rejected}</span> rejected
                    </span>
                  )}
                  {/* The checked counter is a PLACE-KEEPER for walking a list
                      that still needs walking. On a settled group it counts
                      progress through a job that is over, and invites a mark
                      that changes nothing — so it goes. */}
                  {!settled && (
                    <span
                      className="col-start-4 inline-flex items-center justify-end gap-[var(--ds-space-tight)] text-[color:var(--ds-success-fg)]"
                      aria-label={`${[...(row.memberIds ?? [])].filter((id) => state.checkedIds.has(id)).length} of ${memberCount} checked by you`}
                      title="How many of these you have marked checked"
                    >
                      <CheckCircle2 aria-hidden className={cn(dsIcon.sm, "shrink-0")} />
                      <span className={dsText.nums}>
                        {[...(row.memberIds ?? [])].filter((id) => state.checkedIds.has(id)).length}/{memberCount}
                      </span>
                    </span>
                  )}
                </div>
                <GroupMemberList row={row} state={state} handlers={handlers} />
              </div>
            ) : (
              <div className="col-start-2">
                <PacketBeforeFanout row={row} handlers={handlers} />
              </div>
            ))}

            {/* THE PEOPLE THIS RUN HAS READ. Same shape as a group's member
                lines, because it is the same thing — a person the row is
                accounting for — and it fills in as the extraction reports
                them, from the queue panel and from the OCR panel alike. */}
            {row.records && row.records.length > 0 && (
              <div className="col-start-2">
                <RecordStreamList row={row} tick={state.tick} />
              </div>
            )}

            {/* THE POINTER TO RELATED WORK, demoted and LAST.
                It used to sit high in the card on its own `ml-5` indent — so it
                broke the left edge every other line hangs off — and it wore the
                info tint, which made a pointer to somewhere else the loudest
                thing on a card whose job is "approve these people". It is
                necessary and it stays; it is now in the card's own grid, below
                the actions in the hierarchy, and quiet. Still obviously
                clickable: a bordered chip with a hover lift and the ↗ that
                means "this changes panel". */}
            {row.reviewRunId && (
              <div className="col-start-2">
                <LinkedReviewChip row={row} handlers={handlers} />
              </div>
            )}
          </div>

          <RowFooterLine row={row} handlers={handlers} elapsed={elapsed} />
        </div>
      </RowContextMenu>
    </div>
  );
}

/**
 * A chip that CHANGES PANEL. Three of these existed as three copies of the same
 * span; the delegation links and the parent back-link now share one shape, so
 * "this points somewhere else" always looks the same in a row.
 */
const linkChip = (tone: "info" | "neutral"): string =>
  cn(
    "inline-flex cursor-pointer items-center border",
    dsClip.token,
    "h-[var(--ds-h-xs)] gap-[var(--ds-space-snug)] px-[var(--ds-space-base)]",
    dsRadius.sm,
    dsText.meta,
    dsFocus,
    dsMotion.fast,
    // Same recessed plane as every other chip. The delegation chip used to be
    // outlined AND lighter than its neighbours — a third answer to "this sits
    // back from the card" on a surface that already had two.
    "border-transparent",
    tone === "info"
      ? "bg-[var(--ds-info-bg)] text-[color:var(--ds-info-fg)] hover:brightness-125"
      : "bg-[var(--ds-recess-bg)] text-[color:var(--ds-fg-muted)] hover:text-[color:var(--ds-fg)]",
  );

/**
 * A packet's pointer to the OCR review row that holds its records.
 *
 * FORWARD ONLY. It used to serve both directions — the same chip, the same info
 * tint, the same corner-arrow glyph, whether it pointed at the review a packet
 * delegated or back at the packet that delegated a review. A link that points
 * backwards while looking like every link that points forwards is how following
 * one leaves the operator stranded: the destination's chip read as another step
 * away, not as the way home. The return trip is the neutral `←` chip in the
 * card body, which both delegated paths now share.
 */
function LinkedReviewChip({ row, handlers }: { row: DemoRow; handlers: DemoQueueHandlers }) {
  const target = row.reviewRunId ? DEMO_ROWS[row.reviewRunId] : undefined;
  if (!target) return null;
  return (
    <div>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          handlers.onOpenPanel(target.wfLabel, target.id);
        }}
        title="Open the OCR panel and select this packet's review row — the records live there, not here"
        className={linkChip("neutral")}
      >
        <ClipboardList aria-hidden className="size-3 shrink-0" />
        <span className="min-w-0 truncate">OCR review · {statusText(effectiveStatus(target)).toLowerCase()}</span>
        <ArrowUpRight aria-hidden className="size-3 shrink-0" />
      </button>
    </div>
  );
}

/**
 * A packet parked at review has NO members: member rows are created by the
 * fan-out, and the fan-out is exactly what approval releases. So the row shows
 * the extracted count — the thing it genuinely knows — and offers the bulk
 * approval right here. Editing a value is deliberately NOT offered: a value may
 * only change with its scanned page on screen.
 *
 * **The block is an ACTION plus ONE line.** It used to carry a full paragraph —
 * who was excluded and why, then the whole editing policy — wrapped into four
 * lines inside a 400px column, where it was taller than the two buttons it was
 * explaining and dwarfed the row it sat in. What stayed is the fact this packet
 * alone has (`1 excluded — Diego Diaz is inactive in UCPath`); the reasoning
 * moved to the two surfaces that exist for it: the panel's decision, which
 * already renders the gate's own note in full, and the row's ⓘ, which carries
 * the editing rule because that rule is the same on every packet in the product.
 */
function PacketBeforeFanout({ row, handlers }: { row: DemoRow; handlers: DemoQueueHandlers }) {
  const bulk = row.bulkApprove;
  if (row.extractedCount === undefined) return null;
  return (
    <div className="flex flex-col gap-[var(--ds-space-snug)]">
      <div className={cn(dsText.meta, "flex flex-wrap items-center gap-[var(--ds-space-base)]")}>
        <span className={rowChip("neutral", "font-medium")}>
          <Users aria-hidden className={cn(dsIcon.sm, "text-[color:var(--ds-fg-muted)]")} />
          {row.extractedCount} people
        </span>
        {/* `member rows appear when you approve` was here. It described what
            the button beside it does, which the row's ⓘ already says once, for
            every packet in the product ("Approving fans out one real run per
            person"). */}
      </div>
      {bulk && (
        <div
          className={cn(
            "flex min-w-0 flex-col border",
            "gap-[var(--ds-space-snug)] px-[var(--ds-space-base)] py-[var(--ds-space-snug)]",
            dsRadius.md,
            "border-[color:var(--ds-status-waiting-border)] bg-[var(--ds-status-waiting-bg)]",
          )}
        >
          <div className="flex min-w-0 items-center gap-[var(--ds-space-snug)]">
            <Button
              size="sm"
              variant="primary"
              onClick={(e) => e.stopPropagation()}
              icon={<CheckCircle2 aria-hidden className={dsIcon.sm} />}
              className="shrink-0"
            >
              Approve {bulk.approvable} of {bulk.total}
            </Button>
            <Button
              size="sm"
              variant="secondary"
              onClick={(e) => {
                e.stopPropagation();
                if (row.reviewRunId) handlers.onOpenPanel(DEMO_ROWS[row.reviewRunId].wfLabel, row.reviewRunId);
              }}
              iconAfter={<ArrowUpRight aria-hidden className={dsIcon.sm} />}
              className="shrink-0"
            >
              Open review
            </Button>
          </div>
          {bulk.excluded && (
            // Its OWN line, because the leftover gutter beside two buttons in a
            // 400px column is ~110px and cut the one fact this line carries to
            // `1 excluded — Die…`. One line at full width holds it whole.
            <span className={cn(dsText.meta, "min-w-0 truncate text-[color:var(--ds-status-waiting-fg)]")}>
              <span className={dsText.nums}>{bulk.excluded.count}</span> excluded — {bulk.excluded.reason}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// ONE member shape, at every count: count strip → compact member lines in a
// scroll well → drill-in.
//
// There is no ladder. Shown a 2-member group drawn as full inline row cards
// beside a 6-member group drawn as compact lines, the operator asked *"why are
// some like this and some like that? keep the design like above. ditch the
// bottom design completely."* — which is the third and last time a rung has
// been cut for the same reason: a change of SHAPE reads as a change of KIND,
// and the same object must not appear to be two objects depending on how many
// people are in it.
//
// Scale now changes the container's OVERFLOW and nothing else. Three lines do
// not fill the well; fifty scroll inside it; the row is the same height either
// way, and `Open all N` is where a set that size is actually worked.
// ---------------------------------------------------------------------------

/**
 * A group's disclosure link — one shape for `Show all N` and `Open all N`, so
 * "there is more of this behind here" always looks the same in a row.
 */
const disclosureLink = cn(
  dsText.meta,
  "inline-flex cursor-pointer items-center gap-[var(--ds-space-tight)]",
  dsFocus,
  dsMotion.fast,
  "text-[color:var(--ds-fg-muted)] hover:text-[color:var(--ds-fg)]",
);

/** the status pill's own word, so the empty state names the filter the operator set */
function filterWord(filter: DemoFilter): string {
  if (filter === "needsYou") return "waiting on you or write parked";
  return PROPOSED_STATUS[filter as ProposedStatus].label.toLowerCase();
}

/**
 * THE WELL. One container for every list of people a row can hold, so a group's
 * members and an OCR run's extracted records are the same object on screen —
 * which they are: a person the row is accounting for. Its cap is what makes
 * scale presentational (three lines do not fill it, fifty scroll inside it),
 * and the half-cut row at the bottom of a long list IS the depth cue, which is
 * why the cap is 136px and not a whole number of rows.
 */
function PersonWell({ children }: { children: ReactNode }) {
  return (
    <div
      className={cn(
        // The recessed plane, plus the ONE case allowed to draw its edge: this
        // well SCROLLS, and the half-cut row at its bottom is only readable as
        // "there is more" if the container has a boundary to be cut by.
        // The edge is set by RE-POINTING `--ds-recess-border` on this element,
        // which is the mechanism the plane documents for exactly this case — a
        // scrolling well, whose half-cut bottom row is only readable as "there
        // is more" if there is a boundary to be cut by. Painting `dsBorder`
        // straight on made this the one recessed surface whose edge did not
        // come from the plane's own token.
        "divide-y overflow-hidden overflow-y-auto border bg-[var(--ds-recess-bg)]",
        "[--ds-recess-border:var(--ds-border-subtle)] border-[color:var(--ds-recess-border)]",
        dsRadius.md,
        "divide-[color:var(--ds-border-subtle)]",
        "max-h-[var(--ds-h-member-well)]",
      )}
    >
      {children}
    </div>
  );
}

/**
 * ONE person, on ONE line: status glyph · name · detail · EID, on the fixed
 * `MEMBER_GRID` track so the names down the left and the EIDs down the right
 * land on the same edge in every list, in every row, at every count.
 */
function PersonLine({
  icon: Icon,
  iconClass,
  name,
  nameClass,
  detail,
  eid,
  selected,
  onClick,
  title,
}: {
  icon: typeof CheckCircle2;
  iconClass?: string;
  name: string;
  nameClass?: string;
  detail: ReactNode;
  eid?: string;
  selected?: boolean;
  onClick?: (e: ReactMouseEvent) => void;
  title?: string;
}) {
  const body = (
    <>
      <Icon aria-hidden className={cn(dsIcon.sm, "shrink-0", iconClass)} />
      <span className={cn("min-w-0 truncate text-[color:var(--ds-fg)]", nameClass)}>{name}</span>
      {detail}
      <span className={cn(dsText.meta, dsText.nums, "min-w-0 truncate text-right text-[color:var(--ds-fg-muted)]")}>
        {eid ?? "—"}
      </span>
    </>
  );
  const shape = cn(
    MEMBER_GRID,
    "w-full items-center text-left",
    "h-[var(--ds-h-sm)] gap-x-[var(--ds-space-base)] px-[var(--ds-space-base)]",
    dsText.body,
  );
  if (!onClick) {
    return (
      <div title={title} className={shape}>
        {body}
      </div>
    );
  }
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className={cn(
        shape,
        "cursor-pointer",
        dsFocus,
        dsMotion.fast,
        "hover:bg-[var(--ds-surface-3)]",
        selected && "bg-[var(--ds-surface-selected)]",
      )}
    >
      {body}
    </button>
  );
}

/**
 * THE PEOPLE AN OCR RUN HAS READ, filling in as it reads them.
 *
 * The row used to carry a count and nothing else — `12 lookups` — which only
 * became information once the whole document was through. The operator:
 * *"the 12 should also appear like [a member list] as they get read. so i can
 * see in the queue panel as well in the ocr."*
 *
 * It is the SAME shape as a group's member lines, because it is the same thing:
 * a person this row is accounting for. The people the run has not reported are
 * a NUMBER, never a placeholder line — the extraction may yet find that a page
 * carries nobody, and a row that has already drawn them would have to take one
 * away.
 */
function RecordStreamList({ row, tick }: { row: DemoRow; tick: number }) {
  const stream = recordStream(row, tick);
  if (stream.total === 0) return null;
  const pending = stream.total - stream.read.length;
  return (
    <div className="flex flex-col gap-[var(--ds-space-snug)]">
      <div className={cn(dsText.meta, "flex items-center gap-[var(--ds-space-cozy)] text-[color:var(--ds-fg-muted)]")}>
        <span className="inline-flex items-center gap-[var(--ds-space-tight)]">
          <ScanText aria-hidden className={dsIcon.sm} />
          <span className={dsText.nums}>
            {stream.read.length} of {stream.total}
          </span>{" "}
          read
        </span>
        {stream.streaming && (
          <span className="inline-flex items-center gap-[var(--ds-space-tight)] text-[color:var(--ds-status-running-fg)]">
            <Loader2 aria-hidden className={cn(dsIcon.sm, "animate-spin motion-reduce:animate-none")} />
            reading
          </span>
        )}
      </div>
      {stream.read.length > 0 && (
        <PersonWell>
          {stream.read.map((rec) => (
            <PersonLine
              key={rec.id}
              icon={RECORD_STATE_ICON[rec.state].icon}
              iconClass={RECORD_STATE_ICON[rec.state].cls}
              name={rec.name}
              title={`${rec.name} — ${rec.pageNote}`}
              detail={
                <span className={cn(dsText.meta, "min-w-0 truncate text-[color:var(--ds-fg-muted)]")}>page {rec.page}</span>
              }
              eid={rec.eid}
            />
          ))}
        </PersonWell>
      )}
      {pending > 0 && (
        <span className={cn(dsText.meta, "text-[color:var(--ds-fg-faint)]")}>
          <span className={dsText.nums}>{pending}</span> more page{pending === 1 ? "" : "s"} to read — each person appears here
          as the run reports them.
        </span>
      )}
    </div>
  );
}

/**
 * A record's own state, on the ratified status glyphs — `ready` reads as the
 * quiet verified check, `warn` as the done-with-warnings circle, `blocked` as
 * the same `SearchX` a rejected member carries. Not a fourth vocabulary: the
 * same four channels, borrowed from the statuses that already mean this.
 */
const RECORD_STATE_ICON: Record<DemoRecord["state"], { icon: typeof CheckCircle2; cls: string }> = {
  ready: { icon: CheckCircle2, cls: "text-[color:var(--ds-status-verified-done-fg)]" },
  warn: { icon: CircleAlert, cls: "text-[color:var(--ds-status-done-warnings-fg)]" },
  blocked: { icon: SearchX, cls: "text-[color:var(--ds-status-failed-fg)]" },
};

function GroupMemberList({ row, state, handlers }: { row: DemoRow; state: DemoQueueState; handlers: DemoQueueHandlers }) {
  const ids = orderedMemberIds(row.id);
  const expanded = state.expandedGroups.has(row.id);
  // A SETTLED group is collapsed shut. This is ratified D5 read literally
  // ("groups default collapsed, auto-expand on a member `Waiting on you` or
  // `Failed`") — on a finished packet the member lines re-explain a composition
  // the count strip above has already reported. It is the ONLY branch left in
  // this component, and it turns on the run's STATE, never on its size.
  const settled = isSettledRow(row);
  const shut = settled && !expanded;
  const visible = shut ? [] : ids;
  const noun = row.wfLabel === "Oath Signature" ? "signers" : "people";
  return (
    <div>
      {/* The well, at EVERY count. Its cap is what makes scale presentational:
          three lines sit inside it without scrolling, fifty scroll, and the row
          occupies the same space either way. The half-cut row at the bottom of
          a long list IS the depth cue, which is why the cap is 136px and not a
          whole number of rows. */}
      {visible.length > 0 && (
        <PersonWell>
          {visible.map((id) => {
            const m = DEMO_ROWS[id];
            const spec = MEMBER_STATUS_ICON[m.status];
            return (
              <PersonLine
                key={id}
                icon={m.containment === "rejected" ? SearchX : spec.icon}
                iconClass={m.containment === "rejected" ? "text-[color:var(--ds-fg-muted)]" : spec.cls}
                name={m.title}
                nameClass={m.containment === "rejected" ? "italic text-[color:var(--ds-fg-muted)]" : undefined}
                detail={<MemberDetailCell row={m} />}
                eid={m.eid}
                selected={state.selectedId === id}
                onClick={(e) => {
                  e.stopPropagation();
                  handlers.onSelect(id);
                }}
              />
            );
          })}
        </PersonWell>
      )}
      {/* The disclosures, at every count. A settled group carries the toggle —
          it is the only way back to its members once it is shut — and the
          drill-in is always offered, because it is the same route into the same
          list whether that list is three people or fifty. */}
      <div className={cn(visible.length > 0 && "mt-[var(--ds-space-snug)]", "flex items-center gap-[var(--ds-space-cozy)]")}>
        {settled && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              handlers.onToggleGroup(row.id);
            }}
            className={disclosureLink}
          >
            {expanded ? <ChevronUp aria-hidden className={dsIcon.sm} /> : <ChevronDown aria-hidden className={dsIcon.sm} />}
            {expanded ? "Collapse" : `Show all ${ids.length} ${noun}`}
          </button>
        )}
        {!shut && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              handlers.onDrillIn(row.id);
            }}
            className={disclosureLink}
          >
            <ArrowRight aria-hidden className={dsIcon.sm} />
            Open all {ids.length} {noun}
          </button>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Drill-in triage table
// ---------------------------------------------------------------------------

/**
 * The drill-in's columns. The detail and EID widths are the SAME tokens the
 * well uses, so a member says the same thing in the same place at both rungs.
 */
// The name column takes `minmax(0,…)`, not a 110px floor: a floor plus four
// fixed columns overflowed the 400px queue and clipped the duration off the
// right edge, which is how a table ends up saying `41` where it means `41s`.
const DRILL_GRID = "grid grid-cols-[1rem_minmax(0,1fr)_var(--ds-w-member-eid)_var(--ds-w-member-detail)_2.5rem]";

/** the drill-in header's three summary chips — one shape, two loudness levels */
const drillChip = (warn: boolean): string =>
  cn(
    "inline-flex shrink-0 items-center border border-transparent text-ellipsis",
    dsClip.token,
    "h-[var(--ds-h-xs)] gap-[var(--ds-space-tight)] px-[var(--ds-space-base)]",
    dsRadius.sm,
    dsText.meta,
    warn
      ? "bg-[var(--ds-status-waiting-bg)] font-medium text-[color:var(--ds-status-waiting-fg)]"
      : "bg-[var(--ds-recess-bg)] text-[color:var(--ds-recess-fg-quiet)]",
  );

function DrillIn({ groupId, state, handlers }: { groupId: string; state: DemoQueueState; handlers: DemoQueueHandlers }) {
  const group = DEMO_ROWS[groupId];
  const ids = orderedMemberIds(groupId);
  const counts = groupCounts(groupId);
  const attentionN = counts.failed + counts.waiting + counts.warnings + counts.parked;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div
        className={cn(
          "flex shrink-0 flex-wrap items-center border-b",
          dsBorder.subtle,
          "gap-[var(--ds-space-snug)] px-[var(--ds-space-cozy)] py-[var(--ds-space-snug)]",
        )}
      >
        <IconButton
          size="sm"
          label="Back to queue"
          onClick={handlers.onBack}
          icon={<ArrowLeft aria-hidden className={dsIcon.md} />}
        />
        <span className={cn(dsText.title, "mr-[var(--ds-space-tight)] truncate font-semibold text-[color:var(--ds-fg)]")}>
          {group.title}
        </span>
        {/* `13+ members · opened in place` USED TO BE HERE, and it was the UI
            describing itself to the operator standing in it. The density rung
            is a fact about the product, not about this group — it belongs to
            the row's ⓘ and to the catalog, both of which still carry it. */}
        <span className={cn(drillChip(true), dsRadius.pill)}>
          Attention <span className={dsText.nums}>{attentionN}</span>
        </span>
        <span className={cn(drillChip(false), dsRadius.pill)}>
          All <span className={dsText.nums}>{ids.length}</span>
        </span>
        <span className="relative ml-auto">
          <Search
            aria-hidden
            className={cn(dsIcon.sm, "pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-[color:var(--ds-fg-muted)]")}
          />
          <input
            aria-label="Search members"
            placeholder="name / EID…"
            className={cn(
              "w-32 border pl-6 pr-[var(--ds-space-base)]",
              "h-[var(--ds-h-sm)]",
              dsRadius.md,
              dsText.meta,
              dsFocus,
              dsMotion.fast,
              dsBorder.strong,
              "bg-[var(--ds-surface-2)] text-[color:var(--ds-fg)] placeholder:text-[color:var(--ds-fg-faint)]",
            )}
          />
        </span>
      </div>
      {/* Column heads earn their 20px HERE and nowhere else. This is the rung
          the operator opens to work a list down, and a column of one-word
          outcomes is only legible once the word above it says what the column
          is. Inside a queue row's well the same heads would cost every group
          on screen a band, which is why the well has none. */}
      <div
        aria-hidden
        className={cn(
          DRILL_GRID,
          dsText.caps,
          "shrink-0 items-center border-b bg-[var(--ds-recess-bg)]",
          dsBorder.subtle,
          "h-[var(--ds-h-xs)] gap-x-[var(--ds-space-base)] px-[var(--ds-space-cozy)] text-[color:var(--ds-fg-muted)]",
        )}
      >
        <span />
        <span>Person</span>
        <span>EID</span>
        <span>{memberDetailHeading(group)}</span>
        <span className="text-right">Took</span>
      </div>
      <div
        role="listbox"
        aria-label="Group members, attention first"
        className="min-h-0 flex-1 divide-y divide-[color:var(--ds-border-subtle)] overflow-y-auto"
      >
        {ids.map((id) => {
          const m = DEMO_ROWS[id];
          const rejected = m.containment === "rejected";
          const spec = MEMBER_STATUS_ICON[m.status];
          const Icon = rejected ? SearchX : spec.icon;
          const isSel = state.selectedId === id;
          return (
            <button
              key={id}
              type="button"
              role="option"
              aria-selected={isSel}
              data-demo-row-id={id}
              onClick={() => handlers.onSelect(id)}
              className={cn(
                DRILL_GRID,
                "w-full cursor-pointer items-center text-left",
                "h-[var(--ds-h-row)] gap-x-[var(--ds-space-base)] px-[var(--ds-space-cozy)]",
                dsText.body,
                dsFocus,
                dsMotion.fast,
                "hover:bg-[var(--ds-surface-3)]",
                isSel && "bg-[var(--ds-surface-selected)] shadow-[inset_2px_0_0_var(--ds-ring)]",
              )}
            >
              <Icon aria-hidden className={cn(dsIcon.md, rejected ? "text-[color:var(--ds-fg-muted)]" : spec.cls)} />
              <span className="flex min-w-0 items-center gap-[var(--ds-space-snug)]">
                <span
                  className={cn(
                    "truncate font-medium text-[color:var(--ds-fg)]",
                    rejected && "italic font-normal text-[color:var(--ds-fg-muted)]",
                  )}
                >
                  {m.title}
                </span>
                {state.checkedIds.has(id) && (
                  <CheckCircle2 aria-hidden className={cn(dsIcon.sm, "shrink-0 text-[color:var(--ds-success-fg)]")} />
                )}
              </span>
              <span className={cn(dsText.meta, dsText.nums, "text-[color:var(--ds-fg-muted)]")}>{m.eid ?? "—"}</span>
              {/* Same cell as the well's, so opening a group to its last rung
                  does not change what its members are saying — only how many
                  of them you can see at once. */}
              <MemberDetailCell row={m} />
              <span className={cn(dsText.meta, dsText.nums, "text-right text-[color:var(--ds-fg-muted)]")}>{m.duration ?? "—"}</span>
            </button>
          );
        })}
      </div>
      {/* The five-key legend that used to sit here is gone. Every one of those
          keys is in the Top Bar's shortcuts Popover, which is on screen in
          every view — a band that teaches the operator the same four keys every
          time they open a group is a band that gets skimmed past twice. What
          survives is the one thing that is a FACT about this list rather than
          about the product: the order it is in. */}
      <div
        className={cn(
          "flex shrink-0 items-center justify-end border-t bg-[var(--ds-recess-bg)]",
          dsBorder.subtle,
          dsText.meta,
          "px-[var(--ds-space-cozy)] py-[var(--ds-space-snug)]",
          "text-[color:var(--ds-fg-muted)]",
        )}
      >
        sorted attention-first
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The panel
// ---------------------------------------------------------------------------

export function DemoQueue({
  rows,
  state,
  handlers,
  workflowLabel,
  day = DEMO_DAY,
}: {
  rows: DemoRow[];
  state: DemoQueueState;
  handlers: DemoQueueHandlers;
  /** the Workflow Panel entry this queue is scoped to — the empty state says so */
  workflowLabel: string;
  /** the day partition these rows came from — the header never invents its own */
  day?: string;
}) {
  const inView = rows.filter((r) => rowInBucket(r, state.filter));
  const isToday = day === DEMO_DAY;
  const bands = bandsFor(inView);
  const finished = bands.find((b) => b.key === "finished")?.rows ?? [];
  const digest = {
    done: finished.filter((r) => effectiveStatus(r) === "verifiedDone").length,
    warned: finished.filter((r) => effectiveStatus(r) === "doneWarnings").length,
    failed: finished.filter((r) => effectiveStatus(r) === "failed").length,
    cancelled: finished.filter((r) => effectiveStatus(r) === "cancelled").length,
  };

  if (state.view.kind === "drill") {
    return (
      <section aria-label="Group triage" className={cn("flex min-h-0 flex-col overflow-hidden border", dsRadius.lg, dsBorder.base, dsSurface.card)}>
        <DrillIn groupId={state.view.groupId} state={state} handlers={handlers} />
      </section>
    );
  }

  return (
    <section aria-label="Queue" className={cn("flex min-h-0 flex-col overflow-hidden border", dsRadius.lg, dsBorder.base, dsSurface.card)}>
      <div
        className={cn(
          "flex shrink-0 items-center border-b",
          dsSize.hBar,
          dsBorder.subtle,
          dsText.meta,
          "gap-[var(--ds-space-snug)] px-[var(--ds-space-cozy)] text-[color:var(--ds-fg-muted)]",
        )}
      >
        {/* The panel is TITLED by the workflow it holds. That used to be an h1
            in a band of its own above the Status Bar; here it costs nothing and
            it is the answer to "which panel am I in" in every Workflow Panel
            state — including the one where the panel is reduced to an icon. */}
        <h2 className={cn(dsText.title, "min-w-0 truncate font-semibold text-[color:var(--ds-fg)]")}>{workflowLabel}</h2>
        <span className="shrink-0">queue · {dayLabel(day)}</span>
        <span className="ml-auto shrink-0">
          <span className={dsText.nums}>{inView.length}</span> {inView.length === 1 ? "run" : "runs"}
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto pb-3">
        {/* Empty is a STATE: what would be here, why it is not, and what to do
            — in that order. "No rows" on its own teaches the operator nothing
            and reads like a failure. */}
        {inView.length === 0 && (
          <div
            className={cn(
              "mx-[var(--ds-space-cozy)] mt-[var(--ds-space-cozy)] flex flex-col items-start border border-dashed",
              "gap-[var(--ds-space-snug)] px-[var(--ds-space-loose)] py-[var(--ds-space-section)]",
              dsRadius.lg,
              dsBorder.base,
            )}
          >
            <span className={cn(dsText.ui, "inline-flex items-center gap-[var(--ds-space-snug)] font-semibold text-[color:var(--ds-fg)]")}>
              <FileText aria-hidden className={cn(dsIcon.md, "text-[color:var(--ds-fg-muted)]")} />
              {state.filter === "all" ? `No ${workflowLabel} runs on Jul 25` : `No ${workflowLabel} runs are ${filterWord(state.filter)}`}
            </span>
            {/* An empty state still owes the operator three things — what would
                be here, why it is not, and what to do — and no more. The two
                sentences that used to justify the DESIGN of the empty panel
                ("a panel that vanishes when idle is a panel you stop trusting",
                "all three read the same count") are gone: they explained the
                product to the person using it. */}
            <p className={cn(dsText.body, "max-w-[52ch] leading-relaxed text-[color:var(--ds-fg-muted)]")}>
              {state.filter === "all"
                ? "It is registered and can be run — there is simply nothing on this day."
                : "There are rows in this workflow, none in this status."}
            </p>
            <p className={cn(dsText.meta, "text-[color:var(--ds-fg-muted)]")}>
              {state.filter === "all"
                ? "Start one with Start a run, or pick another workflow."
                : "Clear the status pill to see everything here."}
            </p>
          </div>
        )}
        {bands.map((band) => {
          if (band.rows.length === 0) return null;
          return (
            <div key={band.key}>
              <div
                className={cn(
                  dsText.caps,
                  "mx-[var(--ds-space-cozy)] mt-[var(--ds-space-loose)] mb-[var(--ds-space-snug)] flex items-center gap-[var(--ds-space-base)]",
                  band.key === "attention"
                    ? "text-[color:var(--ds-status-waiting-fg)]"
                    : "text-[color:var(--ds-fg-muted)]",
                )}
              >
                {/* "Finished today" is only true on today's partition */}
                {band.key === "finished" && !isToday ? "Finished" : band.label}
                <span
                  className={cn(
                    dsText.nums,
                    dsText.micro,
                    "inline-flex h-[var(--ds-h-xs)] items-center rounded-full border px-[var(--ds-space-snug)]",
                    band.key === "attention" ? "border-[color:var(--ds-status-waiting-border)]" : dsBorder.base,
                  )}
                >
                  {band.rows.length}
                </span>
                <span aria-hidden className="h-px flex-1 bg-[var(--ds-border-subtle)]" />
              </div>
              {band.key === "finished" && state.filter === "all" && (
                <div
                  className={cn(
                    dsText.meta,
                    "mx-[var(--ds-space-cozy)] mt-[var(--ds-space-base)] flex flex-wrap items-center border border-dashed",
                    "gap-x-[var(--ds-space-cozy)] gap-y-[var(--ds-space-tight)] px-[var(--ds-space-cozy)] py-[var(--ds-space-snug)]",
                    dsRadius.md,
                    dsBorder.base,
                    "text-[color:var(--ds-fg-muted)]",
                  )}
                >
                  <span className="font-semibold text-[color:var(--ds-fg-secondary)]">{isToday ? "Today:" : `${dayLabel(day)}:`}</span>
                  <span>
                    <span className="font-semibold text-[color:var(--ds-success-fg)]">{digest.done}</span> verified
                  </span>
                  {digest.warned > 0 && (
                    <span className="text-[color:var(--ds-status-waiting-fg)]">
                      <span className="font-semibold">{digest.warned}</span> with warnings
                    </span>
                  )}
                  {digest.failed > 0 && (
                    <span className="text-[color:var(--ds-status-failed-fg)]">
                      <span className="font-semibold">{digest.failed}</span> failed
                    </span>
                  )}
                  {digest.cancelled > 0 && (
                    <span>
                      <span className="font-semibold">{digest.cancelled}</span> cancelled
                    </span>
                  )}
                </div>
              )}
              {/* sorting reorders WITHIN a band and never across one, so the
                  attention band is always the attention band */}
              {sortDemoRows(band.rows, state.sort, state.tick).map((row) => (
                <DemoRowCard key={row.id} row={row} state={state} handlers={handlers} />
              ))}
            </div>
          );
        })}
      </div>
    </section>
  );
}
