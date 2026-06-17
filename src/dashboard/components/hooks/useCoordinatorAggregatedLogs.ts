import { useMemo } from "react";
import type { CollapsedLogEntry } from "./useLogs";
import { useLogs } from "./useLogs";
import type { TrackerEntry } from "@/components/shared/types";
import { resolveEntryName } from "@/components/shared/entry-display";
import {
  buildMemberSummaryLines,
  isOperationCoordinatorWorkflow,
  mergeCoordinatorLogs,
  type CoordinatorLogLine,
} from "../log-panel/coordinator-logs";

/**
 * Aggregate an operation coordinator row's lifecycle into one merged,
 * source-labeled log timeline. A row qualifies when its workflow is an
 * operation coordinator (oath-signature / emergency-contact) AND it carries a
 * delegated OCR run id (`data.ocrRunId`). For every other row this hook is a
 * no-op (`active: false`) and the caller renders the row's own logs unchanged.
 *
 * The coordinator's OWN logs are passed in (already fetched by the LogPanel via
 * `useLogs`); this hook additionally fetches the delegated OCR run's logs (keyed
 * by `data.ocrSessionId` / `data.ocrRunId` under workflow `"ocr"`) and folds in
 * one summary line per member from `childEntries`, then runs the pure
 * {@link mergeCoordinatorLogs} merger.
 *
 * `useLogs` is always called (hooks can't be conditional); when the row is not a
 * coordinator the OCR ids are `null`, so `useSseHistoryStream` stays disabled
 * (`enabled = Boolean(itemId)`) and no SSE subscription opens.
 */
export function useCoordinatorAggregatedLogs(args: {
  entry: TrackerEntry | null;
  coordinatorLogs: CollapsedLogEntry[];
  childEntries: TrackerEntry[];
  date: string;
}): { active: boolean; logs: CoordinatorLogLine[] } {
  const { entry, coordinatorLogs, childEntries, date } = args;

  const isCoordinator = Boolean(
    entry && isOperationCoordinatorWorkflow(entry.workflow) && entry.data?.ocrRunId,
  );
  const ocrRunId = isCoordinator ? entry!.data!.ocrRunId ?? null : null;
  const ocrSessionId = isCoordinator
    ? entry!.data!.ocrSessionId ?? entry!.data!.sessionId ?? null
    : null;

  const { logs: ocrLogs } = useLogs("ocr", ocrSessionId, ocrRunId, date);

  const memberLines = useMemo(
    () => buildMemberSummaryLines(childEntries, (m) => resolveEntryName(m)),
    [childEntries],
  );

  const merged = useMemo(
    () => mergeCoordinatorLogs(coordinatorLogs, ocrLogs, memberLines),
    [coordinatorLogs, ocrLogs, memberLines],
  );

  return { active: isCoordinator, logs: merged };
}
