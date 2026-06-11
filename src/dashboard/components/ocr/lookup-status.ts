import type { TaskDependencyChild } from "../hooks/useTaskDependencies";
import type { PrepRecordWorkflowPhase } from "./PrepReviewFormCard";

type LookupRecord = {
  formKind?: string;
  officerSigned?: boolean | null;
  matchState?: string;
  personLookupStatus?: string;
  personLookupTraceId?: string;
  i9LookupStatus?: string;
  i9LookupTraceId?: string;
};

export type OcrRecordLookupPhase = "pending" | "running" | "completed" | "failed";

export interface LookupPhaseTracker {
  phase: OcrRecordLookupPhase;
  label: string;
  traceId?: string;
  inProgress: boolean;
}

export interface OcrRecordLookupTracker {
  phase: OcrRecordLookupPhase;
  label: string;
  traceId?: string;
  inProgress: boolean;
  /** True while the OCR row is still at the verify enrichment step (person-lookup / i9). */
  enrichmentInProgress: boolean;
  person?: LookupPhaseTracker;
  i9?: LookupPhaseTracker;
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
  const allowInProgress = args.entryStatus === "running";
  const children = args.dependencyChildren.filter(
    (child) =>
      child.workflow === "person-lookup" &&
      child.metadata.recordIndex === args.originalIndex,
  );
  const personTraceId = firstNonEmpty(
    children.find((child) => isRunningChildStatus(child.status))?.traceId,
    children.find((child) => isPendingChildStatus(child.status))?.traceId,
    children.find((child) => child.status === "done")?.traceId,
    children.find((child) => child.status === "failed" || child.status === "cancelled")?.traceId,
    args.record.personLookupTraceId,
  );

  let person: LookupPhaseTracker | undefined;
  if (allowInProgress && children.some((child) => isRunningChildStatus(child.status))) {
    person = lookupTracker("running", "Person lookup", personTraceId);
  } else if (allowInProgress && children.some((child) => isPendingChildStatus(child.status))) {
    person = lookupTracker("pending", "Person lookup", personTraceId);
  } else if (children.some((child) => child.status === "failed" || child.status === "cancelled")) {
    person = lookupTracker("failed", "Person lookup", personTraceId);
  } else if (children.length > 0) {
    person = lookupTracker("completed", "Person lookup", personTraceId);
  } else {
    const stampedPersonStatus = normalizeLookupStatus(args.record.personLookupStatus, allowInProgress);
    if (stampedPersonStatus) {
      person = lookupTracker(stampedPersonStatus, "Person lookup", personTraceId);
    } else if (args.entryStatus === "running") {
      const step = args.entryStep ?? "";
      if (step === "person-lookup" || step === "verification") {
        person = lookupTracker("running", "Person lookup", personTraceId);
      }
    } else if (args.record.matchState === "lookup-running") {
      person = lookupTracker("running", "Person lookup", personTraceId);
    } else if (args.record.matchState === "lookup-pending" && args.entryStatus === "running") {
      person = lookupTracker("pending", "Person lookup", personTraceId);
    }
  }

  const i9Status = normalizeLookupStatus(args.record.i9LookupStatus, allowInProgress);
  const i9 = i9Status
    ? lookupTracker(i9Status, "I-9 lookup", args.record.i9LookupTraceId)
    : undefined;
  const i9Needed = needsI9Lookup(args.record);

  if (person && i9) {
    const active = i9.inProgress || person.phase === "completed" ? i9 : person;
    return recordTracker(active, enrichmentInProgress, person, i9);
  }
  if (person?.phase === "completed" && enrichmentInProgress && i9Needed) {
    const pendingI9 = lookupTracker("running", "I-9 lookup", args.record.i9LookupTraceId);
    return recordTracker(pendingI9, enrichmentInProgress, person, pendingI9);
  }
  if (person) {
    return recordTracker(person, enrichmentInProgress, person, i9);
  }
  if (i9) {
    return recordTracker(i9, enrichmentInProgress, person, i9);
  }

  if (args.entryStatus === "running") {
    const step = args.entryStep ?? "";
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
    if (tracker.i9) return tracker.i9.inProgress;
    return tracker.enrichmentInProgress;
  }
  if (tracker.person && !tracker.person.inProgress) return false;
  if (!tracker.person && !tracker.inProgress) return false;
  return PERSON_LOOKUP_CHECK_KEYS.has(checkKey);
}

/** Operator-facing in-progress label for a lookup-backed missing check row. */
export function deriveLookupProgressLabel(
  tracker: OcrRecordLookupTracker | undefined,
  checkKey: string,
): string {
  if (checkKey === "officialSigner" && tracker?.i9?.inProgress) {
    return tracker.i9.label;
  }
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

function lookupTracker(
  phase: OcrRecordLookupPhase,
  prefix: "Person lookup" | "I-9 lookup",
  traceId: string | undefined,
): LookupPhaseTracker {
  const label =
    phase === "pending"
      ? `${prefix} pending`
      : phase === "running"
        ? `${prefix} running`
        : phase === "failed"
          ? `${prefix} failed`
          : `${prefix} completed`;
  return {
    phase,
    label,
    ...(traceId ? { traceId } : {}),
    inProgress: phase === "pending" || phase === "running",
  };
}

function recordTracker(
  active: LookupPhaseTracker,
  enrichmentInProgress: boolean,
  person: LookupPhaseTracker | undefined,
  i9: LookupPhaseTracker | undefined,
): OcrRecordLookupTracker {
  return {
    ...active,
    enrichmentInProgress,
    ...(person ? { person } : {}),
    ...(i9 ? { i9 } : {}),
  };
}

function isVerifyEnrichmentRunning(entryStatus: string, entryStep?: string): boolean {
  if (entryStatus !== "running") return false;
  const step = entryStep ?? "";
  return step === "person-lookup" || step === "verification";
}

function needsI9Lookup(record: LookupRecord): boolean {
  return record.formKind === "oath" && record.officerSigned !== true;
}

function normalizeLookupStatus(
  value: string | undefined,
  allowInProgress: boolean,
): OcrRecordLookupPhase | null {
  if ((value === "pending" || value === "running" || value === "queued") && !allowInProgress) {
    return null;
  }
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
