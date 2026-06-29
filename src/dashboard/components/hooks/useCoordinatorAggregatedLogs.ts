import { useMemo } from "react";
import type { CollapsedLogEntry } from "./useLogs";
import { useLogs } from "./useLogs";
import type { TrackerEntry } from "@/components/shared/types";
import { resolveEntryName } from "@/components/shared/entry-display";
import {
  buildMemberSummaryLines,
  isOperationCoordinatorWorkflow,
  mergeCoordinatorLogs,
  mergeSessionLifecycleIntoCoordinatorLogs,
  type CoordinatorLogLine,
} from "../log-panel/coordinator-logs";
import { resolveRowArchetype } from "../../../domain/row-archetype.js";

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
  sessionEvents?: readonly import("@/components/shared/types").RunEvent[];
}): { active: boolean; logs: CoordinatorLogLine[] } {
  const { entry, coordinatorLogs, childEntries, date, sessionEvents } = args;

  const isOcrCoordinator = Boolean(
    entry && isOperationCoordinatorWorkflow(entry.workflow) && entry.data?.ocrRunId,
  );
  const isInputRunCoordinator = Boolean(
    entry && resolveRowArchetype(entry) === "operation" && !entry.data?.ocrRunId,
  );
  const isCoordinator = isOcrCoordinator || isInputRunCoordinator;
  const ocrRunId = isOcrCoordinator ? entry!.data!.ocrRunId ?? null : null;
  const ocrSessionId = isOcrCoordinator
    ? entry!.data!.ocrSessionId ?? entry!.data!.sessionId ?? null
    : null;

  const { logs: ocrLogs } = useLogs("ocr", ocrSessionId, ocrRunId, date);

  const memberLines = useMemo(
    () => buildMemberSummaryLines(childEntries, (m) => resolveEntryName(m)),
    [childEntries],
  );

  const merged = useMemo(() => {
    const base = mergeCoordinatorLogs(coordinatorLogs, ocrLogs, memberLines);
    if (!isInputRunCoordinator || !sessionEvents?.length) return base;
    return mergeSessionLifecycleIntoCoordinatorLogs(base, sessionEvents, entry ?? undefined);
  }, [coordinatorLogs, ocrLogs, memberLines, isInputRunCoordinator, sessionEvents]);

  return { active: isCoordinator, logs: merged };
}
