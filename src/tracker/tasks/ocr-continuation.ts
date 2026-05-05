import type { TrackerEntry } from "../jsonl.js";
import type { PendingTaskDependency, TaskStore } from "./store.js";
import type { ProjectedRun } from "./scheduler.js";
import {
  patchOcrRecordFromEidLookupOutcome,
  patchOcrRecordUnresolved,
  type OcrLookupKind,
} from "../../workflows/ocr/eid-lookup-results.js";

interface OcrEidLookupDependencyMetadata {
  recordIndex: number;
  lookupKind: OcrLookupKind;
  formType: string;
}

export async function applyOcrEidLookupContinuation(args: {
  store: TaskStore;
  dependency: PendingTaskDependency;
  parentRun: ProjectedRun;
  childRun: ProjectedRun;
  now: string;
  emitTracker: (entry: TrackerEntry) => void;
}): Promise<void> {
  const metadata = readOcrEidLookupMetadata(args.dependency.metadata);
  if (!metadata) return;
  const records = readRecords(args.parentRun.data?.records);
  if (!records) return;

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
    patchOcrRecordUnresolved(records, metadata.recordIndex, "eid-lookup failed");
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

function readRecords(raw: string | undefined): unknown[] | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
