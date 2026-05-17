import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { buildTrackerQueueSurfaces } from "../../../src/tracker/queue-surfaces.js";
import type { TrackerEntry } from "../../../src/tracker/jsonl.js";

function entry(
  overrides: Partial<TrackerEntry> & Pick<TrackerEntry, "workflow" | "id" | "status">,
): TrackerEntry {
  return {
    timestamp: "2026-05-16T12:00:00.000Z",
    step: "searching",
    ...overrides,
  } as TrackerEntry;
}

describe("buildTrackerQueueSurfaces", () => {
  it("classifies OCR awaiting-approval as a group card via batch-parent archetype", () => {
    const ocr = entry({
      workflow: "ocr",
      id: "ocr-session-1",
      runId: "ocr-run-1",
      status: "running",
      step: "awaiting-approval",
      data: { archetype: "batch-parent", mode: "prepare", formType: "oath" },
    });

    const result = buildTrackerQueueSurfaces({
      entries: [ocr],
      delegationSourceEntries: [ocr],
    });

    assert.equal(result.groupRows.length, 1, "should produce one group card");
    assert.equal(result.groupRows[0]?.kind, "approval-delegation");
    assert.equal(result.groupRows[0]?.approvalState, "awaiting-approval");
    assert.equal(result.groupRows[0]?.parentRunId, "ocr-run-1");
    assert.deepEqual(result.flatEntries.map((e) => e.id), []);
  });

  it("classifies legacy OCR awaiting-approval (no stamped archetype) as group card via legacy resolver", () => {
    const ocr = entry({
      workflow: "ocr",
      id: "ocr-legacy",
      runId: "ocr-run-legacy",
      status: "running",
      step: "awaiting-approval",
      data: { mode: "prepare", formType: "emergency-contact" },
    });

    const result = buildTrackerQueueSurfaces({
      entries: [ocr],
      delegationSourceEntries: [ocr],
    });

    assert.equal(result.groupRows.length, 1);
    assert.equal(result.groupRows[0]?.kind, "approval-delegation");
    assert.equal(result.groupRows[0]?.approvalState, "awaiting-approval");
  });

  it("classifies any stamped batch-parent as a group card anchor, regardless of workflow name", () => {
    const row = entry({
      workflow: "some-future-workflow",
      id: "future-prep-1",
      runId: "future-run-1",
      status: "running",
      step: "awaiting-approval",
      data: { archetype: "batch-parent" },
    });

    const result = buildTrackerQueueSurfaces({
      entries: [row],
      delegationSourceEntries: [row],
    });

    assert.equal(result.groupRows.length, 1);
    assert.equal(result.groupRows[0]?.kind, "approval-delegation");
    assert.equal(result.groupRows[0]?.approvalState, "awaiting-approval");
  });

  it("keeps approved batch-parent flat when no delegation members are visible", () => {
    const ocr = entry({
      workflow: "ocr",
      id: "ocr-approved-nochildren",
      runId: "ocr-run-nochildren",
      status: "done",
      step: "approved",
      data: { archetype: "batch-parent", mode: "prepare", formType: "oath" },
    });

    const result = buildTrackerQueueSurfaces({
      entries: [ocr],
      delegationSourceEntries: [ocr],
    });

    assert.equal(result.groupRows.length, 0, "no group card with zero visible members");
    assert.deepEqual(result.flatEntries.map((e) => e.id), ["ocr-approved-nochildren"]);
  });

  it("folds a multi-member approved batch-parent into a group card", () => {
    const ocr = entry({
      workflow: "ocr",
      id: "ocr-session-2",
      runId: "ocr-run-2",
      status: "done",
      step: "approved",
      data: { archetype: "batch-parent", mode: "prepare", formType: "oath" },
    });
    const child1 = entry({
      workflow: "oath-signature",
      id: "child-1",
      runId: "child-run-1",
      parentRunId: "ocr-run-2",
      status: "pending",
    });
    const child2 = entry({
      workflow: "oath-signature",
      id: "child-2",
      runId: "child-run-2",
      parentRunId: "ocr-run-2",
      status: "pending",
    });

    const result = buildTrackerQueueSurfaces({
      entries: [ocr],
      delegationSourceEntries: [ocr, child1, child2],
    });

    assert.equal(result.groupRows.length, 1);
    assert.equal(result.groupRows[0]?.kind, "approval-delegation");
    assert.equal(result.groupRows[0]?.approvalState, "approved");
    assert.deepEqual(result.groupRows[0]?.members.map((e) => e.id), ["child-1", "child-2"]);
    assert.deepEqual(result.flatEntries.map((e) => e.id), []);
  });

  it("surfaces a single approved-batch-parent child as a selectable flat row", () => {
    const ocr = entry({
      workflow: "ocr",
      id: "ocr-session-single",
      runId: "ocr-run-single",
      status: "done",
      step: "approved",
      data: { archetype: "batch-parent", mode: "prepare" },
    });
    const child = entry({
      workflow: "oath-signature",
      id: "10000001",
      runId: "oath-run-single",
      parentRunId: "ocr-run-single",
      status: "running",
    });

    const result = buildTrackerQueueSurfaces({
      entries: [ocr],
      delegationSourceEntries: [ocr, child],
    });

    assert.equal(result.groupRows.length, 0);
    assert.deepEqual(result.flatEntries.map((e) => e.id), ["10000001"]);
  });

  it("excludes discarded batch-parent rows from all surfaces", () => {
    const ocr = entry({
      workflow: "ocr",
      id: "ocr-discarded",
      runId: "ocr-run-discarded",
      status: "failed",
      step: "discarded",
      data: { archetype: "batch-parent", mode: "prepare" },
    });

    const result = buildTrackerQueueSurfaces({
      entries: [ocr],
      delegationSourceEntries: [ocr],
    });

    assert.equal(result.groupRows.length, 0);
    assert.equal(result.flatEntries.length, 0);
  });

  it("does not include batch-parent entries as members of their own parent", () => {
    // OCR row has parentRunId pointing to oath-upload; must not appear as a member
    const ocrPrepRow = entry({
      workflow: "ocr",
      id: "ocr-child",
      runId: "ocr-child-run",
      parentRunId: "oath-upload-run",
      status: "running",
      step: "awaiting-approval",
      data: { archetype: "batch-parent" },
    });
    const oauthUpload = entry({
      workflow: "oath-upload",
      id: "upload-1",
      runId: "oath-upload-run",
      status: "running",
      data: { archetype: "dispatch" },
    });

    const result = buildTrackerQueueSurfaces({
      entries: [oauthUpload, ocrPrepRow],
      delegationSourceEntries: [oauthUpload, ocrPrepRow],
    });

    // OCR row becomes its own group card; oath-upload appears flat
    const groupParentRunIds = result.groupRows.map((g) => g.parentRunId);
    assert.ok(groupParentRunIds.includes("ocr-child-run"), "OCR prep row should be a group card");
    const flatIds = result.flatEntries.map((e) => e.id);
    assert.ok(!flatIds.includes("ocr-child"), "OCR prep row should not appear flat");
  });

  it("surfaces passive-child archetype members as passive-delegation cards", () => {
    const child = entry({
      workflow: "crm-doc-download",
      id: "jane@ucsd.edu",
      runId: "child-run-1",
      parentRunId: "parent-run-1",
      status: "pending",
      data: {
        archetype: "passive-child",
        taskRole: "utility",
        originWorkflow: "onboarding",
        parentSubject: "Onboarding: jane@ucsd.edu",
      },
    });

    const result = buildTrackerQueueSurfaces({
      entries: [],
      delegationSourceEntries: [child],
    });

    assert.equal(result.groupRows.length, 1);
    assert.equal(result.groupRows[0]?.kind, "passive-delegation");
    assert.equal(result.groupRows[0]?.titleOverride, "Onboarding: jane@ucsd.edu");
  });
});
