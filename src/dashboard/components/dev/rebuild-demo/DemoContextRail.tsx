import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ArrowDownToLine,
  ArrowRight,
  ArrowUpFromLine,
  ClipboardList,
  Database,
  History,
  Lock,
  Maximize2,
  Minimize2,
  PanelRightClose,
  PanelRightOpen,
  Play,
  RotateCcw,
  Save,
  TriangleAlert,
  Users,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  Badge,
  Banner,
  Button,
  Chip,
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  Field,
  IconButton,
  MetaLine,
  SectionLabel,
  Separator,
  Textarea,
  Well,
  dsFocus,
  dsIcon,
  dsMotion,
  dsText,
  useToasts,
} from "./demo-ui";
import { EvidenceSection, SystemChip } from "./DemoEvidence";
import { RunIdentityStrip, RunSelector } from "./DemoRunIdentity";
import { actionsAt, fmtClock, type ActionDescriptorWire } from "./demo-wire";
import {
  checkpointAge,
  checkpointFor,
  editPolicyFor,
  editPolicySummary,
  freshnessOf,
  type DemoEditLock,
} from "./demo-flows-wire";
import type { DemoActionHandler } from "./DemoActions";
import type { DemoCommandResult } from "./demo-commands";
import { DEMO_ROWS, linkedGroupSummary, type DemoDataPoint, type DemoRow } from "./demo-data";

/**
 * DEV-ONLY — the run's CONTEXT RAIL: the third column of the detail region.
 *
 * WHY IT EXISTS. The Log Panel used to stack nine bands over one scrolling
 * body — run header, delegation link, linked-children chip, outcome bar,
 * identity strip, attempt selector, gate banner, timeline, evidence strip, tab
 * bar. Measured at 1280×720 that was 380–410px of chrome over a 542px panel,
 * which left the log stream — the one thing the panel is opened for — about
 * 125px. Every band was in normal flow, so each one was subtracted from the
 * stream.
 *
 * The bands were not all the same KIND of thing, which is what made the stack
 * wrong rather than merely tall. Two kinds were wearing one shape:
 *
 *  - **live state** — what the run is doing and what it needs from you. Read
 *    continuously, changes constantly. That stays in the centre column.
 *  - **reference** — what it read and wrote, what it captured, who asked for
 *    it, which attempt this is, what it was delegated by. Read on demand,
 *    changes rarely. That is this rail.
 *
 * So the split is by reading pattern, not by importance: nothing was deleted
 * and nothing was hidden behind a hover. The Data surface in particular STOPS
 * being a tab — the operator asked to watch the stream and see what the run
 * touched at the same time, and two mutually-exclusive tabs made that
 * impossible.
 *
 * WHAT DOES NOT MOVE. The decision and the failure record stay in the centre
 * column, always, never behind an interaction: `Waiting on you` and `Failed`
 * are the only two things allowed to shout (DESIGN.md rule 1), and a decision
 * parked in a collapsible rail is a decision that never gets made.
 *
 * The Data surface's CONTRACT is unchanged (D19c): reads are editable, writes
 * are shown and never editable, staged is staged, unconfirmed is unconfirmed,
 * and nothing gains success styling it has not earned.
 *
 * ORDER, and where the editing happens (2026-07-27, operator direction).
 * EVIDENCE COMES FIRST — it is what an operator reaches for while reading a
 * run, and it was sitting underneath the longest section on the rail. And DATA
 * IS ONE SURFACE again: the `Edit & re-run` Dialog is gone, reads are corrected
 * in place in the ledger itself, and the two outcomes — carry THIS run on with
 * these values, or start a NEW run from them — are that ledger's own footer. A
 * dialog turned "correct a value" into "open a thing, correct a value, close
 * the thing", which is the same mutual exclusion that moving Data off the tab
 * set existed to end. 348px is tight for editing, so the surface WIDENS itself
 * (`--ds-w-context-rail-wide`) instead of hiding in a modal.
 *
 * The ledger's row is deliberately the shape the old Data TAB had — direction
 * icon, quiet label, value in tabular mono, badges, system, clock — narrowed
 * rather than redrawn, because the operator recognises that row.
 */

// ---------------------------------------------------------------------------
// open / collapsed, persisted
// ---------------------------------------------------------------------------

const RAIL_STORAGE_KEY = "rebuild-demo.context-rail";

function readStoredRailOpen(): boolean {
  if (typeof window === "undefined") return true;
  try {
    return window.localStorage.getItem(RAIL_STORAGE_KEY) !== "closed";
  } catch {
    // A blocked localStorage (private mode, storage off) is a real browser
    // state, not a failed read: it means there is no stored preference, which
    // is the documented default — open.
    return true;
  }
}

/**
 * The three-column threshold, as a matchMedia the LAYOUT also uses. It is here
 * in JS as well as in the class names for one reason: collapsing is a
 * three-column affordance. Below the threshold the region is a scrolling stack,
 * and a collapsed spine there would hide Data and Evidence behind a control
 * that gives back 34px of a column that no longer exists — so the stored
 * preference is simply not applied at that width.
 */
const THREE_COLUMN_QUERY = "(min-width: 1280px)";

function useThreeColumnRegion(): boolean {
  const [wide, setWide] = useState(() =>
    typeof window === "undefined" ? true : window.matchMedia(THREE_COLUMN_QUERY).matches,
  );
  useEffect(() => {
    const mq = window.matchMedia(THREE_COLUMN_QUERY);
    const onChange = () => setWide(mq.matches);
    onChange();
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return wide;
}

export interface ContextRailState {
  open: boolean;
  collapsed: boolean;
  setOpen: (open: boolean) => void;
  /**
   * The Data surface has taken the rail over to be edited in. Deliberately NOT
   * persisted: open/closed is a preference, "I am editing right now" is a task,
   * and a rail that boots 520px wide because of something the operator did
   * yesterday would be answering a question nobody asked.
   */
  dataExpanded: boolean;
  setDataExpanded: (expanded: boolean) => void;
}

export function useContextRail(): ContextRailState {
  const [open, setOpenState] = useState(readStoredRailOpen);
  const [dataExpanded, setDataExpanded] = useState(false);
  const wide = useThreeColumnRegion();
  const setOpen = useCallback((next: boolean) => {
    setOpenState(next);
    if (!next) setDataExpanded(false);
    try {
      window.localStorage.setItem(RAIL_STORAGE_KEY, next ? "open" : "closed");
    } catch {
      // An unwritable store loses the preference for next time. That is not a
      // reason to refuse the operator this one.
    }
  }, []);
  return { open, collapsed: !open && wide, setOpen, dataExpanded, setDataExpanded };
}

// ---------------------------------------------------------------------------
// The Data surface — ONE surface: the ledger AND its editing, together
// ---------------------------------------------------------------------------

/**
 * What the PARENT will do with this run's answer. A delegated helper run seen
 * from its own panel is context-free without this line: you can read what it
 * looked up, but not why anybody wanted it (delegation §5-S7).
 */
function FeedsIntoLine({ row }: { row: DemoRow }) {
  if (!row.feedsInto) return null;
  const target = row.feedsInto.targetRunId ? DEMO_ROWS[row.feedsInto.targetRunId] : undefined;
  return (
    <div
      className={cn(
        "flex flex-col gap-[var(--ds-space-hair)] border px-[var(--ds-space-base)] py-[var(--ds-space-snug)]",
        "rounded-[var(--ds-radius-md)] border-[color:var(--ds-info-border)] bg-[var(--ds-info-bg)]",
      )}
    >
      <span className={cn(dsText.caps, "text-[color:var(--ds-info-fg)]")}>Result feeds</span>
      <span className={cn(dsText.body, "text-[color:var(--ds-fg-secondary)]")}>{row.feedsInto.label}</span>
      {target && <span className={cn(dsText.meta, dsText.nums, "text-[color:var(--ds-fg-muted)]")}>{target.trace}</span>}
    </div>
  );
}

/**
 * ONE value the run touched — the row from the old Data TAB, narrowed.
 *
 * Same shape and same reading order as the tab had, because that is the row the
 * operator knows: DIRECTION as an icon, the field label quiet, the value in
 * tabular mono and doing the work, then what is true about it (refreshed /
 * staged / unconfirmed / why it is locked), then which system and when.
 *
 * The narrowing is honest rather than decorative. The rail is ~316px of usable
 * width, so the clock folds away below a container width and comes back the
 * moment the surface is expanded — a timestamp is the least load-bearing thing
 * on the line, and dropping it beats truncating the value. Nothing else is
 * removed; the label gives up width first, the value last.
 */
function LedgerRow({
  point,
  base,
  value,
  policy,
  dirty,
  refreshed,
  onEdit,
}: {
  point: DemoDataPoint;
  /** what the server holds for this field at the generation we are on */
  base: string;
  value: string;
  policy: DemoEditLock;
  dirty: boolean;
  refreshed?: string;
  onEdit: (next: string) => void;
}) {
  const Icon = point.dir === "read" ? ArrowDownToLine : ArrowUpFromLine;
  return (
    <div className="flex items-center gap-[var(--ds-space-tight)] py-[var(--ds-space-hair)]">
      <Icon aria-hidden className={cn(dsIcon.sm, "shrink-0 text-[color:var(--ds-fg-muted)]")} />
      <span
        title={point.field}
        className={cn(dsText.meta, "w-24 shrink-0 truncate text-[color:var(--ds-fg-muted)]", "@min-[26rem]:w-36")}
      >
        {point.field}
      </span>
      {dirty && <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-[var(--ds-status-waiting-mark)]" />}
      {policy.editable ? (
        <input
          aria-label={`${point.field} — edit this read value`}
          value={value}
          onChange={(e) => onEdit(e.target.value)}
          className={cn(
            "min-w-0 flex-1 border bg-transparent px-[var(--ds-space-tight)]",
            "h-[var(--ds-h-sm)] rounded-[var(--ds-radius-md)]",
            dsText.body,
            dsText.nums,
            dsFocus,
            dsMotion.fast,
            "text-[color:var(--ds-fg)]",
            dirty
              ? "border-[color:var(--ds-status-waiting-border)] bg-[var(--ds-status-waiting-bg)]"
              : "border-transparent hover:border-[color:var(--ds-border)] focus:border-[color:var(--ds-border)]",
          )}
        />
      ) : (
        <span className="flex min-w-0 flex-1 items-center gap-[var(--ds-space-tight)]" title={policy.reason}>
          <Lock aria-hidden className={cn(dsIcon.sm, "shrink-0 text-[color:var(--ds-fg-faint)]")} />
          <span title={base} className={cn(dsText.body, dsText.nums, "min-w-0 flex-1 truncate text-[color:var(--ds-fg)]")}>
            {base}
          </span>
          {/* The one-word WHY. It folds away in the narrow rail — the lock
              icon, the direction arrow and the surface's own summary line all
              still say it, and the sentence is on the row's title — because at
              316px a two-badge row was truncating the VALUE, which is the one
              thing on the line that cannot be recovered from anywhere else. */}
          <Badge className="hidden shrink-0 @min-[26rem]:inline-flex">{policy.tag}</Badge>
        </span>
      )}
      {refreshed !== undefined && (
        <Badge tone="info" className="shrink-0" title={`This value changed on the server: ${point.value} → ${refreshed}`}>
          refreshed
        </Badge>
      )}
      {point.staged && (
        <Badge tone="warning" className="shrink-0">
          staged
        </Badge>
      )}
      {point.unconfirmed && (
        <Badge
          tone="warning"
          className="shrink-0"
          title="Sent, but never read back — the outcome is unknown until you resolve the park"
        >
          unconfirmed
        </Badge>
      )}
      <SystemChip system={point.system} className="mr-0 shrink-0" />
      <span className={cn(dsText.micro, dsText.nums, "hidden shrink-0 text-[color:var(--ds-fg-faint)] @min-[26rem]:inline")}>
        {point.ts}
      </span>
    </div>
  );
}

/**
 * The merged Data surface (D19c), living in the rail with its editing intact.
 *
 * Everything the `Edit & re-run` dialog used to do happens HERE now:
 *
 *  1. **Edit-unlock rules by run state.** `editPolicyFor` is still the one place
 *     a field's editability is decided, and the REASON is always shown — a
 *     greyed box with no explanation is how an operator learns to distrust a
 *     screen.
 *  2. **CAS on the checkpoint generation.** A save carries the generation the
 *     surface was captured at. If the checkpoint moved the save is REFUSED and
 *     the patch is kept and re-offered field by field against the fresh values.
 *     A patch is never silently dropped and never merged blind.
 *  3. **Freshness.** Reusing values older than the consuming node accepts takes
 *     an explicit, audited override — or a re-read. That confirm is still a
 *     dialog, because it is a question with a typed answer, not a surface.
 *
 * And it keeps the two outcomes APART, in words: the save arm either continues
 * THIS run or just records a correction (the server decides which by sending
 * one descriptor or the other), and beside it `Start a new run with these
 * values` mints a separate run with its own trace and its own receipt.
 */
function DataSection({
  row,
  onAction,
  tick,
  expanded,
  onExpandedChange,
}: {
  row: DemoRow;
  onAction: DemoActionHandler;
  tick: number;
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
}) {
  const { toast } = useToasts();
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [seededFrom, setSeededFrom] = useState<number | null>(null);
  const [conflict, setConflict] = useState<DemoCommandResult | null>(null);
  const [baseGeneration, setBaseGeneration] = useState<number | null>(null);
  const [freshnessPending, setFreshnessPending] = useState<ActionDescriptorWire | null>(null);
  const [overrideReason, setOverrideReason] = useState("");

  useEffect(() => {
    setEdits({});
    setSeededFrom(null);
    setConflict(null);
    setBaseGeneration(null);
    setFreshnessPending(null);
    setOverrideReason("");
  }, [row.id]);

  const cp = checkpointFor(row);
  const held = baseGeneration ?? cp.heldGeneration;
  const fresh = freshnessOf(cp, tick);
  const dataActions = actionsAt(row.actions, "data");
  /**
   * The save arm is whichever one the server sent. `continue-with-data` on a
   * run that still has work to release, `edit-checkpoint` on one that does not,
   * and NEITHER on a parked run — where saving a checkpoint and releasing work
   * on an unknown write is how somebody gets terminated twice (D20).
   */
  const saveAction = dataActions.find((a) => a.command === "continue-with-data" || a.command === "edit-checkpoint");
  const rerunAction = dataActions.find((a) => a.command === "rerun-with-existing-data");
  const continues = saveAction?.command === "continue-with-data";

  const reads = row.data.filter((d) => d.dir === "read");
  const writes = row.data.filter((d) => d.dir === "write");
  const staged = writes.filter((d) => d.staged).length;
  const unconfirmed = writes.filter((d) => d.unconfirmed).length;
  const steps = [...new Set(row.data.map((d) => d.step))];

  const baseValue = (point: DemoDataPoint) =>
    held >= cp.serverGeneration ? (cp.freshValues[point.field] ?? point.value) : point.value;
  const refreshedValue = (point: DemoDataPoint) =>
    held >= cp.serverGeneration ? cp.freshValues[point.field] : undefined;

  const changed = reads.filter((d) => edits[d.field] !== undefined && edits[d.field] !== baseValue(d));
  // Why the values cannot be touched, in one sentence, so a locked ledger never
  // reads as a broken one. Writes are locked BY CONTRACT, so they never count.
  const locked = reads.length > 0 && reads.every((d) => !editPolicyFor(row, d).editable);
  const lockReason = locked ? editPolicyFor(row, reads[0]) : null;

  const submitSave = (generation: number) => {
    if (!saveAction) return;
    const payload: Record<string, string> = { expectedGeneration: String(generation) };
    for (const d of changed) payload[d.field] = edits[d.field];
    const result = onAction(row, { ...saveAction, payload });
    if (!result) return;
    if (result.state === "conflict") {
      setConflict(result);
      toast({
        tone: "warning",
        title: "Not saved — the checkpoint moved",
        description: `Your ${changed.length} edit${changed.length === 1 ? "" : "s"} are still here and are being re-offered against the values the server now holds. Nothing was overwritten.`,
      });
      return;
    }
    setConflict(null);
    toast({ tone: "success", title: result.headline, description: result.detail });
  };

  const submitRerun = (payload: Record<string, string>) => {
    if (!rerunAction) return;
    const result = onAction(row, { ...rerunAction, payload });
    setFreshnessPending(null);
    setOverrideReason("");
    if (result?.state === "applied") toast({ tone: "info", title: result.headline, description: result.detail });
  };

  return (
    <section aria-label="Data" className="flex shrink-0 flex-col gap-[var(--ds-space-snug)]">
      <div className="flex items-center gap-[var(--ds-space-snug)]">
        <SectionLabel className="min-w-0 truncate">Data</SectionLabel>
        {/* The expand affordance, not a modal: 348px is tight for typing a date
            into, so the surface takes the room it needs and gives it back. */}
        <IconButton
          size="sm"
          className="ml-auto"
          label={expanded ? "Narrow the data surface" : "Widen the data surface to edit"}
          onClick={() => onExpandedChange(!expanded)}
          icon={
            expanded ? (
              <Minimize2 aria-hidden className={dsIcon.md} />
            ) : (
              <Maximize2 aria-hidden className={dsIcon.md} />
            )
          }
        />
      </div>

      <FeedsIntoLine row={row} />

      {row.data.length === 0 ? (
        <p className={cn(dsText.meta, "text-[color:var(--ds-fg-muted)]")}>
          No data points recorded — this run has not read or written anything yet.
        </p>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-[var(--ds-space-tight)]">
            <Chip label="read">{String(reads.length)}</Chip>
            {writes.length > 0 && <Chip label="written">{String(writes.length)}</Chip>}
            {staged > 0 && (
              <Chip tone="warning" label="staged">
                {String(staged)}
              </Chip>
            )}
            {unconfirmed > 0 && (
              <Chip
                tone="warning"
                label="unconfirmed"
                title="Sent, but never read back — the outcome is unknown until you resolve the park"
              >
                {String(unconfirmed)}
              </Chip>
            )}
            <Chip
              label="gen"
              tone={fresh.stale ? "warning" : "neutral"}
              title={`Captured ${checkpointAge(cp, tick)} ago · the ${cp.consumingNode} node accepts reads up to ${cp.maxAgeMin}m old`}
            >
              {fresh.stale ? `${held} · ${fresh.ageMin}m old` : String(held)}
            </Chip>
          </div>

          {locked && lockReason && !lockReason.editable && (
            <Banner tone="info" title="These values cannot be edited right now" icon={<Lock aria-hidden className={dsIcon.md} />}>
              {lockReason.reason}
            </Banner>
          )}

          {/* The CAS refusal. The patch is HELD — the operator decides field by
              field against the fresh values, and nothing is merged for them. */}
          {conflict && (
            <Banner tone="danger" title={conflict.headline} icon={<TriangleAlert aria-hidden className={dsIcon.md} />}>
              <span className="block">{conflict.detail}</span>
              {cp.movedBecause && (
                <span className={cn(dsText.meta, "mt-[var(--ds-space-tight)] block text-[color:var(--ds-fg-muted)]")}>
                  The checkpoint moved because {cp.movedBecause}.
                </span>
              )}
              <span className="mt-[var(--ds-space-base)] flex flex-col gap-[var(--ds-space-tight)]">
                {changed.map((d) => (
                  <span key={d.field} className={cn(dsText.meta, "flex flex-wrap items-center gap-[var(--ds-space-tight)]")}>
                    <span className="w-32 shrink-0 text-[color:var(--ds-fg-muted)]">{d.field}</span>
                    <Chip label="yours">{edits[d.field]}</Chip>
                    <Chip label="server now">{cp.freshValues[d.field] ?? d.value}</Chip>
                    <button
                      type="button"
                      onClick={() => setEdits((prev) => Object.fromEntries(Object.entries(prev).filter(([k]) => k !== d.field)))}
                      className={cn(dsText.meta, "underline underline-offset-2 text-[color:var(--ds-fg-secondary)]", dsFocus)}
                    >
                      take the server&apos;s
                    </button>
                  </span>
                ))}
              </span>
              <span className="mt-[var(--ds-space-base)] flex flex-wrap gap-[var(--ds-space-base)]">
                <Button
                  size="sm"
                  variant="primary"
                  onClick={() => {
                    setBaseGeneration(cp.serverGeneration);
                    submitSave(cp.serverGeneration);
                  }}
                >
                  {`Keep my edits and save against generation ${cp.serverGeneration}`}
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => {
                    setEdits({});
                    setBaseGeneration(cp.serverGeneration);
                    setConflict(null);
                  }}
                >
                  Discard my edits and load the fresh checkpoint
                </Button>
              </span>
            </Banner>
          )}

          {/* The ledger, grouped by STEP — the run's own order, so a value is
              read next to the thing that read it. */}
          <div className="flex flex-col gap-[var(--ds-space-base)]">
            {steps.map((step) => (
              <div key={step} className="flex flex-col">
                <div className="flex items-center gap-[var(--ds-space-snug)]">
                  <span className={cn(dsText.meta, "min-w-0 truncate font-semibold text-[color:var(--ds-fg-secondary)]")}>
                    {step}
                  </span>
                  <span aria-hidden className="h-px flex-1 bg-[var(--ds-border-subtle)]" />
                </div>
                {row.data
                  .filter((d) => d.step === step)
                  .map((d, i) => {
                    const base = baseValue(d);
                    const value = edits[d.field] ?? base;
                    return (
                      <LedgerRow
                        key={`${d.field}-${i}`}
                        point={d}
                        base={base}
                        value={value}
                        policy={editPolicyFor(row, d)}
                        dirty={value !== base}
                        refreshed={refreshedValue(d)}
                        onEdit={(next) => setEdits((prev) => ({ ...prev, [d.field]: next }))}
                      />
                    );
                  })}
              </div>
            ))}
          </div>

          <p className={cn(dsText.meta, "text-[color:var(--ds-fg-muted)]")}>
            {locked && lockReason && !lockReason.editable ? lockReason.reason : editPolicySummary(row)}
          </p>

          {/* The two outcomes. They are DESCRIPTORS (`actions[]` at the `data`
              placement) — a row whose checkpoint may not be saved is simply not
              sent a save arm, so there is nothing here to disable, and a parked
              row is sent neither. */}
          {(saveAction || rerunAction) && (
            <div className="flex flex-col gap-[var(--ds-space-snug)] border-t border-[color:var(--ds-border-subtle)] pt-[var(--ds-space-snug)]">
              <MetaLine
                items={[
                  seededFrom !== null && changed.length === 0
                    ? `Loaded run #${seededFrom} — edit anything above`
                    : changed.length === 0
                      ? "Unchanged — either outcome would use exactly these values"
                      : `${changed.length} value${changed.length === 1 ? "" : "s"} changed`,
                  continues ? "this run resumes · or start a separate one" : "a correction · or a separate run",
                ]}
              />
              <div className="flex flex-wrap items-center gap-[var(--ds-space-tight)]">
                <Button
                  size="sm"
                  variant="ghost"
                  icon={<History aria-hidden className={dsIcon.sm} />}
                  onClick={() => {
                    setSeededFrom(Math.max(row.run - 1, 1));
                    setEdits(
                      Object.fromEntries(
                        reads
                          .filter((f) => editPolicyFor(row, f).editable)
                          .slice(0, 2)
                          .map((f) => [f.field, baseValue(f)]),
                      ),
                    );
                  }}
                >
                  Load a prior run
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  icon={<RotateCcw aria-hidden className={dsIcon.sm} />}
                  disabled={changed.length === 0 && seededFrom === null}
                  onClick={() => {
                    setEdits({});
                    setSeededFrom(null);
                  }}
                >
                  Reset
                </Button>
                <span aria-hidden className="flex-1" />
                {/* Exactly one of these two carries `primary`, and the SERVER
                    picks which: on a run with work left to release, continuing
                    it is the affirmative action; on one with nothing left,
                    starting a new run is. */}
                {saveAction && (
                  <Button
                    size="sm"
                    variant={saveAction.intent === "primary" ? "primary" : "secondary"}
                    icon={continues ? <Play aria-hidden className={dsIcon.sm} /> : <Save aria-hidden className={dsIcon.sm} />}
                    disabled={changed.length === 0}
                    title={saveAction.detail}
                    onClick={() => submitSave(held)}
                  >
                    {saveAction.label}
                  </Button>
                )}
                {rerunAction && (
                  <Button
                    size="sm"
                    variant={rerunAction.intent === "primary" ? "primary" : "secondary"}
                    icon={<Play aria-hidden className={dsIcon.sm} />}
                    title={rerunAction.detail}
                    onClick={() => (fresh.stale ? setFreshnessPending(rerunAction) : submitRerun({ freshness: "within-limit" }))}
                  >
                    {rerunAction.label}
                  </Button>
                )}
              </div>
            </div>
          )}
        </>
      )}

      {/* Freshness. Reusing a stale read is allowed — but only deliberately,
          with a reason that goes into the run's evidence. This one stays a
          dialog on purpose: it is a question with a typed answer and two
          mutually exclusive exits, which is what a dialog is for. */}
      <Dialog open={Boolean(freshnessPending)} onOpenChange={(next) => !next && setFreshnessPending(null)}>
        <DialogContent
          size="md"
          title="These values are older than the next write accepts"
          description={`Captured ${checkpointAge(cp, tick)} ago. The ${cp.consumingNode} node accepts reads up to ${cp.maxAgeMin} minutes old, so reusing them is a decision, not a default.`}
        >
          <DialogBody className="flex flex-col gap-[var(--ds-space-cozy)]">
            <Well className="flex flex-wrap items-center gap-[var(--ds-space-snug)]">
              <Chip label="captured">{fmtClock(cp.capturedAt)}</Chip>
              <Chip label="age" tone="warning">{`${fresh.ageMin}m`}</Chip>
              <Chip label="limit">{`${fresh.maxAgeMin}m`}</Chip>
              <Chip label="consumed by">{fresh.consumingNode}</Chip>
            </Well>
            <Field
              label="Why reuse them?"
              description="Recorded on the new run's receipt beside every reused value, so a replay is never mistaken for a fresh observation."
            >
              <Textarea
                rows={2}
                value={overrideReason}
                onChange={(e) => setOverrideReason(e.target.value)}
                placeholder="Kuali is read-only until 5 PM; these values were confirmed against the paper form this morning."
              />
            </Field>
          </DialogBody>
          <DialogFooter>
            <Button variant="secondary" onClick={() => setFreshnessPending(null)}>
              Cancel
            </Button>
            <Button
              variant="dangerGhost"
              disabled={overrideReason.trim().length < 8}
              onClick={() => submitRerun({ freshness: "override", reason: overrideReason.trim() })}
            >
              Override — reuse these values
            </Button>
            <Button variant="primary" onClick={() => submitRerun({ freshness: "re-read" })}>
              Re-read live instead
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Provenance — who, which attempt, delegated by what
// ---------------------------------------------------------------------------

/**
 * The cross-panel delegation links. A `linked` child and its parent point at
 * each other instead of duplicating the run, and the link CHANGES PANEL rather
 * than pulling a copy of the row into this one.
 *
 * They live here, not in the centre column, because they are navigation to
 * somewhere ELSE — nothing about them changes as the run progresses, and D13's
 * loud case (a failed linked child) is carried by the failure record in the
 * centre, which mirrors the child's error verbatim.
 */
function DelegationLinks({ row, onOpenPanel }: { row: DemoRow; onOpenPanel: (workflow: string, id: string) => void }) {
  const linkedTarget = row.reviewRunId ?? row.reviewOf ?? row.linkedParentId;
  const linked = linkedGroupSummary(row);
  const target = linkedTarget ? DEMO_ROWS[linkedTarget] : undefined;
  if (!target && !linked) return null;

  const linkClass = cn(
    "flex w-full cursor-pointer items-start gap-[var(--ds-space-snug)] border text-left",
    "px-[var(--ds-space-base)] py-[var(--ds-space-snug)] rounded-[var(--ds-radius-md)]",
    dsText.body,
    dsFocus,
    dsMotion.fast,
    "border-[color:var(--ds-info-border)] bg-[var(--ds-info-bg)] text-[color:var(--ds-info-fg)]",
    "hover:brightness-125",
  );

  return (
    <section aria-label="Delegation" className="flex flex-col gap-[var(--ds-space-snug)]">
      <SectionLabel>Delegation</SectionLabel>
      {target && linkedTarget && (
        <button type="button" onClick={() => onOpenPanel(target.wfLabel, linkedTarget)} className={linkClass}>
          <ClipboardList aria-hidden className={cn(dsIcon.md, "mt-px shrink-0")} />
          <span className="min-w-0 flex-1">
            {row.reviewRunId
              ? `Records live on the OCR review row — open the OCR panel (${DEMO_ROWS[row.reviewRunId]?.records?.length ?? 0} people)`
              : row.reviewOf
                ? `Delegated by ${DEMO_ROWS[row.reviewOf]?.title ?? "the packet"} — open the packet row`
                : // one level of back, no breadcrumb trail: `← OCR · <packet>`
                  `← ${target.wfLabel} · ${target.title} — the run that asked for this one`}
          </span>
          <ArrowRight aria-hidden className={cn(dsIcon.sm, "mt-px shrink-0")} />
        </button>
      )}
      {linked && (
        <button type="button" onClick={() => onOpenPanel(linked.panel, linked.targetId)} className={linkClass}>
          <Users aria-hidden className={cn(dsIcon.md, "mt-px shrink-0")} />
          <span className="min-w-0 flex-1">
            {linked.label} — {linked.total === 1 ? "it runs" : "each runs"} in the {linked.panel} panel, counted there and
            not here
          </span>
          <ArrowRight aria-hidden className={cn(dsIcon.sm, "mt-px shrink-0")} />
        </button>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// the rail
// ---------------------------------------------------------------------------

export function ContextRailSpine({ row, onOpen, className }: { row: DemoRow; onOpen: () => void; className?: string }) {
  return (
    <aside
      aria-label="Run context, collapsed"
      className={cn(
        "flex min-h-0 flex-col items-center gap-[var(--ds-space-base)] overflow-hidden border pb-[var(--ds-space-base)]",
        "border-[color:var(--ds-border)] bg-[var(--ds-surface-1)] rounded-[var(--ds-radius-lg)]",
        className,
      )}
    >
      {/* The swap is instant — it retargets a grid column, which is a layout
          property nothing may animate, and this is a control the operator
          presses often. With no motion to carry the eye, POSITION does it: the
          expand button sits on the same baseline as the collapse button it
          replaces, so undoing the press needs no pointer travel. */}
      <span className="flex h-[var(--ds-h-bar)] shrink-0 items-center">
        <IconButton
          label="Show run context — data, evidence and provenance"
          size="sm"
          onClick={onOpen}
          icon={<PanelRightOpen aria-hidden className={dsIcon.md} />}
        />
      </span>
      {/* A collapsed rail still says what is in it. A blank spine is a control
          the operator has to click to find out whether it was worth clicking. */}
      <span className={cn(dsText.caps, "[writing-mode:vertical-rl] text-[color:var(--ds-fg-muted)]")}>Context</span>
      <span className={cn(dsText.micro, dsText.nums, "[writing-mode:vertical-rl] text-[color:var(--ds-fg-faint)]")}>
        {row.data.length} data · {row.shots.length} captures
      </span>
    </aside>
  );
}

export function ContextRail({
  row,
  onOpenPanel,
  onAction,
  onClose,
  tick,
  isMember,
  dataExpanded,
  onDataExpandedChange,
  className,
}: {
  row: DemoRow;
  onOpenPanel: (workflow: string, id: string) => void;
  onAction: DemoActionHandler;
  onClose: () => void;
  tick: number;
  /** a member inherits its identity from its group, so that strip stays off it */
  isMember: boolean;
  /** the Data surface has the rail to itself, to be edited in */
  dataExpanded: boolean;
  onDataExpandedChange: (expanded: boolean) => void;
  className?: string;
}) {
  const sections = useMemo(
    () => ({
      hasDelegation: Boolean(row.reviewRunId ?? row.reviewOf ?? row.linkedParentId) || Boolean(linkedGroupSummary(row)),
    }),
    [row],
  );

  return (
    <aside
      aria-label="Run context"
      className={cn(
        // A CONTAINER, so the ledger row can decide for itself whether the
        // clock fits. Its width is a function of the rail's own expanded state
        // as much as the window's, which a viewport query cannot see.
        "@container flex min-h-0 min-w-0 flex-col overflow-hidden border",
        "border-[color:var(--ds-border)] bg-[var(--ds-surface-1)] rounded-[var(--ds-radius-lg)]",
        className,
      )}
    >
      <header
        className={cn(
          "flex shrink-0 items-center gap-[var(--ds-space-snug)] border-b px-[var(--ds-space-cozy)]",
          "min-h-[var(--ds-h-bar)] border-[color:var(--ds-border)]",
        )}
      >
        <Database aria-hidden className={cn(dsIcon.md, "shrink-0 text-[color:var(--ds-fg-muted)]")} />
        <span className={cn(dsText.title, "min-w-0 truncate font-semibold text-[color:var(--ds-fg)]")}>
          {dataExpanded ? "Context · editing data" : "Context"}
        </span>
        <IconButton
          label="Hide run context"
          size="sm"
          className="ml-auto"
          onClick={onClose}
          icon={<PanelRightClose aria-hidden className={dsIcon.md} />}
        />
      </header>

      <div className="flex min-h-0 flex-1 flex-col gap-[var(--ds-space-cozy)] overflow-y-auto px-[var(--ds-space-cozy)] py-[var(--ds-space-cozy)]">
        {/**
         * ORDER: Evidence · Data · Provenance · Delegation.
         *
         * Evidence first on the operator's own instruction, and it holds up on
         * its own terms: it is the shortest section and the one most often
         * reached for mid-read, so putting the long editable ledger above it
         * meant scrolling past a form to look at a screenshot.
         *
         * Expanding Data hides PROVENANCE AND DELEGATION only. Evidence stays
         * where it is on purpose, and not just because the order was asked for:
         * the expand control lives in the Data section's own header, and
         * folding the section above it would teleport that control to the top
         * of the rail the moment it was pressed. Undoing a press has to cost no
         * pointer travel — the swap retargets a grid column, which is a layout
         * property nothing may animate, so there is no motion to carry the eye
         * to a button that moved.
         */}
        <EvidenceSection row={row} />
        <Separator />

        <DataSection
          row={row}
          onAction={onAction}
          tick={tick}
          expanded={dataExpanded}
          onExpandedChange={onDataExpandedChange}
        />

        {!dataExpanded && (
          <>
            <Separator />
            <section aria-label="Provenance" className="flex flex-col gap-[var(--ds-space-snug)]">
              <SectionLabel>Provenance</SectionLabel>
              {!isMember && <RunIdentityStrip row={row} />}
              <RunSelector row={row} />
            </section>
            {sections.hasDelegation && (
              <>
                <Separator />
                <DelegationLinks row={row} onOpenPanel={onOpenPanel} />
              </>
            )}
          </>
        )}

        {dataExpanded && (
          <p className={cn(dsText.meta, "text-[color:var(--ds-fg-muted)]")}>
            Provenance and delegation are hidden while you edit — narrow the surface to bring them back.
          </p>
        )}
      </div>
    </aside>
  );
}
