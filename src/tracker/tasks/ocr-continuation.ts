import type { TrackerEntry } from "../jsonl.js";
import type { PendingTaskDependency, TaskStore } from "./store.js";
import type { ProjectedRun } from "./scheduler.js";
import {
  computeOcrVerification,
  patchOcrRecordFromActiveCheckOutcome,
  patchOcrRecordFromEidLookupOutcome,
  patchOcrRecordUnresolved,
  type OcrLookupKind,
} from "../../services/ocr/eid-lookup-results.js";

interface OcrEidLookupDependencyMetadata {
  recordIndex: number;
  lookupKind: OcrLookupKind;
  formType: string;
}

export type OcrEidLookupContinuationResult =
  | { ok: true }
  | { ok: false; reason: string };

const EID_LOOKUP_FAILED_WARNING = "eid-lookup failed";
const ACTIVE_CHECK_FAILED_WARNING = "active-check failed";

export async function applyOcrEidLookupContinuation(args: {
  store: TaskStore;
  dependency: PendingTaskDependency;
  parentRun: ProjectedRun;
  childRun: ProjectedRun;
  now: string;
  emitTracker: (entry: TrackerEntry) => void;
}): Promise<OcrEidLookupContinuationResult> {
  const metadata = readOcrEidLookupMetadata(args.dependency.metadata);
  if (!metadata) {
    return { ok: false, reason: `invalid ocr-eid-lookup dependency metadata for ${args.dependency.id}` };
  }
  const records = readRecords(args.parentRun.data?.records);
  if (!records) {
    return { ok: false, reason: `missing OCR records on parent run ${args.parentRun.runId ?? args.parentRun.id}` };
  }
  if (isContinuationAlreadyApplied(records, metadata, args.childRun)) {
    return { ok: true };
  }

  if (args.childRun.status === "done" || args.childRun.status === "skipped") {
    patchOcrRecordFromEidLookupOutcome(records, metadata.recordIndex, {
      workflow: args.childRun.workflow,
      itemId: args.childRun.id,
      runId: args.childRun.runId ?? "",
      status: "done",
      data: args.childRun.data,
      error: args.childRun.error,
    }, metadata.lookupKind);
  } else {
    patchOcrRecordUnresolved(records, metadata.recordIndex, EID_LOOKUP_FAILED_WARNING);
  }

  const verifiedCount = records.filter((record) => {
    const verification = (record as Record<string, unknown>).verification as { state?: string } | undefined;
    return verification?.state === "verified";
  }).length;

  args.emitTracker({
    workflow: "ocr",
    timestamp: args.now,
    id: args.parentRun.id,
    ...(args.parentRun.runId ? { runId: args.parentRun.runId } : {}),
    ...(args.parentRun.parentRunId ? { parentRunId: args.parentRun.parentRunId } : {}),
    status: "running",
    step: "awaiting-approval",
    data: {
      ...(args.parentRun.data ?? {}),
      recordCount: String(records.length),
      verifiedCount: String(verifiedCount),
      records: JSON.stringify(records),
    },
  });
  return { ok: true };
}

export async function applyOcrActiveCheckContinuation(args: {
  store: TaskStore;
  dependency: PendingTaskDependency;
  parentRun: ProjectedRun;
  childRun: ProjectedRun;
  now: string;
  emitTracker: (entry: TrackerEntry) => void;
}): Promise<OcrEidLookupContinuationResult> {
  const metadata = readOcrActiveCheckMetadata(args.dependency.metadata);
  if (!metadata) {
    return { ok: false, reason: `invalid ocr-active-check dependency metadata for ${args.dependency.id}` };
  }
  const records = readRecords(args.parentRun.data?.records);
  if (!records) {
    return { ok: false, reason: `missing OCR records on parent run ${args.parentRun.runId ?? args.parentRun.id}` };
  }
  if (isActiveCheckContinuationAlreadyApplied(records, metadata, args.childRun)) {
    return { ok: true };
  }

  if (args.childRun.status === "done" || args.childRun.status === "skipped") {
    patchOcrRecordFromActiveCheckOutcome(records, metadata.recordIndex, {
      workflow: args.childRun.workflow,
      itemId: args.childRun.id,
      runId: args.childRun.runId ?? "",
      status: "done",
      data: args.childRun.data,
      error: args.childRun.error,
    });
  } else {
    markOcrRecordUnresolved(records, metadata.recordIndex, ACTIVE_CHECK_FAILED_WARNING);
  }

  emitPatchedOcrTrackerRow({
    parentRun: args.parentRun,
    records,
    now: args.now,
    emitTracker: args.emitTracker,
  });
  return { ok: true };
}

function readOcrEidLookupMetadata(raw: Record<string, unknown>): OcrEidLookupDependencyMetadata | null {
  const recordIndex = raw.recordIndex;
  const lookupKind = raw.lookupKind;
  const formType = raw.formType;
  if (typeof recordIndex !== "number") return null;
  if (lookupKind !== "name" && lookupKind !== "verify" && lookupKind !== "verify-only") return null;
  if (typeof formType !== "string" || !formType) return null;
  return { recordIndex, lookupKind, formType };
}

function readOcrActiveCheckMetadata(raw: Record<string, unknown>): OcrEidLookupDependencyMetadata | null {
  const recordIndex = raw.recordIndex;
  const lookupKind = raw.lookupKind;
  const formType = raw.formType;
  if (typeof recordIndex !== "number") return null;
  if (lookupKind !== "verify" && lookupKind !== "verify-only") return null;
  if (typeof formType !== "string" || !formType) return null;
  return { recordIndex, lookupKind, formType };
}

function readRecords(raw: string | undefined): unknown[] | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isContinuationAlreadyApplied(
  records: unknown[],
  metadata: OcrEidLookupDependencyMetadata,
  childRun: ProjectedRun,
): boolean {
  const record = asRecord(records[metadata.recordIndex]);
  if (!record) return false;
  if (childRun.status !== "done" && childRun.status !== "skipped") {
    return record.matchState === "unresolved" && warningsContain(record, EID_LOOKUP_FAILED_WARNING);
  }

  if (metadata.lookupKind === "name") {
    const eid = (childRun.data?.emplId ?? "").trim();
    if (/^\d{5,}$/.test(eid)) {
      return getRecordEmployeeId(record) === eid
        && record.matchState === "resolved"
        && record.matchSource === "eid-lookup"
        && verificationMatchesChildOutcome(record.verification, childRun);
    }
    return record.matchState === "unresolved"
      && warningsContain(record, `eid-lookup returned "${eid || "no result"}"`)
      && verificationMatchesChildOutcome(record.verification, childRun);
  }

  return verificationMatchesChildOutcome(record.verification, childRun);
}

function isActiveCheckContinuationAlreadyApplied(
  records: unknown[],
  metadata: OcrEidLookupDependencyMetadata,
  childRun: ProjectedRun,
): boolean {
  const record = asRecord(records[metadata.recordIndex]);
  if (!record) return false;
  if (childRun.status !== "done" && childRun.status !== "skipped") {
    return record.matchState === "unresolved" && warningsContain(record, ACTIVE_CHECK_FAILED_WARNING);
  }
  return verificationMatchesActiveCheckOutcome(record.verification, childRun);
}

function emitPatchedOcrTrackerRow(args: {
  parentRun: ProjectedRun;
  records: unknown[];
  now: string;
  emitTracker: (entry: TrackerEntry) => void;
}): void {
  const verifiedCount = args.records.filter((record) => {
    const verification = (record as Record<string, unknown>).verification as { state?: string } | undefined;
    return verification?.state === "verified";
  }).length;

  args.emitTracker({
    workflow: "ocr",
    timestamp: args.now,
    id: args.parentRun.id,
    ...(args.parentRun.runId ? { runId: args.parentRun.runId } : {}),
    ...(args.parentRun.parentRunId ? { parentRunId: args.parentRun.parentRunId } : {}),
    status: "running",
    step: "awaiting-approval",
    data: {
      ...(args.parentRun.data ?? {}),
      recordCount: String(args.records.length),
      verifiedCount: String(verifiedCount),
      records: JSON.stringify(args.records),
    },
  });
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function getRecordEmployeeId(record: Record<string, unknown>): string | null {
  if (typeof record.employeeId === "string") return record.employeeId;
  const employee = asRecord(record.employee);
  return typeof employee?.employeeId === "string" ? employee.employeeId : null;
}

function warningsContain(record: Record<string, unknown>, warning: string): boolean {
  return Array.isArray(record.warnings)
    && record.warnings.some((value) => value === warning);
}

function markOcrRecordUnresolved(records: unknown[], idx: number, warning: string): void {
  const record = asRecord(records[idx]);
  if (!record) return;
  record.matchState = "unresolved";
  record.selected = false;
  const warnings = Array.isArray(record.warnings) ? record.warnings as string[] : [];
  if (!warnings.includes(warning)) warnings.push(warning);
  record.warnings = warnings;
}

function verificationMatchesChildOutcome(raw: unknown, childRun: ProjectedRun): boolean {
  const actual = asRecord(raw);
  if (!actual) return false;
  const expected = computeOcrVerification({
    activeStatus: childRun.data?.activeStatus,
    isActive: childRun.data?.isActive,
    isHdhAccepted: childRun.data?.isHdhAccepted,
    hrStatus: childRun.data?.hrStatus,
    department: childRun.data?.department,
    personOrgScreenshot: childRun.data?.personOrgScreenshot,
    terminationDate: childRun.data?.terminationDate,
  });
  return actual.state === expected.state
    && optionalString(actual.hrStatus) === optionalString(expected.hrStatus)
    && optionalString(actual.department) === optionalString(expected.department)
    && optionalString(actual.screenshotFilename) === optionalString(expected.screenshotFilename)
    && optionalString(actual.error) === optionalString(expected.error);
}

function verificationMatchesActiveCheckOutcome(raw: unknown, childRun: ProjectedRun): boolean {
  const actual = asRecord(raw);
  if (!actual) return false;
  const expected = computeOcrVerification({
    activeStatus: childRun.data?.activeStatus,
    isActive: childRun.data?.isActive,
    isHdhAccepted: childRun.data?.isHdhAccepted,
    hrStatus: childRun.data?.hrStatus,
    department: childRun.data?.department,
    personOrgScreenshot: childRun.data?.personOrgScreenshot,
    terminationDate: childRun.data?.terminationDate,
  });
  return actual.state === expected.state
    && optionalString(actual.hrStatus) === optionalString(expected.hrStatus)
    && optionalString(actual.department) === optionalString(expected.department)
    && optionalString(actual.screenshotFilename) === optionalString(expected.screenshotFilename)
    && optionalString(actual.error) === optionalString(expected.error);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
