import { useState, type ReactNode } from "react";
import {
  ArrowDown,
  ArrowDownToLine,
  ArrowRight,
  ArrowUpFromLine,
  Camera,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  ClipboardList,
  Database,
  Pause,
  Receipt,
  ScrollText,
  Search,
  ShieldCheck,
  TriangleAlert,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { StatusBadge } from "./proposal-rows";
import { useProposals } from "./proposal-toggles";

/**
 * DEV-ONLY prototype of the enriched Log Panel for the UI gallery "Proposals"
 * tab: the persistent step strip with hover detail (L3 — the ratified
 * hover-per-step made concrete), step-grouped stream (L2), structured chips
 * from fields the SSE wire already carries (L1), inline data-provenance pills
 * (L4), and in-stream gate/failure cards (L5). Content mirrors a real
 * separations run paused on the identity-approval gate.
 */

const NOOP = () => {};

type StepState = "done" | "current" | "pending";

function StepChip({
  state,
  label,
  duration,
  hover,
}: {
  state: StepState;
  label: string;
  duration?: string;
  hover?: ReactNode;
}) {
  const { on } = useProposals();
  return (
    <span className="group relative">
      <button
        type="button"
        onClick={NOOP}
        className={cn(
          "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px] outline-none focus-visible:ring-2 focus-visible:ring-ring",
          state === "done" && "border-success/35 bg-card text-success",
          state === "current" && "border-warning/45 bg-warning/8 text-warning",
          state === "pending" && "border-border bg-card text-muted-foreground",
        )}
      >
        {state === "done" && <Check aria-hidden className="size-3" />}
        {state === "current" && <Pause aria-hidden className="size-3" />}
        {label}
        {duration && <span className="font-mono text-[10px] text-muted-foreground">{duration}</span>}
      </button>
      {on("l3") && hover && (
        <span className="absolute left-0 top-full z-50 mt-1.5 hidden w-64 rounded-lg border border-border bg-popover p-2.5 text-left shadow-lg group-hover:block group-focus-within:block">
          {hover}
        </span>
      )}
    </span>
  );
}

function HoverKv({ k, v, tone }: { k: string; v: string; tone?: "warning" }) {
  return (
    <span className="flex items-center justify-between py-px text-[10.5px]">
      <span className="text-muted-foreground">{k}</span>
      <span className={cn("font-mono", tone === "warning" ? "text-warning" : "text-secondary-foreground")}>{v}</span>
    </span>
  );
}

function HoverCard({ title, rows, keyLines, screenshot }: { title: string; rows: ReactNode; keyLines?: string[]; screenshot?: boolean }) {
  return (
    <span className="flex flex-col">
      <span className="mb-1 text-[11.5px] font-semibold text-foreground">{title}</span>
      {rows}
      {keyLines && (
        <span className="mt-1.5 flex flex-col border-t border-border/60 pt-1.5 font-mono text-[10px] leading-relaxed text-secondary-foreground">
          {keyLines.map((line) => (
            <span key={line}>{line}</span>
          ))}
        </span>
      )}
      {screenshot && <span className="mt-1 text-[10.5px] text-info">Step screenshot →</span>}
    </span>
  );
}

function SystemBadge({ system }: { system: "kuali" | "ucpath" | "kronos" }) {
  const cls =
    system === "kuali"
      ? "bg-log-violet/15 text-log-violet"
      : system === "ucpath"
        ? "bg-log-cyan/15 text-log-cyan"
        : "bg-log-teal/15 text-log-teal";
  return (
    <span className={cn("mr-1.5 inline-block rounded px-1 align-[1px] text-[9px] font-bold tracking-wider", cls)}>
      {system.toUpperCase()}
    </span>
  );
}

function DurChip({ d }: { d: string }) {
  return <span className="ml-1.5 font-mono text-[10px] text-muted-foreground">{d}</span>;
}

function AttemptMark({ n }: { n: number }) {
  return (
    <span className="ml-1.5 rounded border border-warning/40 px-1 text-[9.5px] font-bold text-warning">
      attempt {n}
    </span>
  );
}

/** L7 — search-match highlight. Renders plain text when the toggle is off. */
function Hl({ children, current }: { children: ReactNode; current?: boolean }) {
  const { on } = useProposals();
  if (!on("l7")) return <>{children}</>;
  return (
    <span
      className={cn(
        "rounded-sm px-0.5 text-foreground",
        current ? "bg-info/35 shadow-[0_0_0_1px_var(--info)]" : "bg-info/18",
      )}
    >
      {children}
    </span>
  );
}

function DataPill({ dir, label, value }: { dir: "read" | "write"; label: string; value: string }) {
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

function StepDivider({ label, meta, lines }: { label: string; meta: string; lines?: string }) {
  const { on } = useProposals();
  if (!on("l2")) return null;
  return (
    <div className="sticky top-0 z-10 flex items-center gap-2 bg-card px-3 pb-1 pt-2 text-[11px] font-semibold text-secondary-foreground">
      {label}
      <span className="font-mono font-normal text-muted-foreground">{meta}</span>
      {lines && <span className="font-normal text-muted-foreground">· {lines}</span>}
      <span aria-hidden className="h-px flex-1 bg-border/60" />
    </div>
  );
}

function Line({
  ts,
  icon,
  tone,
  current,
  children,
}: {
  ts: string;
  icon: ReactNode;
  tone?: "success" | "destructive" | "warning";
  current?: boolean;
  children: ReactNode;
}) {
  return (
    <div className={cn("flex items-start gap-2 px-3 py-[3px] pl-5 text-[12px]", current && "bg-info/6")}>
      <span className="mt-0.5 shrink-0 font-mono text-[10.5px] text-muted-foreground tabular-nums">{ts}</span>
      <span className="mt-0.5 w-3.5 shrink-0 text-center">{icon}</span>
      <span
        className={cn(
          "min-w-0 break-words",
          tone === "success" && "text-success",
          tone === "destructive" && "text-destructive",
          tone === "warning" && "text-warning",
          !tone && "text-secondary-foreground",
        )}
      >
        {children}
      </span>
    </div>
  );
}

function GateCard({ inStream = true }: { inStream?: boolean }) {
  return (
    <div
      className={cn(
        "rounded-lg border border-warning/45 bg-warning/6 px-3 py-2.5 text-[12px]",
        inStream && "mx-3 my-1.5 ml-11",
      )}
    >
      <div className="mb-1.5 text-[11.5px] font-semibold text-warning">Waiting on you — identity approval</div>
      <div className="grid grid-cols-2 gap-2">
        <div className="rounded-md border border-border/60 bg-card/60 px-2.5 py-1.5">
          <div className="text-[9.5px] font-semibold uppercase tracking-wider text-muted-foreground">
            On the input record
          </div>
          <div className="text-[12px] font-semibold text-foreground">Maria Lopez</div>
          <div className="text-[10.5px] text-muted-foreground">no EID · Kuali doc 4-VMPHRW</div>
        </div>
        <div className="rounded-md border border-border/60 bg-card/60 px-2.5 py-1.5">
          <div className="text-[9.5px] font-semibold uppercase tracking-wider text-muted-foreground">
            UCPath name match (proposed)
          </div>
          <div className="text-[12px] font-semibold text-foreground">M. Lopez-Garcia</div>
          <div className="text-[10.5px] text-muted-foreground">10583942 · Dept 000371 · Blank Ast 3</div>
        </div>
      </div>
      <div className="mt-2 flex gap-1.5">
        <button
          type="button"
          onClick={NOOP}
          className="rounded-md border border-primary bg-primary px-2.5 py-0.5 text-[11px] font-semibold text-primary-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          Use 10583942
        </button>
        <button
          type="button"
          onClick={NOOP}
          className="rounded-md border border-border bg-card px-2.5 py-0.5 text-[11px] font-medium text-secondary-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          Enter EID…
        </button>
        <button
          type="button"
          onClick={NOOP}
          className="rounded-md border border-border bg-card px-2.5 py-0.5 text-[11px] font-medium text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          Dismiss
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tab surfaces — every ratified tab gets a real mock, state-appropriate for a
// run paused on the identity gate.
// ---------------------------------------------------------------------------

function DataLedgerRow({
  dir,
  field,
  value,
  system,
  ts,
  staged,
}: {
  dir: "read" | "write";
  field: string;
  value: string;
  system: "kuali" | "ucpath" | "kronos";
  ts: string;
  staged?: boolean;
}) {
  const read = dir === "read";
  const Icon = read ? ArrowDownToLine : ArrowUpFromLine;
  return (
    <div className="flex items-center gap-2.5 px-3 py-[5px] text-[12px] hover:bg-accent/30">
      <Icon aria-hidden className={cn("size-3 shrink-0", read ? "text-log-cyan" : "text-log-teal")} />
      <span className="w-36 shrink-0 truncate text-muted-foreground">{field}</span>
      <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-foreground">{value}</span>
      {staged && (
        <span className="shrink-0 rounded border border-warning/40 px-1 text-[9.5px] font-semibold text-warning">
          staged
        </span>
      )}
      <SystemBadge system={system} />
      <span className="w-14 shrink-0 text-right font-mono text-[10px] text-muted-foreground tabular-nums">{ts}</span>
    </div>
  );
}

function DataGroup({ label, meta, children }: { label: string; meta?: string; children: ReactNode }) {
  return (
    <div>
      <div className="flex items-center gap-2 px-3 pb-0.5 pt-2.5 text-[11px] font-semibold text-secondary-foreground">
        {label}
        {meta && <span className="font-normal text-muted-foreground">{meta}</span>}
        <span aria-hidden className="h-px flex-1 bg-border/60" />
      </div>
      {children}
    </div>
  );
}

function DataTab() {
  return (
    <div className="max-h-[560px] overflow-y-auto pb-3">
      <div className="flex items-center gap-3 border-b border-border/40 px-3 py-2 text-[11px] text-muted-foreground">
        <span className="inline-flex items-center gap-1 text-log-cyan">
          <ArrowDownToLine aria-hidden className="size-3" />7 reads
        </span>
        <span className="inline-flex items-center gap-1 text-log-teal">
          <ArrowUpFromLine aria-hidden className="size-3" />2 writes
          <span className="rounded border border-warning/40 px-1 text-[9.5px] font-semibold text-warning">staged</span>
        </span>
        <span className="ml-auto">3 systems · every value the run touched, in order</span>
      </div>
      <DataGroup label="Kuali extraction" meta="· doc 4-VMPHRW">
        <DataLedgerRow dir="read" field="Last day worked" value="07/15/2026" system="kuali" ts="2:02:58" />
        <DataLedgerRow dir="read" field="Separation date" value="07/16/2026" system="kuali" ts="2:02:58" />
        <DataLedgerRow dir="read" field="Termination type" value="Voluntary" system="kuali" ts="2:03:07" />
        <DataLedgerRow dir="read" field="Department" value="000371" system="kuali" ts="2:03:07" />
      </DataGroup>
      <DataGroup label="Job summary">
        <DataLedgerRow dir="read" field="Position" value="40128733" system="ucpath" ts="2:04:18" />
      </DataGroup>
      <DataGroup label="Kronos search">
        <DataLedgerRow dir="read" field="Last punch" value="07/14/2026" system="kronos" ts="2:05:39" />
        <DataLedgerRow dir="read" field="Sick dates in window" value="2" system="kronos" ts="2:05:39" />
      </DataGroup>
      <DataGroup label="UCPath transaction" meta="· parked until identity approval">
        <DataLedgerRow dir="write" field="Separation date" value="07/16/2026" system="ucpath" ts="—" staged />
        <DataLedgerRow dir="write" field="Action" value="Voluntary termination" system="ucpath" ts="—" staged />
      </DataGroup>
    </div>
  );
}

function ReviewTab() {
  return (
    <div className="flex flex-col gap-2.5 px-3 py-3">
      <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
        <ClipboardList aria-hidden className="size-3.5 text-warning" />
        <span>
          Gate opened <span className="font-mono">2:03 PM</span> · waiting{" "}
          <span className="font-mono text-warning">18m</span> · nothing written yet
        </span>
      </div>
      <GateCard inStream={false} />
      <div className="rounded-md border border-border/60 bg-secondary/20 px-3 py-2 text-[11px] leading-relaxed text-muted-foreground">
        Review is a <span className="text-secondary-foreground">status</span>, not a separate row — resolving here
        returns the run to <span className="text-secondary-foreground">Running</span> at UCPath transaction, and the
        staged writes in the Data tab go live. Dismiss ends the run with nothing written.
      </div>
    </div>
  );
}

function ReceiptLine({ label, value, verified }: { label: string; value: string; verified?: boolean }) {
  return (
    <div className="flex items-center gap-2 py-[3px] text-[12px]">
      <span className="w-36 shrink-0 text-muted-foreground">{label}</span>
      <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-foreground">{value}</span>
      {verified && (
        <span className="inline-flex shrink-0 items-center gap-1 text-[10px] font-semibold text-success">
          <Check aria-hidden className="size-3" />
          read-back
        </span>
      )}
    </div>
  );
}

function ReceiptTab() {
  return (
    <div className="flex flex-col gap-3 px-3 py-3">
      <div className="rounded-lg border border-border bg-secondary/20 px-3 py-2.5">
        <div className="flex items-center gap-2 text-[12px] font-semibold text-secondary-foreground">
          <ShieldCheck aria-hidden className="size-3.5 text-muted-foreground" />
          Receipt — pending
        </div>
        <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
          Issued once the UCPath write completes and read-back verification passes. This run has staged 2 writes and
          written nothing.
        </p>
      </div>
      <div>
        <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          What a completed receipt records — finished run example
        </div>
        <div className="rounded-lg border border-success/35 bg-success/5 px-3 py-2.5">
          <div className="flex items-center gap-2 text-[12px] font-semibold text-success">
            <ShieldCheck aria-hidden className="size-3.5" />
            Verified done · separation submitted
            <span className="ml-auto rounded border border-success/40 px-1.5 text-[9.5px] font-semibold uppercase">
              verified
            </span>
          </div>
          <div className="mt-1.5 border-t border-success/20 pt-1.5">
            <ReceiptLine label="Separation date" value="07/16/2026" verified />
            <ReceiptLine label="Action" value="Voluntary termination" verified />
            <ReceiptLine label="Transaction" value="TXN-0912844" verified />
            <ReceiptLine label="Kuali finalized" value="timekeeper + comment filed" verified />
            <ReceiptLine label="Finished" value="2:31 PM · 6m 12s active" />
            <ReceiptLine label="Run" value="se-140211-9f3a · attempt 1" />
          </div>
        </div>
      </div>
    </div>
  );
}

function ShotTile({ label, badge }: { label: string; badge: "step" | "error" }) {
  return (
    <button
      type="button"
      onClick={NOOP}
      title={`Screenshot — ${label}`}
      className={cn(
        "relative flex h-24 flex-col items-center justify-center gap-1.5 rounded-md border bg-secondary/40 outline-none focus-visible:ring-2 focus-visible:ring-ring",
        badge === "error" ? "border-destructive/45" : "border-border hover:border-info/50",
      )}
    >
      <Camera aria-hidden className="size-4 text-muted-foreground" />
      <span className="max-w-full truncate px-2 text-[10px] text-muted-foreground">{label}</span>
      <span
        className={cn(
          "absolute right-1 top-1 rounded px-1 text-[8.5px] font-bold uppercase tracking-wide",
          badge === "error" ? "bg-destructive/15 text-destructive" : "bg-info/15 text-info",
        )}
      >
        {badge}
      </span>
    </button>
  );
}

function ShotsTab() {
  return (
    <div className="px-3 py-3">
      <div className="mb-2 flex gap-1.5">
        <span className="rounded-full border border-primary/50 bg-primary/12 px-2.5 py-0.5 text-[10.5px] font-medium text-foreground">
          All 6
        </span>
        <span className="rounded-full border border-border bg-card px-2.5 py-0.5 text-[10.5px] font-medium text-muted-foreground">
          Steps 5
        </span>
        <span className="rounded-full border border-border bg-card px-2.5 py-0.5 text-[10.5px] font-medium text-muted-foreground">
          Errors 1
        </span>
      </div>
      <div className="grid grid-cols-3 gap-2">
        <ShotTile label="Kuali doc 4-VMPHRW" badge="step" />
        <ShotTile label="Identity check" badge="step" />
        <ShotTile label="Job summary" badge="step" />
        <ShotTile label="Kronos timeout" badge="error" />
        <ShotTile label="Kronos search" badge="step" />
        <ShotTile label="Paused at gate" badge="step" />
      </div>
      <p className="mt-2 text-[10.5px] text-muted-foreground">
        One capture per completed step (kernel audit trail) + one per failure — the filmstrip above Logs jumps here.
      </p>
    </div>
  );
}

function FailureCard() {
  return (
    <div className="mx-3 my-1.5 ml-11 rounded-lg border border-destructive/40 bg-destructive/6 px-3 py-2 text-[12px]">
      <div className="mb-0.5 text-[11.5px] font-semibold text-destructive">Step failed — retried automatically</div>
      <div className="text-[11px] text-muted-foreground">
        Timeout in Kronos employee search (30s). Attempt 2 started 2:05:12.{" "}
        <span className="text-info">Screenshot at failure →</span>
      </div>
    </div>
  );
}

type PanelTab = "logs" | "data" | "review" | "receipt" | "shots";

const PANEL_TABS: { key: PanelTab; label: string; icon: typeof ScrollText; dot?: boolean }[] = [
  { key: "logs", label: "Logs", icon: ScrollText },
  { key: "data", label: "Data", icon: Database },
  { key: "review", label: "Review", icon: ClipboardList, dot: true },
  { key: "receipt", label: "Receipt", icon: Receipt },
  { key: "shots", label: "Screenshots", icon: Camera },
];

export function ProposalLogPanel() {
  const { on } = useProposals();
  // Ratified state-driven default: a run Waiting on you opens on Review.
  const [tab, setTab] = useState<PanelTab>("review");
  return (
    <div className="flex flex-col overflow-hidden rounded-lg border border-border bg-card">
      {/* header */}
      <div className="flex items-center gap-2 border-b border-border/60 px-3 py-2.5">
        <span className="text-[13.5px] font-semibold text-foreground">Maria Lopez-Garcia</span>
        <StatusBadge status="waiting" />
        <span className="ml-auto font-mono text-[10.5px] text-muted-foreground">se-140211-9f3a</span>
      </div>

      {/* L6 — pinned outcome/blocker bar: always states the run's ONE current
          fact + the one action that matters, regardless of tab or scroll. */}
      {on("l6") && (
        <div className="flex items-center gap-2 border-b border-warning/30 bg-warning/6 px-3 py-1.5">
          <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-warning" />
          <span className="min-w-0 truncate text-[11.5px] text-warning">
            Paused on <span className="font-semibold">identity approval</span> — 18m in gate · nothing written yet
          </span>
          <button
            type="button"
            onClick={NOOP}
            className="ml-auto shrink-0 rounded-md border border-warning/45 bg-warning/12 px-2.5 py-0.5 text-[10.5px] font-semibold text-warning outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            Review
          </button>
        </div>
      )}

      {/* persistent step strip (ratified: NOT a tab) */}
      <div className="flex flex-wrap gap-1 border-b border-border/60 px-3 py-2">
        <StepChip
          state="done"
          label="Kuali extraction"
          duration="41s"
          hover={
            <HoverCard
              title="Kuali extraction"
              rows={
                <>
                  <HoverKv k="Status" v="done" />
                  <HoverKv k="Duration" v="41s" />
                  <HoverKv k="Attempts" v="1" />
                </>
              }
              keyLines={["last day worked = 07/15/2026", "termination type = Voluntary"]}
              screenshot
            />
          }
        />
        <StepChip
          state="done"
          label="Identity check"
          duration="12s"
          hover={
            <HoverCard
              title="Identity check"
              rows={
                <>
                  <HoverKv k="Status" v="done — differs, paused" tone="warning" />
                  <HoverKv k="Duration" v="12s" />
                </>
              }
              keyLines={["input: Maria Lopez", "match: M. Lopez-Garcia (10583942)"]}
            />
          }
        />
        <StepChip
          state="done"
          label="Job summary"
          duration="22s"
          hover={
            <HoverCard
              title="UCPath job summary"
              rows={
                <>
                  <HoverKv k="Status" v="done" />
                  <HoverKv k="Duration" v="22s" />
                </>
              }
              keyLines={["active job rec 0 · dept 000371"]}
              screenshot
            />
          }
        />
        <StepChip
          state="done"
          label="Kronos search"
          duration="1m 4s"
          hover={
            <HoverCard
              title="Kronos search"
              rows={
                <>
                  <HoverKv k="Status" v="done" />
                  <HoverKv k="Duration" v="1m 4s" />
                  <HoverKv k="Attempts" v="2" tone="warning" />
                </>
              }
              keyLines={["attempt 1 timeout · retried ok", "last punch 07/14 · 2 sick dates"]}
            />
          }
        />
        <StepChip
          state="current"
          label="UCPath transaction"
          hover={
            <HoverCard
              title="UCPath transaction"
              rows={
                <>
                  <HoverKv k="Status" v="waiting on you" tone="warning" />
                  <HoverKv k="Gate" v="identity approval" />
                  <HoverKv k="Waiting" v="18m" tone="warning" />
                </>
              }
            />
          }
        />
        <StepChip state="pending" label="Kuali finalization" />
      </div>

      {/* L10 — step time waterfall: where the run's time actually went. */}
      {on("l10") && (
        <div className="flex items-center gap-2 border-b border-border/60 px-3 py-1.5">
          <span aria-hidden className="flex h-1.5 flex-1 overflow-hidden rounded-full bg-secondary">
            <span className="bg-log-violet/70" style={{ flexGrow: 41 }} title="Kuali extraction — 41s" />
            <span className="bg-log-cyan/70" style={{ flexGrow: 12 }} title="Identity check — 12s" />
            <span className="bg-log-cyan/50" style={{ flexGrow: 22 }} title="Job summary — 22s" />
            <span className="bg-log-teal/70" style={{ flexGrow: 64 }} title="Kronos search — 1m 4s" />
            <span className="bg-warning/45" style={{ flexGrow: 100 }} title="Waiting on you — 18m (compressed)" />
          </span>
          <span className="shrink-0 font-mono text-[10px] text-muted-foreground">2m 19s active · 18m waiting</span>
        </div>
      )}

      {/* L9 — step screenshot filmstrip: the kernel's per-step audit captures
          as a visual scrub row; click opens the Screenshots tab at that step. */}
      {on("l9") && (
        <div className="flex gap-1.5 overflow-x-auto border-b border-border/60 px-3 py-2">
          {["Kuali doc", "Identity", "Job summary", "Kronos", "Paused"].map((label) => (
            <button
              key={label}
              type="button"
              onClick={NOOP}
              title={`Step screenshot — ${label}`}
              className="flex h-12 w-20 shrink-0 flex-col items-center justify-center gap-1 rounded-md border border-border bg-secondary/40 outline-none hover:border-info/50 focus-visible:ring-2 focus-visible:ring-ring"
            >
              <Camera aria-hidden className="size-3.5 text-muted-foreground" />
              <span className="max-w-full truncate px-1 text-[9px] text-muted-foreground">{label}</span>
            </button>
          ))}
        </div>
      )}

      {/* tabs — ratified 5-tab set, interactive; a paused run defaults to Review */}
      <div role="tablist" className="flex items-center gap-0.5 border-b border-border/60 px-2.5 py-1.5 text-[12px]">
        {PANEL_TABS.map((t) => {
          const Icon = t.icon;
          const active = tab === t.key;
          return (
            <button
              key={t.key}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => setTab(t.key)}
              className={cn(
                "relative inline-flex items-center gap-1.5 rounded-md px-2.5 py-0.5 outline-none focus-visible:ring-2 focus-visible:ring-ring",
                active ? "bg-accent font-semibold text-foreground" : "text-muted-foreground hover:text-foreground",
              )}
            >
              <Icon aria-hidden className="size-3" />
              {t.label}
              {t.dot && <span aria-hidden className="absolute right-0.5 top-0.5 size-1.5 rounded-full bg-warning" />}
            </button>
          );
        })}
        {tab === "review" && (
          <span className="ml-auto text-[9.5px] uppercase tracking-wider text-muted-foreground/70">state default</span>
        )}
      </div>

      {/* stream */}
      {tab === "logs" && (<>
      <div className="relative">
        {/* L8 — scrolled-up catch-up pill: appears when auto-follow is off and
            new lines arrive; click snaps back to live tail. */}
        {on("l8") && (
          <button
            type="button"
            onClick={NOOP}
            className="absolute bottom-2 left-1/2 z-20 inline-flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-info/45 bg-popover px-3 py-1 text-[10.5px] font-semibold text-info shadow-lg outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <ArrowDown aria-hidden className="size-3" />6 new lines
          </button>
        )}
      <div className="max-h-[560px] overflow-y-auto pb-2 pt-1">
        <StepDivider label="Kuali extraction" meta="41s" lines="9 lines" />
        <Line ts="2:02:41" icon={<ArrowRight aria-hidden className="size-3 text-log-slate" />}>
          {on("l1") && <SystemBadge system="kuali" />}Opened separation document 4-VMPHRW
        </Line>
        <Line ts="2:02:58" icon={<ArrowDownToLine aria-hidden className="size-3 text-log-cyan" />}>
          {on("l1") && <SystemBadge system="kuali" />}
          {on("l4") ? (
            <>
              <DataPill dir="read" label="last day worked" value="07/15/2026" />
              <DataPill dir="read" label="separation date" value="07/16/2026" />
            </>
          ) : (
            <>Extracted last day worked 07/15/2026, separation date 07/16/2026</>
          )}
        </Line>
        <Line ts="2:03:07" icon={<ArrowDownToLine aria-hidden className="size-3 text-log-cyan" />}>
          {on("l1") && <SystemBadge system="kuali" />}
          {on("l4") ? (
            <>
              <DataPill dir="read" label="termination type" value="Voluntary" />
              <DataPill dir="read" label="dept" value="000371" />
            </>
          ) : (
            <>Termination type Voluntary · department 000371</>
          )}
        </Line>
        <Line ts="2:03:22" tone="success" icon={<Check aria-hidden className="size-3 text-success" />}>
          Kuali extraction complete
          {on("l1") && <DurChip d="41s" />}
        </Line>

        <StepDivider label="Identity check" meta="12s" lines="4 lines" />
        <Line ts="2:03:25" icon={<Search aria-hidden className="size-3 text-log-slate" />}>
          {on("l1") && <SystemBadge system="ucpath" />}Person search: &ldquo;Maria Lopez&rdquo; — 1 active match
        </Line>
        <Line ts="2:03:34" tone="warning" icon={<TriangleAlert aria-hidden className="size-3 text-warning" />}>
          Resolved person differs from input record — pausing before any write
        </Line>
        {on("l5") && <GateCard />}

        <StepDivider label="Job summary" meta="22s" lines="5 lines" />
        <Line ts="2:04:02" icon={<ArrowRight aria-hidden className="size-3 text-log-slate" />}>
          {on("l1") && <SystemBadge system="ucpath" />}Job summary open — active job record 0
        </Line>
        <Line ts="2:04:18" icon={<ArrowDownToLine aria-hidden className="size-3 text-log-cyan" />}>
          {on("l1") && <SystemBadge system="ucpath" />}
          {on("l4") ? <DataPill dir="read" label="position" value="40128733" /> : <>Read position 40128733</>}
        </Line>

        <StepDivider label="Kronos search" meta="1m 4s · 2 attempts" lines="7 lines" />
        <Line ts="2:04:41" tone="destructive" icon={<X aria-hidden className="size-3 text-destructive" />}>
          {on("l1") && <SystemBadge system="kronos" />}
          <Hl>Employee search</Hl> timed out after 30s
          {on("l1") && <AttemptMark n={1} />}
        </Line>
        {on("l5") && <FailureCard />}
        <Line ts="2:05:12" icon={<Search aria-hidden className="size-3 text-log-slate" />}>
          {on("l1") && <SystemBadge system="kronos" />}
          <Hl current>Employee search</Hl>: 10583942
          {on("l1") && <AttemptMark n={2} />}
        </Line>
        <Line ts="2:05:39" icon={<ArrowDownToLine aria-hidden className="size-3 text-log-cyan" />}>
          {on("l1") && <SystemBadge system="kronos" />}
          {on("l4") ? (
            <>
              <DataPill dir="read" label="last punch" value="07/14/2026" />
              <DataPill dir="read" label="sick dates" value="2" />
            </>
          ) : (
            <>Last punch 07/14/2026 · 2 sick dates in window</>
          )}
        </Line>
        <Line ts="2:05:45" tone="success" icon={<Check aria-hidden className="size-3 text-success" />}>
          Kronos search complete
          {on("l1") && <DurChip d="1m 4s" />}
        </Line>

        <StepDivider label="UCPath transaction" meta="waiting" />
        <Line ts="2:05:58" current icon={<Pause aria-hidden className="size-3 text-warning" />}>
          Paused — identity approval required before the termination write. Resolve in the{" "}
          <span className="font-semibold text-foreground">Review</span> tab.
        </Line>
        {on("l4") && (
          <Line ts="" icon={<CheckCircle2 aria-hidden className="size-3 text-muted-foreground" />}>
            <span className="text-muted-foreground">On resume this run will </span>
            <DataPill dir="write" label="separation date" value="07/16/2026" />
            <DataPill dir="write" label="action" value="Voluntary termination" />
          </Line>
        )}
      </div>
      </div>

      {/* footer */}
      <div className="flex items-center gap-2 border-t border-border/60 px-3 py-1.5 text-[11.5px] text-muted-foreground">
        <label className="sr-only" htmlFor="proposal-log-filter">
          {on("l7") ? "Search logs" : "Filter logs"}
        </label>
        <input
          id="proposal-log-filter"
          placeholder={on("l7") ? "Search logs…" : "Filter logs…"}
          defaultValue={on("l7") ? "employee search" : undefined}
          key={on("l7") ? "search" : "filter"}
          className="w-40 rounded-md border border-border bg-secondary/40 px-2 py-0.5 text-[11.5px] text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
        {on("l7") && (
          <span className="inline-flex items-center gap-0.5">
            <span className="font-mono text-[10.5px] tabular-nums">2/2</span>
            <button
              type="button"
              onClick={NOOP}
              aria-label="Previous match"
              className="inline-flex size-5 items-center justify-center rounded text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
            >
              <ChevronUp aria-hidden className="size-3" />
            </button>
            <button
              type="button"
              onClick={NOOP}
              aria-label="Next match"
              className="inline-flex size-5 items-center justify-center rounded text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
            >
              <ChevronDown aria-hidden className="size-3" />
            </button>
          </span>
        )}
        {on("l1") && (
          <span className="inline-flex items-center gap-1.5">
            <span className="inline-flex items-center gap-0.5 rounded-md border border-border px-1.5 py-0.5">
              System <ChevronDown aria-hidden className="size-3" />
            </span>
            <span className="inline-flex items-center gap-0.5 rounded-md border border-border px-1.5 py-0.5">
              Step <ChevronDown aria-hidden className="size-3" />
            </span>
          </span>
        )}
        <span aria-hidden className="ml-auto size-1.5 rounded-full bg-success" />
      </div>
      </>)}

      {tab === "data" && <DataTab />}
      {tab === "review" && <ReviewTab />}
      {tab === "receipt" && <ReceiptTab />}
      {tab === "shots" && <ShotsTab />}
    </div>
  );
}
