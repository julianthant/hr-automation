import type { CollapsedLogEntry } from "@/components/hooks/useLogs";
import type { LogEntry, TrackerEntry } from "@/components/shared/types";
import { isTerminalMemberStatus, rollupOperationStatus } from "../../../domain/operation-status.js";

export { isTerminalMemberStatus };

/**
 * The three lifecycle sources that fold into an operation coordinator's Logs
 * panel. The coordinator's OWN runId carries only sparse `operation:*` lines
 * (see `src/tracker/dashboard/ocr/prepare.ts`); the bulk of the real activity
 * lives on the delegated OCR run and the fanned-out member runs, which the
 * strict per-run logs filter would otherwise hide. This merger pools the three
 * into one chronological, source-labeled timeline for the coordinator row.
 */
/**
 * Client-safe mirror of `OPERATION_COORDINATOR_WORKFLOWS`
 * (`src/tracker/dashboard/ocr/shared.ts`) — the workflows that get a top-level
 * `operation` coordinator row. The canonical set lives in a tracker module that
 * transitively imports `node:fs`, so it cannot be pulled into the React bundle;
 * this tiny constant is duplicated here the same way per-workflow status rules
 * live client-safe in domain/tracker leaf modules. Keep in lockstep with the
 * canonical set.
 */
const OPERATION_COORDINATOR_WORKFLOWS = new Set(["oath-signature", "emergency-contact", "onbase"]);

export function isOperationCoordinatorWorkflow(workflow: string | undefined): boolean {
  return workflow !== undefined && OPERATION_COORDINATOR_WORKFLOWS.has(workflow);
}

/**
 * Display-only operation coordinators never emit their own terminal row. Once
 * every fanned-out member is terminal, the coordinator reads as done in the
 * queue chip and log-panel pipeline even though its stored row stays `running`.
 */
export function operationCoordinatorEffectiveStatus(
  entry: TrackerEntry,
  childEntries: readonly TrackerEntry[],
): TrackerEntry["status"] {
  if (!isOperationCoordinatorWorkflow(entry.workflow)) return entry.status;
  return rollupOperationStatus(
    entry.status,
    childEntries.map((child) => child.status),
  );
}

/**
 * The operation coordinator's OWN lifecycle, expressed as a 3-step pipeline so
 * its log panel carries the same step-timeline every other workflow shows
 * (instead of hiding it). The coordinator is a display row whose stored `step`
 * only ever reads `ocr-prep` then `approved` — it can't tell preparing from
 * awaiting-review — so the stage is derived from its denormalized OCR status
 * (`data.ocrStatus`) plus the member-rollup effective status. These are NOT the
 * target workflow's member steps (navigation/fill-form/save); those belong to
 * the fanned-out rows, not the coordinator.
 *
 *   Prepare   — OCR is reading the PDF            (ocrStatus running/preparing)
 *   Review    — awaiting operator approval        (ocrStatus awaiting-review)
 *   Fan-out   — approved; member rows dispatched  (ocrStatus approved → done)
 */
export const OPERATION_PIPELINE_STEPS = ["prepare", "review", "fan-out"] as const;

/**
 * Map an operation coordinator row to a `{ steps, currentStep, status }` view
 * for the shared `StepPipeline`. Pure + deterministic.
 *
 *   - Members all terminal → the pipeline reads complete (`done`). A failed
 *     MEMBER does not fail the coordinator — its chip tracks its own lifecycle
 *     (see the operation-coordinator-chip contract) — so `effective === "done"`
 *     even when a contact/signer failed.
 *   - A real coordinator failure (OCR prep failed) or an operator stop
 *     (cancel/discard) surfaces on the stage it stopped at. We do NOT fabricate
 *     per-stage durations to recover the amber "cancelled" pipeline sentinel
 *     (no-fabrication rule); the amber tone lives on the row badge, and the
 *     pipeline marks the reached stage as the failure point.
 */
export function computeOperationPipelineView(
  entry: TrackerEntry,
  childEntries: readonly TrackerEntry[],
): { steps: string[]; currentStep: string | null; status: string } {
  const steps: string[] = [...OPERATION_PIPELINE_STEPS];
  const effective = operationCoordinatorEffectiveStatus(entry, childEntries);
  const ocrStatus = entry.data?.ocrStatus;

  let stage: "prepare" | "review" | "fan-out" = "prepare";
  if (ocrStatus === "approved" || entry.step === "approved") stage = "fan-out";
  else if (ocrStatus === "awaiting-review") stage = "review";

  if (effective === "done") return { steps, currentStep: "fan-out", status: "done" };
  if (effective === "failed") return { steps, currentStep: stage, status: "failed" };
  return { steps, currentStep: stage, status: "running" };
}

export type CoordinatorLogSource = "coordinator" | "ocr" | "member" | "session";

export interface CoordinatorLogLine extends CollapsedLogEntry {
  /** Which lifecycle stream this line came from (drives the source label). */
  source: CoordinatorLogSource;
}

/** Human label per source, rendered as a prefix badge in the stream. */
export const COORDINATOR_LOG_SOURCE_LABEL: Record<CoordinatorLogSource, string> = {
  coordinator: "Operation",
  ocr: "OCR",
  member: "Member",
  session: "Session",
};

const SESSION_LIFECYCLE_EVENT_TYPES = new Set<string>([
  "workflow_start",
  "workflow_end",
  "session_create",
  "session_close",
  "browser_launch",
  "browser_close",
  "auth_start",
  "auth_complete",
  "duo_request",
  "duo_start",
  "duo_complete",
  "idle_signal",
]);

/**
 * The OCR-run lifecycle events worth surfacing on the coordinator timeline.
 * The OCR run is verbose (per-page extraction, matching, …); we only fold its
 * KEY lifecycle moments so the coordinator panel stays a sparse overview, not a
 * firehose. Matched on the structured `event` name first, then on the level/
 * message shape for the step boundaries (which carry `event` too).
 */
const OCR_KEY_EVENTS = new Set<string>([
  "step:start",
  "step:done",
  "ocr:awaiting-approval",
  "ocr:review-complete",
  "run:terminal",
]);

function logEventName(entry: LogEntry): string | undefined {
  // `event` rides the wire LogEntry via the structured-log spread; it is not in
  // the base `LogEntry` interface, so read it defensively.
  const value = (entry as { event?: unknown }).event;
  return typeof value === "string" ? value : undefined;
}

/**
 * Pick the KEY OCR lifecycle lines out of the delegated OCR run's full log.
 * Keeps only lines carrying one of {@link OCR_KEY_EVENTS}; everything else
 * (extraction noise, debug) is dropped so the coordinator timeline stays sparse.
 */
export function selectKeyOcrLogLines(ocrLogs: readonly CollapsedLogEntry[]): CollapsedLogEntry[] {
  return ocrLogs.filter((entry) => {
    const event = logEventName(entry);
    return event !== undefined && OCR_KEY_EVENTS.has(event);
  });
}

/**
 * One-line-per-member summary from the coordinator's `childEntries` (the
 * fanned-out signer / contact rows). Each becomes a synthetic log line stamped
 * at the member's tracker timestamp so it sorts into the merged timeline at the
 * right moment, labeled by the member's resolved title + terminal/in-flight
 * status (e.g. `signer-1 -> done`, `contact-2 -> running`).
 */
export function buildMemberSummaryLines(
  memberEntries: readonly TrackerEntry[],
  resolveTitle: (entry: TrackerEntry) => string,
): CoordinatorLogLine[] {
  return memberEntries.map((member) => {
    const title = resolveTitle(member) || member.id;
    const status = member.status;
    return {
      workflow: member.workflow,
      itemId: member.id,
      ...(member.runId ? { runId: member.runId } : {}),
      level: memberStatusLevel(status),
      message: `${title} → ${status}`,
      ts: member.timestamp,
      count: 1,
      source: "member" as const,
    };
  });
}

function memberStatusLevel(status: TrackerEntry["status"]): CollapsedLogEntry["level"] {
  if (status === "failed") return "error";
  if (status === "done") return "success";
  if (status === "running") return "step";
  if (status === "skipped") return "warn";
  return "waiting"; // pending
}

function tag(entry: CollapsedLogEntry, source: CoordinatorLogSource): CoordinatorLogLine {
  return { ...entry, source };
}

/**
 * Merge the three lifecycle streams of an operation coordinator into ONE
 * chronological, source-labeled timeline:
 *
 *   - `coordinatorLogs` — the coordinator's own sparse `operation:*` lines
 *     (its real runId), labeled `coordinator`.
 *   - `ocrLogs` — the delegated OCR run's KEY lifecycle events (filtered via
 *     {@link selectKeyOcrLogLines}), labeled `ocr`.
 *   - `memberLines` — one synthetic summary line per fanned-out member (built
 *     by {@link buildMemberSummaryLines}), labeled `member`.
 *
 * Pure + deterministic: sorts ascending by `ts` (ISO strings sort
 * lexicographically = chronologically), stable within equal timestamps in the
 * source order coordinator → ocr → member, and DEDUPES exact duplicates
 * (same source + ts + message) which can appear when the OCR run and the
 * coordinator both record the same transition. No browser / hook dependency.
 */
export function mergeCoordinatorLogs(
  coordinatorLogs: readonly CollapsedLogEntry[],
  ocrLogs: readonly CollapsedLogEntry[],
  memberLines: readonly CoordinatorLogLine[],
): CoordinatorLogLine[] {
  const tagged: CoordinatorLogLine[] = [
    ...coordinatorLogs.map((e) => tag(e, "coordinator")),
    ...selectKeyOcrLogLines(ocrLogs).map((e) => tag(e, "ocr")),
    ...memberLines,
  ];

  // Stable index by source so equal-ts lines keep a deterministic order.
  const sourceRank: Record<CoordinatorLogSource, number> = { coordinator: 0, ocr: 1, member: 2, session: 0 };
  const withIndex = tagged.map((entry, index) => ({ entry, index }));
  withIndex.sort((a, b) => {
    const ta = a.entry.ts ?? "";
    const tb = b.entry.ts ?? "";
    if (ta !== tb) return ta < tb ? -1 : 1;
    const ra = sourceRank[a.entry.source];
    const rb = sourceRank[b.entry.source];
    if (ra !== rb) return ra - rb;
    return a.index - b.index; // preserve original order for a fully-tied pair
  });

  const seen = new Set<string>();
  const out: CoordinatorLogLine[] = [];
  for (const { entry } of withIndex) {
    const key = JSON.stringify([entry.source, entry.ts ?? "", entry.message]);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(entry);
  }
  return out;
}

/** Fold daemon session lifecycle events into an input-run coordinator timeline. */
export function mergeSessionLifecycleIntoCoordinatorLogs(
  logs: readonly CoordinatorLogLine[],
  sessionEvents: readonly {
    type?: string;
    timestamp?: string;
    ts?: number;
    message?: string;
    system?: string;
    workflow?: string;
    itemId?: string;
  }[],
  fallback?: Pick<TrackerEntry, "workflow" | "id">,
): CoordinatorLogLine[] {
  const sessionLines: CoordinatorLogLine[] = sessionEvents
    .filter((e) => e.type && SESSION_LIFECYCLE_EVENT_TYPES.has(e.type))
    .map((e) => ({
      workflow: e.workflow ?? fallback?.workflow ?? "workflow",
      itemId: e.itemId ?? fallback?.id ?? "session",
      level: "step" as const,
      message: e.message ?? e.type ?? "session",
      ts:
        typeof e.timestamp === "string" && e.timestamp.length > 0
          ? e.timestamp
          : typeof e.ts === "number"
            ? new Date(e.ts).toISOString()
            : "",
      count: 1,
      source: "session" as const,
      ...(e.system ? { system: e.system } : {}),
    }));
  const sourceRank: Record<CoordinatorLogSource, number> = {
    session: 0,
    coordinator: 1,
    ocr: 2,
    member: 3,
  };
  const tagged = [...sessionLines, ...logs];
  const withIndex = tagged.map((entry, index) => ({ entry, index }));
  withIndex.sort((a, b) => {
    const ta = a.entry.ts ?? "";
    const tb = b.entry.ts ?? "";
    if (ta !== tb) return ta < tb ? -1 : 1;
    const ra = sourceRank[a.entry.source];
    const rb = sourceRank[b.entry.source];
    if (ra !== rb) return ra - rb;
    return a.index - b.index;
  });
  return withIndex.map(({ entry }) => entry);
}
