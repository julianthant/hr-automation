import { useEffect, useMemo, useState } from "react";
import {
  ArrowDownToLine,
  ArrowRight,
  ArrowUpFromLine,
  Ban,
  Camera,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ClipboardList,
  Database,
  Pause,
  Receipt,
  RotateCcw,
  ScrollText,
  Search,
  ShieldCheck,
  TriangleAlert,
  X,
  Zap,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { IconActionButton } from "@/components/shared/IconActionButton";
import { StatusBadge } from "../proposals/proposal-rows";
import {
  fmtElapsed,
  LIVE_SEQUENCE,
  memberAttentionIds,
  orderedMemberIds,
  SYSTEM_ACCENT,
  WATERFALL_ACCENT,
  type DemoLine,
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

export type DemoTab = "logs" | "data" | "review" | "receipt" | "shots";

export function defaultTabFor(row: DemoRow): DemoTab {
  if (row.status === "waiting" || row.status === "parked") return "review";
  if (row.status === "verifiedDone" || row.status === "doneWarnings" || row.status === "failed" || row.status === "cancelled")
    return "receipt";
  return "logs";
}

export interface DemoLogPanelProps {
  row: DemoRow;
  tab: DemoTab | null;
  onTab: (t: DemoTab) => void;
  onSelect: (id: string) => void;
  checkedIds: ReadonlySet<string>;
  onToggleChecked: (id: string) => void;
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

const LINE_ICON: Record<LineKind, { icon: typeof Check; cls: string }> = {
  nav: { icon: ArrowRight, cls: "text-log-slate" },
  search: { icon: Search, cls: "text-log-slate" },
  read: { icon: ArrowDownToLine, cls: "text-log-cyan" },
  write: { icon: ArrowUpFromLine, cls: "text-log-teal" },
  ok: { icon: Check, cls: "text-success" },
  error: { icon: X, cls: "text-destructive" },
  warn: { icon: TriangleAlert, cls: "text-warning" },
  pause: { icon: Pause, cls: "text-warning" },
  event: { icon: Zap, cls: "text-log-violet" },
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

function GateCardView({ row, wide }: { row: DemoRow; wide?: boolean }) {
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
              <span className="shrink-0 rounded border border-warning/40 px-1 text-[9.5px] font-semibold text-warning">staged</span>
            </div>
          ))}
        </div>
      )}
      <div className="mt-2 flex flex-wrap gap-1.5">
        {gate.actions.map((a, i) => (
          <button
            key={a}
            type="button"
            onClick={NOOP}
            className={cn(
              "rounded-md border px-2.5 py-0.5 text-[11px] outline-none focus-visible:ring-2 focus-visible:ring-ring",
              i === 0
                ? "border-primary bg-primary font-semibold text-primary-foreground"
                : "border-border bg-card font-medium text-secondary-foreground",
            )}
          >
            {a}
          </button>
        ))}
      </div>
      {wide && <div className="mt-2 border-t border-border/40 pt-2 text-[11px] leading-relaxed text-muted-foreground">{gate.note}</div>}
    </div>
  );
}

function FailureCardView({ row }: { row: DemoRow }) {
  if (!row.failCard) return null;
  return (
    <div className="mx-3 my-1.5 ml-11 rounded-lg border border-destructive/40 bg-destructive/6 px-3 py-2 text-[12px]">
      <div className="mb-0.5 text-[11.5px] font-semibold text-destructive">{row.failCard.title}</div>
      <div className="text-[11px] text-muted-foreground">
        {row.failCard.meta} <span className="text-info">Screenshot at failure →</span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// strip + waterfall + filmstrip
// ---------------------------------------------------------------------------

function StepChipView({ step }: { step: DemoStep }) {
  const stateCls =
    step.state === "done"
      ? "border-success/35 text-success"
      : step.state === "current"
        ? "border-primary/50 bg-primary/8 text-primary"
        : step.state === "waiting"
          ? "border-warning/45 bg-warning/8 text-warning"
          : step.state === "failed"
            ? "border-destructive/50 bg-destructive/8 text-destructive"
            : step.state === "cancelled"
              ? "border-warning/40 bg-warning/6 text-warning"
              : "border-border text-muted-foreground";
  return (
    <span className="group relative">
      <button
        type="button"
        onClick={NOOP}
        className={cn(
          "inline-flex items-center gap-1.5 rounded-full border bg-card px-2.5 py-0.5 text-[11px] outline-none focus-visible:ring-2 focus-visible:ring-ring",
          stateCls,
        )}
      >
        {step.state === "done" && <Check aria-hidden className="size-3" />}
        {step.state === "current" && <span aria-hidden className="size-1.5 rounded-full bg-primary animate-pulse motion-reduce:animate-none" />}
        {step.state === "waiting" && <Pause aria-hidden className="size-3" />}
        {step.state === "failed" && <X aria-hidden className="size-3" />}
        {step.state === "cancelled" && <Ban aria-hidden className="size-3" />}
        {step.label}
        {step.durationSec !== undefined && <span className="font-mono text-[10px] text-muted-foreground">{fmtElapsed(step.durationSec)}</span>}
        {step.attempts && step.attempts > 1 && (
          <span className="rounded border border-warning/40 px-1 text-[9px] font-bold text-warning">×{step.attempts}</span>
        )}
      </button>
      {(step.keyLines || step.durationSec !== undefined) && (
        <span className="absolute left-0 top-full z-50 mt-1.5 hidden w-60 rounded-lg border border-border bg-popover p-2.5 text-left shadow-lg group-hover:block group-focus-within:block">
          <span className="mb-1 block text-[11.5px] font-semibold text-foreground">{step.label}</span>
          <span className="flex items-center justify-between text-[10.5px]">
            <span className="text-muted-foreground">Status</span>
            <span className="font-mono text-secondary-foreground">{step.state}</span>
          </span>
          {step.durationSec !== undefined && (
            <span className="flex items-center justify-between text-[10.5px]">
              <span className="text-muted-foreground">Duration</span>
              <span className="font-mono text-secondary-foreground">{fmtElapsed(step.durationSec)}</span>
            </span>
          )}
          {step.attempts && (
            <span className="flex items-center justify-between text-[10.5px]">
              <span className="text-muted-foreground">Attempts</span>
              <span className={cn("font-mono", step.attempts > 1 ? "text-warning" : "text-secondary-foreground")}>{step.attempts}</span>
            </span>
          )}
          {step.keyLines && (
            <span className="mt-1.5 flex flex-col border-t border-border/60 pt-1.5 font-mono text-[10px] leading-relaxed text-secondary-foreground">
              {step.keyLines.map((l) => (
                <span key={l}>{l}</span>
              ))}
            </span>
          )}
          {step.hasShot && <span className="mt-1 block text-[10.5px] text-info">Step screenshot →</span>}
        </span>
      )}
    </span>
  );
}

function Waterfall({ row }: { row: DemoRow }) {
  const segs = row.steps.filter((s) => s.durationSec);
  if (segs.length < 2) return null;
  const active = segs.reduce((a, s) => a + (s.durationSec ?? 0), 0);
  return (
    <div className="flex items-center gap-2 border-b border-border/60 px-3 py-1.5">
      <span aria-hidden className="flex h-1.5 flex-1 overflow-hidden rounded-full bg-secondary">
        {segs.map((s, i) => (
          <span
            key={i}
            className={s.system ? WATERFALL_ACCENT[s.system] : "bg-log-slate/60"}
            style={{ flexGrow: s.durationSec }}
            title={`${s.label} — ${fmtElapsed(s.durationSec ?? 0)}`}
          />
        ))}
        {row.gate && <span className="bg-warning/45" style={{ flexGrow: Math.max(active, 60) }} title={`Waiting — ${row.gate.waiting}`} />}
      </span>
      <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
        {fmtElapsed(active)} active{row.gate ? ` · ${row.gate.waiting} waiting` : ""}
      </span>
    </div>
  );
}

function Filmstrip({ row }: { row: DemoRow }) {
  if (row.shots.length === 0) return null;
  return (
    <div className="flex gap-1.5 overflow-x-auto border-b border-border/60 px-3 py-2">
      {row.shots.map((s) => (
        <button
          key={s.label}
          type="button"
          onClick={NOOP}
          title={`Screenshot — ${s.label}`}
          className={cn(
            "flex h-11 w-[4.5rem] shrink-0 flex-col items-center justify-center gap-0.5 rounded-md border bg-secondary/40 outline-none focus-visible:ring-2 focus-visible:ring-ring",
            s.kind === "error" ? "border-destructive/45" : "border-border hover:border-info/50",
          )}
        >
          <Camera aria-hidden className={cn("size-3", s.kind === "error" ? "text-destructive" : "text-muted-foreground")} />
          <span className="max-w-full truncate px-1 text-[8.5px] text-muted-foreground">{s.label}</span>
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// tab bodies
// ---------------------------------------------------------------------------

function LogsTab({ row, liveCount }: { row: DemoRow; liveCount: number }) {
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
              {line.card === "gate" && <GateCardView row={row} />}
              {line.card === "failure" && <FailureCardView row={row} />}
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

function DataTab({ row }: { row: DemoRow }) {
  if (row.data.length === 0) {
    return <EmptyTab icon={Database} text="No data points recorded — this run has not read or written anything yet." />;
  }
  const reads = row.data.filter((d) => d.dir === "read").length;
  const writes = row.data.filter((d) => d.dir === "write");
  const staged = writes.filter((d) => d.staged).length;
  const steps = [...new Set(row.data.map((d) => d.step))];
  return (
    <div className="min-h-0 flex-1 overflow-y-auto pb-3">
      <div className="flex items-center gap-3 border-b border-border/40 px-3 py-2 text-[11px] text-muted-foreground">
        <span className="inline-flex items-center gap-1 text-log-cyan">
          <ArrowDownToLine aria-hidden className="size-3" />
          {reads} reads
        </span>
        {writes.length > 0 && (
          <span className="inline-flex items-center gap-1 text-log-teal">
            <ArrowUpFromLine aria-hidden className="size-3" />
            {writes.length} writes
            {staged > 0 && <span className="rounded border border-warning/40 px-1 text-[9.5px] font-semibold text-warning">staged</span>}
          </span>
        )}
        <span className="ml-auto">every value the run touched, in order</span>
      </div>
      {steps.map((step) => (
        <div key={step}>
          <div className="flex items-center gap-2 px-3 pb-0.5 pt-2.5 text-[11px] font-semibold text-secondary-foreground">
            {step}
            <span aria-hidden className="h-px flex-1 bg-border/60" />
          </div>
          {row.data
            .filter((d) => d.step === step)
            .map((d, i) => (
              <div key={i} className="flex items-center gap-2.5 px-3 py-[5px] text-[12px] hover:bg-accent/30">
                {d.dir === "read" ? (
                  <ArrowDownToLine aria-hidden className="size-3 shrink-0 text-log-cyan" />
                ) : (
                  <ArrowUpFromLine aria-hidden className="size-3 shrink-0 text-log-teal" />
                )}
                <span className="w-36 shrink-0 truncate text-muted-foreground">{d.field}</span>
                <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-foreground">{d.value}</span>
                {d.staged && <span className="shrink-0 rounded border border-warning/40 px-1 text-[9.5px] font-semibold text-warning">staged</span>}
                <SystemChip system={d.system} />
                <span className="w-14 shrink-0 text-right font-mono text-[10px] text-muted-foreground tabular-nums">{d.ts}</span>
              </div>
            ))}
        </div>
      ))}
    </div>
  );
}

function ReviewTab({ row }: { row: DemoRow }) {
  if (!row.gate) {
    return <EmptyTab icon={ClipboardList} text="Nothing to review — this run has no open gate." />;
  }
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="flex flex-col gap-2.5 px-3 py-3">
        <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
          <ClipboardList aria-hidden className="size-3.5 text-warning" />
          <span>
            Gate opened <span className="font-mono">{row.gate.openedAt}</span> · waiting{" "}
            <span className="font-mono text-warning">{row.gate.waiting}</span> · nothing written yet
          </span>
        </div>
        <GateCardView row={row} wide />
      </div>
    </div>
  );
}

function ReceiptTab({ row }: { row: DemoRow }) {
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
  const staged = row.data.filter((d) => d.staged);
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
          {r.note && <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground">{r.note}</p>}
        </div>
        {staged.length > 0 && (
          <div>
            <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Staged — goes live on resume</div>
            <div className="rounded-lg border border-border bg-secondary/20 px-3 py-1.5">
              {staged.map((d) => (
                <div key={d.field} className="flex items-center gap-2 py-[3px] text-[12px]">
                  <ArrowUpFromLine aria-hidden className="size-3 text-log-teal" />
                  <span className="w-36 shrink-0 text-muted-foreground">{d.field}</span>
                  <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-foreground">{d.value}</span>
                  <SystemChip system={d.system} />
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function ShotsTab({ row }: { row: DemoRow }) {
  if (row.shots.length === 0) {
    return <EmptyTab icon={Camera} text="No screenshots yet — one is captured per completed step, plus one per failure." />;
  }
  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
      <div className="grid grid-cols-3 gap-2">
        {row.shots.map((s) => (
          <button
            key={s.label}
            type="button"
            onClick={NOOP}
            title={`Screenshot — ${s.label}`}
            className={cn(
              "relative flex h-24 flex-col items-center justify-center gap-1.5 rounded-md border bg-secondary/40 outline-none focus-visible:ring-2 focus-visible:ring-ring",
              s.kind === "error" ? "border-destructive/45" : "border-border hover:border-info/50",
            )}
          >
            <Camera aria-hidden className="size-4 text-muted-foreground" />
            <span className="max-w-full truncate px-2 text-[10px] text-muted-foreground">{s.label}</span>
            <span
              className={cn(
                "absolute right-1 top-1 rounded px-1 text-[8.5px] font-bold uppercase tracking-wide",
                s.kind === "error" ? "bg-destructive/15 text-destructive" : s.kind === "form" ? "bg-log-violet/15 text-log-violet" : "bg-info/15 text-info",
              )}
            >
              {s.kind}
            </span>
          </button>
        ))}
      </div>
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
          {idx + 1}/{total}
        </span>
        <IconActionButton
          tone="muted"
          icon={<ChevronRight aria-hidden className="size-3.5" />}
          label="Next member"
          onClick={() => onSelect(siblings[(idx + 1) % total])}
        />
        <span className="ml-1 min-w-0 truncate text-[13px] font-semibold text-foreground">{row.title}</span>
        <StatusBadge status={row.status} />
        {nextAttention && nextAttention !== row.id && (
          <button
            type="button"
            onClick={() => onSelect(nextAttention)}
            className="ml-auto inline-flex shrink-0 items-center gap-1 rounded-md border border-warning/45 bg-warning/10 px-2 py-0.5 text-[10.5px] font-semibold text-warning outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            Next attention
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

// ---------------------------------------------------------------------------
// the panel
// ---------------------------------------------------------------------------

const TAB_SPECS: { key: DemoTab; label: string; icon: typeof ScrollText }[] = [
  { key: "logs", label: "Logs", icon: ScrollText },
  { key: "data", label: "Data", icon: Database },
  { key: "review", label: "Review", icon: ClipboardList },
  { key: "receipt", label: "Receipt", icon: Receipt },
  { key: "shots", label: "Screenshots", icon: Camera },
];

const OUTCOME_TONE: Record<DemoRow["outcome"]["tone"], { bar: string; dot: string; btn: string }> = {
  warning: { bar: "border-warning/30 bg-warning/6 text-warning", dot: "bg-warning", btn: "border-warning/45 bg-warning/12 text-warning" },
  violet: { bar: "border-log-violet/30 bg-log-violet/6 text-log-violet", dot: "bg-log-violet", btn: "border-log-violet/45 bg-log-violet/12 text-log-violet" },
  info: { bar: "border-info/25 bg-info/5 text-info", dot: "bg-info", btn: "border-info/45 bg-info/12 text-info" },
  success: { bar: "border-success/25 bg-success/5 text-success", dot: "bg-success", btn: "border-success/45 bg-success/12 text-success" },
  destructive: { bar: "border-destructive/30 bg-destructive/6 text-destructive", dot: "bg-destructive", btn: "border-destructive/45 bg-destructive/12 text-destructive" },
  muted: { bar: "border-border bg-secondary/20 text-muted-foreground", dot: "bg-muted-foreground", btn: "border-border bg-card text-secondary-foreground" },
};

export function DemoLogPanel({ row, tab, onTab, onSelect, checkedIds, onToggleChecked, tick, liveCount }: DemoLogPanelProps) {
  const effectiveTab = tab ?? defaultTabFor(row);
  const isMember = row.rowType === "member";
  const tone = OUTCOME_TONE[row.outcome.tone];
  const elapsed = row.elapsedSec !== undefined ? fmtElapsed(row.elapsedSec + tick) : undefined;
  const attentionMember = isMember && (row.status === "failed" || row.status === "waiting" || row.status === "doneWarnings");

  return (
    <section aria-label="Run detail" className="flex min-h-0 flex-col overflow-hidden rounded-lg border border-border bg-card">
      {isMember ? (
        <ConveyorHeader row={row} onSelect={onSelect} checkedIds={checkedIds} />
      ) : (
        <div className="flex items-center gap-2 border-b border-border/60 px-3 py-2.5">
          <span className="min-w-0 truncate text-[13.5px] font-semibold text-foreground">{row.title}</span>
          <StatusBadge status={row.status} />
          {elapsed && <span className="font-mono text-[10.5px] text-primary/85 tabular-nums">{elapsed}</span>}
          <span className="ml-auto shrink-0 font-mono text-[10.5px] text-muted-foreground">{row.trace}</span>
        </div>
      )}

      {/* pinned outcome bar */}
      <div className={cn("flex items-center gap-2 border-b px-3 py-1.5", tone.bar)}>
        <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", tone.dot)} />
        <span className="min-w-0 truncate text-[11.5px]">{row.outcome.text}</span>
        {row.outcome.action && (
          <button
            type="button"
            onClick={NOOP}
            className={cn("ml-auto shrink-0 rounded-md border px-2.5 py-0.5 text-[10.5px] font-semibold outline-none focus-visible:ring-2 focus-visible:ring-ring", tone.btn)}
          >
            {row.outcome.action}
          </button>
        )}
      </div>

      {/* persistent strip */}
      <div className="flex flex-wrap gap-1 border-b border-border/60 px-3 py-2">
        {row.steps.map((s) => (
          <StepChipView key={s.label} step={s} />
        ))}
      </div>

      <Waterfall row={row} />
      <Filmstrip row={row} />

      {/* tabs */}
      <div role="tablist" className="flex items-center gap-0.5 border-b border-border/60 px-2.5 py-1.5 text-[12px]">
        {TAB_SPECS.map((t) => {
          const active = effectiveTab === t.key;
          const Icon = t.icon;
          const showDot = t.key === "review" && Boolean(row.gate);
          return (
            <button
              key={t.key}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => onTab(t.key)}
              className={cn(
                "relative inline-flex items-center gap-1.5 rounded-md px-2.5 py-0.5 outline-none focus-visible:ring-2 focus-visible:ring-ring",
                active ? "bg-accent font-semibold text-foreground" : "text-muted-foreground hover:text-foreground",
              )}
            >
              <Icon aria-hidden className="size-3" />
              {t.label}
              {showDot && <span aria-hidden className="absolute right-0.5 top-0.5 size-1.5 rounded-full bg-warning" />}
            </button>
          );
        })}
        {tab === null && <span className="ml-auto text-[9.5px] uppercase tracking-wider text-muted-foreground/70">state default</span>}
      </div>

      {effectiveTab === "logs" && <LogsTab row={row} liveCount={liveCount} />}
      {effectiveTab === "data" && <DataTab row={row} />}
      {effectiveTab === "review" && <ReviewTab row={row} />}
      {effectiveTab === "receipt" && <ReceiptTab row={row} />}
      {effectiveTab === "shots" && <ShotsTab row={row} />}

      {/* member action bar */}
      {isMember && !row.displayOnly && (
        <div className="mt-auto flex items-center gap-1.5 border-t border-border/60 bg-secondary/20 px-3 py-2">
          {(row.status === "failed" || row.status === "doneWarnings") && (
            <button
              type="button"
              onClick={NOOP}
              className="inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-2.5 py-1 text-[11px] font-medium text-secondary-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <RotateCcw aria-hidden className="size-3" />
              Retry
            </button>
          )}
          <button
            type="button"
            onClick={() => onToggleChecked(row.id)}
            aria-pressed={checkedIds.has(row.id)}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-[11px] font-semibold outline-none focus-visible:ring-2 focus-visible:ring-ring",
              checkedIds.has(row.id)
                ? "border-success/60 bg-success/20 text-success"
                : "border-success/45 bg-success/10 text-success",
            )}
          >
            {checkedIds.has(row.id) ? <CheckCircle2 aria-hidden className="size-3" /> : <Check aria-hidden className="size-3" />}
            {checkedIds.has(row.id) ? "Checked" : "Mark checked"}
          </button>
          {attentionMember && (
            <button
              type="button"
              onClick={NOOP}
              className="inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-2.5 py-1 text-[11px] font-medium text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <Ban aria-hidden className="size-3" />
              Skip
            </button>
          )}
          <span className="ml-auto font-mono text-[10px] text-muted-foreground">
            <kbd className="rounded border border-border bg-card px-1">c</kbd> checks ·{" "}
            <kbd className="rounded border border-border bg-card px-1">n</kbd> next attention
          </span>
        </div>
      )}
    </section>
  );
}
