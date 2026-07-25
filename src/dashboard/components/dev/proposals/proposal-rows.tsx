import { useState, type ComponentType, type ReactNode, type SVGProps } from "react";
import {
  AlertTriangle,
  ArrowUpRight,
  Ban,
  Camera,
  CheckCircle2,
  ChevronsUp,
  ChevronDown,
  Clock,
  Loader2,
  MoveRight,
  PauseCircle,
  RotateCcw,
  SearchX,
  ShieldCheck,
  Trash2,
  UserRoundSearch,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { QueueRowCard } from "@/components/queue-panel/QueueRowCard";
import { StatusCounts } from "@/components/queue-panel/StatusCounts";
import { IconActionButton } from "@/components/shared/IconActionButton";
import { useProposals } from "./proposal-toggles";

/**
 * DEV-ONLY prototype row pieces for the UI gallery "Proposals" tab.
 *
 * These render the PROPOSED queue-row enrichments in the exact slots the real
 * `EntryItem` uses (same card chrome via the real `QueueRowCard` + `RowFooter`,
 * same header/subline geometry), so the operator judges content changes — not a
 * restyle. Status labels use the ratified rebuild 8-status vocabulary
 * (docs/rebuild reviews/second-look D1–D5). None of this is imported by
 * production surfaces.
 */

const NOOP = () => {};

// ---------------------------------------------------------------------------
// Ratified 8-status badge recipes — same tint pattern as EntryItem's
// STATUS_CONFIG (bg-<tone>/12 + text-<tone> + border-<tone>/30).
// ---------------------------------------------------------------------------

export type ProposedStatus =
  | "queued"
  | "running"
  | "waiting"
  | "parked"
  | "verifiedDone"
  | "doneWarnings"
  | "failed"
  | "cancelled";

interface ProposedStatusSpec {
  label: string;
  badge: string;
  icon: ComponentType<SVGProps<SVGSVGElement>>;
  iconClass: string;
}

export const PROPOSED_STATUS: Record<ProposedStatus, ProposedStatusSpec> = {
  queued: {
    label: "Queued",
    badge: "bg-warning/12 text-warning border border-warning/30",
    icon: Clock,
    iconClass: "text-warning",
  },
  running: {
    label: "Running",
    badge: "bg-primary/15 text-primary border border-primary/30",
    icon: Loader2,
    iconClass: "text-primary animate-spin motion-reduce:animate-none",
  },
  waiting: {
    label: "Waiting on you",
    badge: "bg-warning/12 text-warning border border-warning/40",
    icon: UserRoundSearch,
    iconClass: "text-warning",
  },
  parked: {
    label: "Write parked",
    badge: "bg-log-violet/12 text-log-violet border border-log-violet/35",
    icon: PauseCircle,
    iconClass: "text-log-violet",
  },
  verifiedDone: {
    label: "Verified done",
    badge: "bg-success/12 text-success border border-success/30",
    icon: CheckCircle2,
    iconClass: "text-success",
  },
  doneWarnings: {
    label: "Done with warnings",
    badge: "bg-warning/12 text-warning border border-warning/40",
    icon: CheckCircle2,
    iconClass: "text-warning",
  },
  failed: {
    label: "Failed",
    badge: "bg-destructive/12 text-destructive border border-destructive/30",
    icon: AlertTriangle,
    iconClass: "text-destructive",
  },
  cancelled: {
    label: "Cancelled",
    badge: "bg-warning/12 text-warning border border-warning/40",
    icon: Ban,
    iconClass: "text-warning",
  },
};

export function StatusBadge({ status, label }: { status: ProposedStatus; label?: string }) {
  const spec = PROPOSED_STATUS[status];
  return (
    <span
      className={cn("text-[10px] font-medium px-2 py-0.5 rounded-md font-sans tracking-wide", spec.badge)}
    >
      {label ?? spec.label}
    </span>
  );
}

// ---------------------------------------------------------------------------
// P1 — outcome fact chips
// ---------------------------------------------------------------------------

export function FactChip({
  label,
  value,
  arrowTo,
  warn,
}: {
  label?: string;
  value: string;
  /** Renders `value → arrowTo` for before/after facts (kronos pay rule). */
  arrowTo?: string;
  warn?: boolean;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-[5px] border px-1.5 py-px text-[10.5px]",
        warn
          ? "border-warning/40 bg-warning/8 text-warning"
          : "border-border bg-secondary/50 text-secondary-foreground",
      )}
    >
      {label && <span className="text-muted-foreground">{label}</span>}
      <span className={cn("font-mono", !warn && "text-foreground")}>{value}</span>
      {arrowTo && (
        <>
          <MoveRight aria-hidden className="size-3 text-muted-foreground" />
          <span className="font-mono text-foreground">{arrowTo}</span>
        </>
      )}
    </span>
  );
}

export function FactRow({ children }: { children: ReactNode }) {
  return <div className="mt-1.5 ml-5 flex min-w-0 flex-wrap items-center gap-1">{children}</div>;
}

// ---------------------------------------------------------------------------
// P2 — micro step-pipeline
// ---------------------------------------------------------------------------

export type MicroSeg = "done" | "current" | "pending" | "failed" | "warn";

const SEG_CLASS: Record<MicroSeg, string> = {
  done: "bg-success",
  current: "bg-primary animate-pulse motion-reduce:animate-none",
  pending: "bg-border",
  failed: "bg-destructive",
  warn: "bg-warning",
};

export function MicroPipeline({ segments, title }: { segments: MicroSeg[]; title: string }) {
  return (
    <span className="inline-flex shrink-0 items-center gap-[3px]" title={title} aria-label={title}>
      {segments.map((seg, i) => (
        <span key={i} aria-hidden className={cn("h-1 w-2.5 rounded-full", SEG_CLASS[seg])} />
      ))}
    </span>
  );
}

// ---------------------------------------------------------------------------
// P3 / P5 / P6 / P7 — small header chips
// ---------------------------------------------------------------------------

export function WarnCountChip({ count }: { count: number }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-md border border-warning/40 bg-warning/12 px-1.5 py-0.5 text-[10px] font-semibold text-warning">
      <AlertTriangle aria-hidden className="size-3" />
      {count}
    </span>
  );
}

export function AttemptChip({ n, title }: { n: number; title: string }) {
  return (
    <span
      title={title}
      className="inline-flex items-center gap-1 rounded-md border border-warning/40 bg-warning/12 px-1.5 py-0.5 text-[10px] font-semibold text-warning"
    >
      <RotateCcw aria-hidden className="size-3" />
      attempt {n}
    </span>
  );
}

export function ReceiptShield({ title }: { title: string }) {
  return (
    <span title={title} className="inline-flex items-center text-success">
      <ShieldCheck aria-hidden className="size-3.5" />
      <span className="sr-only">{title}</span>
    </span>
  );
}

export function ScreenshotCountChip({ count }: { count: number }) {
  return (
    <span
      title={`${count} failure screenshots — opens the Screenshots tab`}
      className="inline-flex items-center gap-1 rounded-md border border-border bg-secondary/60 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground"
    >
      <Camera aria-hidden className="size-3" />
      {count}
    </span>
  );
}

export function WaitChip({ text }: { text: string }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-md bg-warning/10 px-1.5 py-0.5 text-[10px] font-medium text-warning">
      <Clock aria-hidden className="size-3" />
      {text}
    </span>
  );
}

// ---------------------------------------------------------------------------
// P4 / V2 — subline with an inline jump action
// ---------------------------------------------------------------------------

export function SubLine({
  tone = "muted",
  children,
  action,
  actionTone = "info",
}: {
  tone?: "muted" | "warning" | "destructive" | "primary";
  children: ReactNode;
  action?: string;
  actionTone?: "info" | "violet";
}) {
  return (
    <div
      className={cn(
        "mt-1.5 ml-5 flex min-w-0 items-center gap-2 text-[11px] font-mono",
        tone === "muted" && "text-muted-foreground",
        tone === "warning" && "text-warning",
        tone === "destructive" && "text-destructive",
        tone === "primary" && "text-primary/85",
      )}
    >
      <span className="min-w-0 truncate">{children}</span>
      {action && (
        <button
          type="button"
          onClick={NOOP}
          className={cn(
            "ml-auto shrink-0 rounded-md border px-2 py-px text-[10.5px] font-sans font-semibold outline-none focus-visible:ring-2 focus-visible:ring-ring",
            actionTone === "info" && "border-info/40 bg-info/8 text-info",
            actionTone === "violet" && "border-log-violet/40 bg-log-violet/8 text-log-violet",
          )}
        >
          {action}
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// V3 / V4 — bands + digest
// ---------------------------------------------------------------------------

export function Band({ label, count, attention }: { label: string; count: number; attention?: boolean }) {
  return (
    <div
      className={cn(
        "mx-3 mt-3 flex items-center gap-2 text-[10px] font-semibold uppercase tracking-widest first:mt-1",
        attention ? "text-warning" : "text-muted-foreground",
      )}
    >
      {label}
      <span
        className={cn(
          "rounded-full border px-1.5 font-mono text-[10px] tabular-nums",
          attention ? "border-warning/50" : "border-border",
        )}
      >
        {count}
      </span>
      <span aria-hidden className="h-px flex-1 bg-border/60" />
    </div>
  );
}

export function DigestStrip() {
  return (
    <div className="mx-3 mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-dashed border-border px-3 py-1.5 text-[11px] text-muted-foreground">
      <span className="font-semibold text-secondary-foreground">Today:</span>
      <span>
        <span className="font-semibold text-success">3</span> done
      </span>
      <span className="text-warning">
        <span className="font-semibold">1</span> with warnings
      </span>
      <span className="text-destructive">
        <span className="font-semibold">1</span> failed
      </span>
      <span className="ml-auto font-mono text-[10.5px]">2 transactions · 1 ticket filed</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Group-row internals — member lines + rollup
// ---------------------------------------------------------------------------

export function MemberLine({
  status,
  name,
  eid,
  facts,
}: {
  status: "done" | "running" | "queued";
  name: string;
  eid: string;
  facts?: ReactNode;
}) {
  const Icon = status === "done" ? CheckCircle2 : status === "running" ? Loader2 : Clock;
  return (
    <div className="flex items-center gap-2 bg-card px-2.5 py-1.5 text-[12px]">
      <Icon
        aria-hidden
        className={cn(
          "size-3 shrink-0",
          status === "done" && "text-success",
          status === "running" && "text-primary animate-spin motion-reduce:animate-none",
          status === "queued" && "text-warning",
        )}
      />
      <span className="min-w-0 flex-1 truncate text-foreground">{name}</span>
      {facts}
      <span className="shrink-0 font-mono text-[10px] text-muted-foreground tabular-nums">{eid}</span>
    </div>
  );
}

/** V1 — a ratified D3 rejected member: not a person, delete-only, muted. */
export function RejectedMemberLine({ reason }: { reason: string }) {
  return (
    <div className="flex items-center gap-2 bg-card/60 px-2.5 py-1.5 text-[12px] text-muted-foreground">
      <SearchX aria-hidden className="size-3 shrink-0" />
      <span className="min-w-0 flex-1 truncate italic">{reason}</span>
      <span className="shrink-0 rounded border border-border px-1.5 text-[9.5px] font-semibold uppercase tracking-wide">
        rejected
      </span>
      <IconActionButton
        tone="destructive"
        icon={<Trash2 aria-hidden className="size-3" />}
        label="Delete rejected page"
        onClick={NOOP}
      />
    </div>
  );
}

export function RollupStrip({ rejected }: { rejected?: number }) {
  const segments: { flex: number; cls: string }[] = [
    { flex: 3, cls: "bg-success/80" },
    { flex: 1, cls: "bg-primary/80" },
    { flex: 3, cls: "bg-border" },
    ...(rejected ? [{ flex: rejected, cls: "bg-muted-foreground/40" }] : []),
  ];
  return (
    <div className="mt-1.5 ml-5 flex items-center gap-2.5 text-[11px]">
      <span className="flex items-center gap-2.5">
        <StatusCounts counts={{ done: 3, running: 1, queued: 3, failed: 0 }} />
        {rejected ? (
          <span className="inline-flex items-center gap-1 text-muted-foreground" aria-label={`${rejected} rejected`}>
            <SearchX aria-hidden className="size-3" />
            {rejected}
          </span>
        ) : null}
      </span>
      <span aria-hidden className="flex h-1.5 flex-1 overflow-hidden rounded-full bg-secondary">
        {segments.map((s, i) => (
          <span key={i} className={s.cls} style={{ flexGrow: s.flex }} />
        ))}
      </span>
      <ChevronDown aria-hidden className="size-3.5 text-muted-foreground" />
    </div>
  );
}

// ---------------------------------------------------------------------------
// The prototype row shell — real QueueRowCard + RowFooter, mock action cluster.
// ---------------------------------------------------------------------------

export function mockRowActions(kinds: ("bump" | "retry" | "cancel" | "delete")[]): ReactNode {
  return (
    <>
      {kinds.includes("bump") && (
        <IconActionButton tone="primary" icon={<ChevronsUp aria-hidden className="size-3.5" />} label="Bump" onClick={NOOP} />
      )}
      {kinds.includes("retry") && (
        <IconActionButton tone="primary" icon={<RotateCcw aria-hidden className="size-3.5" />} label="Retry" onClick={NOOP} />
      )}
      {kinds.includes("cancel") && (
        <IconActionButton tone="warning" icon={<X aria-hidden className="size-3.5" />} label="Cancel" onClick={NOOP} className="border-0 bg-transparent text-muted-foreground hover:bg-warning/15 hover:text-warning" />
      )}
      {kinds.includes("delete") && (
        <IconActionButton tone="destructive" icon={<Trash2 aria-hidden className="size-3.5" />} label="Delete" onClick={NOOP} />
      )}
    </>
  );
}

export interface ProposedRowProps {
  id: string;
  status: ProposedStatus;
  statusLabel?: string;
  title: string;
  headerChips?: ReactNode;
  children?: ReactNode;
  footer: {
    time: string;
    runNumber: number;
    secondaryId: string;
    elapsed?: string;
    duration?: string;
    actions: ReactNode;
  };
  selected?: boolean;
  onSelect?: (id: string) => void;
}

export function ProposedRow({
  id,
  status,
  statusLabel,
  title,
  headerChips,
  children,
  footer,
  selected = false,
  onSelect,
}: ProposedRowProps) {
  const spec = PROPOSED_STATUS[status];
  const Icon = spec.icon;
  return (
    <QueueRowCard
      selected={selected}
      rootProps={{
        onClick: () => onSelect?.(id),
        role: "button",
        tabIndex: 0,
        "aria-pressed": selected,
        "aria-label": `${title} — ${(statusLabel ?? spec.label).toLowerCase()}`,
        onKeyDown: (e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onSelect?.(id);
          }
        },
        className: cn(status === "running" && "border-primary/30"),
      }}
      footer={{
        time: footer.time,
        runNumber: footer.runNumber,
        secondaryId: footer.secondaryId,
        suppressIdWhenEquals: title,
        elapsed: footer.elapsed ?? null,
        duration: footer.duration ?? null,
        actions: footer.actions,
      }}
    >
      <div className="px-3.5 py-2.5">
        <div className="flex min-w-0 items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            <Icon aria-hidden className={cn("h-3.5 w-3.5 shrink-0", spec.iconClass)} />
            <span className="truncate text-[14px] font-semibold text-foreground">{title}</span>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            {headerChips}
            <StatusBadge status={status} label={statusLabel} />
          </div>
        </div>
        {children}
      </div>
    </QueueRowCard>
  );
}

// ---------------------------------------------------------------------------
// The assembled proposed queue — one column, every proposal in place.
// ---------------------------------------------------------------------------

export function ProposedQueue() {
  const { on } = useProposals();
  const [selected, setSelected] = useState("sep-waiting");
  const select = (id: string) => setSelected(id);
  const rowProps = (id: string) => ({ id, selected: selected === id, onSelect: select });

  return (
    <div className="pb-2">
      {on("v3") && <Band label="Needs you" count={2} attention />}

      {/* Separations — Waiting on you (identity gate) */}
      <ProposedRow
        {...rowProps("sep-waiting")}
        status="waiting"
        title="Maria Lopez-Garcia"
        headerChips={on("p7") ? <WaitChip text="waiting 18m" /> : undefined}
        footer={{
          time: "2:02 PM",
          runNumber: 4,
          secondaryId: "se-140211-9f3a",
          duration: on("p7") ? undefined : "21m 4s",
          actions: mockRowActions(["cancel"]),
        }}
      >
        {on("p4") ? (
          <SubLine tone="warning" action="Review">
            Identity differs — input Maria Lopez vs UCPath match M. Lopez-Garcia · 10583942
          </SubLine>
        ) : (
          <SubLine>Awaiting approval</SubLine>
        )}
      </ProposedRow>

      {/* Separations — Write parked (V2) */}
      <ProposedRow
        {...rowProps("sep-parked")}
        status="parked"
        title="Rosa Delgado"
        headerChips={on("p7") ? <WaitChip text="parked 32m" /> : undefined}
        footer={{
          time: "1:48 PM",
          runNumber: 3,
          secondaryId: "se-134802-c2d7",
          actions: mockRowActions(["cancel"]),
        }}
      >
        {on("v2") && (
          <SubLine tone="muted" action="Resume" actionTone="violet">
            UCPath termination write verified &amp; staged — parked before submit
          </SubLine>
        )}
      </ProposedRow>

      {on("v3") && <Band label="Active" count={2} />}

      {/* Person lookup — Running (micro pipeline) */}
      <ProposedRow
        {...rowProps("pl-running")}
        status="running"
        title="Daniel Okafor"
        headerChips={
          on("p2") ? (
            <MicroPipeline
              segments={["done", "current", "pending", "pending"]}
              title="Searching ✓ 6s · Cross-verification (running, 8s) · Active status · CRM dates"
            />
          ) : undefined
        }
        footer={{
          time: "2:19 PM",
          runNumber: 12,
          secondaryId: "pl-141904-72e1",
          elapsed: "14s",
          actions: mockRowActions(["cancel"]),
        }}
      >
        <SubLine tone="primary">Cross-verification — matching CRM record by start date</SubLine>
      </ProposedRow>

      {/* I-9 check — group coordinator with OCR phase, rollup, members */}
      <ProposedRow
        {...rowProps("i9-group")}
        status="running"
        title="I9_Retention_Batch_Jul24.pdf"
        footer={{
          time: "2:11 PM",
          runNumber: 7,
          secondaryId: "ic-141108-b0a4",
          elapsed: "9m 12s",
          actions: (
            <span className="flex items-center gap-1">
              <span className="mr-1 hidden text-[10px] font-sans text-muted-foreground min-[400px]:inline">
                Cancel remaining
              </span>
              {mockRowActions(["cancel"])}
            </span>
          ),
        }}
      >
        {on("p8") ? (
          <SubLine tone="muted" action="Open review">
            OCR — matching people <span className="text-foreground">6/8</span> · roster EID re-match
          </SubLine>
        ) : (
          <SubLine tone="muted" action="Open review">
            OCR review
          </SubLine>
        )}
        <RollupStrip rejected={on("v1") ? 1 : undefined} />
        <div className="mt-1.5 ml-5 divide-y divide-border/40 overflow-hidden rounded-md border border-border/60">
          <MemberLine
            status="done"
            name="Kevin Tran"
            eid="10442810"
            facts={
              on("p1") ? (
                <span className="flex shrink-0 items-center gap-1">
                  <FactChip label="S1" value="p9" />
                  <FactChip label="S2" value="p1" />
                  <FactChip label="retain" value="3y" />
                </span>
              ) : undefined
            }
          />
          <MemberLine status="running" name="Alicia Mendez" eid="10518226" />
          {on("v1") && <RejectedMemberLine reason="Page 12 — no searchable name on form" />}
        </div>
      </ProposedRow>

      {on("v3") && <Band label="Queued" count={1} />}

      {/* Work-study — Queued (queue-wait) */}
      <ProposedRow
        {...rowProps("ws-queued")}
        status="queued"
        title="Priya Natarajan"
        footer={{
          time: "2:24 PM",
          runNumber: 5,
          secondaryId: "ws-142401-e8c3",
          elapsed: on("p7") ? "in queue 3m · 2 ahead" : undefined,
          actions: mockRowActions(["bump", "cancel"]),
        }}
      />

      {on("v3") && <Band label="Finished today" count={5} />}
      {on("v4") && <DigestStrip />}

      {/* Onboarding — Verified done (facts + receipt) */}
      <ProposedRow
        {...rowProps("onb-done")}
        status="verifiedDone"
        statusLabel={on("p6") ? undefined : "Done"}
        title="Jordan Whitfield"
        headerChips={
          on("p6") ? <ReceiptShield title="Receipt — UCPath read-back verified · TXN-0891245" /> : undefined
        }
        footer={{
          time: "11:42 AM",
          runNumber: 2,
          secondaryId: "on-114203-4f9b",
          duration: "6m 41s",
          actions: mockRowActions(["retry", "delete"]),
        }}
      >
        {on("p1") && (
          <FactRow>
            <FactChip label="wage" value="$18.50/hr" />
            <FactChip label="effective" value="07/01" />
            <FactChip label="dept" value="000482" />
            <FactChip label="txn" value="TXN-0891245" />
          </FactRow>
        )}
      </ProposedRow>

      {/* Kronos pay rule — Verified done (before → after) */}
      <ProposedRow
        {...rowProps("kp-done")}
        status="verifiedDone"
        statusLabel={on("p6") ? undefined : "Done"}
        title="Marcus Bell"
        footer={{
          time: "10:15 AM",
          runNumber: 6,
          secondaryId: "kp-101502-d6a0",
          duration: "1m 12s",
          actions: mockRowActions(["retry", "delete"]),
        }}
      >
        {on("p1") && (
          <FactRow>
            <FactChip label="pay rule" value="SDCMP" arrowTo="SDCMP-WS" />
            <FactChip label="union" value="CX" />
          </FactRow>
        )}
      </ProposedRow>

      {/* OnBase — Done with warnings */}
      <ProposedRow
        {...rowProps("ob-warn")}
        status={on("p3") ? "doneWarnings" : "verifiedDone"}
        statusLabel={on("p3") ? undefined : "Done"}
        title="Elena Vasquez"
        headerChips={on("p3") ? <WarnCountChip count={1} /> : undefined}
        footer={{
          time: "9:52 AM",
          runNumber: 3,
          secondaryId: "ob-095204-77b2",
          duration: "2m 55s",
          actions: mockRowActions(["retry", "delete"]),
        }}
      >
        {on("p1") && (
          <FactRow>
            <FactChip label="doc" value="I-9 Supporting" />
            <FactChip label="page" value="4" />
            {on("p3") && <FactChip warn value="keyset autofill fell back — verify keywords" />}
          </FactRow>
        )}
      </ProposedRow>

      {/* CRM doc download — Failed (attempt lineage + screenshots) */}
      <ProposedRow
        {...rowProps("cd-failed")}
        status="failed"
        title="Samuel Ortiz"
        headerChips={
          <>
            {on("p5") && <AttemptChip n={2} title="Attempt 1 failed 12:58 PM (timeout) · this is the retry" />}
            {on("p6") && <ScreenshotCountChip count={3} />}
          </>
        }
        footer={{
          time: "1:12 PM",
          runNumber: 9,
          secondaryId: "cd-131202-5e19",
          duration: "48s",
          actions: mockRowActions(["retry", "delete"]),
        }}
      >
        <SubLine tone="destructive">
          CRM search returned no record for samuel.ortiz@ucsd.edu — download step never reached
        </SubLine>
        {on("p5") && (
          <div className="mt-1 ml-5 flex items-center gap-1.5 text-[10.5px] font-mono text-muted-foreground">
            <ArrowUpRight aria-hidden className="size-3" />
            <span>prior attempt: failed 12:58 PM — timeout</span>
          </div>
        )}
      </ProposedRow>
    </div>
  );
}
