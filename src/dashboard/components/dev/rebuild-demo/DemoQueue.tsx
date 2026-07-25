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
  ChevronsUp,
  ClipboardList,
  Clock,
  CornerDownRight,
  Eye,
  Loader2,
  PauseCircle,
  RotateCcw,
  Search,
  SearchX,
  ShieldCheck,
  Trash2,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { QueueRowCard } from "@/components/queue-panel/QueueRowCard";
import { StatusCounts } from "@/components/queue-panel/StatusCounts";
import { IconActionButton } from "@/components/shared/IconActionButton";
import { PROPOSED_STATUS, StatusBadge, type ProposedStatus } from "./demo-status";
import {
  ATTENTION_STATUSES,
  BAND_ORDER,
  DEMO_ROWS,
  fmtElapsed,
  groupCounts,
  orderedMemberIds,
  type DemoRow,
} from "./demo-data";

/**
 * DEV-ONLY — the rebuild demo's queue panel. Attention bands, working filter
 * pills, enriched rows for all 3 ratified row types, the 50-member status
 * matrix, inline compact members for medium groups, and the triage drill-in.
 * Rendering rides the REAL QueueRowCard/RowFooter/StatusCounts chrome.
 */

const NOOP = () => {};

export type DemoFilter = "all" | "attention" | "running" | "queued" | "done" | "failed" | "cancelled";
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
  onFilter: (f: DemoFilter) => void;
  onDrillIn: (groupId: string) => void;
  onBack: () => void;
  onToggleGroup: (groupId: string) => void;
}

function rowMatchesFilter(row: DemoRow, filter: DemoFilter): boolean {
  switch (filter) {
    case "all":
      return true;
    case "attention":
      return ATTENTION_STATUSES.includes(row.status);
    case "running":
      return row.status === "running";
    case "queued":
      return row.status === "queued";
    case "done":
      return row.status === "verifiedDone" || row.status === "doneWarnings";
    case "failed":
      return row.status === "failed";
    case "cancelled":
      return row.status === "cancelled";
  }
}

/** the j/k traversal order for the current view — shared with the shell */
export function computeVisibleIds(state: Pick<DemoQueueState, "view" | "filter" | "expandedGroups">): string[] {
  if (state.view.kind === "drill") return orderedMemberIds(state.view.groupId);
  const ids: string[] = [];
  for (const band of BAND_ORDER) {
    for (const id of band.ids) {
      const row = DEMO_ROWS[id];
      if (!rowMatchesFilter(row, state.filter)) continue;
      ids.push(id);
      // an expanded, list-density group puts its members in the traversal order
      if (row.rowType === "group" && state.expandedGroups.has(id) && (row.memberIds?.length ?? 0) <= 20) {
        ids.push(...orderedMemberIds(id));
      }
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

function headerChips(row: DemoRow, checked: ReadonlySet<string>): ReactNode {
  return (
    <>
      {row.waitingLabel && (
        <span className="inline-flex items-center gap-1 rounded-md bg-warning/10 px-1.5 py-0.5 text-[10px] font-medium text-warning">
          <Clock aria-hidden className="size-3" />
          {row.waitingLabel}
        </span>
      )}
      {row.attempt && (
        <span
          title={row.attempt.prior}
          className="inline-flex items-center gap-1 rounded-md border border-warning/40 bg-warning/12 px-1.5 py-0.5 text-[10px] font-semibold text-warning"
        >
          <RotateCcw aria-hidden className="size-3" />
          attempt {row.attempt.n}
        </span>
      )}
      {row.warnings && (
        <span className="inline-flex items-center gap-1 rounded-md border border-warning/40 bg-warning/12 px-1.5 py-0.5 text-[10px] font-semibold text-warning">
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
      {row.status === "running" && row.rowType !== "group" && <MicroSteps row={row} />}
      <StatusBadge status={row.status} />
    </>
  );
}

function sublineFor(row: DemoRow): { tone: string; text: string; action?: string; actionTone?: string } | null {
  if (row.status === "failed" && row.error) return { tone: "text-destructive", text: row.error };
  if (row.status === "waiting" && row.gate)
    return {
      tone: "text-warning",
      text: row.gate.kind === "identity" && row.gate.candidates ? `${row.gate.title.replace("Waiting on you — ", "")} — ${row.gate.candidates[0].name} vs ${row.gate.candidates[1].name}` : row.gate.title,
      action: "Review",
      actionTone: "info",
    };
  if (row.status === "parked") return { tone: "text-muted-foreground", text: "UCPath termination write verified & staged — parked before submit", action: "Resume", actionTone: "violet" };
  if (row.status === "cancelled") return { tone: "text-muted-foreground", text: "Cancelled by you — nothing written" };
  if (row.status === "running" && row.liveText) return { tone: "text-primary/85", text: row.liveText };
  if (row.rowType === "group" && row.ocrPhase) return { tone: "text-muted-foreground", text: row.ocrPhase, action: "Open review", actionTone: "info" };
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
  const sub = sublineFor(row);
  const elapsed = row.elapsedSec !== undefined ? fmtElapsed(row.elapsedSec + state.tick) : undefined;
  const isGroup = row.rowType === "group";
  const counts = isGroup ? groupCounts(row.id) : null;
  const StatusIcon = PROPOSED_STATUS[row.status].icon;

  const actions =
    row.status === "running" || row.status === "waiting" || row.status === "parked" ? (
      isGroup ? (
        <span className="flex items-center gap-1">
          <span className="mr-1 hidden text-[10px] font-sans text-muted-foreground min-[400px]:inline">Cancel remaining</span>
          <IconActionButton tone="muted" icon={<X aria-hidden className="size-3.5" />} label="Cancel remaining" onClick={NOOP} />
        </span>
      ) : (
        <IconActionButton tone="muted" icon={<X aria-hidden className="size-3.5" />} label="Cancel" onClick={NOOP} />
      )
    ) : row.status === "queued" ? (
      <>
        <IconActionButton tone="primary" icon={<ChevronsUp aria-hidden className="size-3.5" />} label="Bump" onClick={NOOP} />
        <IconActionButton tone="muted" icon={<X aria-hidden className="size-3.5" />} label="Cancel" onClick={NOOP} />
      </>
    ) : row.displayOnly ? (
      <IconActionButton tone="destructive" icon={<Trash2 aria-hidden className="size-3.5" />} label="Delete" onClick={NOOP} />
    ) : (
      <>
        <IconActionButton tone="primary" icon={<RotateCcw aria-hidden className="size-3.5" />} label="Retry" onClick={NOOP} />
        <IconActionButton tone="destructive" icon={<Trash2 aria-hidden className="size-3.5" />} label="Delete" onClick={NOOP} />
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
        "aria-label": `${row.title} — ${PROPOSED_STATUS[row.status].label.toLowerCase()}`,
        "data-demo-row-id": row.id,
        onKeyDown: (e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            handlers.onSelect(row.id);
          }
        },
        className: cn(row.status === "running" && "border-primary/30"),
      }}
      footer={{
        time: row.time,
        runNumber: row.run,
        secondaryId: row.trace,
        suppressIdWhenEquals: row.title,
        elapsed: elapsed ?? row.queueNote ?? null,
        duration: row.duration ?? null,
        actions,
      }}
    >
      <div className="px-3.5 py-2.5">
        <div className="flex min-w-0 items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            <StatusIcon aria-hidden className={cn("h-3.5 w-3.5 shrink-0", PROPOSED_STATUS[row.status].iconClass)} />
            <span className={cn("truncate text-[14px] font-semibold text-foreground", row.displayOnly && "italic font-normal text-muted-foreground")}>
              {row.title}
            </span>
            {/* which workflow owns this row — needed the moment the queue shows
                more than one workflow, and the only thing that tells a packet
                apart from the OCR review row that shares its filename */}
            <span className="shrink-0 rounded border border-border bg-secondary/50 px-1.5 py-px text-[9.5px] uppercase tracking-wider text-muted-foreground">
              {row.wfLabel}
            </span>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">{headerChips(row, state.checkedIds)}</div>
        </div>

        {sub && (
          <div className={cn("mt-1.5 ml-5 flex min-w-0 items-center gap-2 text-[11px] font-mono", sub.tone)}>
            <span className="min-w-0 truncate">{sub.text}</span>
            {sub.action && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  if (isGroup) handlers.onDrillIn(row.id);
                  else handlers.onSelect(row.id);
                }}
                className={cn(
                  "ml-auto shrink-0 rounded-md border px-2 py-px text-[10.5px] font-sans font-semibold outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  sub.actionTone === "violet"
                    ? "border-log-violet/40 bg-log-violet/8 text-log-violet"
                    : "border-info/40 bg-info/8 text-info",
                )}
              >
                {sub.action}
              </button>
            )}
          </div>
        )}

        {/* Linked delegation. A `linked` child keeps its own row in its own
            panel (D4) and the two point at each other — one chip each, never a
            duplicated run. `member` children live in the body instead. */}
        {(row.reviewRunId || row.reviewOf) && (
          <div className="mt-1.5 ml-5">
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                handlers.onSelect((row.reviewRunId ?? row.reviewOf) as string);
              }}
              className="inline-flex max-w-full items-center gap-1.5 rounded-md border border-info/35 bg-info/8 px-2 py-0.5 text-[10.5px] text-info outline-none hover:bg-info/15 focus-visible:ring-2 focus-visible:ring-ring"
            >
              {row.reviewOf ? (
                <>
                  <CornerDownRight aria-hidden className="size-3 shrink-0" />
                  <span className="truncate">Delegated by {DEMO_ROWS[row.reviewOf]?.title}</span>
                </>
              ) : (
                <>
                  <ClipboardList aria-hidden className="size-3 shrink-0" />
                  <span className="truncate">
                    OCR review · {PROPOSED_STATUS[DEMO_ROWS[row.reviewRunId as string]?.status ?? "queued"].label.toLowerCase()}
                  </span>
                  <ArrowUpRight aria-hidden className="size-3 shrink-0" />
                </>
              )}
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

        {isGroup && counts && (
          <>
            <div className="mt-1.5 ml-5 flex items-center gap-2.5 text-[11px]">
              <StatusCounts counts={{ done: counts.done + counts.warnings, running: counts.running, queued: counts.queued, failed: counts.failed }} />
              {counts.waiting > 0 && (
                <span className="inline-flex items-center gap-1 text-warning" aria-label={`${counts.waiting} waiting on you`}>
                  <Eye aria-hidden className="size-3" />
                  {counts.waiting}
                </span>
              )}
              {counts.rejected > 0 && (
                <span className="inline-flex items-center gap-1 text-muted-foreground" aria-label={`${counts.rejected} rejected`}>
                  <SearchX aria-hidden className="size-3" />
                  {counts.rejected}
                </span>
              )}
              <span className="ml-auto inline-flex items-center gap-1 text-success" aria-label="checked progress">
                <CheckCircle2 aria-hidden className="size-3" />
                {[...(row.memberIds ?? [])].filter((id) => state.checkedIds.has(id)).length}/{row.memberIds?.length} checked
              </span>
            </div>
            {/* Density ladder (ratified): 20+ members collapse to the status
                matrix; anything smaller stays a readable member list. Member
                count is a continuous property — never a fourth row type. */}
            {(row.memberIds?.length ?? 0) > 20 ? (
              <GroupMatrix row={row} state={state} handlers={handlers} />
            ) : (
              <GroupMemberList row={row} state={state} handlers={handlers} />
            )}
          </>
        )}
      </div>
    </QueueRowCard>
  );
}

// ---------------------------------------------------------------------------
// Group internals — matrix (50) + compact list (12)
// ---------------------------------------------------------------------------

function GroupMatrix({ row, state, handlers }: { row: DemoRow; state: DemoQueueState; handlers: DemoQueueHandlers }) {
  const attention = useMemo(
    () => (row.memberIds ?? []).filter((id) => !DEMO_ROWS[id].displayOnly && ATTENTION_STATUSES.includes(DEMO_ROWS[id].status)),
    [row.memberIds],
  );
  return (
    <>
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
                m.displayOnly ? "bg-muted-foreground/40" : MATRIX_CELL[m.status],
                cellSelected && "ring-2 ring-primary",
                state.checkedIds.has(id) && "ring-1 ring-success/70",
              )}
            />
          );
        })}
      </div>
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
    </>
  );
}

/** "2 failed · 1 waiting · 1 warning" — derived, never a hardcoded caption. */
function attentionBreakdown(groupId: string): string {
  const c = groupCounts(groupId);
  const parts: string[] = [];
  if (c.failed) parts.push(`${c.failed} failed`);
  if (c.waiting) parts.push(`${c.waiting} waiting on you`);
  if (c.warnings) parts.push(`${c.warnings} with warnings`);
  if (c.rejected) parts.push(`${c.rejected} rejected`);
  return parts.join(" · ") || "all clear";
}

function GroupMemberList({ row, state, handlers }: { row: DemoRow; state: DemoQueueState; handlers: DemoQueueHandlers }) {
  const ids = orderedMemberIds(row.id);
  const expanded = state.expandedGroups.has(row.id);
  const visible = expanded ? ids : ids.slice(0, 4);
  const noun = row.wfLabel === "Oath Signature" ? "signers" : "people";
  return (
    <div className="mt-1.5 ml-5">
      <div className="divide-y divide-border/40 overflow-hidden rounded-md border border-border/60">
        {visible.map((id) => {
          const m = DEMO_ROWS[id];
          const spec = MEMBER_STATUS_ICON[m.status];
          const Icon = spec.icon;
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
              <Icon aria-hidden className={cn("size-3 shrink-0", spec.cls)} />
              <span className="min-w-0 flex-1 truncate text-foreground">{m.title}</span>
              <span className={cn("shrink-0 truncate font-mono text-[10px]", m.status === "failed" ? "text-destructive" : "text-muted-foreground")}>
                {m.memberFact}
              </span>
              <span className="w-16 shrink-0 text-right font-mono text-[10px] text-muted-foreground tabular-nums">{m.eid}</span>
            </button>
          );
        })}
      </div>
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
  const attentionN = counts.failed + counts.waiting + counts.warnings;
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
          const spec = MEMBER_STATUS_ICON[m.status];
          const Icon = m.displayOnly ? SearchX : spec.icon;
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
              <Icon aria-hidden className={cn("size-3.5", m.displayOnly ? "text-muted-foreground" : spec.cls)} />
              <span className="flex min-w-0 items-center gap-1.5">
                <span className={cn("truncate font-medium text-foreground", m.displayOnly && "italic font-normal text-muted-foreground")}>
                  {m.title}
                </span>
                {state.checkedIds.has(id) && <CheckCircle2 aria-hidden className="size-3 shrink-0 text-success" />}
              </span>
              <span className="font-mono text-[10.5px] text-muted-foreground tabular-nums">{m.eid ?? "—"}</span>
              <span
                className={cn(
                  "truncate font-mono text-[10.5px]",
                  m.status === "failed" && !m.displayOnly && "text-destructive",
                  (m.status === "waiting" || m.status === "doneWarnings") && "text-warning",
                  (m.status === "verifiedDone" || m.status === "running" || m.displayOnly) && "text-muted-foreground",
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


export function DemoQueue({ state, handlers }: { state: DemoQueueState; handlers: DemoQueueHandlers }) {
  const topLevel = BAND_ORDER.flatMap((b) => b.ids).map((id) => DEMO_ROWS[id]);
  const countFor = (f: DemoFilter) => topLevel.filter((r) => rowMatchesFilter(r, f)).length;
  const finished = BAND_ORDER.find((b) => b.key === "finished")?.ids.map((id) => DEMO_ROWS[id]) ?? [];
  const digest = {
    done: finished.filter((r) => r.status === "verifiedDone").length,
    warned: finished.filter((r) => r.status === "doneWarnings").length,
    failed: finished.filter((r) => r.status === "failed").length,
    cancelled: finished.filter((r) => r.status === "cancelled").length,
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
        <span className="text-[13px] font-semibold text-foreground">Queue</span>· Jul 24
        <span className="ml-auto font-mono text-[10px]">{countFor("all")} runs</span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto pb-3">
        {BAND_ORDER.map((band) => {
          const ids = band.ids.filter((id) => rowMatchesFilter(DEMO_ROWS[id], state.filter));
          if (ids.length === 0) return null;
          return (
            <div key={band.key}>
              <div
                className={cn(
                  "mx-3 mt-3 flex items-center gap-2 text-[10px] font-semibold uppercase tracking-widest",
                  band.key === "attention" ? "text-warning" : "text-muted-foreground",
                )}
              >
                {band.label}
                <span className={cn("rounded-full border px-1.5 font-mono text-[10px] tabular-nums", band.key === "attention" ? "border-warning/50" : "border-border")}>
                  {ids.length}
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
              {ids.map((id) => (
                <DemoRowCard key={id} row={DEMO_ROWS[id]} state={state} handlers={handlers} />
              ))}
            </div>
          );
        })}
      </div>
    </section>
  );
}
