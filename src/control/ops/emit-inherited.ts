import { emitTrackerRow, type TrackerEntry } from "../../tracker/jsonl.js";
import { findLatestEntryForPredicate } from "../../tracker/find-latest-entry.js";
import { resolveRowArchetype, type RowArchetype } from "../../domain/row-archetype.js";

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
  fallbackArchetype: RowArchetype;
  parentRunId?: string;
  inheritFrom?: {
    id?: string;
    runId?: string;
  };
  predicate?: (entry: TrackerEntry) => boolean;
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
