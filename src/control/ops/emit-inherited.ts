import { emitTrackerRow, type TrackerEntry } from "../../tracker/jsonl.js";
import { findLatestEntryForPredicate } from "../../tracker/find-latest-entry.js";
import { resolveRowArchetype } from "../../domain/row-archetype.js";
import type { Database } from "../../infra/sqlite/index.js";

export class PriorTrackerRowNotFoundError extends Error {
  readonly workflow: string;
  readonly id: string;
  readonly runId?: string;

  constructor(args: { workflow: string; id: string; runId?: string }) {
    super(
      `Cannot emit inherited tracker row: no prior entry for workflow=${args.workflow} id=${args.id}` +
        (args.runId ? ` runId=${args.runId}` : ""),
    );
    this.name = "PriorTrackerRowNotFoundError";
    this.workflow = args.workflow;
    this.id = args.id;
    this.runId = args.runId;
  }
}

export interface EmitInheritedRowArgs {
  workflow: string;
  trackerDir?: string;
  id: string;
  runId?: string;
  status: TrackerEntry["status"];
  step?: string;
  error?: string;
  input?: TrackerEntry["input"];
  data?: Record<string, string>;
  parentRunId?: string;
  inheritFrom?: {
    id?: string;
    runId?: string;
  };
  predicate?: (entry: TrackerEntry) => boolean;
  /**
   * SQLite handle (`stores.taskStore.db` from `openControlStores`). When
   * supplied AND the inherit lookup keys on a runId or itemId, the prior-row
   * lookup uses the indexed `runs` / `items` projection tables instead of a
   * 30-day JSONL scan — turns bulk cancel/retry/discard from O(K*D*L) into
   * O(K*log N). Optional for backwards compat with single-row paths whose
   * cost is irrelevant; callers in bulk loops MUST pass it.
   */
  db?: Database;
}

/**
 * Lookup-only subset of {@link EmitInheritedRowArgs}: the fields
 * {@link findInheritedPriorEntry} actually reads to locate the prior row. The
 * emit-side fields (`status`, `step`, `error`, `input`, `data`, `parentRunId`)
 * are intentionally excluded so callers that only look up a prior row don't pass
 * a dead `status` they expect to filter on — the predicate, not `status`, scopes
 * the match.
 */
export type FindInheritedPriorEntryArgs = Pick<
  EmitInheritedRowArgs,
  "workflow" | "trackerDir" | "id" | "runId" | "inheritFrom" | "predicate" | "db"
>;

export function findInheritedPriorEntry(args: FindInheritedPriorEntryArgs): TrackerEntry | null {
  const inheritId = args.inheritFrom?.id ?? args.id;
  const inheritRunId = args.inheritFrom?.runId ?? args.runId;
  return findLatestEntryForPredicate({
    workflow: args.workflow,
    trackerDir: args.trackerDir,
    lookbackDays: 30,
    predicate: args.predicate ?? ((entry) =>
      entry.id === inheritId && (inheritRunId ? entry.runId === inheritRunId : true)),
    ...(args.db ? { db: args.db } : {}),
    ...(args.predicate
      ? {}
      : {
          ...(inheritRunId ? { runId: inheritRunId } : {}),
          ...(!inheritRunId && inheritId ? { itemId: inheritId } : {}),
        }),
  });
}

export function emitInheritedRow(args: EmitInheritedRowArgs): void {
  const inheritId = args.inheritFrom?.id ?? args.id;
  const inheritRunId = args.inheritFrom?.runId ?? args.runId;
  const priorEntry = findInheritedPriorEntry(args);
  if (!priorEntry) {
    throw new PriorTrackerRowNotFoundError({
      workflow: args.workflow,
      id: inheritId,
      runId: inheritRunId,
    });
  }
  const archetype = resolveRowArchetype(priorEntry);
  const parentRunId = args.parentRunId ?? priorEntry.parentRunId;

  emitTrackerRow(
    {
      workflow: args.workflow,
      timestamp: new Date().toISOString(),
      id: args.id,
      ...(args.runId ? { runId: args.runId } : {}),
      ...(parentRunId ? { parentRunId } : {}),
      status: args.status,
      ...(args.step ? { step: args.step } : {}),
      data: {
        ...(priorEntry.data ?? {}),
        ...(args.data ?? {}),
        archetype,
      },
      ...(args.input ? { input: args.input } : {}),
      ...(args.error ? { error: args.error } : {}),
    },
    args.trackerDir,
  );
}
