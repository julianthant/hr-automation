import { useEffect, useState } from "react";
import { ArrowRight, ChevronLeft, ChevronRight, History, Pencil, Sliders } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { StatusBadge } from "./demo-status";
import { attemptDuration, attemptTrace, fmtElapsed, type DemoRerunDiffEntry, type DemoRow } from "./demo-data";
import type { ActionDescriptorWire } from "./demo-wire";

/**
 * DEV-ONLY — WHICH RUN IS THIS, exactly.
 *
 * Four facts the queue row can only afford a chip for, and one the demo could
 * not show at all:
 *
 *  - **Identity strip** — who asked for this run, at what priority, under which
 *    descriptor + app version, against which system instance, and whether a
 *    preset put values in that nobody typed. Every one of these is a served
 *    field (`requestedBy` / `priority` / `workflowVersion` / `appVersion` /
 *    `resolvedInstance` / `preset`); none is inferred.
 *  - **Run selector** — `‹ #2 of 2 ›` over the attempt lineage, so a failed
 *    first attempt is one click away instead of lost.
 *  - **Rerun diff** — what actually differed between the last two attempts.
 *    The load-bearing rule (12 §2.4): replayed data is NEVER labelled as newly
 *    observed, so a reused checkpoint says "replayed" in its own words.
 *  - **Rename** — the operator's own name for a run. It rides the row and the
 *    receipt; the trace id is untouched, so history still matches.
 */

// ---------------------------------------------------------------------------
// Identity strip
// ---------------------------------------------------------------------------

function IdentityChip({
  label,
  value,
  tone = "neutral",
  title,
}: {
  label: string;
  value: string;
  tone?: "neutral" | "info" | "violet" | "warning";
  title?: string;
}) {
  return (
    <span
      title={title}
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-md border px-1.5 py-px text-[10px]",
        tone === "neutral" && "border-border bg-secondary/50 text-muted-foreground",
        tone === "info" && "border-info/45 bg-info/10 text-info",
        tone === "violet" && "border-log-violet/45 bg-log-violet/10 text-log-violet",
        tone === "warning" && "border-warning/45 bg-warning/12 text-warning",
      )}
    >
      <span className="uppercase tracking-wider opacity-70">{label}</span>
      <span className="font-mono">{value}</span>
    </span>
  );
}

export function RunIdentityStrip({ row }: { row: DemoRow }) {
  const testSystems = Object.entries(row.resolvedInstance).filter(([, v]) => v === "test");
  const [presetOpen, setPresetOpen] = useState(false);
  useEffect(() => setPresetOpen(false), [row.id]);

  return (
    <div className="flex flex-col gap-1 border-b border-border/60 px-3 py-1.5">
      <div className="flex flex-wrap items-center gap-1">
        {row.displayName && (
          <IdentityChip
            label="named"
            value={row.displayName}
            tone="info"
            title={`Named by you. The subject is still ${row.title} and the trace id ${row.trace} is unchanged — history matches either way.`}
          />
        )}
        <IdentityChip label="by" value={row.requestedBy} title="Every run and every command records who asked for it." />
        <IdentityChip
          label="priority"
          value={row.priority}
          tone={row.priority === "bulk" ? "neutral" : "info"}
          title={
            row.priority === "bulk"
              ? "Bulk — yields the worker to anything interactive. A 50-person packet must never make one urgent separation wait."
              : "Interactive — takes a worker ahead of bulk work."
          }
        />
        <IdentityChip
          label="wf"
          value={`v${row.workflowVersion}`}
          tone={row.workflowVersion !== row.workflow.version ? "warning" : "neutral"}
          title={
            row.workflowVersion !== row.workflow.version
              ? `Ran under ${row.workflow.label} v${row.workflowVersion}; runs are served by v${row.workflow.version} now. Runs of different versions are not comparable — a retry would replay retired code.`
              : `${row.workflow.label} v${row.workflowVersion} — the version currently serving runs.`
          }
        />
        <IdentityChip label="app" value={row.appVersion} title="The app build that served this run — the other half of the archive key." />
        {testSystems.length > 0 && (
          <IdentityChip
            label="instance"
            value={testSystems.map(([k]) => `${k}:test`).join(" ")}
            tone="info"
            title={`Ran against the TEST instance of ${testSystems.map(([k]) => k).join(", ")} — nothing here reached production.`}
          />
        )}
        {row.dryRun && (
          <IdentityChip
            label="dry run"
            value="writes nothing"
            tone="violet"
            title="A rehearsal: it reads every system and writes to none. The receipt says what it WOULD have written."
          />
        )}
        {row.preset && (
          <button
            type="button"
            onClick={() => setPresetOpen((v) => !v)}
            aria-expanded={presetOpen}
            title="A saved preset merged constant values into this run's inputs — open it to see exactly which."
            className="inline-flex shrink-0 items-center gap-1 rounded-md border border-log-teal/45 bg-log-teal/10 px-1.5 py-px text-[10px] text-log-teal outline-none hover:bg-log-teal/15 focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Sliders aria-hidden className="size-2.5" />
            <span className="uppercase tracking-wider opacity-70">preset</span>
            <span className="font-mono">{row.preset.name}</span>
            <span className="font-mono opacity-70">+{row.preset.merged.length}</span>
          </button>
        )}
      </div>

      {row.preset && presetOpen && (
        <div className="rounded-md border border-log-teal/30 bg-log-teal/6 px-2.5 py-1.5">
          <p className="mb-1 text-[10.5px] text-muted-foreground">
            {row.preset.source} “{row.preset.name}” — merged into every member at enqueue. These values were not typed for this run; the
            preset put them there.
          </p>
          {row.preset.merged.map((f) => (
            <div key={f.field} className="flex items-baseline gap-2 text-[11px]">
              <span className="w-32 shrink-0 text-muted-foreground">{f.field}</span>
              <span className="min-w-0 flex-1 truncate font-mono text-secondary-foreground">{f.value}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Run selector + rerun diff
// ---------------------------------------------------------------------------

const DIFF_TONE: Record<DemoRerunDiffEntry["kind"], { label: string; cls: string }> = {
  input: { label: "input", cls: "border-border text-muted-foreground" },
  checkpoint: { label: "replayed", cls: "border-log-violet/45 text-log-violet" },
  correction: { label: "correction", cls: "border-warning/45 text-warning" },
  proof: { label: "write proof", cls: "border-log-teal/45 text-log-teal" },
};

/**
 * `‹ #2 of 2 ›` over the run's attempts, with the rerun diff for whichever
 * attempt is selected. The prior attempt's trace id is DERIVED from its own
 * instants — the fixture never writes one, so a lineage entry cannot claim a
 * trace that no run ever had.
 */
export function RunSelector({ row }: { row: DemoRow }) {
  const lineage = row.lineage;
  const [idx, setIdx] = useState((lineage?.attempts.length ?? 1) - 1);
  useEffect(() => setIdx((lineage?.attempts.length ?? 1) - 1), [row.id, lineage?.attempts.length]);
  if (!lineage || lineage.attempts.length < 2) return null;

  const attempts = lineage.attempts;
  const attempt = attempts[Math.min(idx, attempts.length - 1)];
  const current = idx === attempts.length - 1;
  const duration = attemptDuration(attempt);

  return (
    <div className="border-b border-border/60 bg-secondary/15">
      <div className="flex flex-wrap items-center gap-1.5 px-3 py-1.5">
        <History aria-hidden className="size-3 shrink-0 text-muted-foreground" />
        <span className="shrink-0 text-[10px] uppercase tracking-wider text-muted-foreground">Attempts</span>
        <button
          type="button"
          aria-label="Previous attempt"
          disabled={idx === 0}
          onClick={() => setIdx((i) => Math.max(i - 1, 0))}
          className="inline-flex size-5 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-30"
        >
          <ChevronLeft aria-hidden className="size-3" />
        </button>
        <span className="shrink-0 font-mono text-[10.5px] tabular-nums text-foreground">
          #{attempt.n} of {attempts.length}
        </span>
        <button
          type="button"
          aria-label="Next attempt"
          disabled={idx === attempts.length - 1}
          onClick={() => setIdx((i) => Math.min(i + 1, attempts.length - 1))}
          className="inline-flex size-5 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-30"
        >
          <ChevronRight aria-hidden className="size-3" />
        </button>
        <StatusBadge status={attempt.status} />
        <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">{attempt.summary}</span>
        {duration && <span className="shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground">{duration}</span>}
        <span
          className={cn("shrink-0 font-mono text-[10px]", current ? "text-muted-foreground" : "text-warning")}
          title={current ? "This is the attempt on screen." : "You are looking at an EARLIER attempt — the row above is the current one."}
        >
          {attemptTrace(row, attempt)}
          {!current && " · older"}
        </span>
      </div>

      {current && lineage.diff.length > 0 && (
        <div className="border-t border-border/40 px-3 py-1.5">
          <p className="mb-1 text-[10px] uppercase tracking-wider text-muted-foreground">
            What changed since attempt #{attempts[attempts.length - 2].n}
          </p>
          {lineage.diff.map((d) => {
            const tone = DIFF_TONE[d.kind];
            const same = d.prior === d.current;
            return (
              <div key={d.label} className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 py-[3px] text-[11px]">
                <span className={cn("shrink-0 rounded border px-1 text-[9px] font-semibold uppercase", tone.cls)}>{tone.label}</span>
                <span className="w-28 shrink-0 truncate text-muted-foreground">{d.label}</span>
                <span className="shrink-0 font-mono text-[10.5px] text-muted-foreground line-through opacity-70">{d.prior}</span>
                <ArrowRight aria-hidden className="size-3 shrink-0 text-muted-foreground" />
                <span className={cn("shrink-0 font-mono text-[10.5px]", same ? "text-muted-foreground" : "text-foreground")}>{d.current}</span>
                {d.note && <span className="min-w-0 basis-full pl-1 text-[10.5px] leading-snug text-muted-foreground">{d.note}</span>}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Rename
// ---------------------------------------------------------------------------

export interface PendingRename {
  row: DemoRow;
  action: ActionDescriptorWire;
}

/**
 * Naming a run does not touch its identity: the subject, the trace id and the
 * `#run` ordinal all stay exactly as they were. That is the whole reason a
 * rename is safe to offer on a row that has already written to UCPath.
 */
export function RenameRunDialog({
  pending,
  onCancel,
  onConfirm,
}: {
  pending: PendingRename | null;
  onCancel: () => void;
  onConfirm: (pending: PendingRename, name: string) => void;
}) {
  const [name, setName] = useState("");
  useEffect(() => setName(pending?.row.displayName ?? ""), [pending]);
  const row = pending?.row;

  return (
    <Dialog open={Boolean(pending)} onOpenChange={(open) => !open && onCancel()}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-[14px]">
            <Pencil aria-hidden className="size-4 shrink-0 text-muted-foreground" />
            {row?.displayName ? "Rename this run" : "Name this run"}
          </DialogTitle>
          <DialogDescription className="text-[12px] leading-relaxed">
            A name for your own use — it rides the queue row and the receipt. The subject, the trace id and the run number are untouched, so
            everything in history still matches.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-1.5 px-1">
          <label htmlFor="demo-rename" className="text-[11px] text-muted-foreground">
            Name
          </label>
          <input
            id="demo-rename"
            value={name}
            autoFocus
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && name.trim() && pending) onConfirm(pending, name.trim());
            }}
            placeholder={row?.title || "Friday exception pack"}
            className="rounded-md border border-border bg-card px-2 py-1 text-[12px] text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
          {row && (
            <p className="font-mono text-[10.5px] text-muted-foreground">
              subject {row.title || "—"} · {row.trace} · #{row.run}
              {row.elapsedSec !== undefined ? ` · ${fmtElapsed(row.elapsedSec)}` : ""}
            </p>
          )}
        </div>
        <DialogFooter>
          <button
            type="button"
            onClick={onCancel}
            className="rounded-md border border-border bg-card px-3 py-1 text-[12px] font-medium text-secondary-foreground outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
          >
            Keep the name it has
          </button>
          <button
            type="button"
            disabled={!name.trim()}
            onClick={() => pending && onConfirm(pending, name.trim())}
            className="rounded-md border border-primary bg-primary px-3 py-1 text-[12px] font-semibold text-primary-foreground outline-none hover:bg-primary/90 focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40"
          >
            Save the name
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
