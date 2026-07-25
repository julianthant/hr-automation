import type { ReactNode } from "react";
import {
  ArrowDownToLine,
  ArrowRight,
  ArrowUpFromLine,
  Check,
  CheckCircle2,
  ChevronDown,
  Pause,
  Search,
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

function GateCard() {
  return (
    <div className="mx-3 my-1.5 ml-11 rounded-lg border border-warning/45 bg-warning/6 px-3 py-2.5 text-[12px]">
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

export function ProposalLogPanel() {
  const { on } = useProposals();
  return (
    <div className="flex flex-col overflow-hidden rounded-lg border border-border bg-card">
      {/* header */}
      <div className="flex items-center gap-2 border-b border-border/60 px-3 py-2.5">
        <span className="text-[13.5px] font-semibold text-foreground">Maria Lopez-Garcia</span>
        <StatusBadge status="waiting" />
        <span className="ml-auto font-mono text-[10.5px] text-muted-foreground">se-140211-9f3a</span>
      </div>

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

      {/* tabs (ratified 5-tab set; Review carries the attention dot) */}
      <div className="flex gap-0.5 border-b border-border/60 px-2.5 py-1.5 text-[12px]">
        <span className="rounded-md bg-accent px-2.5 py-0.5 font-semibold text-foreground">Logs</span>
        <span className="px-2.5 py-0.5 text-muted-foreground">Data</span>
        <span className="relative px-2.5 py-0.5 text-muted-foreground">
          Review
          <span aria-hidden className="absolute right-0.5 top-0.5 size-1.5 rounded-full bg-warning" />
        </span>
        <span className="px-2.5 py-0.5 text-muted-foreground">Receipt</span>
        <span className="px-2.5 py-0.5 text-muted-foreground">Screenshots</span>
      </div>

      {/* stream */}
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
          {on("l1") && <SystemBadge system="kronos" />}Employee search timed out after 30s
          {on("l1") && <AttemptMark n={1} />}
        </Line>
        {on("l5") && <FailureCard />}
        <Line ts="2:05:12" icon={<Search aria-hidden className="size-3 text-log-slate" />}>
          {on("l1") && <SystemBadge system="kronos" />}Employee search: 10583942
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

      {/* footer */}
      <div className="flex items-center gap-2 border-t border-border/60 px-3 py-1.5 text-[11.5px] text-muted-foreground">
        <label className="sr-only" htmlFor="proposal-log-filter">
          Filter logs
        </label>
        <input
          id="proposal-log-filter"
          placeholder="Filter logs…"
          className="w-40 rounded-md border border-border bg-secondary/40 px-2 py-0.5 text-[11.5px] text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
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
    </div>
  );
}
