import type { TaskDependencyChild } from "../hooks/useTaskDependencies";
import type { PrepRecordWorkflowPhase } from "./PrepReviewFormCard";

type LookupRecord = {
  matchState?: string;
  personLookupStatus?: string;
  personLookupTraceId?: string;
};

export type OcrRecordLookupPhase = "pending" | "running" | "completed" | "failed";

export interface OcrRecordLookupTracker {
  phase: OcrRecordLookupPhase;
  label: string;
  traceId?: string;
  inProgress: boolean;
  /** True while the OCR row is still at the verify enrichment step (person-lookup / i9). */
  enrichmentInProgress: boolean;
}

const PERSON_LOOKUP_CHECK_KEYS = new Set([
  "name",
  "eid",
  "employmentDate",
  "oathDate",
  "activeStatus",
]);

export function deriveRecordWorkflowPhase(
  tracker: OcrRecordLookupTracker,
): PrepRecordWorkflowPhase {
  if (tracker.phase === "running") return "running";
  if (tracker.phase === "pending") return "pending";
  if (tracker.phase === "failed") return "failed";
  return "done";
}

export function deriveOcrRecordLookupTracker(args: {
  record: LookupRecord;
  originalIndex: number;
  entryStatus: string;
  entryStep?: string;
  dependencyChildren: readonly TaskDependencyChild[];
}): OcrRecordLookupTracker {
  const enrichmentInProgress = isVerifyEnrichmentRunning(args.entryStatus, args.entryStep);
  const children = args.dependencyChildren.filter(
    (child) =>
      child.workflow === "person-lookup" &&
      child.metadata.recordIndex === args.originalIndex,
  );
  const traceId = firstNonEmpty(
    children.find((child) => isRunningChildStatus(child.status))?.traceId,
    children.find((child) => isPendingChildStatus(child.status))?.traceId,
    children.find((child) => child.status === "done")?.traceId,
    children.find((child) => child.status === "failed" || child.status === "cancelled")?.traceId,
    args.record.personLookupTraceId,
  );

  if (children.some((child) => isRunningChildStatus(child.status))) {
    return personTracker("running", traceId, enrichmentInProgress);
  }
  if (children.some((child) => isPendingChildStatus(child.status))) {
    return personTracker("pending", traceId, enrichmentInProgress);
  }
  if (children.some((child) => child.status === "failed" || child.status === "cancelled")) {
    return personTracker("failed", traceId, enrichmentInProgress);
  }
  if (children.length > 0) {
    return personTracker("completed", traceId, enrichmentInProgress);
  }

  const stampedPersonStatus = normalizePersonLookupStatus(args.record.personLookupStatus);
  if (stampedPersonStatus) {
    return personTracker(stampedPersonStatus, traceId, enrichmentInProgress);
  }

  if (args.entryStatus === "running") {
    const step = args.entryStep ?? "";
    if (step === "person-lookup" || step === "verification") {
      return personTracker("running", traceId, enrichmentInProgress);
    }
    if (step === "loading-roster") {
      return {
        phase: "running",
        label: "Roster loading",
        inProgress: true,
        enrichmentInProgress,
      };
    }
    if (step === "ocr" || step === "matching" || step === "disambiguating") {
      return {
        phase: "running",
        label: "OCR in progress",
        inProgress: true,
        enrichmentInProgress,
      };
    }
  }

  if (args.record.matchState === "lookup-running") {
    return personTracker("running", traceId, enrichmentInProgress);
  }
  if (args.record.matchState === "lookup-pending" && args.entryStatus === "running") {
    return personTracker("pending", traceId, enrichmentInProgress);
  }

  return {
    phase: "completed",
    label: "Lookup completed",
    inProgress: false,
    enrichmentInProgress,
  };
}

export function deriveLookupInProgress(
  tracker: OcrRecordLookupTracker | undefined,
  checkKey: string,
): boolean {
  if (!tracker) return false;
  if (checkKey === "officialSigner") {
    return tracker.enrichmentInProgress;
  }
  if (!tracker.inProgress) return false;
  return PERSON_LOOKUP_CHECK_KEYS.has(checkKey);
}

/** Operator-facing in-progress label for a lookup-backed missing check row. */
export function deriveLookupProgressLabel(
  tracker: OcrRecordLookupTracker | undefined,
  checkKey: string,
): string {
  if (checkKey === "officialSigner" && tracker?.enrichmentInProgress) {
    return "I-9 lookup running";
  }
  return tracker?.label ?? "Looking up";
}

export function lookupTrackerClassName(phase: OcrRecordLookupPhase): string {
  switch (phase) {
    case "running":
      return "border-primary/40 bg-primary/10 text-primary";
    case "pending":
      return "border-warning/40 bg-warning/10 text-warning";
    case "failed":
      return "border-destructive/40 bg-destructive/10 text-destructive";
    case "completed":
      return "border-success/40 bg-success/10 text-success";
  }
}

function personTracker(
  phase: OcrRecordLookupPhase,
  traceId: string | undefined,
  enrichmentInProgress: boolean,
): OcrRecordLookupTracker {
  const label =
    phase === "pending"
      ? "Person lookup pending"
      : phase === "running"
        ? "Person lookup running"
        : phase === "failed"
          ? "Person lookup failed"
          : "Person lookup completed";
  return {
    phase,
    label,
    ...(traceId ? { traceId } : {}),
    inProgress: phase === "pending" || phase === "running",
    enrichmentInProgress,
  };
}

function isVerifyEnrichmentRunning(entryStatus: string, entryStep?: string): boolean {
  if (entryStatus !== "running") return false;
  const step = entryStep ?? "";
  return step === "person-lookup" || step === "verification";
}

function normalizePersonLookupStatus(value: string | undefined): OcrRecordLookupPhase | null {
  if (value === "pending" || value === "running" || value === "completed" || value === "failed") {
    return value;
  }
  if (value === "queued") return "pending";
  if (value === "done") return "completed";
  return null;
}

function isRunningChildStatus(status: string): boolean {
  return status === "running" || status === "in_progress" || status === "processing";
}

function isPendingChildStatus(status: string): boolean {
  return status === "queued" || status === "pending" || status === "ready";
}

function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  return values.find((value) => typeof value === "string" && value.trim().length > 0);
}
