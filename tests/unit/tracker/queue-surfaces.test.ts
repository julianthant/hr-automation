import { describe, it } from "vitest";
import assert from "node:assert/strict";

import { buildTrackerQueueSurfaces } from "../../../src/tracker/queue-surfaces.js";
import type { TrackerEntry } from "../../../src/tracker/jsonl.js";
import { OCR_WORKFLOW_RUNTIME_POLICY } from "../../../src/workflows/ocr/workflow.js";

const phase4Policies = new Map([["ocr", OCR_WORKFLOW_RUNTIME_POLICY]]);

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

  it("keeps an approved batch-parent with a single child as a group card", () => {
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

    // A single-signer PDF stays a batch card after approval — the row type
    // must not change just because OCR matched only one person.
    assert.equal(result.groupRows.length, 1);
    assert.equal(result.groupRows[0]?.kind, "approval-delegation");
    assert.equal(result.groupRows[0]?.approvalState, "approved");
    assert.deepEqual(result.groupRows[0]?.members.map((e) => e.id), ["10000001"]);
    assert.deepEqual(result.flatEntries.map((e) => e.id), []);
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

    // A single delegated OCR row stays flat; the important guard is that a
    // batch-parent is never folded into its own approval members.
    const groupParentRunIds = result.groupRows.map((g) => g.parentRunId);
    assert.ok(!groupParentRunIds.includes("ocr-child-run"), "OCR prep row should not self-group");
    const flatIds = result.flatEntries.map((e) => e.id);
    assert.ok(flatIds.includes("ocr-child"), "single delegated OCR prep row should appear flat");
  });

  it("surfaces one delegated OCR batch-parent as a flat single delegation row", () => {
    const ocrPrepRow = entry({
      workflow: "ocr",
      id: "ocr-single",
      runId: "ocr-single-run",
      parentRunId: "oath-upload-run",
      status: "running",
      step: "awaiting-approval",
      data: { archetype: "batch-parent", mode: "prepare", formType: "oath" },
    });

    const result = buildTrackerQueueSurfaces({
      entries: [ocrPrepRow],
      delegationSourceEntries: [ocrPrepRow],
    });

    assert.equal(result.groupRows.length, 0);
    assert.deepEqual(result.flatEntries.map((e) => e.id), ["ocr-single"]);
  });

  it("folds multiple delegated OCR batch-parents into the upstream batch row with inherited title", () => {
    const first = entry({
      workflow: "ocr",
      id: "ocr-first",
      runId: "ocr-first-run",
      parentRunId: "oath-upload-run",
      status: "running",
      step: "awaiting-approval",
      data: { archetype: "batch-parent", mode: "prepare", formType: "oath", parentSubject: "Oath · 7777" },
    });
    const second = entry({
      workflow: "ocr",
      id: "ocr-second",
      runId: "ocr-second-run",
      parentRunId: "oath-upload-run",
      status: "running",
      step: "awaiting-approval",
      data: { archetype: "batch-parent", mode: "prepare", formType: "oath", parentSubject: "Oath · 7777" },
    });

    const result = buildTrackerQueueSurfaces({
      entries: [first, second],
      delegationSourceEntries: [first, second],
    });

    assert.equal(result.groupRows.length, 1);
    assert.equal(result.groupRows[0]?.kind, "batch");
    assert.equal(result.groupRows[0]?.parentRunId, "oath-upload-run");
    assert.equal(result.groupRows[0]?.titleOverride, "Oath · 7777");
    assert.deepEqual(result.groupRows[0]?.members.map((e) => e.id), ["ocr-first", "ocr-second"]);
    assert.deepEqual(result.flatEntries.map((e) => e.id), []);
  });

  it("surfaces OCR eid lookup fan-out as flat delegation member rows", () => {
    const child = entry({
      workflow: "eid-lookup",
      id: "lookup-1",
      runId: "lookup-run-1",
      parentRunId: "ocr-run-1",
      status: "pending",
      data: {
        archetype: "delegate-child",
        originWorkflow: "ocr",
        parentSubject: "Oath · 1234",
      },
    });

    const result = buildTrackerQueueSurfaces({
      entries: [],
      delegationSourceEntries: [child],
      runtimePolicies: phase4Policies,
    });

    assert.equal(result.groupRows.length, 0);
    assert.deepEqual(result.flatEntries.map((e) => e.id), ["lookup-1"]);
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
