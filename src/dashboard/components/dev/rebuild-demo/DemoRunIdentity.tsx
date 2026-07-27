import { useEffect, useState } from "react";
import { ArrowRight, ChevronLeft, ChevronRight, FlaskConical, History, Info, Pencil, TriangleAlert } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Badge,
  BulletList,
  Button,
  Field,
  IconButton,
  Input,
  KeyValueList,
  MetaLine,
  Popover,
  PopoverContent,
  PopoverTrigger,
  SectionLabel,
  dsIcon,
  dsText,
  useDsModalPresence,
} from "./demo-ui";
import { StatusBadge } from "./demo-status";
import { attemptDuration, attemptTrace, fmtElapsed, type DemoRerunDiffEntry, type DemoRow } from "./demo-data";
import { DEMO_APP_VERSION, fmtVersionTag, workflowVersionTag, type ActionDescriptorWire } from "./demo-wire";

/**
 * DEV-ONLY — WHICH RUN IS THIS, exactly.
 *
 * Four facts the queue row can only afford a chip for, and one the demo could
 * not show at all:
 *
 *  - **Provenance bar** — the workflow version, in the Log Panel's bottom bar,
 *    with the two run HAZARDS beside it and everything else behind its ⓘ: who
 *    asked for this run, at what priority, under which app build, against which
 *    system instance, and whether a preset put values in that nobody typed.
 *    Every one of these is a served field (`requestedBy` / `priority` /
 *    `workflowVersion` / `appVersion` / `resolvedInstance` / `preset`); none is
 *    inferred.
 *  - **Run selector** — `‹ #2 of 2 ›` over the attempt lineage, so a failed
 *    first attempt is one click away instead of lost.
 *  - **Rerun diff** — what actually differed between the last two attempts.
 *    The load-bearing rule (12 §2.4): replayed data is NEVER labelled as newly
 *    observed, so a reused checkpoint says "replayed" in its own words.
 *  - **Rename** — the operator's own name for a run. It rides the row and the
 *    receipt; the trace id is untouched, so history still matches.
 *
 * NOTE ON THE FLAG VOCABULARY: `dry run` and `test instance` are drawn here with
 * the SAME hue and icon `RunFlagChips` uses in the run-start plan preview
 * (`FlaskConical` on info, `TriangleAlert` on warning). They used to disagree —
 * violet here, blue there — which meant the badge you were promised before
 * starting a run was not the badge you found on it afterwards.
 *
 * `StatusBadge` is deliberately still the legacy `demo-status` chip rather than
 * the ratified `StatusPill`: this strip renders inside the Log Panel, and the
 * status vocabulary is that panel's to reconcile, not this file's.
 */

// ---------------------------------------------------------------------------
// Identity strip
// ---------------------------------------------------------------------------

/**
 * The run's PROVENANCE, in the Log Panel's bottom bar.
 *
 * It used to be a `Provenance` section in the context rail carrying seven chips
 * — `by`, `priority`, `wf`, `app`, `test`, `dry run`, `preset` — on EVERY run.
 * Three of those were not provenance and two were not about the run at all:
 *
 *  - the **app** build is a property of the dashboard, not of a run, so it is
 *    stated once on the Sessions bar (`DemoShell`) and only reappears on a run
 *    that RAN under a different build, which is where it is a real fact;
 *  - **by** and **priority** are the same two words on every row an operator
 *    starts on their own machine, so they cost a chip each to say nothing —
 *    they moved into the ⓘ, in full, with the reason each matters;
 *  - the **workflow version** is the one that changes what a row means, and it
 *    belongs where the run's own stream is read.
 *
 * **The two hazards stay VISIBLE.** `dry run` and `test instance` are outcomes
 * about this run, not teaching, so they are never behind the disclosure — a
 * rehearsal that reads as a filing is the single most expensive misread this
 * product can produce.
 */
export function RunProvenanceBar({ row }: { row: DemoRow }) {
  const testSystems = Object.entries(row.resolvedInstance).filter(([, v]) => v === "test");
  const ranVersion = fmtVersionTag({ major: row.workflowVersion, minor: row.workflowMinorVersion });
  const shapeMoved = row.workflowVersion !== row.workflow.version;
  const staleApp = row.appVersion !== DEMO_APP_VERSION;

  return (
    <span className="flex min-w-0 shrink-0 items-center gap-[var(--ds-space-snug)]">
      <span
        title={
          shapeMoved
            ? `Ran under ${row.workflow.label} ${ranVersion}; runs are served by ${workflowVersionTag(row.workflow)} now. The run's SHAPE moved, so these are not comparable — a retry would replay retired code.`
            : `${row.workflow.label} ${ranVersion} — the version currently serving runs.`
        }
        className={cn(
          dsText.meta,
          dsText.nums,
          "shrink-0",
          shapeMoved ? "text-[color:var(--ds-status-waiting-fg)]" : "text-[color:var(--ds-fg-muted)]",
        )}
      >
        {ranVersion}
      </span>

      {/* Hazards, never disclosed. */}
      {row.dryRun && (
        <span
          title="A rehearsal: it read every system and wrote to none. The receipt says what it WOULD have written."
          className={cn(dsText.meta, "inline-flex shrink-0 items-center gap-[var(--ds-space-tight)] text-[color:var(--ds-info-fg)]")}
        >
          <FlaskConical aria-hidden className={dsIcon.sm} />
          dry run
        </span>
      )}
      {testSystems.length > 0 && (
        <span
          title={`Ran against the TEST instance of ${testSystems.map(([k]) => k).join(", ")} — nothing here reached production.`}
          className={cn(
            dsText.meta,
            "inline-flex shrink-0 items-center gap-[var(--ds-space-tight)] text-[color:var(--ds-status-waiting-fg)]",
          )}
        >
          <TriangleAlert aria-hidden className={dsIcon.sm} />
          test
        </span>
      )}

      <Popover>
        <PopoverTrigger asChild>
          <IconButton size="xs" label="Run provenance" icon={<Info aria-hidden className={dsIcon.sm} />} />
        </PopoverTrigger>
        <PopoverContent title="Provenance" description={row.trace} width="lg" side="top" align="end">
          <div className="flex flex-col gap-[var(--ds-space-base)]">
            <KeyValueList
              items={[
                { key: "Workflow", value: `${row.workflow.label} ${ranVersion}`, tone: shapeMoved ? "warning" : "default" },
                { key: "App build", value: row.appVersion, tone: staleApp ? "warning" : "default" },
                { key: "Requested by", value: row.requestedBy },
                { key: "Priority", value: row.priority },
                ...(row.displayName ? [{ key: "Named", value: row.displayName }] : []),
                ...Object.entries(row.resolvedInstance).map(([system, instance]) => ({
                  key: system,
                  value: instance,
                  tone: instance === "test" ? ("warning" as const) : ("default" as const),
                })),
              ]}
            />
            <BulletList
              items={[
                row.priority === "bulk"
                  ? "Bulk yields the worker to anything interactive — a 50-person packet must never make one urgent separation wait."
                  : "Interactive takes a worker ahead of bulk work.",
                shapeMoved
                  ? `This run's SHAPE is a prior major. It is not comparable with a ${workflowVersionTag(row.workflow)} run, and a retry would replay retired code.`
                  : "The MAJOR digit is the run's shape; the minor is presentation, so a row one minor behind is still the same run.",
                staleApp
                  ? `Served by app ${row.appVersion}; this dashboard is ${DEMO_APP_VERSION}. The app build is the other half of the archive key.`
                  : `Served by the app build this dashboard is running (${DEMO_APP_VERSION}), which is why it is stated once on the Sessions bar rather than on every run.`,
                ...(row.displayName
                  ? [`Named by you. The subject is still ${row.title} and the trace id ${row.trace} is unchanged — history matches either way.`]
                  : []),
              ]}
            />
            {row.preset && (
              <div className="flex min-w-0 flex-col gap-[var(--ds-space-tight)]">
                <SectionLabel>
                  {row.preset.source} “{row.preset.name}” — merged at enqueue
                </SectionLabel>
                <dl className="grid grid-cols-[minmax(0,128px)_minmax(0,1fr)] gap-x-[var(--ds-space-base)] gap-y-[var(--ds-space-hair)]">
                  {row.preset.merged.map((f) => (
                    <div key={f.field} className="contents">
                      <dt className={cn(dsText.meta, "truncate text-[color:var(--ds-fg-muted)]")}>{f.field}</dt>
                      <dd className={cn(dsText.meta, dsText.nums, "min-w-0 truncate text-[color:var(--ds-fg)]")}>{f.value}</dd>
                    </div>
                  ))}
                </dl>
              </div>
            )}
          </div>
        </PopoverContent>
      </Popover>
    </span>
  );
}

// ---------------------------------------------------------------------------
// Run selector + rerun diff
// ---------------------------------------------------------------------------

const DIFF_TONE: Record<DemoRerunDiffEntry["kind"], { label: string; tone: "neutral" | "info" | "warning" | "success" }> = {
  input: { label: "input", tone: "neutral" },
  checkpoint: { label: "replayed", tone: "info" },
  correction: { label: "correction", tone: "warning" },
  proof: { label: "write proof", tone: "success" },
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
    <div className="flex flex-col overflow-hidden rounded-[var(--ds-radius-md)] border border-[color:var(--ds-border-subtle)] bg-[var(--ds-surface-2)]">
      <div className="flex flex-wrap items-center gap-[var(--ds-space-snug)] px-[var(--ds-space-base)] py-[var(--ds-space-snug)]">
        <History aria-hidden className={cn(dsIcon.sm, "shrink-0 text-[color:var(--ds-fg-muted)]")} />
        <SectionLabel className="shrink-0">Attempts</SectionLabel>
        <IconButton
          label="Previous attempt"
          size="sm"
          disabled={idx === 0}
          onClick={() => setIdx((i) => Math.max(i - 1, 0))}
          icon={<ChevronLeft aria-hidden className={dsIcon.sm} />}
        />
        <span className={cn(dsText.meta, dsText.nums, "shrink-0 text-[color:var(--ds-fg)]")}>
          #{attempt.n} of {attempts.length}
        </span>
        <IconButton
          label="Next attempt"
          size="sm"
          disabled={idx === attempts.length - 1}
          onClick={() => setIdx((i) => Math.min(i + 1, attempts.length - 1))}
          icon={<ChevronRight aria-hidden className={dsIcon.sm} />}
        />
        <StatusBadge status={attempt.status} />
        <span className={cn(dsText.meta, "min-w-0 flex-1 truncate text-[color:var(--ds-fg-muted)]")}>{attempt.summary}</span>
        {duration && (
          <span className={cn(dsText.meta, dsText.nums, "shrink-0 text-[color:var(--ds-fg-muted)]")}>{duration}</span>
        )}
        <span
          className={cn(
            dsText.meta,
            dsText.nums,
            "shrink-0",
            current ? "text-[color:var(--ds-fg-muted)]" : "text-[color:var(--ds-status-waiting-fg)]",
          )}
          title={current ? "This is the attempt on screen." : "You are looking at an EARLIER attempt — the row above is the current one."}
        >
          {attemptTrace(row, attempt)}
          {!current && " · older"}
        </span>
      </div>

      {current && lineage.diff.length > 0 && (
        <div className="flex flex-col gap-[var(--ds-space-tight)] border-t border-[color:var(--ds-border-subtle)] px-[var(--ds-space-base)] py-[var(--ds-space-snug)]">
          <SectionLabel>What changed since attempt #{attempts[attempts.length - 2].n}</SectionLabel>
          {lineage.diff.map((d) => {
            const tone = DIFF_TONE[d.kind];
            const same = d.prior === d.current;
            return (
              <div key={d.label} className="flex flex-wrap items-baseline gap-x-[var(--ds-space-base)] gap-y-[var(--ds-space-hair)]">
                <Badge tone={tone.tone} className="shrink-0">
                  {tone.label}
                </Badge>
                <span className={cn(dsText.meta, "w-28 shrink-0 truncate text-[color:var(--ds-fg-muted)]")}>{d.label}</span>
                <span
                  className={cn(dsText.meta, dsText.nums, "shrink-0 text-[color:var(--ds-fg-faint)] line-through")}
                >
                  {d.prior}
                </span>
                <ArrowRight aria-hidden className={cn(dsIcon.sm, "shrink-0 text-[color:var(--ds-fg-muted)]")} />
                <span
                  className={cn(
                    dsText.meta,
                    dsText.nums,
                    "shrink-0",
                    same ? "text-[color:var(--ds-fg-muted)]" : "text-[color:var(--ds-fg)]",
                  )}
                >
                  {d.current}
                </span>
                {d.note && (
                  <span className={cn(dsText.meta, "min-w-0 basis-full text-[color:var(--ds-fg-muted)]")}>{d.note}</span>
                )}
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
 *
 * Built on the APP's dialog primitive (`@/components/ui/dialog`), not `ds`'s —
 * on purpose. That primitive does not know about `ds`'s modal registry, so a
 * persistent `danger` toast used to sit at the toast layer directly over this
 * footer and swallow every click on "Save the name", with nothing on screen to
 * explain why. `RenameDialogBody` calls `useDsModalPresence()`, which joins the
 * registry and makes the toast viewport step aside and go inert exactly as it
 * does for a `ds` Dialog. `ConfirmCommandDialog` needs the same one-line fix.
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
  return (
    <Dialog open={Boolean(pending)} onOpenChange={(open) => !open && onCancel()}>
      <DialogContent size="sm">
        {pending && <RenameDialogBody pending={pending} onCancel={onCancel} onConfirm={onConfirm} />}
      </DialogContent>
    </Dialog>
  );
}

/**
 * Mounts only while the dialog is open — which is what makes the modal-presence
 * registration correct: the count is keyed to mount, not to an `open` prop.
 */
function RenameDialogBody({
  pending,
  onCancel,
  onConfirm,
}: {
  pending: PendingRename;
  onCancel: () => void;
  onConfirm: (pending: PendingRename, name: string) => void;
}) {
  useDsModalPresence();
  const row = pending.row;
  const [name, setName] = useState(row.displayName ?? "");
  const trimmed = name.trim();

  return (
    <>
      <DialogHeader>
        <DialogTitle className={cn("flex items-center gap-[var(--ds-space-snug)]", dsText.section)}>
          <Pencil aria-hidden className={cn(dsIcon.lg, "shrink-0 text-[color:var(--ds-fg-muted)]")} />
          {row.displayName ? "Rename this run" : "Name this run"}
        </DialogTitle>
        <DialogDescription className={cn(dsText.body, "text-[color:var(--ds-fg-muted)]")}>
          A name for your own use — it rides the queue row and the receipt. The subject, the trace id and the run number are
          untouched, so everything in history still matches.
        </DialogDescription>
      </DialogHeader>

      <div className="flex flex-col gap-[var(--ds-space-snug)] px-px">
        <Field label="Name">
          <Input
            value={name}
            autoFocus
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && trimmed) onConfirm(pending, trimmed);
            }}
            placeholder={row.title || "Friday exception pack"}
          />
        </Field>
        <MetaLine
          tone="faint"
          items={[
            `subject ${row.title || "—"}`,
            row.trace,
            `#${row.run}`,
            row.elapsedSec !== undefined && fmtElapsed(row.elapsedSec),
          ]}
        />
      </div>

      <DialogFooter>
        <Button variant="secondary" onClick={onCancel}>
          Keep the name it has
        </Button>
        <Button variant="primary" disabled={!trimmed} onClick={() => onConfirm(pending, trimmed)}>
          Save the name
        </Button>
      </DialogFooter>
    </>
  );
}
