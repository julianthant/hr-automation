import type { ReactNode } from "react";
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  ArrowUpRight,
  Camera,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  ClipboardList,
  CornerDownRight,
  Eye,
  FileText,
  GitBranch,
  RotateCcw,
  Search,
  SearchX,
  ShieldCheck,
  Users,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { QueueRowCard } from "@/components/queue-panel/QueueRowCard";
import { StatusCounts } from "@/components/queue-panel/StatusCounts";
import { PROPOSED_STATUS, StatusBadge, statusText, type ProposedStatus } from "./demo-status";
import {
  Button,
  IconButton,
  Kbd,
  dsBorder,
  dsFocus,
  dsIcon,
  dsMotion,
  dsRadius,
  dsSize,
  dsSurface,
  dsText,
} from "./demo-ui";
import { FooterActions, OutcomeActionButton, RowActionMenu, type DemoActionHandler } from "./DemoActions";
import { rowInBucket, type StatusBucket } from "./DemoShell";
import { DEMO_DAY, dayLabel } from "./demo-days";
import {
  bandsFor,
  DEMO_ROWS,
  DENSITY_RUNGS,
  densityRung,
  effectiveStatus,
  fmtElapsed,
  gateAge,
  groupCounts,
  linkedGroupSummary,
  orderedMemberIds,
  sortDemoRows,
  type DemoRow,
  type DemoSortKey,
} from "./demo-data";

/**
 * DEV-ONLY — the rebuild demo's queue panel. Attention bands, the three-rung
 * density ladder and the triage drill-in, rendered on
 * the REAL QueueRowCard/RowFooter/StatusCounts chrome.
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

/**
 * Which of a group's members are actually on screen — and therefore which ones
 * j/k should walk. Deriving traversal from the SAME rung that renders them is
 * what keeps the keyboard and the eye in the same place.
 */
export function visibleMemberIds(row: DemoRow, expandedGroups: ReadonlySet<string>): string[] {
  const ids = orderedMemberIds(row.id);
  switch (densityRung(ids.length)) {
    case "inline":
      return ids;
    case "compact":
      return expandedGroups.has(row.id) ? ids : ids.slice(0, 4);
    case "well":
      return ids;
  }
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

function FactChipView({ label, value, arrowTo, warn }: NonNullable<DemoRow["facts"]>[number]) {
  return (
    <span
      className={cn(
        "inline-flex items-center border",
        "h-[var(--ds-h-xs)] gap-[var(--ds-space-tight)] px-[var(--ds-space-snug)]",
        dsRadius.sm,
        dsText.meta,
        warn
          ? "border-[color:var(--ds-status-waiting-border)] bg-[var(--ds-status-waiting-bg)] text-[color:var(--ds-status-waiting-fg)]"
          : "border-[color:var(--ds-border)] bg-[var(--ds-surface-2)] text-[color:var(--ds-fg-secondary)]",
      )}
    >
      {label && <span className="text-[color:var(--ds-fg-muted)]">{label}</span>}
      <span className={cn(dsText.nums, !warn && "text-[color:var(--ds-fg)]")}>{value}</span>
      {arrowTo && (
        <>
          <ArrowRight aria-hidden className="size-2.5 shrink-0 text-[color:var(--ds-fg-muted)]" />
          <span className={cn(dsText.nums, "text-[color:var(--ds-fg)]")}>{arrowTo}</span>
        </>
      )}
    </span>
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

const ROW_CHIP_TONE: Record<RowChipTone, string> = {
  neutral: "border-[color:var(--ds-border)] bg-[var(--ds-surface-2)] text-[color:var(--ds-fg-muted)]",
  info: "border-[color:var(--ds-info-border)] bg-[var(--ds-info-bg)] text-[color:var(--ds-info-fg)]",
  warning:
    "border-[color:var(--ds-status-waiting-border)] bg-[var(--ds-status-waiting-bg)] text-[color:var(--ds-status-waiting-fg)]",
  violet:
    "border-[color:var(--ds-status-parked-border)] bg-[var(--ds-status-parked-bg)] text-[color:var(--ds-status-parked-fg)]",
};

const rowChip = (tone: RowChipTone, extra?: string): string =>
  cn(
    "inline-flex shrink-0 items-center border",
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
  const lookups = row.linkedGroup ? 0 : (row.records ?? []).filter((r) => r.lookup).length;
  return (
    <>
      {/* Depth 2 lives here and nowhere else. The packet that delegated this
          run deliberately does not repeat it — two levels of run in a queue row
          is already the limit of what stays readable. */}
      {lookups > 0 && (
        <span
          title={`${lookups} delegated person lookups — one per record. Reachable only from this review row; the packet never lists them.`}
          className={rowChip("neutral")}
        >
          <GitBranch aria-hidden className={dsIcon.sm} />
          {lookups} lookups
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
      {row.workflowVersion !== row.workflow.version && (
        <span
          title={`Ran under ${row.workflow.label} v${row.workflowVersion}; runs are served by v${row.workflow.version} now. Archived runs are not comparable with today's.`}
          className={rowChip("neutral", dsText.nums)}
        >
          v{row.workflowVersion}
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
  if (row.rowType === "group")
    return {
      tone: status === "waiting" ? "text-[color:var(--ds-status-waiting-fg)]" : "text-[color:var(--ds-fg-muted)]",
      text: row.outcome.text,
    };
  return null;
}

// ---------------------------------------------------------------------------
// The universal demo row card
// ---------------------------------------------------------------------------

export function DemoRowCard({
  row,
  state,
  handlers,
  nested,
}: {
  row: DemoRow;
  state: DemoQueueState;
  handlers: DemoQueueHandlers;
  nested?: boolean;
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

  // NO status branching here. The footer renders exactly the descriptors the
  // surface sent for this row; an action the server did not send has no button.
  const actions = (
    <>
      <FooterActions row={row} onAction={handlers.onAction} />
      <RowActionMenu row={row} onAction={handlers.onAction} />
    </>
  );

  return (
    <QueueRowCard
      selected={selected}
      selectionTone={nested ? "muted" : "primary"}
      rootProps={{
        onClick: () => handlers.onSelect(row.id),
        role: "button",
        tabIndex: 0,
        "aria-pressed": selected,
        "aria-label": `${row.displayName ?? row.title} — ${statusText(status, gateAge(row, state.tick)).toLowerCase()}`,
        "data-demo-row-id": row.id,
        onKeyDown: (e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            handlers.onSelect(row.id);
          }
        },
        className: cn(status === "running" && "border-primary/30"),
      }}
      footer={{
        time: row.time,
        runNumber: row.run,
        secondaryId: row.subtitle,
        suppressIdWhenEquals: row.title,
        elapsed: elapsed ?? row.queueNote ?? null,
        duration: row.duration ?? null,
        actions,
      }}
    >
      <div className="px-3.5 py-2.5">
        <div className="flex min-w-0 items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            {/* Bulk selection is a TOP-LEVEL act: a member is acted on through
                its group or on its own row, never half-selected inside one. */}
            {state.selectMode && !nested && (
              <input
                type="checkbox"
                checked={state.bulkIds.has(row.id)}
                aria-label={`Select ${row.displayName || row.title || row.trace} for a bulk command`}
                onClick={(e) => e.stopPropagation()}
                onChange={() => handlers.onToggleBulk(row.id)}
                className="size-3.5 shrink-0 accent-primary outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
            )}
            <StatusIcon aria-hidden className={cn("h-3.5 w-3.5 shrink-0", PROPOSED_STATUS[status].iconClass)} />
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
            {/* which workflow owns this row — needed the moment the queue shows
                more than one workflow, and the only thing that tells a packet
                apart from the OCR review row that shares its filename */}
            <span className={rowChip("neutral", cn(dsText.caps, "tracking-[var(--ds-tracking-caps)]"))}>{row.wfLabel}</span>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">{headerChips(row, state.checkedIds, state.tick)}</div>
        </div>

        {/* A counted anchor ("5 separations") has no subject of its own, so the
            names ARE its identity — without them the row is a number. */}
        {row.memberPreview && row.groupNoun && (
          <div
            className={cn(dsText.meta, "mt-[var(--ds-space-hair)] ml-5 truncate text-[color:var(--ds-fg-muted)]")}
            title={row.memberPreview}
          >
            {row.memberPreview}
          </div>
        )}

        {sub && (
          <div
            className={cn(
              dsText.meta,
              "mt-[var(--ds-space-snug)] ml-5 flex min-w-0 items-center gap-[var(--ds-space-base)] font-mono",
              sub.tone,
            )}
          >
            <span className="min-w-0 truncate">{sub.text}</span>
            <OutcomeActionButton row={row} onAction={handlers.onAction} className="ml-auto" />
          </div>
        )}

        {/* Linked delegation. A `linked` child keeps its own row in its own
            panel and the two point at each other — one chip each, never a
            duplicated run. `member` children live in the body instead. */}
        {(row.reviewRunId || row.reviewOf) && <LinkedReviewChip row={row} handlers={handlers} />}

        {/* A SET of linked children — Oath Upload's signers. Still a chip, not
            a member list: each signer is an Oath Signature run with its own row
            in that panel, counted there exactly once. */}
        {linked && (
          <div className="mt-1.5 ml-5">
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
              <span className="truncate">{linked.label}</span>
              <ArrowUpRight aria-hidden className="size-3 shrink-0" />
            </button>
          </div>
        )}

        {/* ONE level of back, never a breadcrumb trail: maximum real depth is 2,
            so there is only ever one parent worth returning to. */}
        {row.linkedParentId && !row.reviewOf && DEMO_ROWS[row.linkedParentId] && (
          <div className="mt-1.5 ml-5">
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                const parent = DEMO_ROWS[row.linkedParentId as string];
                handlers.onOpenPanel(parent.wfLabel, parent.id);
              }}
              title={`Delegated by ${DEMO_ROWS[row.linkedParentId].wfLabel} · ${DEMO_ROWS[row.linkedParentId].title} — open it in its own panel`}
              className={linkChip("neutral")}
            >
              <ArrowLeft aria-hidden className={cn(dsIcon.sm, "shrink-0")} />
              <span className="truncate">
                {DEMO_ROWS[row.linkedParentId].wfLabel} · {DEMO_ROWS[row.linkedParentId].title}
              </span>
            </button>
          </div>
        )}

        {row.facts && (
          <div className="mt-1.5 ml-5 flex min-w-0 flex-wrap items-center gap-1">
            {row.facts.map((f, i) => (
              <FactChipView key={i} {...f} />
            ))}
          </div>
        )}

        {isGroup && counts && (memberCount > 0 ? (
          <>
            <div className={cn(dsText.meta, "mt-[var(--ds-space-snug)] ml-5 flex items-center gap-[var(--ds-space-cozy)]")}>
              <StatusCounts counts={{ done: counts.done + counts.warnings, running: counts.running, queued: counts.queued, failed: counts.failed }} />
              {counts.waiting > 0 && (
                <span
                  className="inline-flex items-center gap-[var(--ds-space-tight)] text-[color:var(--ds-status-waiting-fg)]"
                  aria-label={`${counts.waiting} waiting on you`}
                >
                  <Eye aria-hidden className={dsIcon.sm} />
                  {counts.waiting}
                </span>
              )}
              {/* Rejected is its own tally. Folding it into done is how a packet
                  with an unreadable page comes to read as clean. */}
              {counts.rejected > 0 && (
                <span
                  className="inline-flex items-center gap-[var(--ds-space-tight)] text-[color:var(--ds-fg-muted)]"
                  title={`${counts.rejected} rejected — never became work, excluded from the rollup, and the reason this group cannot read as Verified done`}
                >
                  <SearchX aria-hidden className={dsIcon.sm} />
                  {counts.rejected} rejected
                </span>
              )}
              <span
                className="ml-auto inline-flex items-center gap-[var(--ds-space-tight)] text-[color:var(--ds-success-fg)]"
                aria-label="checked progress"
              >
                <CheckCircle2 aria-hidden className={dsIcon.sm} />
                {[...(row.memberIds ?? [])].filter((id) => state.checkedIds.has(id)).length}/{memberCount} checked
              </span>
            </div>
            <GroupBody row={row} state={state} handlers={handlers} />
          </>
        ) : (
          <PacketBeforeFanout row={row} handlers={handlers} />
        ))}
      </div>
    </QueueRowCard>
  );
}

/**
 * A chip that CHANGES PANEL. Three of these existed as three copies of the same
 * span; the delegation links and the parent back-link now share one shape, so
 * "this points somewhere else" always looks the same in a row.
 */
const linkChip = (tone: "info" | "neutral"): string =>
  cn(
    "inline-flex max-w-full cursor-pointer items-center border",
    "h-[var(--ds-h-xs)] gap-[var(--ds-space-snug)] px-[var(--ds-space-base)]",
    dsRadius.sm,
    dsText.meta,
    dsFocus,
    dsMotion.fast,
    tone === "info"
      ? "border-[color:var(--ds-info-border)] bg-[var(--ds-info-bg)] text-[color:var(--ds-info-fg)] hover:brightness-125"
      : cn(dsBorder.base, "bg-[var(--ds-surface-2)] text-[color:var(--ds-fg-muted)] hover:text-[color:var(--ds-fg)]"),
  );

function LinkedReviewChip({ row, handlers }: { row: DemoRow; handlers: DemoQueueHandlers }) {
  const targetId = (row.reviewRunId ?? row.reviewOf) as string;
  const target = DEMO_ROWS[targetId];
  if (!target) return null;
  return (
    <div className="mt-1.5 ml-5">
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          handlers.onOpenPanel(target.wfLabel, target.id);
        }}
        title={
          row.reviewOf
            ? `Open ${target.title} in the ${target.wfLabel} panel`
            : `Open the OCR panel and select this packet's review row — the records live there, not here`
        }
        className={linkChip("info")}
      >
        {row.reviewOf ? (
          <>
            <CornerDownRight aria-hidden className="size-3 shrink-0" />
            <span className="truncate">Delegated by {target.title}</span>
          </>
        ) : (
          <>
            <ClipboardList aria-hidden className="size-3 shrink-0" />
            <span className="truncate">OCR review · {statusText(effectiveStatus(target)).toLowerCase()}</span>
          </>
        )}
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
 */
function PacketBeforeFanout({ row, handlers }: { row: DemoRow; handlers: DemoQueueHandlers }) {
  const bulk = row.bulkApprove;
  if (row.extractedCount === undefined) return null;
  return (
    <div className="mt-1.5 ml-5 flex flex-col gap-1.5">
      <div className={cn(dsText.meta, "flex flex-wrap items-center gap-[var(--ds-space-base)]")}>
        <span className={rowChip("neutral", "font-medium")}>
          <Users aria-hidden className={cn(dsIcon.sm, "text-[color:var(--ds-fg-muted)]")} />
          {row.extractedCount} people
        </span>
        <span className="text-[color:var(--ds-fg-muted)]">extracted — no member rows yet, they are created when you approve</span>
      </div>
      {bulk && (
        <div
          className={cn(
            "flex flex-wrap items-center border",
            "gap-[var(--ds-space-snug)] px-[var(--ds-space-base)] py-[var(--ds-space-snug)]",
            dsRadius.md,
            "border-[color:var(--ds-status-waiting-border)] bg-[var(--ds-status-waiting-bg)]",
          )}
        >
          <Button
            size="sm"
            variant="primary"
            onClick={(e) => e.stopPropagation()}
            icon={<CheckCircle2 aria-hidden className={dsIcon.sm} />}
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
          >
            Open review
          </Button>
          <span className={cn(dsText.meta, "min-w-0 flex-1 leading-snug text-[color:var(--ds-fg-muted)]")}>
            {bulk.blockedNote} {bulk.editNote}
          </span>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Density ladder — 1–3 inline · 4–12 compact · 13+ scroll well.
// Three rungs, one member LINE shape across all of them. Scale changes the
// container, never the language: a 50-person roster is the 18-person roster
// with a scrollbar, because a second shape for the same object is what made
// the queue read as if it held more concepts than it does.
// ---------------------------------------------------------------------------

function GroupBody({ row, state, handlers }: { row: DemoRow; state: DemoQueueState; handlers: DemoQueueHandlers }) {
  const ids = orderedMemberIds(row.id);
  const rung = densityRung(ids.length);
  if (rung === "inline") {
    // At three people or fewer the group IS its members — a chevron here is
    // pure friction, so they are always open and rendered as full rows.
    return (
      <div className="mt-1.5 ml-5 flex flex-col gap-1.5" onClick={(e) => e.stopPropagation()} role="presentation">
        {ids.map((id) => (
          <DemoRowCard key={id} row={DEMO_ROWS[id]} state={state} handlers={handlers} nested />
        ))}
      </div>
    );
  }
  return <GroupMemberList row={row} state={state} handlers={handlers} rung={rung} />;
}

/** the status pill's own word, so the empty state names the filter the operator set */
function filterWord(filter: DemoFilter): string {
  if (filter === "needsYou") return "waiting on you or write parked";
  return PROPOSED_STATUS[filter as ProposedStatus].label.toLowerCase();
}

function GroupMemberList({
  row,
  state,
  handlers,
  rung,
}: {
  row: DemoRow;
  state: DemoQueueState;
  handlers: DemoQueueHandlers;
  rung: "compact" | "well";
}) {
  const ids = orderedMemberIds(row.id);
  const expanded = state.expandedGroups.has(row.id);
  // 13 people or 50, every line stays available inside a fixed-height well, so
  // the row is the same size on screen either way. This is the ONLY treatment
  // above twelve members — a roster does not get a second visual language just
  // for being long, it gets the same lines and a scrollbar.
  const visible = rung === "well" ? ids : expanded ? ids : ids.slice(0, 4);
  const noun = row.wfLabel === "Oath Signature" ? "signers" : "people";
  return (
    <div className="mt-1.5 ml-5">
      <div
        className={cn(
          "divide-y divide-border/40 overflow-hidden rounded-md border border-border/60",
          rung === "well" && "max-h-[var(--ds-h-member-well)] overflow-y-auto",
        )}
      >
        {visible.map((id) => {
          const m = DEMO_ROWS[id];
          const spec = MEMBER_STATUS_ICON[m.status];
          const Icon = m.containment === "rejected" ? SearchX : spec.icon;
          return (
            <button
              key={id}
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                handlers.onSelect(id);
              }}
              className={cn(
                "flex w-full cursor-pointer items-center text-left",
                "h-[var(--ds-h-sm)] gap-[var(--ds-space-base)] px-[var(--ds-space-base)]",
                dsText.body,
                dsFocus,
                dsMotion.fast,
                "bg-[var(--ds-surface-1)] hover:bg-[var(--ds-surface-3)]",
                state.selectedId === id && "bg-[var(--ds-surface-selected)]",
              )}
            >
              <Icon
                aria-hidden
                className={cn(dsIcon.sm, "shrink-0", m.containment === "rejected" ? "text-[color:var(--ds-fg-muted)]" : spec.cls)}
              />
              <span
                className={cn(
                  "min-w-0 flex-1 truncate text-[color:var(--ds-fg)]",
                  m.containment === "rejected" && "italic text-[color:var(--ds-fg-muted)]",
                )}
              >
                {m.title}
              </span>
              <span
                className={cn(
                  dsText.meta,
                  dsText.nums,
                  "shrink-0 truncate",
                  m.status === "failed" && m.containment !== "rejected"
                    ? "text-[color:var(--ds-status-failed-fg)]"
                    : "text-[color:var(--ds-fg-muted)]",
                )}
              >
                {m.memberFact}
              </span>
              <span className={cn(dsText.meta, dsText.nums, "w-16 shrink-0 text-right text-[color:var(--ds-fg-muted)]")}>
                {m.eid ?? "—"}
              </span>
            </button>
          );
        })}
      </div>
      {rung === "well" ? (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            handlers.onDrillIn(row.id);
          }}
          className={cn(
            dsText.meta,
            "mt-[var(--ds-space-snug)] inline-flex cursor-pointer items-center gap-[var(--ds-space-tight)]",
            dsFocus,
            dsMotion.fast,
            "text-[color:var(--ds-fg-muted)] hover:text-[color:var(--ds-fg)]",
          )}
        >
          <ArrowRight aria-hidden className={dsIcon.sm} />
          Open all {ids.length} {noun}
        </button>
      ) : (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            handlers.onToggleGroup(row.id);
          }}
          className={cn(
            dsText.meta,
            "mt-[var(--ds-space-snug)] inline-flex cursor-pointer items-center gap-[var(--ds-space-tight)]",
            dsFocus,
            dsMotion.fast,
            "text-[color:var(--ds-fg-muted)] hover:text-[color:var(--ds-fg)]",
          )}
        >
          {expanded ? <ChevronUp aria-hidden className={dsIcon.sm} /> : <ChevronDown aria-hidden className={dsIcon.sm} />}
          {expanded ? "Collapse" : `Show all ${ids.length} ${noun}`}
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Drill-in triage table
// ---------------------------------------------------------------------------

/** the drill-in header's three summary chips — one shape, two loudness levels */
const drillChip = (warn: boolean): string =>
  cn(
    "inline-flex shrink-0 items-center border",
    "h-[var(--ds-h-xs)] gap-[var(--ds-space-tight)] px-[var(--ds-space-base)]",
    dsText.meta,
    warn
      ? "border-[color:var(--ds-status-waiting-border)] bg-[var(--ds-status-waiting-bg)] font-medium text-[color:var(--ds-status-waiting-fg)]"
      : cn(dsBorder.base, "bg-[var(--ds-surface-2)] text-[color:var(--ds-fg-muted)]"),
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
        {/* This is the LAST RUNG of the density ladder, not a route: the same
            group, the same members, opened to the size the set actually needs.
            One back, no breadcrumb — there is only one parent to return to. */}
        <span
          title={`Density ladder — ${DENSITY_RUNGS.find((r) => r.key === densityRung(ids.length))?.range}. The drill-in is a rung, not a separate page.`}
          className={cn(drillChip(false), dsRadius.pill)}
        >
          {DENSITY_RUNGS.find((r) => r.key === densityRung(ids.length))?.range} · opened in place
        </span>
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
      <div role="listbox" aria-label="Group members, attention first" className="min-h-0 flex-1 divide-y divide-border/30 overflow-y-auto">
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
                "grid w-full cursor-pointer grid-cols-[16px_minmax(110px,1.2fr)_74px_minmax(100px,1fr)_44px] items-center text-left",
                "h-[var(--ds-h-row)] gap-x-[var(--ds-space-cozy)] px-[var(--ds-space-cozy)]",
                dsText.body,
                dsFocus,
                dsMotion.fast,
                "hover:bg-[var(--ds-surface-3)]",
                isSel && "bg-[var(--ds-surface-selected)] shadow-[inset_2px_0_0_var(--ds-accent)]",
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
              <span
                className={cn(
                  dsText.meta,
                  dsText.nums,
                  "truncate",
                  m.status === "failed" && !rejected && "text-[color:var(--ds-status-failed-fg)]",
                  (m.status === "waiting" || m.status === "doneWarnings") && "text-[color:var(--ds-status-waiting-fg)]",
                  (m.status === "verifiedDone" || m.status === "running" || rejected) && "text-[color:var(--ds-fg-muted)]",
                  m.status === "queued" && "text-[color:var(--ds-fg-faint)]",
                )}
              >
                {m.memberFact}
              </span>
              <span className={cn(dsText.meta, dsText.nums, "text-right text-[color:var(--ds-fg-muted)]")}>{m.duration ?? "—"}</span>
            </button>
          );
        })}
      </div>
      <div
        className={cn(
          "flex shrink-0 flex-wrap items-center border-t bg-[var(--ds-surface-2)]",
          dsBorder.subtle,
          dsText.meta,
          "gap-x-[var(--ds-space-cozy)] gap-y-[var(--ds-space-tight)] px-[var(--ds-space-cozy)] py-[var(--ds-space-snug)]",
          "text-[color:var(--ds-fg-muted)]",
        )}
      >
        <span className="inline-flex items-center gap-[var(--ds-space-tight)]">
          <Kbd>j</Kbd>
          <Kbd>k</Kbd> move
        </span>
        <span className="inline-flex items-center gap-[var(--ds-space-tight)]">
          <Kbd>n</Kbd> next attention
        </span>
        <span className="inline-flex items-center gap-[var(--ds-space-tight)]">
          <Kbd>c</Kbd> mark checked
        </span>
        <span className="inline-flex items-center gap-[var(--ds-space-tight)]">
          <Kbd>Esc</Kbd> back
        </span>
        <span className="ml-auto">sorted attention-first</span>
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
            <p className={cn(dsText.body, "max-w-[52ch] leading-relaxed text-[color:var(--ds-fg-muted)]")}>
              {state.filter === "all"
                ? "This workflow is registered and can be run — it simply has no runs today. A panel that vanishes when idle is a panel you stop trusting, so it stays."
                : "Rows exist in this workflow, just none in this status. The badge beside the workflow and the pill above both read zero here because all three read the same count."}
            </p>
            <p className={cn(dsText.meta, "text-[color:var(--ds-fg-muted)]")}>
              {state.filter === "all"
                ? "Start one from the run controls, or pick another workflow in the Workflow Panel."
                : "Clear the status pill to see everything in this workflow."}
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
