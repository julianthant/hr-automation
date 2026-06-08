import { describe, it } from "vitest";
import assert from "node:assert/strict";

import {
  deriveLookupInProgress,
  deriveOcrRecordLookupTracker,
  deriveRecordWorkflowPhase,
} from "../../../../src/dashboard/components/ocr/lookup-status.js";
import type { TaskDependencyChild } from "../../../../src/dashboard/components/hooks/useTaskDependencies.js";
import type { OathPreviewRecord } from "../../../../src/dashboard/components/ocr/types.js";

function record(overrides: Partial<OathPreviewRecord> = {}): OathPreviewRecord {
  return {
    formKind: "oath",
    sourcePage: 1,
    rowIndex: 0,
    printedName: "Doe, Jane",
    employeeId: "10000001",
    employeeSigned: true,
    officerSigned: true,
    dateSigned: "06/01/2026",
    notes: [],
    matchState: "resolved",
    matchSource: "form-eid",
    selected: true,
    warnings: [],
    ...overrides,
  };
}

function child(
  status: string,
  overrides: Partial<TaskDependencyChild> = {},
): TaskDependencyChild {
  return {
    workflow: "person-lookup",
    itemId: "ocr-oath-run-r0",
    runId: "child-run",
    status,
    metadata: { recordIndex: 0, lookupKind: "verify" },
    traceId: "ou-101010-abcd",
    ...overrides,
  };
}

describe("deriveOcrRecordLookupTracker", () => {
  it("shows pending with trace id for a queued person lookup child", () => {
    const tracker = deriveOcrRecordLookupTracker({
      record: record({ matchState: "lookup-pending" }),
      originalIndex: 0,
      entryStatus: "running",
      entryStep: "person-lookup",
      dependencyChildren: [child("queued")],
    });

    assert.equal(tracker.phase, "pending");
    assert.equal(tracker.label, "Person lookup pending");
    assert.equal(tracker.traceId, "ou-101010-abcd");
    assert.equal(tracker.inProgress, true);
  });

  it("shows running with trace id for an active person lookup child", () => {
    const tracker = deriveOcrRecordLookupTracker({
      record: record({ matchState: "lookup-running" }),
      originalIndex: 0,
      entryStatus: "running",
      entryStep: "person-lookup",
      dependencyChildren: [child("running")],
    });

    assert.equal(tracker.phase, "running");
    assert.equal(tracker.label, "Person lookup running");
    assert.equal(tracker.traceId, "ou-101010-abcd");
    assert.equal(tracker.inProgress, true);
  });

  it("shows completed with trace id after a person lookup child finishes", () => {
    const tracker = deriveOcrRecordLookupTracker({
      record: record(),
      originalIndex: 0,
      entryStatus: "running",
      entryStep: "awaiting-approval",
      dependencyChildren: [child("done")],
    });

    assert.equal(tracker.phase, "completed");
    assert.equal(tracker.label, "Person lookup completed");
    assert.equal(tracker.traceId, "ou-101010-abcd");
    assert.equal(tracker.inProgress, false);
  });

  it("shows completed without trace when no person lookup was needed", () => {
    const tracker = deriveOcrRecordLookupTracker({
      record: record(),
      originalIndex: 0,
      entryStatus: "running",
      entryStep: "awaiting-approval",
      dependencyChildren: [],
    });

    assert.equal(tracker.phase, "completed");
    assert.equal(tracker.label, "Lookup completed");
    assert.equal(tracker.traceId, undefined);
    assert.equal(tracker.inProgress, false);
  });

  it("treats OCR and roster phases as in progress instead of not found", () => {
    const tracker = deriveOcrRecordLookupTracker({
      record: record({ matchState: "extracted" }),
      originalIndex: 0,
      entryStatus: "running",
      entryStep: "ocr",
      dependencyChildren: [],
    });

    assert.equal(tracker.phase, "running");
    assert.equal(tracker.label, "OCR in progress");
    assert.equal(tracker.inProgress, true);
    assert.equal(tracker.enrichmentInProgress, false);
  });

  it("shows failed when a person lookup child fails", () => {
    const tracker = deriveOcrRecordLookupTracker({
      record: record(),
      originalIndex: 0,
      entryStatus: "running",
      entryStep: "person-lookup",
      dependencyChildren: [child("failed")],
    });

    assert.equal(tracker.phase, "failed");
    assert.equal(tracker.label, "Person lookup failed");
    assert.equal(tracker.inProgress, false);
    assert.equal(deriveRecordWorkflowPhase(tracker), "failed");
  });
});

describe("deriveRecordWorkflowPhase", () => {
  it("does not map a failed lookup tracker to done", () => {
    const tracker = deriveOcrRecordLookupTracker({
      record: record(),
      originalIndex: 0,
      entryStatus: "running",
      entryStep: "person-lookup",
      dependencyChildren: [child("failed")],
    });

    assert.equal(deriveRecordWorkflowPhase(tracker), "failed");
    assert.notEqual(deriveRecordWorkflowPhase(tracker), "done");
  });
});

describe("deriveLookupInProgress", () => {
  it("marks lookup-backed rows as in progress while a child lookup is queued", () => {
    const tracker = deriveOcrRecordLookupTracker({
      record: record({ matchState: "lookup-pending" }),
      originalIndex: 0,
      entryStatus: "running",
      entryStep: "person-lookup",
      dependencyChildren: [child("queued")],
    });

    assert.equal(deriveLookupInProgress(tracker, "activeStatus"), true);
  });

  it("does not mark paper-only rows as in progress", () => {
    const tracker = deriveOcrRecordLookupTracker({
      record: record({ matchState: "lookup-pending" }),
      originalIndex: 0,
      entryStatus: "running",
      entryStep: "person-lookup",
      dependencyChildren: [child("queued")],
    });

    assert.equal(deriveLookupInProgress(tracker, "employeeSigned"), false);
  });

  it("marks officialSigner in progress during verify enrichment after person lookup completes", () => {
    const tracker = deriveOcrRecordLookupTracker({
      record: record(),
      originalIndex: 0,
      entryStatus: "running",
      entryStep: "person-lookup",
      dependencyChildren: [child("done")],
    });

    assert.equal(tracker.enrichmentInProgress, true);
    assert.equal(tracker.inProgress, false);
    assert.equal(deriveLookupInProgress(tracker, "officialSigner"), true);
    assert.equal(deriveLookupInProgress(tracker, "activeStatus"), false);
  });

  it("does not mark officialSigner in progress after enrichment completes", () => {
    const tracker = deriveOcrRecordLookupTracker({
      record: record(),
      originalIndex: 0,
      entryStatus: "done",
      entryStep: "person-lookup",
      dependencyChildren: [child("done")],
    });

    assert.equal(tracker.enrichmentInProgress, false);
    assert.equal(deriveLookupInProgress(tracker, "officialSigner"), false);
  });
});
