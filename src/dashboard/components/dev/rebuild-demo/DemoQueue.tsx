import { useMemo, type ReactNode } from "react";
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  ArrowUpRight,
  Ban,
  Camera,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  ClipboardList,
  Clock,
  CornerDownRight,
  Eye,
  FileText,
  GitBranch,
  Loader2,
  PauseCircle,
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
import { FooterActions, OutcomeActionButton, RowActionMenu, type DemoActionHandler } from "./DemoActions";
import { rowInBucket, type StatusBucket } from "./DemoShell";
import {
  ATTENTION_STATUSES,
  bandsFor,
  DEMO_ROWS,
  densityRung,
  effectiveStatus,
  fmtElapsed,
  gateAge,
  groupCounts,
  linkedGroupSummary,
  orderedMemberIds,
  type DemoRow,
} from "./demo-data";

/**
 * DEV-ONLY — the rebuild demo's queue panel. Attention bands, the four-rung
 * density ladder, the 41+ status matrix, and the triage drill-in, rendered on
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
    case "matrix":
      // cells, not rows — the drill-in is where you walk these people
      return [];
  }
}

/** the j/k traversal order for the current view */
export function computeVisibleIds(rows: DemoRow[], state: Pick<DemoQueueState, "view" | "filter" | "expandedGroups">): string[] {
  if (state.view.kind === "drill") return orderedMemberIds(state.view.groupId);
  const ids: string[] = [];
  for (const band of bandsFor(rows.filter((r) => rowInBucket(r, state.filter)))) {
    for (const row of band.rows) {
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
        "inline-flex items-center gap-1 rounded-[5px] border px-1.5 py-px text-[10.5px]",
        warn ? "border-warning/40 bg-warning/8 text-warning" : "border-border bg-secondary/50 text-secondary-foreground",
      )}
    >
      {label && <span className="text-muted-foreground">{label}</span>}
      <span className={cn("font-mono", !warn && "text-foreground")}>{value}</span>
      {arrowTo && (
        <>
          <ArrowRight aria-hidden className="size-2.5 text-muted-foreground" />
          <span className="font-mono text-foreground">{arrowTo}</span>
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

const MEMBER_STATUS_ICON: Record<ProposedStatus, { icon: typeof CheckCircle2; cls: string }> = {
  verifiedDone: { icon: CheckCircle2, cls: "text-success" },
  doneWarnings: { icon: CheckCircle2, cls: "text-warning" },
  running: { icon: Loader2, cls: "text-primary animate-spin motion-reduce:animate-none" },
  queued: { icon: Clock, cls: "text-warning" },
  failed: { icon: AlertTriangle, cls: "text-destructive" },
  waiting: { icon: Eye, cls: "text-warning" },
  parked: { icon: PauseCircle, cls: "text-log-violet" },
  cancelled: { icon: Ban, cls: "text-warning" },
};

const MATRIX_CELL: Record<ProposedStatus, string> = {
  verifiedDone: "bg-success/75",
  doneWarnings: "bg-warning/80",
  running: "bg-primary/80 animate-pulse motion-reduce:animate-none",
  queued: "bg-secondary",
  failed: "bg-destructive",
  waiting: "bg-warning",
  parked: "bg-log-violet",
  cancelled: "bg-warning/60",
};

function headerChips(row: DemoRow, checked: ReadonlySet<string>, tick: number): ReactNode {
  const status = effectiveStatus(row);
  const lookups = (row.records ?? []).filter((r) => r.lookup).length;
  return (
    <>
      {/* Depth 2 lives here and nowhere else. The packet that delegated this
          run deliberately does not repeat it — two levels of run in a queue row
          is already the limit of what stays readable. */}
      {lookups > 0 && (
        <span
          title={`${lookups} delegated person lookups — one per record. Reachable only from this review row; the packet never lists them.`}
          className="inline-flex items-center gap-1 rounded-md border border-border bg-secondary/50 px-1.5 py-0.5 text-[10px] text-muted-foreground"
        >
          <GitBranch aria-hidden className="size-3" />
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
          className="inline-flex items-center gap-1 rounded-md border border-info/45 bg-info/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-info"
        >
          test
        </span>
      )}
      {row.dryRun && (
        <span
          title="Dry run — this rehearsal reads the systems and writes nothing."
          className="inline-flex items-center gap-1 rounded-md border border-log-violet/45 bg-log-violet/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-log-violet"
        >
          dry run
        </span>
      )}
      {row.workflowVersion !== row.workflow.version && (
        <span
          title={`Ran under ${row.workflow.label} v${row.workflowVersion}; runs are served by v${row.workflow.version} now. Archived runs are not comparable with today's.`}
          className="inline-flex items-center gap-1 rounded-md border border-border bg-secondary/60 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground"
        >
          v{row.workflowVersion}
        </span>
      )}
      {row.attemptHistory && (
        <span
          title={row.attemptHistory.prior}
          className="inline-flex items-center gap-1 rounded-md border border-warning/40 bg-warning/12 px-1.5 py-0.5 text-[10px] font-semibold text-warning"
        >
          <RotateCcw aria-hidden className="size-3" />
          attempt {row.attemptHistory.n}
        </span>
      )}
      {row.warnings && (
        <span
          title={row.warnings.first}
          className="inline-flex items-center gap-1 rounded-md border border-warning/40 bg-warning/12 px-1.5 py-0.5 text-[10px] font-semibold text-warning"
        >
          <AlertTriangle aria-hidden className="size-3" />
          {row.warnings.count}
        </span>
      )}
      {row.failShots && (
        <span
          title={`${row.failShots} failure screenshots`}
          className="inline-flex items-center gap-1 rounded-md border border-border bg-secondary/60 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground"
        >
          <Camera aria-hidden className="size-3" />
          {row.failShots}
        </span>
      )}
      {row.receiptShield && (
        <span title={row.receiptShield} className="inline-flex items-center text-success">
          <ShieldCheck aria-hidden className="size-3.5" />
          <span className="sr-only">{row.receiptShield}</span>
        </span>
      )}
      {row.rowType === "member" && checked.has(row.id) && (
        <span title="Marked checked by you" className="inline-flex items-center text-success">
          <CheckCircle2 aria-hidden className="size-3.5" />
          <span className="sr-only">checked</span>
        </span>
      )}
      {status === "running" && row.rowType !== "group" && <MicroSteps row={row} />}
      {/* A collapsed row says how OLD the decision is, not only that there is
          one. Age is the whole triage signal. */}
      <StatusBadge status={status} age={gateAge(row, tick)} />
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
  if (status === "failed" && row.error) return { tone: "text-destructive", text: row.error };
  if (status === "waiting" && row.gate)
    return {
      tone: "text-warning",
      text:
        row.gate.kind === "identity" && row.gate.candidates
          ? `${row.gate.title.replace("Waiting on you — ", "")} — ${row.gate.candidates[0].name} vs ${row.gate.candidates[1].name}`
          : row.gate.title,
    };
  // Parked is an UNKNOWN outcome, never a hold you resume.
  if (status === "parked") return { tone: "text-log-violet", text: row.outcome.text };
  if (status === "cancelled") return { tone: "text-muted-foreground", text: "Cancelled by you — nothing written" };
  if (status === "running" && row.liveText) return { tone: "text-primary/85", text: row.liveText };
  if (row.rowType === "group" && row.ocrPhase) return { tone: "text-muted-foreground", text: row.ocrPhase };
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
            <StatusIcon aria-hidden className={cn("h-3.5 w-3.5 shrink-0", PROPOSED_STATUS[status].iconClass)} />
            <span
              title={row.displayName ? `Named by you — subject is ${row.title}` : undefined}
              className={cn(
                "truncate text-[14px] font-semibold text-foreground",
                row.containment === "rejected" && "italic font-normal text-muted-foreground",
              )}
            >
              {row.displayName ?? row.title}
            </span>
            {/* which workflow owns this row — needed the moment the queue shows
                more than one workflow, and the only thing that tells a packet
                apart from the OCR review row that shares its filename */}
            <span className="shrink-0 rounded border border-border bg-secondary/50 px-1.5 py-px text-[9.5px] uppercase tracking-wider text-muted-foreground">
              {row.wfLabel}
            </span>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">{headerChips(row, state.checkedIds, state.tick)}</div>
        </div>

        {sub && (
          <div className={cn("mt-1.5 ml-5 flex min-w-0 items-center gap-2 text-[11px] font-mono", sub.tone)}>
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
                handlers.onOpenPanel(linked.panel, linked.firstId);
              }}
              title={`Open the ${linked.panel} panel — these runs live there, not under this row`}
              className="inline-flex max-w-full items-center gap-1.5 rounded-md border border-info/35 bg-info/8 px-2 py-0.5 text-[10.5px] text-info outline-none hover:bg-info/15 focus-visible:ring-2 focus-visible:ring-ring"
            >
              <Users aria-hidden className="size-3 shrink-0" />
              <span className="truncate">{linked.label}</span>
              <ArrowUpRight aria-hidden className="size-3 shrink-0" />
            </button>
          </div>
        )}

        {row.linkedParentId && !row.reviewOf && (
          <div className="mt-1.5 ml-5">
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                const parent = DEMO_ROWS[row.linkedParentId as string];
                handlers.onOpenPanel(parent.wfLabel, parent.id);
              }}
              className="inline-flex max-w-full items-center gap-1.5 rounded-md border border-border bg-secondary/40 px-2 py-0.5 text-[10.5px] text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
            >
              <CornerDownRight aria-hidden className="size-3 shrink-0" />
              <span className="truncate">Released by {DEMO_ROWS[row.linkedParentId]?.title}</span>
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
            <div className="mt-1.5 ml-5 flex items-center gap-2.5 text-[11px]">
              <StatusCounts counts={{ done: counts.done + counts.warnings, running: counts.running, queued: counts.queued, failed: counts.failed }} />
              {counts.waiting > 0 && (
                <span className="inline-flex items-center gap-1 text-warning" aria-label={`${counts.waiting} waiting on you`}>
                  <Eye aria-hidden className="size-3" />
                  {counts.waiting}
                </span>
              )}
              {/* Rejected is its own tally. Folding it into done is how a packet
                  with an unreadable page comes to read as clean. */}
              {counts.rejected > 0 && (
                <span
                  className="inline-flex items-center gap-1 text-muted-foreground"
                  title={`${counts.rejected} rejected — never became work, excluded from the rollup, and the reason this group cannot read as Verified done`}
                >
                  <SearchX aria-hidden className="size-3" />
                  {counts.rejected} rejected
                </span>
              )}
              <span className="ml-auto inline-flex items-center gap-1 text-success" aria-label="checked progress">
                <CheckCircle2 aria-hidden className="size-3" />
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
        className="inline-flex max-w-full items-center gap-1.5 rounded-md border border-info/35 bg-info/8 px-2 py-0.5 text-[10.5px] text-info outline-none hover:bg-info/15 focus-visible:ring-2 focus-visible:ring-ring"
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
      <div className="flex flex-wrap items-center gap-2 text-[11px]">
        <span className="inline-flex items-center gap-1.5 rounded-md border border-border bg-secondary/50 px-2 py-0.5 font-medium text-secondary-foreground">
          <Users aria-hidden className="size-3 text-muted-foreground" />
          {row.extractedCount} people
        </span>
        <span className="text-muted-foreground">extracted — no member rows yet, they are created when you approve</span>
      </div>
      {bulk && (
        <div className="flex flex-wrap items-center gap-1.5 rounded-md border border-warning/35 bg-warning/6 px-2.5 py-1.5">
          <button
            type="button"
            onClick={(e) => e.stopPropagation()}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-warning/55 bg-warning/15 px-2.5 py-0.5 text-[11px] font-semibold text-warning outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <CheckCircle2 aria-hidden className="size-3" />
            Approve {bulk.approvable} of {bulk.total}
          </button>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              if (row.reviewRunId) handlers.onOpenPanel(DEMO_ROWS[row.reviewRunId].wfLabel, row.reviewRunId);
            }}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-border bg-card px-2.5 py-0.5 text-[11px] font-semibold text-secondary-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            Open review
            <ArrowUpRight aria-hidden className="size-3" />
          </button>
          <span className="min-w-0 flex-1 text-[10.5px] leading-snug text-muted-foreground">
            {bulk.blockedNote} {bulk.editNote}
          </span>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Density ladder — 1–3 inline · 4–12 compact · 13–40 scroll well · 41+ matrix
// ---------------------------------------------------------------------------

function GroupBody({ row, state, handlers }: { row: DemoRow; state: DemoQueueState; handlers: DemoQueueHandlers }) {
  const ids = orderedMemberIds(row.id);
  const rung = densityRung(ids.length);
  if (rung === "matrix") return <GroupMatrix row={row} state={state} handlers={handlers} />;
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

function GroupMatrix({ row, state, handlers }: { row: DemoRow; state: DemoQueueState; handlers: DemoQueueHandlers }) {
  const attention = useMemo(
    () => (row.memberIds ?? []).filter((id) => DEMO_ROWS[id].containment !== "rejected" && ATTENTION_STATUSES.includes(DEMO_ROWS[id].status)),
    [row.memberIds],
  );
  return (
    <>
      {/* The strip sits ABOVE the matrix on purpose. Fifty cells is a texture,
          not a message — the sentence that names who needs you has to be read
          first, or the matrix becomes decoration. */}
      <div className="mt-2 ml-5 flex items-center gap-2 rounded-md border border-warning/35 bg-warning/6 px-2.5 py-1.5">
        <AlertTriangle aria-hidden className="size-3.5 shrink-0 text-warning" />
        <span className="min-w-0 flex-1 truncate text-[11.5px] text-warning">
          {attention.length} need attention — {attentionBreakdown(row.id)}
        </span>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            handlers.onDrillIn(row.id);
            if (attention[0]) handlers.onSelect(attention[0]);
          }}
          className="shrink-0 rounded-md border border-warning/45 bg-warning/12 px-2.5 py-0.5 text-[10.5px] font-semibold text-warning outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          Start review
        </button>
      </div>
      <div className="mt-1.5 ml-5 flex flex-wrap gap-[3px]" role="listbox" aria-label="Member status matrix">
        {(row.memberIds ?? []).map((id) => {
          const m = DEMO_ROWS[id];
          const cellSelected = state.selectedId === id;
          return (
            <button
              key={id}
              type="button"
              role="option"
              aria-selected={cellSelected}
              title={`${m.title} — ${PROPOSED_STATUS[m.status].label}${m.memberFact && m.memberFact !== "—" ? ` · ${m.memberFact}` : ""}`}
              aria-label={`${m.title} — ${PROPOSED_STATUS[m.status].label}`}
              onClick={(e) => {
                e.stopPropagation();
                handlers.onSelect(id);
              }}
              className={cn(
                "size-3.5 rounded-[3px] outline-none transition-transform hover:scale-125 focus-visible:ring-2 focus-visible:ring-ring",
                m.containment === "rejected" ? "bg-muted-foreground/40" : MATRIX_CELL[m.status],
                cellSelected && "ring-2 ring-primary",
                state.checkedIds.has(id) && "ring-1 ring-success/70",
              )}
            />
          );
        })}
      </div>
    </>
  );
}

/** "2 failed · 1 waiting · 1 warning" — derived, never a hardcoded caption. */
function attentionBreakdown(groupId: string): string {
  const c = groupCounts(groupId);
  const parts: string[] = [];
  if (c.failed) parts.push(`${c.failed} failed`);
  if (c.waiting) parts.push(`${c.waiting} waiting on you`);
  if (c.parked) parts.push(`${c.parked} write parked`);
  if (c.warnings) parts.push(`${c.warnings} with warnings`);
  if (c.rejected) parts.push(`${c.rejected} rejected`);
  return parts.join(" · ") || "all clear";
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
  // 13–40 people: every line stays available, but inside a fixed-height well so
  // a group of 40 is the same size on screen as a group of 13.
  const visible = rung === "well" ? ids : expanded ? ids : ids.slice(0, 4);
  const noun = row.wfLabel === "Oath Signature" ? "signers" : "people";
  return (
    <div className="mt-1.5 ml-5">
      <div
        className={cn(
          "divide-y divide-border/40 overflow-hidden rounded-md border border-border/60",
          rung === "well" && "max-h-[8.5rem] overflow-y-auto",
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
                "flex w-full items-center gap-2 bg-card px-2.5 py-1 text-left text-[11.5px] outline-none hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                state.selectedId === id && "bg-info/8",
              )}
            >
              <Icon aria-hidden className={cn("size-3 shrink-0", m.containment === "rejected" ? "text-muted-foreground" : spec.cls)} />
              <span className={cn("min-w-0 flex-1 truncate text-foreground", m.containment === "rejected" && "italic text-muted-foreground")}>
                {m.title}
              </span>
              <span className={cn("shrink-0 truncate font-mono text-[10px]", m.status === "failed" && m.containment !== "rejected" ? "text-destructive" : "text-muted-foreground")}>
                {m.memberFact}
              </span>
              <span className="w-16 shrink-0 text-right font-mono text-[10px] text-muted-foreground tabular-nums">{m.eid ?? "—"}</span>
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
          className="mt-1 inline-flex items-center gap-1 text-[10.5px] text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        >
          <ArrowRight aria-hidden className="size-3" />
          Open all {ids.length} {noun}
        </button>
      ) : (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            handlers.onToggleGroup(row.id);
          }}
          className="mt-1 inline-flex items-center gap-1 text-[10.5px] text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        >
          {expanded ? <ChevronUp aria-hidden className="size-3" /> : <ChevronDown aria-hidden className="size-3" />}
          {expanded ? "Collapse" : `Show all ${ids.length} ${noun}`}
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Drill-in triage table
// ---------------------------------------------------------------------------

function DrillIn({ groupId, state, handlers }: { groupId: string; state: DemoQueueState; handlers: DemoQueueHandlers }) {
  const group = DEMO_ROWS[groupId];
  const ids = orderedMemberIds(groupId);
  const counts = groupCounts(groupId);
  const attentionN = counts.failed + counts.waiting + counts.warnings + counts.parked;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-1.5 border-b border-border/60 px-3 py-2">
        <button
          type="button"
          onClick={handlers.onBack}
          aria-label="Back to queue"
          className="mr-1 inline-flex size-6 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        >
          <ArrowLeft aria-hidden className="size-3.5" />
        </button>
        <span className="mr-2 truncate text-[13px] font-semibold text-foreground">{group.title}</span>
        <span className="rounded-full border border-warning/50 bg-warning/12 px-2.5 py-0.5 text-[10.5px] font-medium text-warning">
          Attention <span className="font-mono tabular-nums">{attentionN}</span>
        </span>
        <span className="rounded-full border border-border bg-card px-2.5 py-0.5 text-[10.5px] font-medium text-muted-foreground">
          All <span className="font-mono tabular-nums">{ids.length}</span>
        </span>
        <span className="relative ml-auto">
          <Search aria-hidden className="pointer-events-none absolute left-2 top-1/2 size-3 -translate-y-1/2 text-muted-foreground" />
          <input
            aria-label="Search members"
            placeholder="name / EID…"
            className="w-32 rounded-md border border-border bg-secondary/40 py-0.5 pl-6 pr-2 text-[11px] text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
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
                "grid w-full grid-cols-[16px_minmax(110px,1.2fr)_74px_minmax(100px,1fr)_44px] items-center gap-x-2.5 px-3 py-[5px] text-left text-[12px] outline-none",
                "hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                isSel && "bg-info/8 shadow-[inset_2px_0_0_var(--info)]",
              )}
            >
              <Icon aria-hidden className={cn("size-3.5", rejected ? "text-muted-foreground" : spec.cls)} />
              <span className="flex min-w-0 items-center gap-1.5">
                <span className={cn("truncate font-medium text-foreground", rejected && "italic font-normal text-muted-foreground")}>{m.title}</span>
                {state.checkedIds.has(id) && <CheckCircle2 aria-hidden className="size-3 shrink-0 text-success" />}
              </span>
              <span className="font-mono text-[10.5px] text-muted-foreground tabular-nums">{m.eid ?? "—"}</span>
              <span
                className={cn(
                  "truncate font-mono text-[10.5px]",
                  m.status === "failed" && !rejected && "text-destructive",
                  (m.status === "waiting" || m.status === "doneWarnings") && "text-warning",
                  (m.status === "verifiedDone" || m.status === "running" || rejected) && "text-muted-foreground",
                  m.status === "queued" && "text-muted-foreground/70",
                )}
              >
                {m.memberFact}
              </span>
              <span className="text-right font-mono text-[10.5px] text-muted-foreground tabular-nums">{m.duration ?? "—"}</span>
            </button>
          );
        })}
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-border/60 bg-secondary/20 px-3 py-1.5 font-mono text-[10px] text-muted-foreground">
        <span>
          <kbd className="rounded border border-border bg-card px-1">j</kbd>/<kbd className="rounded border border-border bg-card px-1">k</kbd> move
        </span>
        <span>
          <kbd className="rounded border border-border bg-card px-1">n</kbd> next attention
        </span>
        <span>
          <kbd className="rounded border border-border bg-card px-1">c</kbd> mark checked
        </span>
        <span>
          <kbd className="rounded border border-border bg-card px-1">Esc</kbd> back
        </span>
        <span className="ml-auto">sorted attention-first</span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The panel
// ---------------------------------------------------------------------------

export function DemoQueue({ rows, state, handlers }: { rows: DemoRow[]; state: DemoQueueState; handlers: DemoQueueHandlers }) {
  const inView = rows.filter((r) => rowInBucket(r, state.filter));
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
      <section aria-label="Group triage" className="flex min-h-0 flex-col overflow-hidden rounded-lg border border-border bg-card">
        <DrillIn groupId={state.view.groupId} state={state} handlers={handlers} />
      </section>
    );
  }

  return (
    <section aria-label="Queue" className="flex min-h-0 flex-col overflow-hidden rounded-lg border border-border bg-card">
      <div className="flex items-center gap-2 border-b border-border/60 px-3 py-2 text-[12px] text-muted-foreground">
        <span className="text-[13px] font-semibold text-foreground">Queue</span>· Jul 25
        <span className="ml-auto font-mono text-[10px]">{inView.length} runs</span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto pb-3">
        {inView.length === 0 && (
          <div className="flex flex-col items-center gap-1.5 px-6 py-12 text-center">
            <FileText aria-hidden className="size-5 text-muted-foreground/60" />
            <p className="max-w-[34ch] text-[11.5px] text-muted-foreground">
              Nothing in this view. The badge beside the workflow and the pill above both read zero — they are the same count.
            </p>
          </div>
        )}
        {bands.map((band) => {
          if (band.rows.length === 0) return null;
          return (
            <div key={band.key}>
              <div
                className={cn(
                  "mx-3 mt-3 flex items-center gap-2 text-[10px] font-semibold uppercase tracking-widest",
                  band.key === "attention" ? "text-warning" : "text-muted-foreground",
                )}
              >
                {band.label}
                <span
                  className={cn(
                    "rounded-full border px-1.5 font-mono text-[10px] tabular-nums",
                    band.key === "attention" ? "border-warning/50" : "border-border",
                  )}
                >
                  {band.rows.length}
                </span>
                <span aria-hidden className="h-px flex-1 bg-border/60" />
              </div>
              {band.key === "finished" && state.filter === "all" && (
                <div className="mx-3 mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-dashed border-border px-3 py-1.5 text-[11px] text-muted-foreground">
                  <span className="font-semibold text-secondary-foreground">Today:</span>
                  <span>
                    <span className="font-semibold text-success">{digest.done}</span> verified
                  </span>
                  {digest.warned > 0 && (
                    <span className="text-warning">
                      <span className="font-semibold">{digest.warned}</span> with warnings
                    </span>
                  )}
                  {digest.failed > 0 && (
                    <span className="text-destructive">
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
              {band.rows.map((row) => (
                <DemoRowCard key={row.id} row={row} state={state} handlers={handlers} />
              ))}
            </div>
          );
        })}
      </div>
    </section>
  );
}
