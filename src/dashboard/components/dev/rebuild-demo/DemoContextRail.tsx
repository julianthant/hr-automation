import { useCallback, useEffect, useId, useMemo, useState } from "react";
import {
  ArrowDownToLine,
  ArrowRight,
  ArrowUpFromLine,
  ClipboardList,
  Database,
  History,
  Info,
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
  BulletList,
  Button,
  Chip,
  ChipRow,
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  Field,
  IconButton,
  LockedValue,
  KeyValueList,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Refusal,
  SectionLabel,
  Separator,
  Textarea,
  ValueField,
  Well,
  dsFocus,
  dsIcon,
  dsMotion,
  dsText,
  useToasts,
} from "./demo-ui";
import { EvidenceSection, SystemChip } from "./DemoEvidence";
import { RunSelector } from "./DemoRunIdentity";
import { actionsAt, fmtClock, plural, type ActionDescriptorWire } from "./demo-wire";
import {
  appliedCorrectionsFor,
  checkpointAge,
  checkpointBaseValue,
  checkpointFor,
  editPolicyFor,
  editPolicySummary,
  freshnessOf,
  type DemoEditLock,
} from "./demo-flows-wire";
import type { DemoActionHandler } from "./DemoActions";
import { hasRefusalCode, type DemoCommandResult } from "./demo-commands";
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
 * The ledger's row STACKS in three levels — step, then sub-step, then the value
 * on its own full-width line below it (2026-07-27, operator: "have the step,
 * have the sub step and below that put the data extracted. not the substep and
 * data in one line"). Label and value used to share a line inside 348px and
 * both truncated; splitting them gives the value the whole column and the label
 * room for its whole name. See `LedgerRow`.
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
 * The direction of ONE value, said twice: an arrow AND a colour.
 *
 * The colour is the point of this component. Direction was previously carried
 * by the arrow glyph alone, in `--ds-fg-muted`, at 12px — which meant a ledger
 * of eight reads and one write looked like nine of the same thing, and the one
 * line that changed the world was the hardest to find. `--ds-read-*` /
 * `--ds-write-*` are a two-tone axis (see `ds/tokens.css`), and the rail is what
 * makes the axis SCANNABLE: a column of blue with one purple entry answers
 * "what did this run change?" without reading a word.
 *
 * The arrow stays. Colour is never the only differentiator, and it is the arrow
 * that survives a forced-colors mode or a colour-blind operator.
 */
function DirectionMark({ dir }: { dir: DemoDataPoint["dir"] }) {
  const read = dir === "read";
  const Icon = read ? ArrowDownToLine : ArrowUpFromLine;
  return (
    <span className="flex shrink-0 gap-[var(--ds-space-tight)] self-stretch">
      {/* The rail spans BOTH lines of the stacked row, which is the whole
          reason it is a rail and not a dot: it is what binds a sub-step label
          to the value printed underneath it, so an eight-row ledger still reads
          as eight things and not sixteen. */}
      <span
        aria-hidden
        className={cn(
          "w-[var(--ds-border-w-emphasis)] shrink-0 self-stretch rounded-[var(--ds-radius-pill)]",
          read ? "bg-[var(--ds-read-mark)]" : "bg-[var(--ds-write-mark)]",
        )}
      />
      {/* The arrow sits on the LABEL line, not centred across the pair — a
          glyph floating in the gutter between two lines belongs to neither. */}
      <Icon
        aria-hidden
        className={cn(
          dsIcon.sm,
          "mt-[var(--ds-space-hair)] shrink-0",
          read ? "text-[color:var(--ds-read-fg)]" : "text-[color:var(--ds-write-fg)]",
        )}
      />
      <span className="sr-only">{read ? "read" : "write"}</span>
    </span>
  );
}

/**
 * ONE value the run touched, in THREE vertical levels: step → sub-step → value.
 *
 *     OCR extraction              ← the step, once, as the group heading
 *     ▌↓ People found        I9   ← the sub-step: this field's label, quiet
 *     ▌  [ 6 (8 pages)        ✎ ] ← the value, on its own line, full width
 *
 * WHY IT STACKS (2026-07-27, operator: "have the step, have the sub step and
 * below that put the data extracted. not the substep and data in one line").
 * The label and the value used to share one line inside a 348px rail, so they
 * competed for the same pixels and the value lost: the operator's own screen
 * showed `Roster rows matc…` beside `5 approvab…` — both halves of the line
 * clipped, and a clipped VALUE is the one thing on the row that cannot be
 * recovered from anywhere else on the surface. Splitting them gives the value
 * the whole column and gives the label the room to say its whole name.
 *
 * This is ONE shape at every width. There is deliberately no "side by side
 * again when there is room" rung: a layout that re-flows into a different
 * reading order as the rail widens is two layouts to learn, and the operator
 * asked for one.
 *
 * WHAT SITS WHERE, and why that is not arbitrary. The label line is short and
 * PREDICTABLE, so it carries every fixed-width fact — what is true about the
 * value (changed / corrected / refreshed / staged / unconfirmed / why it is
 * locked), which system it came from, and when. The value line is UNBOUNDED, so
 * it carries nothing but the value. Furniture goes on the line that can afford
 * it. The hazard badges did not get quieter by moving: `staged` sits on the
 * exact row whose write is staged, which is nearer the hazard than the summary
 * chip that used to count them ever was.
 *
 * WHY THE EDITABLE ONE LOOKS LIKE A FIELD (operator: "how can i edit the
 * data"). A read value was ALREADY a real `<input>` at rest — styled
 * `border-transparent` on no background, so it looked exactly like the static
 * text beside it and the operator never found it. The capability existed and
 * the affordance did not, and a sentence at the bottom of the section saying
 * "read values are editable" is not an affordance. It now reads as a field
 * without being hovered: control-border outline, inset surface, and a pencil —
 * a control you have to discover by sweeping the pointer over the page is a
 * control that does not exist. A locked value is FLAT TEXT with its lock and no
 * box at all, so editable and locked are told apart by SHAPE, not by a badge
 * and not by colour.
 */
function LedgerRow({
  point,
  base,
  value,
  policy,
  dirty,
  refreshed,
  corrected,
  onEdit,
}: {
  point: DemoDataPoint;
  /** what the server holds for this field at the generation we are on */
  base: string;
  value: string;
  policy: DemoEditLock;
  dirty: boolean;
  refreshed?: string;
  /** the observed reading this field's applied correction replaced */
  corrected?: string;
  onEdit: (next: string) => void;
}) {
  // A real `htmlFor` pairing, which the one-line row could not have had: the
  // label sat beside the input rather than above it, so it was written as an
  // `aria-label` and the visible text was associated with nothing. Stacked, the
  // label IS the field's label — which also makes it a click target that focuses
  // the input, one more thing saying "this line takes typing".
  const fieldId = useId();
  const labelClass = cn(dsText.meta, "min-w-0 flex-1 truncate text-[color:var(--ds-fg-muted)]");
  return (
    <div className="flex gap-[var(--ds-space-tight)] py-[var(--ds-space-tight)]">
      <DirectionMark dir={point.dir} />
      <div className="flex min-w-0 flex-1 flex-col gap-[var(--ds-space-hair)]">
        {/* LEVEL 2 — the sub-step. It gives up width to the badges, never the
            other way round, because a truncated label still has its full text
            one hover away and a truncated badge would be unreadable. */}
        <div className="flex items-center gap-[var(--ds-space-tight)]">
          {policy.editable ? (
            <label htmlFor={fieldId} title={point.field} className={cn(labelClass, "cursor-text")}>
              {point.field}
            </label>
          ) : (
            <span title={point.field} className={labelClass}>
              {point.field}
            </span>
          )}
          {/* A WORD, not just the amber fill on the field below it — the fill
              is the fast signal and the word is the one that survives a
              colour-blind operator or a forced-colors mode. */}
          {dirty && (
            <Badge tone="warning" className="shrink-0" title="You changed this value. It is not saved yet.">
              changed
            </Badge>
          )}
          {corrected !== undefined && (
            <Badge
              tone="info"
              className="shrink-0"
              title={`You corrected this value. The run observed “${corrected}”, which is kept beside your correction on the receipt.`}
            >
              corrected
            </Badge>
          )}
          {refreshed !== undefined && (
            <Badge
              tone="info"
              className="shrink-0"
              title={`This value changed on the server: ${point.value} → ${refreshed}`}
            >
              refreshed
            </Badge>
          )}
          {point.staged && (
            <Badge
              tone="warning"
              className="shrink-0"
              title="Filled but not submitted — it goes live when the run continues"
            >
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
          {/* The one-word WHY this value has no box. The lock icon on the line
              below says THAT it is locked; only this says which rule locked it. */}
          {!policy.editable && (
            <Badge className="shrink-0" title={policy.reason}>
              {policy.tag}
            </Badge>
          )}
          <SystemChip system={point.system} className="mr-0 shrink-0" />
          {/* A timestamp is the least load-bearing thing here, so it is the
              first thing to fold away in the narrow rail and the first to come
              back when the surface is widened to edit in. It reads `-muted`
              rather than `-faint` because it is real information: `-faint` is
              the disabled/placeholder step and this is neither. */}
          <span
            className={cn(dsText.micro, dsText.nums, "hidden shrink-0 text-[color:var(--ds-fg-muted)] @min-[26rem]:inline")}
          >
            {point.ts}
          </span>
        </div>

        {/* LEVEL 3 — the value, with the whole column to itself.
            `ValueField` / `LockedValue` are the SHARED pair (`ds/primitives-
            form.tsx`); the OCR review's extracted fields draw the same two, so
            "a box takes typing, flat text with a lock does not" is one lesson
            the operator learns once. */}
        {policy.editable ? (
          <ValueField id={fieldId} title={value} value={value} dirty={dirty} onChange={onEdit} className="w-full" />
        ) : (
          <LockedValue value={base} reason={policy.reason} className="w-full" />
        )}
      </div>
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
  const [refusal, setRefusal] = useState<DemoCommandResult | null>(null);
  const [baseGeneration, setBaseGeneration] = useState<number | null>(null);
  const [freshnessPending, setFreshnessPending] = useState<ActionDescriptorWire | null>(null);
  const [overrideReason, setOverrideReason] = useState("");

  useEffect(() => {
    setEdits({});
    setSeededFrom(null);
    setConflict(null);
    setRefusal(null);
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
  const steps = [...new Set(row.data.map((d) => d.step))];

  const applied = appliedCorrectionsFor(row.runId);
  const baseValue = (point: DemoDataPoint) => checkpointBaseValue(cp, point, held);
  const refreshedValue = (point: DemoDataPoint) =>
    cp.correctedValues[point.field] === undefined && held >= cp.serverGeneration
      ? cp.freshValues[point.field]
      : undefined;
  /** the observed reading an applied correction replaced — never overwritten */
  const correctedFrom = (point: DemoDataPoint) =>
    cp.correctedValues[point.field] === undefined ? undefined : (applied?.observed[point.field] ?? point.value);

  const changed = reads.filter((d) => edits[d.field] !== undefined && edits[d.field] !== baseValue(d));

  /**
   * The save, and the three answers it can come back with.
   *
   * The bug this replaces was the sharpest kind this product forbids: the old
   * version built a payload, called the command service, and then showed
   * "Checkpoint saved" for EVERY non-conflict result — including a `rejected`
   * one — while never clearing `edits` and never touching the world. So the
   * field stayed amber and dirty forever underneath a success toast, and a
   * refusal was rendered as a success. Success styling on something that did
   * not happen is the exact failure DESIGN.md rule 3 exists to prevent.
   *
   *  · APPLIED  — the correction is in the checkpoint, the row's base value IS
   *               the new value, and the surface ADOPTS the generation the
   *               server minted. Only then are the edits cleared, because the
   *               thing they represented has landed.
   *  · CONFLICT — the checkpoint moved. The patch is HELD and re-offered field
   *               by field against the fresh values (unchanged behaviour).
   *  · REJECTED — the server refused. The patch is HELD and the reason is shown
   *               with its code, because a refusal you cannot quote is one you
   *               cannot get help with.
   */
  const submitSave = (generation: number) => {
    if (!saveAction) return;
    const payload: Record<string, string> = { expectedGeneration: String(generation) };
    for (const d of changed) payload[d.field] = edits[d.field];
    const saved = changed.length;
    const result = onAction(row, { ...saveAction, payload });
    if (!result) return;
    if (result.state === "conflict") {
      setConflict(result);
      toast({
        tone: "warning",
        title: "Not saved — the checkpoint moved",
        description: `Your ${saved} edit${saved === 1 ? "" : "s"} are still here and are being re-offered against the values the server now holds. Nothing was overwritten.`,
      });
      return;
    }
    if (result.state === "rejected") {
      setRefusal(result);
      toast({
        tone: "danger",
        title: result.headline,
        description: `Your ${saved} edit${saved === 1 ? "" : "s"} are still here. Nothing was written to the checkpoint.`,
      });
      return;
    }
    // Applied. Adopt the server's generation, drop the patch — the values on
    // screen now come from the checkpoint, so holding the edits would leave
    // every corrected field dirty against itself.
    setConflict(null);
    setRefusal(null);
    setSeededFrom(null);
    setEdits({});
    if (result.checkpoint) setBaseGeneration(result.checkpoint.generation);
    toast({ tone: "success", title: result.headline, description: result.detail });
  };

  const submitRerun = (payload: Record<string, string>) => {
    if (!rerunAction) return;
    const result = onAction(row, { ...rerunAction, payload });
    setFreshnessPending(null);
    setOverrideReason("");
    if (!result) return;
    if (result.state === "applied") {
      toast({ tone: "info", title: result.headline, description: result.detail });
      return;
    }
    // A refused or conflicted new run is not a silent no-op. It used to be.
    setRefusal(result.state === "rejected" ? result : null);
    toast({ tone: result.state === "rejected" ? "danger" : "warning", title: result.headline, description: result.detail });
  };

  return (
    <section aria-label="Data" className="flex shrink-0 flex-col gap-[var(--ds-space-snug)]">
      <div className="flex items-center gap-[var(--ds-space-snug)]">
        <SectionLabel className="min-w-0 truncate">Data</SectionLabel>
        {/* THE ⓘ IS WHERE THE EXPLAINING GOES NOW.
            Three sentences used to be printed on this surface at all times:
            the writes-are-never-edited rule, the freshness limit, and a
            paragraph describing what each of the two save buttons does. All
            three are true of every run in the product and none of them is a
            fact about the run on screen — so they are here, one press away,
            and the surface is back to being a ledger. */}
        <Popover>
          <PopoverTrigger asChild>
            <IconButton
              size="xs"
              label="About this ledger"
              icon={<Info aria-hidden className={dsIcon.sm} />}
              className="text-[color:var(--ds-fg-faint)] hover:text-[color:var(--ds-fg)] data-[state=open]:text-[color:var(--ds-fg)]"
            />
          </PopoverTrigger>
          <PopoverContent title="Data" side="bottom" align="start" width="lg">
            <div className="flex flex-col gap-[var(--ds-space-base)]">
              {/* The CHECKPOINT's own provenance. It used to be a `MetaLine`
                  under the ledger reading `gen 4 · captured 6m ago` — a fact
                  about the run, but one the operator has never had to act on
                  and one that took a band under every ledger to say. It sits
                  with the freshness rule it qualifies now. The STALE case is
                  different and stays on the surface: that is a hazard, not
                  provenance, and a hazard is never disclosed. */}
              <KeyValueList
                items={[
                  { key: "Generation", value: String(held) },
                  { key: "Captured", value: `${checkpointAge(cp, tick)} ago` },
                  { key: "Accepted age", value: `${cp.maxAgeMin} min at ${cp.consumingNode}` },
                ]}
              />
              <BulletList
                items={[
                  "Reads are correctable in place. Writes are shown and never edited — they are the record of what happened.",
                  `Reusing reads older than ${cp.maxAgeMin} minutes takes a reason, and the reason goes on the receipt.`,
                  continues
                    ? "Saving continues THIS run from where it stopped — same run id, same receipt."
                    : "Saving records a correction on this run. Nothing runs.",
                  "Starting a new run leaves this one exactly as it is, with its own trace and its own receipt.",
                  ...(editPolicySummary(row) ? [editPolicySummary(row)] : []),
                ]}
              />
            </div>
          </PopoverContent>
        </Popover>
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
          {/* THE SUMMARY CHIP ROW IS GONE — deliberately, and nothing replaced
              it (2026-07-27, operator: "remove these tags in data").

              It read `read 2 · written 1 · staged 1 · gen 4` directly above a
              ledger that shows all four of those things. `read` and `written`
              counted rows the eye can count. `gen` is provenance, so it moved
              to the section's provenance line below with its full explanation
              rather than a four-character abbreviation. And `staged` — the one
              genuine hazard in the set — now lives on the ROW whose write is
              staged, which is where the hazard actually is; a badge on the
              offending line beats a number above the list, because the number
              tells you a staged write exists and the badge tells you WHICH.
              `unconfirmed` went the same way for the same reason.

              Do not reintroduce a count here. A ledger that restates itself in
              a header is the clutter the operator asked us to remove. */}

          {/* A refused save. The patch is still on screen above it — this says
              WHY it is still there, in the server's own words and with its code. */}
          {refusal && (
            <Refusal
              title={refusal.headline}
              code={hasRefusalCode(refusal) ? refusal.code : "unknown — the server refused without one"}
              outcome="nothing was written to the checkpoint"
              action={
                <Button size="sm" variant="secondary" onClick={() => setRefusal(null)}>
                  Dismiss
                </Button>
              }
            >
              {refusal.detail}
            </Refusal>
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
              read next to the thing that read it.
              LEVEL 1 of the three. Now that each value is two lines tall, the
              step heading has to survive being further from its last row than
              it used to be, so it is drawn as a genuine group header (caps +
              a rule) rather than a bolder version of the sub-step label
              beneath it. Same size, different CASE and different colour: three
              levels the eye separates without measuring them. The gap between
              groups is `cozy` and the gap under the heading is nothing —
              more space above a heading than below it is what makes the
              heading belong to the rows that follow it. */}
          <div className="flex flex-col gap-[var(--ds-space-cozy)]">
            {steps.map((step) => (
              <div key={step} className="flex flex-col">
                <div className="flex items-center gap-[var(--ds-space-snug)]">
                  <span className={cn(dsText.caps, "min-w-0 truncate text-[color:var(--ds-fg-secondary)]")}>{step}</span>
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
                        corrected={correctedFrom(d)}
                        onEdit={(next) => setEdits((prev) => ({ ...prev, [d.field]: next }))}
                      />
                    );
                  })}
              </div>
            ))}
          </div>

          {/* WHAT IS LEFT ON THIS SURFACE: the hazard, and nothing else.
              The blue "These values cannot be edited right now" banner and the
              paragraph under the ledger that repeated its sentence are both
              GONE — every locked value already draws a lock and prints its own
              reason on its own row, which is where the fact belongs, and the
              two bands said it twice more for the whole list. `gen · captured`
              went into the ⓘ beside the freshness rule it qualifies.

              A STALE checkpoint does not go with them. It is an outcome about
              this run — reusing these values takes an override that lands on
              the receipt — and an outcome is never disclosed. */}
          {fresh.stale && (
            <p className={cn(dsText.meta, "text-[color:var(--ds-status-waiting-fg)]")}>
              Captured {checkpointAge(cp, tick)} ago — older than the {fresh.maxAgeMin}m limit. Reusing them takes an override.
            </p>
          )}

          {/* The two outcomes. They are DESCRIPTORS (`actions[]` at the `data`
              placement) — a row whose checkpoint may not be saved is simply not
              sent a save arm, so there is nothing here to disable, and a parked
              row is sent neither. */}
          {(saveAction || rerunAction) && (
            <div className="flex flex-col gap-[var(--ds-space-snug)] border-t border-[color:var(--ds-border-subtle)] pt-[var(--ds-space-snug)]">
              {/*
                ONE GRID, TWO ROWS, TWO COLUMNS — and every edge is a column.

                It was two rows that had each decided their own shape: a `mr-auto`
                pair of BORDERLESS buttons pinned left, an OUTLINED save and a
                FILLED rerun pinned right, on a `flex-wrap` that broke wherever
                348px ran out. Three button treatments, four widths, and no two
                of the four sharing a left or a right edge. Four buttons genuinely
                do not fit on one line in this rail — which is an argument for
                laying out two rows on purpose, not for letting a wrap do it.

                So: `grid-cols-2`, every button `w-full`. Column one is a left
                edge, column two is a right edge, both rows land on both, and
                the four cells are the same size whatever the labels say. Reading
                order is the house order — the quiet, undoable pair first, the
                two commit arms last — so the eye still ends on the verb.

                ONE CONTROL FAMILY. `ghost` is gone: these are four peers on one
                grid, so they are `secondary` and exactly one of them is
                `primary`. The SERVER picks which — on a run with work left to
                release, continuing it is the affirmative action; on one with
                nothing left, starting a new run is — and a `primary` in the
                bottom-right cell of a grid of equals is unmistakable in a way
                that a filled button beside a borderless one never was.

                THE STATE LINE went into the grid's own quiet meta slot: row
                zero, spanning both columns, at `meta` weight. It is a note about
                the form, not a fifth control, and it was sitting at the same
                weight and the same left edge as the buttons underneath it.
              */}
              <div className="grid grid-cols-2 gap-[var(--ds-space-snug)]">
                <p className={cn(dsText.meta, "col-span-2 text-[color:var(--ds-fg-muted)]")}>
                  {changed.length > 0
                    ? `${changed.length} value${changed.length === 1 ? "" : "s"} changed, not saved yet.`
                    : seededFrom !== null
                      ? `Loaded the values from run #${seededFrom} — they match what this run holds.`
                      : "Nothing is changed yet."}
                </p>
                <Button
                  size="sm"
                  variant="secondary"
                  className="w-full"
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
                  Prior run
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  className="w-full"
                  icon={<RotateCcw aria-hidden className={dsIcon.sm} />}
                  disabled={changed.length === 0 && seededFrom === null}
                  onClick={() => {
                    setEdits({});
                    setSeededFrom(null);
                  }}
                >
                  Reset
                </Button>
                {saveAction && (
                  <Button
                    size="sm"
                    variant={saveAction.intent === "primary" ? "primary" : "secondary"}
                    // A lone commit arm takes the RIGHT-HAND cell, never the
                    // left: the primary's place on this surface is the bottom
                    // right corner, and a grid that lets it slide to column one
                    // when its partner is absent has moved the one control the
                    // operator aims at without saying so.
                    className={cn("w-full", !rerunAction && "col-start-2")}
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
                    className={cn("w-full", !saveAction && "col-start-2")}
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
            <Well>
              <ChipRow>
              <Chip label="captured">{fmtClock(cp.capturedAt)}</Chip>
              <Chip label="age" tone="warning">{`${fresh.ageMin}m`}</Chip>
              <Chip label="limit">{`${fresh.maxAgeMin}m`}</Chip>
              <Chip label="consumed by">{fresh.consumingNode}</Chip>
              </ChipRow>
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
              ? `Records live on the OCR review row — open the OCR panel (${plural(DEMO_ROWS[row.reviewRunId]?.records?.length ?? 0, "person", "people")})`
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
  dataExpanded,
  onDataExpandedChange,
  className,
}: {
  row: DemoRow;
  onOpenPanel: (workflow: string, id: string) => void;
  onAction: DemoActionHandler;
  onClose: () => void;
  tick: number;
  /** the Data surface has the rail to itself, to be edited in */
  dataExpanded: boolean;
  onDataExpandedChange: (expanded: boolean) => void;
  className?: string;
}) {
  const sections = useMemo(
    () => ({
      hasDelegation: Boolean(row.reviewRunId ?? row.reviewOf ?? row.linkedParentId) || Boolean(linkedGroupSummary(row)),
      // `RunSelector` renders nothing below two attempts, so the heading is
      // gated on the same fact rather than on the component returning null —
      // a labelled section with nothing under it reads as a failed render.
      hasAttempts: (row.lineage?.attempts.length ?? 1) > 1,
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
         * ORDER: Evidence · Data · Attempts · Delegation.
         *
         * Evidence first on the operator's own instruction, and it holds up on
         * its own terms: it is the shortest section and the one most often
         * reached for mid-read, so putting the long editable ledger above it
         * meant scrolling past a form to look at a screenshot.
         *
         * **Provenance is no longer a section here.** It was seven chips on
         * every run, five of which said the same words on all of them; the one
         * that changes what a row MEANS — the workflow version — went to the Log
         * Panel's bottom bar beside the stream it qualifies, the app build went
         * to the Sessions bar because it is a property of the dashboard rather
         * than of a run, and the rest is behind that bar's ⓘ. What is left here
         * is the ATTEMPT selector, which was never provenance: it changes which
         * run you are reading.
         *
         * Expanding Data hides ATTEMPTS AND DELEGATION only. Evidence stays
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
            {sections.hasAttempts && (
              <>
                <Separator />
                <section aria-label="Attempts" className="flex flex-col gap-[var(--ds-space-snug)]">
                  <SectionLabel>Attempts</SectionLabel>
                  <RunSelector row={row} />
                </section>
              </>
            )}
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
            Attempts and delegation are hidden while you edit — narrow the surface to bring them back.
          </p>
        )}
      </div>
    </aside>
  );
}
