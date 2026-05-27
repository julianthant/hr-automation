import { emitTrackerRow, type TrackerEntry } from "../../tracker/jsonl.js";
import { findLatestEntryForPredicate } from "../../tracker/find-latest-entry.js";
import { resolveRowArchetype, type TrackerRowArchetype } from "../../domain/row-archetype.js";
import type { Database } from "../../infra/sqlite/index.js";

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
  fallbackArchetype: TrackerRowArchetype;
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

export function emitInheritedRow(args: EmitInheritedRowArgs): void {
  const inheritId = args.inheritFrom?.id ?? args.id;
  const inheritRunId = args.inheritFrom?.runId ?? args.runId;
  const priorEntry = findLatestEntryForPredicate({
    workflow: args.workflow,
    trackerDir: args.trackerDir,
    lookbackDays: 30,
    predicate: args.predicate ?? ((entry) =>
      entry.id === inheritId && (inheritRunId ? entry.runId === inheritRunId : true)),
    // SQLite fast path — uses the indexed `runs.run_id` lookup when a runId
    // is known, or the `items` projection when only an itemId is known.
    // Falls through to JSONL scan when no `db` was provided (e.g. tests
    // with isolated trackerDir) or when no projection row matches yet.
    ...(args.db ? { db: args.db } : {}),
    ...(args.predicate
      ? {}
      : {
          ...(inheritRunId ? { runId: inheritRunId } : {}),
          ...(!inheritRunId && inheritId ? { itemId: inheritId } : {}),
        }),
  });
  const archetype = priorEntry ? resolveRowArchetype(priorEntry) : args.fallbackArchetype;
  const parentRunId = args.parentRunId ?? priorEntry?.parentRunId;

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
        ...(priorEntry?.data ?? {}),
        ...(args.data ?? {}),
        archetype,
      },
      ...(args.input ? { input: args.input } : {}),
      ...(args.error ? { error: args.error } : {}),
    },
    args.trackerDir,
  );
}
