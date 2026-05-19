import { findLatestEntryForPredicate } from "../../tracker/find-latest-entry.js";

const OCR_READER_LOOKBACK_DAYS = 7;

export function resolveParentSubject(args: {
  parentRunId: string | undefined;
  originWorkflow: string | undefined;
  trackerDir?: string;
}): string | undefined {
  if (!args.parentRunId || !args.originWorkflow) return undefined;
  const match = findLatestEntryForPredicate({
    workflow: args.originWorkflow,
    trackerDir: args.trackerDir,
    lookbackDays: OCR_READER_LOOKBACK_DAYS,
    predicate: (e) =>
      e.runId === args.parentRunId &&
      typeof e.data?.__name === "string" &&
      e.data.__name.length > 0,
  });
  return match?.data?.__name;
}
