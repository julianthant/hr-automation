import type { CollapsedLogEntry } from "@/components/hooks/useLogs";
import type { TrackerEntry } from "@/components/shared/types";

function fallbackLevel(status: TrackerEntry["status"]): CollapsedLogEntry["level"] {
  if (status === "failed") return "error";
  if (status === "done") return "success";
  if (status === "skipped") return "warn";
  return "step";
}

/**
 * Turn an internal step name into a readable phrase. Steps are kebab-case
 * tokens (`loading-roster`, `awaiting-approval`, `ocr-prep`); a few have
 * bespoke phrasings, the rest are Title-Cased word-by-word so an unmapped step
 * still reads cleanly instead of leaking the raw code.
 */
function humanizeStep(step: string): string {
  const known: Record<string, string> = {
    "ocr-prep": "Preparing OCR",
    "preparing": "Preparing OCR",
    "loading-roster": "Loading roster",
    "awaiting-approval": "Awaiting review",
    "awaiting-review": "Awaiting review",
    "person-lookup": "Looking up person",
    "verification": "Verifying",
    "approved": "Approved",
    "discarded": "Discarded",
    "cancelled": "Cancelled",
  };
  if (known[step]) return known[step];
  return step
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((w, i) => (i === 0 ? w.charAt(0).toUpperCase() + w.slice(1) : w))
    .join(" ");
}

/**
 * Map a (status, step) pair to an operator-readable lifecycle phrase.
 *
 * Replaces the old raw `Tracker state: running (ocr-prep)` dump with phrasing a
 * human can read at a glance: `Preparing OCR…`, `Awaiting review`, `Done`,
 * `Running: <readable step>`. Pure + exported so the mapping is unit-tested
 * directly (internal codes → readable strings).
 */
export function describeTrackerPhase(
  status: TrackerEntry["status"],
  step: string | undefined,
): string {
  // Terminal "cancelled"/"discarded" sentinels (failed + sentinel step) read as
  // the operator action, not a failure.
  if (status === "failed" && step === "cancelled") return "Cancelled";
  if (status === "failed" && step === "discarded") return "Discarded";
  if (status === "failed") return step ? `Failed at ${humanizeStep(step)}` : "Failed";
  if (status === "done") return "Done";
  if (status === "skipped") return "Skipped";
  if (status === "pending") return "Queued";
  // running
  if (!step) return "Running…";
  if (step === "ocr-prep" || step === "preparing") return "Preparing OCR…";
  if (step === "awaiting-approval" || step === "awaiting-review") return "Awaiting review";
  return `Running: ${humanizeStep(step)}`;
}

/**
 * For an operation coordinator row, the operator-meaningful phase lives in the
 * denormalized OCR fields (`data.ocrStatus` / `data.ocrStep`) — the row's own
 * top-level status is always `running` (or `failed` on a terminal mirror) and
 * its step is the opaque `ocr-prep`. Map the OCR fields to a readable phrase so
 * a coordinator with no real logs yet still shows where it is.
 */
function describeCoordinatorPhase(data: Record<string, string>): string | null {
  const ocrStatus = data.ocrStatus;
  const ocrStep = data.ocrStep;
  if (!ocrStatus && !ocrStep) return null;
  switch (ocrStatus) {
    case "preparing":
      return "Preparing OCR…";
    case "running":
      return "Preparing OCR…";
    case "awaiting-review":
      return "Awaiting review";
    case "approved":
      return "Approved — fanning out";
    case "discarded":
      return "Discarded";
    case "cancelled":
      return "Cancelled";
    case "failed":
      return "OCR failed";
    default:
      // Unmapped OCR status → humanize whatever step we have.
      return ocrStep ? humanizeStep(ocrStep) : null;
  }
}

/**
 * A single synthetic log line for a row that genuinely has no real logs yet
 * (sparse rows — e.g. a just-created operation coordinator, or a row that
 * crashed before emitting any log). Renders a HUMAN-READABLE lifecycle phase
 * instead of the raw `Tracker state: <status> (<step>)` code dump it used to
 * show. Returns null when there is no selected entry.
 *
 * Coordinator rows (which carry denormalized `data.ocrStatus`/`ocrStep`) get
 * their OCR phase; all other rows map their own (status, step). The error text,
 * if any, is appended.
 */
export function deriveTrackerFallbackLog(
  entry: TrackerEntry | null,
  activeRunId: string | null,
): CollapsedLogEntry | null {
  if (!entry) return null;
  const status = entry.status;
  const coordinatorPhase = entry.data ? describeCoordinatorPhase(entry.data) : null;
  const phase = coordinatorPhase ?? describeTrackerPhase(status, entry.step);
  const suffix = entry.error ? ` — ${entry.error}` : "";
  return {
    workflow: entry.workflow,
    itemId: entry.id,
    runId: activeRunId ?? entry.runId,
    level: fallbackLevel(status),
    message: `${phase}${suffix}`,
    ts: entry.timestamp,
    count: 1,
  };
}
