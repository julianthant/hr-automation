import type { TrackerEntry } from "../jsonl.js";

/**
 * Minimal TrackerEntry shape needed for step-duration computation. Kept
 * narrow (timestamp + status + step) so the function works against both
 * today's JSONL records and any shimmed test fixtures.
 */
export interface StepDurationEntry {
  timestamp: string;
  status: "pending" | "running" | "done" | "failed" | "skipped";
  step?: string;
}

/**
 * Compute per-step durations (ms) for a single (itemId, runId) pair.
 *
 * Input: entries for one run, in any order. Sorted internally by timestamp.
 * Output: `{ [stepName]: durationMs }`. Only steps with a computed duration
 * are included. The last step is closed out by a subsequent `done` / `failed`
 * event; a still-running final step yields no duration for that step (yet).
 *
 * The first step's start is anchored at the earliest valid timestamp in the
 * run (typically the `pending` event), NOT at its own `running` event. This
 * way the pre-first-step gap - browser launch, session setup, any time
 * between workflow start and the first emitted step - is absorbed into
 * step 1's duration instead of being silently lost. The upshot:
 * `sum(stepDurations)` tiles the full elapsed time shown by the global
 * `useElapsed` counter (pending -> done/failed), so the timeline matches the
 * dashboard's top-level timer.
 *
 * Why pull this out of `/events`? It's pure data-over-data - easily unit
 * testable, easily reusable if we later want to expose durations through
 * another endpoint.
 */
export function computeStepDurations(
  entries: StepDurationEntry[],
): Record<string, number> {
  if (entries.length === 0) return {};

  // Defensive copy + sort by timestamp; input arrays are usually already in
  // order (JSONL is append-only) but test fixtures may not be.
  const sorted = [...entries].sort((a, b) =>
    a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0,
  );

  const durations: Record<string, number> = {};
  let currentStep: string | null = null;
  let currentStepStartMs: number | null = null;
  // Anchor step 1 at the first non-`pending` event. The `pending` row is
  // written at enqueue time in daemon / pre-emit batch mode (potentially
  // minutes/hours before the item starts actual work), so using it would
  // bleed the full queue-wait duration into step 1's duration. The first
  // `running` event is the "work started here" moment; that's what the
  // step pipeline should measure.
  let workflowStartMs: number | null = null;
  let firstStepSeen = false;

  for (const e of sorted) {
    const tsMs = Date.parse(e.timestamp);
    if (Number.isNaN(tsMs)) continue;

    if (workflowStartMs === null && e.status !== "pending") workflowStartMs = tsMs;

    const isTerminal = e.status === "done" || e.status === "failed" || e.status === "skipped";
    const nextStep = isTerminal ? null : e.step ?? null;

    // When the active step changes (or we reach a terminal event), close out
    // the previous step's duration.
    if (currentStep && currentStep !== nextStep && currentStepStartMs !== null) {
      const delta = tsMs - currentStepStartMs;
      if (delta >= 0) {
        // Sum durations if a step re-appears (it won't normally, but be tolerant)
        durations[currentStep] = (durations[currentStep] ?? 0) + delta;
      }
    }

    if (nextStep !== currentStep) {
      currentStep = nextStep;
      if (nextStep && !firstStepSeen) {
        // Anchor step 1 at the workflow's earliest timestamp so the
        // pre-first-step gap is absorbed. workflowStartMs is guaranteed
        // non-null here because we set it above on the first valid ts.
        currentStepStartMs = workflowStartMs ?? tsMs;
        firstStepSeen = true;
      } else {
        currentStepStartMs = nextStep ? tsMs : null;
      }
    }
  }

  return durations;
}

/**
 * Summary of a run's timeline derived from its tracker JSONL history.
 * `earliestTrackerTs` is the single source of truth for "when did this run
 * start" - it matches the anchor `computeStepDurations` uses, so the header
 * Elapsed timer, the step pipeline durations, and the queue-row elapsed all
 * reference the same t=0. For batch items that means the synthetic auth
 * `running` entries at `onAuthStart` timestamps (injected by `runOneItem` -
 * see src/core/workflow.ts) are what anchor the run.
 */
export interface RunTimeline {
  /** 1-indexed chronological position among runs for the same itemId. */
  ordinal: number;
  /** Earliest tracker-entry ts for this run. */
  earliestTrackerTs: string;
  /** Latest tracker-entry ts for this run. */
  latestTrackerTs: string;
}

/** Return the earlier of two ISO timestamps, ignoring undefined inputs. */
export function pickEarlier(a: string | undefined, b: string | undefined): string | undefined {
  if (!a) return b;
  if (!b) return a;
  return a < b ? a : b;
}

/** Return the later of two ISO timestamps, ignoring undefined inputs. */
export function pickLater(a: string | undefined, b: string | undefined): string | undefined {
  if (!a) return b;
  if (!b) return a;
  return a > b ? a : b;
}

/**
 * Build a `runId -> RunTimeline` map for all runs of a single itemId.
 *
 * Runs are ordered (and ordinals assigned) by each run's earliest tracker
 * entry timestamp, NOT by parsing the trailing `#N` off the runId. This
 * means the two coexisting runId shapes - legacy `{id}#N` and the UUID
 * format emitted by batch/pool runners - are numbered consistently:
 * "run #1" is always the chronologically first run for that item.
 *
 * Exported so both the SSE `/events` enrichment and `/api/runs` can use the
 * same assignment rule - the ordinal a queue row shows MUST match the
 * ordinal the RunSelector dropdown shows for the same runId.
 */
export function buildRunTimelines(
  entries: Array<Pick<TrackerEntry, "runId" | "id" | "timestamp"> & { status?: string }>,
): Map<string, RunTimeline> {
  // `earliestTs` anchors the run's timer (header Elapsed, queue-row elapsed,
  // step pipeline widths). We prefer the first non-`pending` event - in
  // daemon mode and pre-emitted batch mode, the `pending` row is written
  // at enqueue time (potentially minutes/hours before the item claims a
  // worker), so using it would attribute the full queue-wait duration to
  // the item's elapsed timer. The first `running` / `done` / `failed` /
  // `skipped` event is the real "work started here" anchor. Items that
  // are still queued (only a `pending` row exists) fall back to the
  // pending timestamp so the queue row still has a sortable timestamp.
  const spans = new Map<
    string,
    { earliestWorkTs: string | null; earliestAnyTs: string; latestTs: string }
  >();
  for (const e of entries) {
    const rid = e.runId || `${e.id}#1`;
    const isWork = e.status !== "pending";
    const prev = spans.get(rid);
    if (!prev) {
      spans.set(rid, {
        earliestWorkTs: isWork ? e.timestamp : null,
        earliestAnyTs: e.timestamp,
        latestTs: e.timestamp,
      });
    } else {
      if (isWork && (prev.earliestWorkTs === null || e.timestamp < prev.earliestWorkTs)) {
        prev.earliestWorkTs = e.timestamp;
      }
      if (e.timestamp < prev.earliestAnyTs) prev.earliestAnyTs = e.timestamp;
      if (e.timestamp > prev.latestTs) prev.latestTs = e.timestamp;
    }
  }
  // Flatten: earliestTs = earliestWorkTs ?? earliestAnyTs (pending-only
  // queued runs fall back to the pending timestamp for sort stability).
  const spansFlat = new Map<string, { earliestTs: string; latestTs: string }>();
  for (const [rid, s] of spans) {
    spansFlat.set(rid, {
      earliestTs: s.earliestWorkTs ?? s.earliestAnyTs,
      latestTs: s.latestTs,
    });
  }
  // Secondary sort by runId keeps the assignment deterministic if two runs
  // share the same earliest timestamp (realistic for synthetic fixtures;
  // production tracker writes are microsecond-distinct).
  const sorted = [...spansFlat.entries()].sort(([ra, sa], [rb, sb]) =>
    sa.earliestTs < sb.earliestTs ? -1 :
    sa.earliestTs > sb.earliestTs ? 1 :
    ra.localeCompare(rb),
  );
  const out = new Map<string, RunTimeline>();
  sorted.forEach(([rid, span], i) => {
    out.set(rid, {
      ordinal: i + 1,
      earliestTrackerTs: span.earliestTs,
      latestTrackerTs: span.latestTs,
    });
  });
  return out;
}
