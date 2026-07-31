import { useEffect, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent, ReactNode } from "react";
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  ArrowUpRight,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  CircleAlert,
  FileText,
  Info,
  ScanText,
  Search,
  SearchX,
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
  Chip,
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
  useDsEnterTransition,
  dsText,
} from "./demo-ui";
import { FooterActions, OutcomeActionButton, RowContextMenu, type DemoActionHandler } from "./DemoActions";
import { rowInBucket, type StatusBucket } from "./DemoShell";
import { DEMO_DAY, dayLabel } from "./demo-days";
import { demoNowMs, fmtDayLabel, plural } from "./demo-wire";
import {
  bandsFor,
  DEMO_ROWS,
  effectiveStatus,
  fmtElapsed,
  gateAge,
  groupCounts,
  recordCountsFromStream,
  recordStream,
  isSettledRow,
  linkedGroupSummary,
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
  /**
   * Which member WELLS are open to their tall shape. Separate from
   * `expandedGroups`, and deliberately: that one answers "are the members drawn
   * at all", this one answers "how many of them fit before it scrolls". A
   * settled group can be shut with its well remembered open, and a running one
   * has no shut state to conflate the two with.
   */
  openWells: ReadonlySet<string>;
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
  /** grow this row's member well from 6 lines to 20, or back */
  onToggleWell: (groupId: string) => void;
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
function FactChipView({
  label,
  value,
  arrowTo,
  warn,
  fullRow,
  className,
  grow = 1,
}: NonNullable<DemoRow["facts"]>[number] & { className?: string; grow?: number }) {
  const full = [label, value, arrowTo && `→ ${arrowTo}`].filter(Boolean).join(" ");
  // `grow > 0` — start at the chip's FULL content width, refuse to shrink, and
  // share only genuine leftover space. Flex wrapping therefore makes a greedy
  // row: another fact joins only when both facts remain readable; otherwise it
  // moves intact to the next line. Beside a redirect we pass `grow={0}` so the
  // fact stays at its natural width and the redirect owns the spare space.
  return (
    <span
      className={cn(fullRow ? "w-full" : grow > 0 ? "max-w-full" : "shrink-0", className)}
      style={
        fullRow
          ? { flexGrow: 1, flexShrink: 0, flexBasis: "100%" }
          : grow > 0
            ? { flexGrow: 1, flexShrink: 0, flexBasis: "max-content" }
            : undefined
      }
    >
      <Chip label={label} tone={warn ? "warning" : "neutral"} title={full} className="w-full max-w-full">
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
    </span>
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
        // Match the existing dashboard's stable composition strip: Done,
        // Running and Queued keep their icon slot at zero; attention statuses
        // appear only when they exist. The stable three let the operator read
        // a group's pipeline state without the strip reflowing between ticks.
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
              dsText.flush,
              // `soloTone` on the chip (colors the digit); `iconClass` only on
              // the Icon. Putting `iconClass` here spun the whole tally — the
              // digit orbited under the glyph (operator: "spinning wrong").
              n === 0 ? "text-[color:var(--ds-fg-faint)]" : spec.soloTone,
            )}
          >
            <Icon
              aria-hidden
              className={cn(dsIcon.sm, "shrink-0", n === 0 ? "text-[color:var(--ds-fg-faint)]" : spec.iconClass)}
            />
            <span className={cn(dsText.nums, "font-medium")}>{n}</span>
          </span>
        );
      })}
    </>
  );
}

function MicroSteps({ row }: { row: DemoRow }) {
  return (
    <span
      // Same height as StatusBadge `sm` / the title row — centres the 4px dots
      // on the name instead of leaving them top-aligned in a taller chip stack.
      className="inline-flex h-[var(--ds-h-xs)] shrink-0 items-center gap-[3px]"
      title={row.steps.map((s) => `${s.label}${s.durationSec ? ` ${fmtElapsed(s.durationSec)}` : ""} (${s.state})`).join(" · ")}
      aria-label={`Steps: ${row.steps.map((s) => `${s.label} ${s.state}`).join(", ")}`}
    >
      {row.steps.map((s, i) => (
        <span
          key={i}
          aria-hidden
          className={cn(
            "h-1.5 w-2.5 rounded-full",
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
/*
  ITS LEADING TRACK IS THE CARD'S OWN `--ds-w-row-indent`, not a hand-picked
  `1rem`. That one substitution is what puts a member's NAME on the same x as
  the card's TITLE and a member's status glyph on the same x as the card's
  status icon — because both are now "a glyph in the leading track, then the
  subject". The well was inset ~20px from everything above it and read as a
  foreign element pasted onto the card; it is part of the card's grid now.
*/
const MEMBER_GRID =
  "grid grid-cols-[var(--ds-w-row-indent)_minmax(0,1fr)_var(--ds-w-member-detail)_var(--ds-w-member-eid)]";

/** Shared horizontal inset for every row inside the member mini-table. */
const MEMBER_WELL_PAD = "px-[var(--ds-space-snug)]";

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
  neutral: "border-[color:var(--ds-recess-border)] bg-[var(--ds-recess-bg)] text-[color:var(--ds-recess-fg-quiet)]",
  info: "border-[color:var(--ds-info-border)] bg-[var(--ds-info-bg)] text-[color:var(--ds-info-fg)]",
  warning: "border-[color:var(--ds-status-waiting-border)] bg-[var(--ds-status-waiting-bg)] text-[color:var(--ds-status-waiting-fg)]",
  violet: "border-[color:var(--ds-status-parked-border)] bg-[var(--ds-status-parked-bg)] text-[color:var(--ds-status-parked-fg)]",
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
    dsText.flush,
    ROW_CHIP_TONE[tone],
    extra,
  );

function headerChips(
  row: DemoRow,
  checked: ReadonlySet<string>,
  tick: number,
): ReactNode {
  const status = effectiveStatus(row);
  return (
    <>
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
      {/* Triangle + N whenever this row (or its members) finished with
          warnings. Authored `row.warnings` wins; otherwise a group's member
          rollup supplies the count so a Done card like a linked lookup group with one
          separated person still wears △ 1 beside the status pill — operator:
          "if there is warning add the triangle with the n number of warnings." */}
      {(() => {
        const authored = row.warnings;
        const fromMembers =
          !authored && row.rowType === "group"
            ? (() => {
                const n = groupCounts(row.id).warnings;
                return n > 0
                  ? {
                      count: n,
                      first: `${n} ${n === 1 ? "member finished with a warning" : "members finished with warnings"}`,
                    }
                  : undefined;
              })()
            : undefined;
        const fromStatus =
          !authored && !fromMembers && status === "doneWarnings"
            ? { count: 1, first: row.outcome.text || "Finished with warnings" }
            : undefined;
        const warn = authored ?? fromMembers ?? fromStatus;
        if (!warn) return null;
        return (
          <span title={warn.first} className={rowChip("warning")}>
            <AlertTriangle aria-hidden className={dsIcon.sm} />
            {warn.count}
          </span>
        );
      })()}
      {/* No separate shield glyph beside Done. The status IS the green solid
          `Done` pill (same shape as Waiting on you); the receipt string stays
          on the pill's title via StatusBadge / meaning, and in the Receipt tab.
          Operator: shield + Done → just a green Done pill. */}
      {row.rowType === "member" && checked.has(row.id) && (
        <span title="Marked checked by you" className="inline-flex shrink-0 items-center text-[color:var(--ds-success-fg)]">
          <CheckCircle2 aria-hidden className={dsIcon.md} />
          <span className="sr-only">checked</span>
        </span>
      )}
      {/* Progress dots then the status pill — both live on the TITLE row's
          right edge (operator: always put the status on the other side of the
          title). The dots sit in the same `--ds-h-xs` box as the StatusBadge
          so they centre on the name rather than hugging the top of the chip
          line. */}
      {status === "running" && row.rowType !== "group" && <MicroSteps row={row} />}
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
  if (status === "waiting" && row.gate) {
    return {
      tone: "text-[color:var(--ds-status-waiting-fg)]",
      // NO PREFIX STRIP HERE ANY MORE. This branch used to do
      // `.replace("Waiting on you — ", "")` on the gate title — on the identity
      // arm only — because the FIXTURES opened every gate title and every
      // outcome sentence with the status word the pill beside them was already
      // showing. Papering over one of nine sites in the renderer left the other
      // eight saying it twice; the prefixes are gone from the source instead,
      // and a sentence next to a status now states WHAT IS NEEDED and nothing
      // the pill has already said.
      text:
        row.gate.kind === "identity" && row.gate.candidates
          ? `${row.gate.title} — ${row.gate.candidates[0].name} vs ${row.gate.candidates[1].name}`
          : row.gate.title,
    };
  }
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

/**
 * A group with its MEMBER LIST on screen has no subtitle.
 *
 * On the failed spring packet it read `11/12 signed · Grace Egan failed —
 * signature fi…`, cut mid-word, directly above a counts strip that says
 * `✓11 ⚠1` and a list whose first line IS Grace Egan with her outcome in its
 * own column. Three renderings of one fact, and the only one that truncates is
 * the redundant one.
 *
 * There is nothing to keep: the counts strip carries the tally, the list names
 * who, and the panel carries the failure detail in full. A row whose list is
 * shut still gets its sentence — that is the case the sentence was written for.
 */
function groupSublineSuppressed(row: DemoRow, membersVisible: boolean): boolean {
  return row.rowType === "group" && membersVisible;
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
 * The rule here: the meta zone is one wrapping provenance line at the row's
 * own indent, and the controls are a sibling pinned to the top-right — so when
 * a run carries both a trace and an elapsed, both stay readable, and the
 * buttons stay exactly where they were. Queued rows never show wait/ahead
 * copy or an elapsed timer — nothing has started. A row with little to say
 * stays one line high; density is spent where there is something to be dense
 * about.
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

/**
 * THE ATTENTION TRANSITION — the one status change this product animates.
 *
 * `DESIGN.md` says never animate status churn, and it is right: this dashboard
 * updates constantly, and if everything that changes also moves it is
 * unreadable exactly when it is busiest. Elapsed timers, counts, background
 * settling and self-initiated re-sorts all stay perfectly still.
 *
 * A run CROSSING INTO `Waiting on you` or `Failed` is different in kind, and
 * the difference is what the rest of the rule is protecting. Those are the two
 * states allowed to shout; a run entering one has stopped being background and
 * become work, and the moment it happens is the moment an operator's attention
 * is somewhere else. A row that silently turns amber between glances is a row
 * that gets found late.
 *
 * So: it fires on the EDGE, never on the state. A row that was already waiting
 * when you scrolled to it does nothing — it has already been noticed, and
 * re-announcing it every render is exactly the churn the rule forbids. It
 * settles once, and it is over.
 */
function useAttentionAnnounce(status: ProposedStatus): boolean {
  const attention = status === "waiting" || status === "failed";
  const previous = useRef<ProposedStatus | null>(null);
  const [announcing, setAnnouncing] = useState(false);

  useEffect(() => {
    const was = previous.current;
    previous.current = status;
    // First sight of a row is not a transition. Mounting into an attention
    // status is how EVERY row on a busy panel would announce itself on paint.
    if (was === null || was === status) return;
    if (!attention) return;
    setAnnouncing(true);
    const id = window.setTimeout(() => setAnnouncing(false), ATTENTION_ANNOUNCE_MS);
    return () => window.clearTimeout(id);
  }, [attention, status]);

  return announcing;
}

/** how long the settle lasts — one `move`, then still */
const ATTENTION_ANNOUNCE_MS = 900;

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
  const announcing = useAttentionAnnounce(status);
  const subline = sublineFor(row);
  const elapsed = row.elapsedSec !== undefined ? fmtElapsed(row.elapsedSec + state.tick) : undefined;
  const isGroup = row.rowType === "group";
  const counts = isGroup ? groupCounts(row.id) : null;
  const memberCount = row.memberIds?.length ?? 0;
  const StatusIcon = PROPOSED_STATUS[status].icon;
  const linked = linkedGroupSummary(row);
  // Members are always drawn now — settled groups no longer collapse to a
  // "Show all N people" link. The well height (5 / 20) is what changes.
  const membersVisible = isGroup && memberCount > 0;
  // Packet-before-fanout used to own a bordered Approve well; that block is
  // gone (operator: no orange box, no Approve pill on the card). The exclusion
  // fact now rides the subline as ordinary muted text — same weight as the
  // footer log line — and the gray ↗ opens the decision.
  const sub = groupSublineSuppressed(row, membersVisible) ? null : subline;

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
            // ONE resting border for every card. Status used to recolor the
            // perimeter (running blue, announce amber/red) and hover bumped it
            // to strong — so a queued row and a running row never matched.
            // Operator: unless selected, every card shares the same dark gray.
            // Selection is the lighter perimeter only — no fill change.
            selected ? dsBorder.loud : dsBorder.base,
            // THE ANNOUNCE. Lift only — the border stays the shared resting
            // ink so a settling card does not flash a different outline.
            announcing && cn(dsMotion.move, "-translate-y-[var(--ds-travel-sm)]"),
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
            {/* The icon, title and status pill share one cross-axis centre —
                operator: top bar must align icon · name · Done. The icon box
                matches the StatusBadge (`sm` = `--ds-h-xs`) so a taller title
                line cannot leave the glyph floating above the pill. */}
            <div className="col-start-1 row-start-1 flex h-[var(--ds-h-xs)] items-center">
              <StatusIcon
                aria-hidden
                className={cn(dsIcon.md, "shrink-0", PROPOSED_STATUS[status].iconClass)}
              />
            </div>
            {/* One responsive header for every run, group and member card.
                The subject keeps a usable track and wraps. Status chrome sits
                here only when there is NO decision subline — otherwise the
                pill shares the gate/Review line so a long name cannot park it
                alone between the title and the action. */}
            <div className="col-start-2 row-start-1 flex min-w-0 flex-nowrap items-center gap-x-[var(--ds-space-base)]">
              <div className="flex min-w-0 flex-1 items-center gap-[var(--ds-space-snug)]">
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
                  data-demo-row-title
                  title={row.displayName ? `Named by you — subject is ${row.title}` : undefined}
                  className={cn(
                    dsText.title,
                    // Truncate rather than wrap — wrapping shoved the status
                    // pill / micro-step dots onto a second line under the name
                    // (operator: status always on the other side of the title).
                    "min-w-0 truncate font-semibold text-[color:var(--ds-fg)]",
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
              <div className="ml-auto flex shrink-0 flex-nowrap items-center justify-end gap-[var(--ds-space-snug)]">
                {/* Status ALWAYS sits on the title row's right — never on the
                    gate/running subline. Operator: put the status on the other
                    side of the title. */}
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
                  "col-start-2 flex min-w-0 flex-wrap items-center gap-x-[var(--ds-space-base)] gap-y-[var(--ds-space-tight)]",
                  sub.tone,
                )}
              >
                {/* Status pill lives on the title row now. This line is the
                    sentence only (gate / running step / error), plus any
                    outcome CTA that is not already covered in-card. */}
                <span className="min-w-0 flex-1 truncate">{sub.text}</span>
                <OutcomeActionButton
                  row={row}
                  onAction={handlers.onAction}
                  className="ml-auto shrink-0"
                  omitKeys={
                    status === "failed"
                      ? ["open-failure", "reupload"]
                      : status === "parked"
                        ? ["open-park"]
                        : status === "waiting"
                          ? ["open-gate"]
                          : undefined
                  }
                />
              </div>
            )}

            {/* FULL WIDTH, both tracks. The group's own grid supplies the
                leading column, so its glyphs land under the card's status icon
                and its text under the card's title — one left edge for the
                whole card rather than a well indented inside column two. */}
            {isGroup && counts && (memberCount > 0 ? (
              <div className="col-span-2 flex flex-col gap-[var(--ds-space-base)]">
                <GroupMemberList row={row} state={state} handlers={handlers} />
              </div>
            ) : null)}

            {/* THE PEOPLE THIS RUN HAS READ. Same shape as a group's member
                lines, because it is the same thing — a person the row is
                accounting for — and it fills in as the extraction reports
                them, from the queue panel and from the OCR panel alike. */}
            {row.records && row.records.length > 0 && (
              <div className="col-span-2 flex flex-col gap-[var(--ds-space-base)]">
                <RecordStreamList row={row} state={state} handlers={handlers} />
              </div>
            )}

            {/* Redirect + fact chips — ONE band BELOW the well.
                Default: title-aligned (`col-start-2`), same left edge as the
                filename. EXCEPTION — group/OCR rows that draw a member or
                record table: hang the chip off the table's left edge
                (`col-span-2` + the well's own pad) so OCR Review lines up
                with the status icons / Name header, not the title indent.
                Operator: "aligned with the left table" for these types only. */}
            {(() => {
              const parent = row.linkedParentId ? DEMO_ROWS[row.linkedParentId] : undefined;
              const review = row.reviewRunId ? DEMO_ROWS[row.reviewRunId] : undefined;
              const hasRedirect = Boolean(linked || parent || review);
              const hasFacts = Boolean(row.facts && row.facts.length > 0);
              const hasPeople = row.extractedCount !== undefined;
              if (!hasRedirect && !hasFacts && !hasPeople) return null;

              const linkedStatus =
                linked &&
                (() => {
                  const target = DEMO_ROWS[linked.targetId];
                  if (linked.total === 1 && target) return redirectStatusWord(target);
                  return linked.done === linked.total ? "done" : `${linked.done} done`;
                })();

              const tableAligned =
                membersVisible || Boolean(row.records && row.records.length > 0);

              return (
                <div
                  className={cn(
                    // Wrap band: primary redirect `flex-1` fills; a small
                    // sibling sits beside it; if they cannot share a line the
                    // sibling drops under at its natural length.
                    "flex w-full min-w-0 flex-wrap items-center",
                    "gap-x-[var(--ds-space-snug)] gap-y-[var(--ds-space-tight)]",
                    tableAligned ? cn("col-span-2", MEMBER_WELL_PAD) : "col-start-2",
                  )}
                >
                  {linked && linkedStatus && (
                    <PanelRedirectChip
                      label={linked.panel}
                      status={linkedStatus}
                      title={`Open the ${linked.panel} panel — ${linked.total === 1 ? "this run lives" : "these runs live"} there, not under this row`}
                      onOpen={() => handlers.onOpenPanel(linked.panel, linked.targetId)}
                    />
                  )}
                  {parent && <ParentBackChip row={row} handlers={handlers} />}
                  {!parent && review && <LinkedReviewChip row={row} handlers={handlers} />}
                  {hasPeople && (
                    <span className={cn(rowChip("neutral", "font-medium"), "shrink-0")}>
                      <Users aria-hidden className={cn(dsIcon.sm, "text-[color:var(--ds-fg-muted)]")} />
                      {plural(row.extractedCount!, "person", "people")}
                    </span>
                  )}
                  {row.facts?.map((f, i) => {
                    return (
                      <FactChipView
                        key={i}
                        {...f}
                        grow={hasRedirect ? 0 : 1}
                      />
                    );
                  })}
                </div>
              );
            })()}
          </div>

          <RowFooterLine row={row} handlers={handlers} elapsed={elapsed} />
        </div>
      </RowContextMenu>
    </div>
  );
}

/**
 * THE BAND A CROSS-PANEL CHIP LIVES IN.
 *
 * A queue row is one large select target with smaller targets nested inside it.
 * Redirect chips carry `data-demo-row-link` so tests can still find them. They
 * used to be capped at half the title column (`--ds-w-row-link-max`) so a click
 * in the middle of a row selected the row instead of jumping panel — that also
 * chopped `Oath Upload · running` mid-word. The band now fills the title
 * column; the footer and title remain the row-select targets.
 */

/**
 * A chip that CHANGES PANEL. One shape everywhere: gray matte + hairline,
 * `Name · status`, arrow on the RIGHT (↗). Never a leading ←, never info-blue —
 * operator: every redirect must match.
 *
 * WIDTH — the primary chip in its band. It grows to fill leftover space
 * (`flex-1`), never truncates the label (`min-w-max` + nowrap), and when a
 * smaller sibling cannot fit beside it the wrap drops that sibling under at
 * its natural length while this chip takes the full first line.
 */
const linkChip = (): string =>
  cn(
    "inline-flex cursor-pointer items-center border",
    dsClip.token,
    "h-[var(--ds-h-xs)] gap-[var(--ds-space-snug)] px-[var(--ds-space-base)]",
    dsRadius.sm,
    dsText.meta,
    dsText.flush,
    dsFocus,
    dsMotion.fast,
    "border-[color:var(--ds-recess-border)] bg-[var(--ds-recess-bg)] text-[color:var(--ds-fg-muted)] hover:text-[color:var(--ds-fg)]",
  );

/** Lowercase status word for redirect chips — `done`, `review`, `running`, … */
function redirectStatusWord(row: DemoRow): string {
  return statusText(effectiveStatus(row)).toLowerCase();
}

/**
 * THE shared panel jump. Text then ↗; label is the workflow name (or
 * `OCR Review`), then `· status`.
 */
function PanelRedirectChip({
  label,
  status,
  title,
  onOpen,
  fill,
}: {
  label: string;
  status: string;
  title: string;
  onOpen: () => void;
  fill?: boolean;
}) {
  return (
    <button
      type="button"
      data-demo-row-link
      onClick={(e) => {
        e.stopPropagation();
        onOpen();
      }}
      title={title}
      aria-label={title}
      className={cn(
        linkChip(),
        "min-w-max justify-start",
        // `fill` = hard full row (rare). Otherwise grow inside the wrap band.
        fill ? "w-full" : "flex-1",
      )}
    >
      <span className="whitespace-nowrap">
        {label} · {status}
      </span>
      <ArrowUpRight aria-hidden className="size-3 shrink-0" />
    </button>
  );
}

/**
 * Route to the parent that delegated this run. Same chip as every other panel
 * jump — `Oath Upload · done ↗`, not `← Oath Upload`.
 */
function ParentBackChip({ row, handlers }: { row: DemoRow; handlers: DemoQueueHandlers }) {
  const parent = row.linkedParentId ? DEMO_ROWS[row.linkedParentId] : undefined;
  if (!parent) return null;
  return (
    <PanelRedirectChip
      label={parent.wfLabel}
      status={redirectStatusWord(parent)}
      title={`${parent.wfLabel} · ${parent.title} — the run that delegated this one`}
      onOpen={() => handlers.onOpenPanel(parent.wfLabel, parent.id)}
    />
  );
}

/**
 * A packet's pointer to the OCR review row that holds its records.
 * Named `OCR Review · {status}` — the one label that is not a bare workflow name.
 */
function LinkedReviewChip({
  row,
  handlers,
  fill,
}: {
  row: DemoRow;
  handlers: DemoQueueHandlers;
  fill?: boolean;
}) {
  const target = row.reviewRunId ? DEMO_ROWS[row.reviewRunId] : undefined;
  if (!target) return null;
  return (
    <PanelRedirectChip
      label="OCR Review"
      status={redirectStatusWord(target)}
      title="Open the OCR panel and select this packet's review row — the records live there, not here"
      onOpen={() => handlers.onOpenPanel(target.wfLabel, target.id)}
      fill={fill}
    />
  );
}

/**
 * A group's disclosure link — one shape for `Expand` / `Collapse` and
 * `Open full list`, so "there is more of this behind here" always looks the
 * same in a row.
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
 * The two well shapes, as LINE COUNTS.
 *
 * `--ds-h-member-well` / `--ds-h-member-well-open` are these same two numbers
 * expressed as pixels. Labels stay word-only ("Expand" / "Collapse") — never
 * "Expand to 12" — so the disclosure does not restate a count the chrome
 * already carries. Exported so the pure test can pin the two against each
 * other rather than against a hand-typed literal in a string.
 */
export const MEMBER_WELL_LINES = 5;
export const MEMBER_WELL_OPEN_LINES = 20;

/** A dedicated roster view accompanies every member set that can expand. */
export function canViewAllMembers(memberCount: number): boolean {
  return memberCount > MEMBER_WELL_LINES;
}

/**
 * THE WELL. One container for every list of people a row can hold, so a group's
 * members and an OCR run's extracted records are the same object on screen —
 * which they are: a person the row is accounting for.
 *
 * IT IS AN OUTLINE, NOT A HOLE. It used to be the recessed plane's fill — on
 * Graphite Warm that is the near-black recessed token sunk into the card token
 * — with a subtle hairline that could not survive against it. The
 * operator: *"i dont like the black background. i feel like it needs outline,
 * better spacing, better alignment."* So the well sits ON the card plane and is
 * separated by its EDGE: same fill as the card, a real border, whole-line
 * clipping. The rows inside it are the content; the container is a frame around
 * them, not a second surface underneath them.
 *
 * A GROUP'S WELL IS A MINI-TABLE. Counts and the OCR route share a surface-2
 * summary strip; Expand / Open all split a two-column action row below the
 * table. Only the person lines scroll, and that scroll region clips on a LINE,
 * never through one — both heights are `N × line + (N−1) hairlines`.
 */
function PersonWell({
  children,
  open,
  header,
  footer,
  embedded,
}: {
  children: ReactNode;
  open?: boolean;
  header?: ReactNode;
  footer?: ReactNode;
  embedded?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex flex-col overflow-hidden border bg-[var(--ds-surface-1)]",
        embedded ? "border-x-0 border-[color:var(--ds-border)]" : dsBorder.strong,
        !embedded && dsRadius.md,
      )}
    >
      {header}
      <div
        className={cn(
          "min-h-0 divide-y overflow-y-auto",
          "divide-[color:var(--ds-border-subtle)]",
          open ? "max-h-[var(--ds-h-member-well-open)]" : "max-h-[var(--ds-h-member-well)]",
        )}
      >
        {children}
      </div>
      {footer}
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
  arriving,
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
  /**
   * This person was read WHILE the list was on screen — so the line arrives
   * rather than appearing. See `RecordStreamList` for why that is a fact off
   * the wire and not a render trick, and why the rest of the list does not do
   * it. The hook runs unconditionally; only the classes are gated.
   */
  arriving?: boolean;
}) {
  const entering = useDsEnterTransition();
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
    MEMBER_WELL_PAD,
    "w-full items-center text-left",
    // The line's own rhythm token, and the well's height is a multiple of it —
    // that is the whole mechanism that stops the container clipping through a
    // row. It is also two pixels taller than the dense control height, because
    // these lines are READ down four columns rather than pressed in a bar.
    "h-[var(--ds-h-member-line)] gap-x-[var(--ds-space-base)]",
    dsText.body,
    // It comes from BELOW, because that is where the next person is coming
    // from: the list grows downward, so a line that slid down from above would
    // be moving against the direction the work is arriving in.
    arriving && cn(dsMotion.enter, "data-[demo-enter=from]:translate-y-[var(--ds-travel-md)] data-[demo-enter=from]:opacity-0"),
  );
  const motionProps = arriving ? entering : undefined;
  if (!onClick) {
    return (
      <div title={title} className={shape} {...motionProps}>
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
      {...motionProps}
    >
      {body}
    </button>
  );
}

/**
 * THE PEOPLE AN OCR RUN HAS READ — same mini-table chrome as a group's member
 * list, because it is the same object on screen: a person this row accounts for.
 *
 * The old shape was a rogue bordered checklist (`12 of 12 read` + check · name ·
 * page · EID) that read as a different KIND of list from the group member table
 * (status strip · Name/Detail/EID · Expand). This renders through the shared
 * `PersonWell` + `PersonLine` + `DemoStatusCounts` path instead.
 */
function RecordStreamList({
  row,
  state,
  handlers,
}: {
  row: DemoRow;
  state: DemoQueueState;
  handlers: DemoQueueHandlers;
}) {
  const stream = recordStream(row, state.tick);
  if (stream.total === 0) return null;

  const counts = recordCountsFromStream(stream);
  const readIds = stream.read.map((r) => r.id);
  const wellOpen = state.openWells.has(row.id);
  const canExpand = readIds.length > MEMBER_WELL_LINES;
  const nowMs = demoNowMs(state.tick);

  const disclosures =
    canExpand ? (
      <button
        type="button"
        aria-expanded={wellOpen}
        onClick={(e) => {
          e.stopPropagation();
          handlers.onToggleWell(row.id);
        }}
        className={disclosureLink}
      >
        {wellOpen ? <ChevronUp aria-hidden className={dsIcon.sm} /> : <ChevronDown aria-hidden className={dsIcon.sm} />}
        {wellOpen ? "Collapse" : "Expand"}
      </button>
    ) : null;

  return (
    <PersonWell
      embedded
      open={wellOpen && canExpand}
      header={
        <div className="shrink-0 border-b border-[color:var(--ds-border-subtle)] bg-[var(--ds-surface-2)]">
          <div
            className={cn(
              MEMBER_GRID,
              MEMBER_WELL_PAD,
              "min-h-[var(--ds-h-member-line)] items-center gap-x-[var(--ds-space-base)] py-[var(--ds-space-tight)]",
              dsText.meta,
            )}
          >
            <div className="col-span-4 flex min-w-0 flex-wrap items-center gap-[var(--ds-space-cozy)]">
              <DemoStatusCounts counts={counts} />
              {counts.rejected > 0 && (
                <span
                  className="inline-flex min-w-0 items-center gap-[var(--ds-space-tight)] truncate text-[color:var(--ds-fg-muted)]"
                  title={`${counts.rejected} blocked — excluded from approve`}
                >
                  <SearchX aria-hidden className={cn(dsIcon.sm, "shrink-0")} />
                  <span className={dsText.nums}>{counts.rejected}</span> blocked
                </span>
              )}
              <span
                className="inline-flex min-w-0 items-center gap-[var(--ds-space-tight)] truncate text-[color:var(--ds-fg-muted)]"
                title={`${stream.read.length} of ${stream.total} people reported by the extraction`}
              >
                <ScanText aria-hidden className={cn(dsIcon.sm, "shrink-0")} />
                <span className={dsText.nums}>
                  {stream.read.length} of {stream.total}
                </span>{" "}
                read
              </span>
            </div>
          </div>
          <div
            className={cn(
              MEMBER_GRID,
              MEMBER_WELL_PAD,
              "h-[var(--ds-h-member-line)] items-center gap-x-[var(--ds-space-base)]",
              dsText.meta,
              "text-[color:var(--ds-fg-faint)]",
            )}
          >
            <span className="col-span-2 col-start-1 truncate">Name</span>
            <span className="col-start-3 truncate">Detail</span>
            <span className="col-start-4 truncate text-right">EID</span>
          </div>
        </div>
      }
      footer={
        canExpand ? (
          <div
            className={cn(
              "grid shrink-0 border-t border-[color:var(--ds-border-subtle)] bg-[var(--ds-surface-2)]",
              "grid-cols-1",
              "[&>button]:h-[var(--ds-h-member-line)] [&>button]:w-full [&>button]:justify-center",
            )}
          >
            {disclosures}
          </div>
        ) : undefined
      }
    >
      {stream.read.map((rec) => (
        <PersonLine
          key={rec.id}
          arriving={
            stream.streaming &&
            rec.readAt !== undefined &&
            nowMs - Date.parse(rec.readAt) < RECORD_ARRIVAL_WINDOW_MS
          }
          icon={RECORD_STATE_ICON[rec.state].icon}
          iconClass={RECORD_STATE_ICON[rec.state].cls}
          name={rec.name}
          title={`${rec.name} — ${rec.pageNote}`}
          detail={
            <span className={cn(dsText.meta, "min-w-0 truncate text-[color:var(--ds-fg-muted)]")}>
              {rec.pageNote ?? `page ${rec.page}`}
            </span>
          }
          eid={rec.eid}
        />
      ))}
    </PersonWell>
  );
}

/**
 * How recently a record has to have been read for its line to ARRIVE rather
 * than simply be there. Wide enough that a slow tick cannot miss the window,
 * short enough that re-opening a row seconds later does not replay the whole
 * extraction as a light show.
 */
const RECORD_ARRIVAL_WINDOW_MS = 4000;

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
  // Every group keeps its people on screen. Settled cards used to collapse to
  // "Show all N people" — operator: no collapsing like that; always show the
  // well at 5, Expand to 20, and keep the dedicated roster view beside Expand.
  const wellOpen = state.openWells.has(row.id);
  const canExpand = ids.length > MEMBER_WELL_LINES;
  const canOpenFullList = canViewAllMembers(ids.length);
  const counts = groupCounts(row.id);
  const checkedCount = ids.filter((id) => state.checkedIds.has(id)).length;
  const memberCount = ids.length;

  const disclosures = (
    <>
      {canExpand && (
        <button
          type="button"
          aria-expanded={wellOpen}
          onClick={(e) => {
            e.stopPropagation();
            handlers.onToggleWell(row.id);
          }}
          className={disclosureLink}
        >
          {wellOpen ? <ChevronUp aria-hidden className={dsIcon.sm} /> : <ChevronDown aria-hidden className={dsIcon.sm} />}
          {wellOpen ? "Collapse" : "Expand"}
        </button>
      )}
      {/* A stable route to the dedicated roster. It stays beside Expand even
          when the expanded well can fit everyone, because the two actions do
          different jobs: inspect inline vs work in the full-list surface. */}
      {canOpenFullList && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            handlers.onDrillIn(row.id);
          }}
          className={disclosureLink}
        >
          <ArrowRight aria-hidden className={dsIcon.sm} />
          {row.workflowId === "oath-signature" ? "View all signers" : "View full list"}
        </button>
      )}
    </>
  );

  if (ids.length === 0) {
    return null;
  }

  return (
    <PersonWell
      embedded
      open={wellOpen && canExpand}
      header={
        <div className="shrink-0 border-b border-[color:var(--ds-border-subtle)] bg-[var(--ds-surface-2)]">
              {/* Composition chrome — tallies live HERE, not as a floating strip
              above the frame. Checked only appears once the operator has
              marked someone; a green `0/12` next to `✓ 11` was a second number
              that looked like composition and meant nothing.

              OCR / parent redirects live in the card body band BELOW this
              well (after Expand / View all), so every panel jump shares one
              place on every row type. */}
          <div
            className={cn(
              MEMBER_GRID,
              MEMBER_WELL_PAD,
              "min-h-[var(--ds-h-member-line)] items-center gap-x-[var(--ds-space-base)] py-[var(--ds-space-tight)]",
              dsText.meta,
            )}
          >
            <div className="col-span-4 flex min-w-0 items-center gap-[var(--ds-space-cozy)]">
              <div className="flex min-w-0 flex-wrap items-center gap-[var(--ds-space-cozy)]">
                <DemoStatusCounts counts={counts} />
                {counts.rejected > 0 && (
                  <span
                    className="inline-flex min-w-0 items-center gap-[var(--ds-space-tight)] truncate text-[color:var(--ds-fg-muted)]"
                    title={`${counts.rejected} rejected — never became work and excluded from the rollup`}
                  >
                    <SearchX aria-hidden className={cn(dsIcon.sm, "shrink-0")} />
                    <span className={dsText.nums}>{counts.rejected}</span> rejected
                  </span>
                )}
                {checkedCount > 0 && (
                  <span
                    className="inline-flex items-center gap-[var(--ds-space-tight)] text-[color:var(--ds-success-fg)]"
                    aria-label={`${checkedCount} of ${memberCount} checked by you`}
                    title="How many of these you have marked checked"
                  >
                    <CheckCircle2 aria-hidden className={cn(dsIcon.sm, "shrink-0")} />
                    <span className={dsText.nums}>
                      {checkedCount}/{memberCount}
                    </span>
                  </span>
                )}
              </div>
            </div>
          </div>
          <div
            className={cn(
              MEMBER_GRID,
              MEMBER_WELL_PAD,
              "h-[var(--ds-h-member-line)] items-center gap-x-[var(--ds-space-base)]",
              dsText.meta,
              "text-[color:var(--ds-fg-faint)]",
            )}
          >
            <span className="col-span-2 col-start-1 truncate">Name</span>
            <span className="col-start-3 truncate">{memberDetailHeading(row)}</span>
            <span className="col-start-4 truncate text-right">EID</span>
          </div>
        </div>
      }
      footer={
        (canExpand || canOpenFullList) ? (
          <div
            className={cn(
              "grid shrink-0 border-t border-[color:var(--ds-border-subtle)] bg-[var(--ds-surface-2)]",
              canExpand && canOpenFullList ? "grid-cols-2" : "grid-cols-1",
              "[&>button]:h-[var(--ds-h-member-line)] [&>button]:w-full [&>button]:justify-center",
              "[&>button+button]:border-l [&>button+button]:border-[color:var(--ds-border-subtle)]",
            )}
          >
            {disclosures}
          </div>
        ) : undefined
      }
    >
      {ids.map((id) => {
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

function DrillIn({ groupId, state, handlers }: { groupId: string; state: DemoQueueState; handlers: DemoQueueHandlers }) {
  const group = DEMO_ROWS[groupId];
  const ids = orderedMemberIds(groupId);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div
        className={cn(
          "flex shrink-0 items-start border-b",
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
        <span className={cn(dsText.title, "min-w-0 flex-1 [overflow-wrap:anywhere] font-semibold text-[color:var(--ds-fg)]")}>
          {group.title}
        </span>
        {/* The roster is already attention-first and already contains the full
            group, so Attention / All chips repeated facts without filtering.
            Search is the one useful header control and stays in the first row,
            with the title wrapping before the input can be pushed downward. */}
        <span className="relative ml-auto w-32 shrink-0">
          <Search
            aria-hidden
            className={cn(dsIcon.sm, "pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-[color:var(--ds-fg-muted)]")}
          />
          <input
            aria-label="Search members"
            placeholder="name / EID…"
            className={cn(
              "w-full border pl-6 pr-[var(--ds-space-base)]",
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
                isSel && "bg-[var(--ds-surface-selected)]",
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
        {/* THE WORKFLOW NAME, AND NOTHING ELSE.

            It read `Oath Upload · queue · Sat, Jul 25 · 1 run`, and three
            quarters of that was already on screen: the DATE is the Top Bar's
            own navigator, the COUNT is the Status Bar's `All` pill and the
            rail's badge on the same workflow, and `queue` names the panel the
            operator is standing in — the scaffolding rule, applied to a header.
            Operator: *"everything else beside oath upload is unnecessary. this
            applies to all other workflows."*

            What it answers is "which panel am I in", which is the one question
            no other surface on screen answers when the Workflow Panel is
            reduced to an icon. */}
        <h2 className={cn(dsText.title, "min-w-0 truncate font-semibold text-[color:var(--ds-fg)]")}>{workflowLabel}</h2>
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
              {/* The day comes from the same `day` prop the header reads. It
                  used to be a hardcoded `Jul 25`, so an empty Wednesday panel
                  said it was an empty Saturday one. */}
              {state.filter === "all"
                ? `No ${workflowLabel} runs on ${fmtDayLabel(`${day}T12:00:00`)}`
                : state.filter === "needsYou"
                  ? `No ${workflowLabel} runs need your attention`
                  : `No ${workflowLabel} runs are ${filterWord(state.filter)}`}
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
                : "Nothing matches this filter."}
            </p>
            <p className={cn(dsText.meta, "text-[color:var(--ds-fg-muted)]")}>
              {state.filter === "all"
                ? "Start one with Start a run, or pick another workflow."
                : "Clear the filter to see all runs."}
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
