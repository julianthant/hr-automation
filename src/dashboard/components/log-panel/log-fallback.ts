import type { CollapsedLogEntry } from "@/components/hooks/useLogs";
import type { TrackerEntry } from "@/components/shared/types";

function fallbackLevel(status: TrackerEntry["status"]): CollapsedLogEntry["level"] {
  if (status === "failed") return "error";
  if (status === "done") return "success";
  if (status === "skipped") return "warn";
  return "step";
}

export function deriveTrackerFallbackLog(
  entry: TrackerEntry | null,
  activeRunId: string | null,
): CollapsedLogEntry | null {
  if (!entry) return null;
  const status = entry.status;
  const step = entry.step ? ` (${entry.step})` : "";
  const suffix = entry.error ? ` — ${entry.error}` : "";
  return {
    workflow: entry.workflow,
    itemId: entry.id,
    runId: activeRunId ?? entry.runId,
    level: fallbackLevel(status),
    message: `Tracker state: ${status}${step}${suffix}`,
    ts: entry.timestamp,
    count: 1,
  };
}
