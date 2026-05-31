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
  it("classifies OCR awaiting-approval as a preview group card", () => {
    const ocr = entry({
      workflow: "ocr",
      id: "ocr-session-1",
      runId: "ocr-run-1",
      status: "running",
      step: "awaiting-approval",
      data: { archetype: "preview", mode: "prepare", formType: "oath" },
    });

    const result = buildTrackerQueueSurfaces({
      entries: [ocr],
      delegationSourceEntries: [ocr],
    });

    assert.equal(result.groupRows.length, 1, "should produce one group card");
    assert.equal(result.groupRows[0]?.kind, "preview");
    assert.equal(result.groupRows[0]?.approvalState, "awaiting-approval");
    assert.equal(result.groupRows[0]?.parentRunId, "ocr-run-1");
    assert.deepEqual(result.flatEntries.map((e) => e.id), []);
  });

  it("classifies stamped batch rows as batch anchors", () => {
    const row = entry({
      workflow: "some-future-workflow",
      id: "future-prep-1",
      runId: "future-run-1",
      status: "running",
      step: "awaiting-approval",
      data: { archetype: "batch" },
    });

    const result = buildTrackerQueueSurfaces({
      entries: [row],
      delegationSourceEntries: [row],
    });

    assert.equal(result.groupRows.length, 1);
    assert.equal(result.groupRows[0]?.kind, "batch");
  });

  it("keeps approved preview rows visible when no delegation members are visible", () => {
    const ocr = entry({
      workflow: "ocr",
      id: "ocr-approved-nochildren",
      runId: "ocr-run-nochildren",
      status: "done",
      step: "approved",
      data: { archetype: "preview", mode: "prepare", formType: "oath" },
    });

    const result = buildTrackerQueueSurfaces({
      entries: [ocr],
      delegationSourceEntries: [ocr],
    });

    assert.equal(result.groupRows.length, 1);
    assert.equal(result.groupRows[0]?.kind, "preview");
    assert.deepEqual(result.groupRows[0]?.members.map((e) => e.id), []);
    assert.deepEqual(result.flatEntries.map((e) => e.id), []);
  });

  it("folds a multi-member approved batch into a group card", () => {
    const ocr = entry({
      workflow: "ocr",
      id: "ocr-session-2",
      runId: "ocr-run-2",
      status: "done",
      step: "approved",
      data: { archetype: "preview", mode: "prepare", formType: "oath" },
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
    assert.equal(result.groupRows[0]?.kind, "preview");
    assert.equal(result.groupRows[0]?.approvalState, "approved");
    assert.deepEqual(result.groupRows[0]?.members.map((e) => e.id), ["child-1", "child-2"]);
    assert.deepEqual(result.flatEntries.map((e) => e.id), []);
  });

  it("keeps an approved batch with a single child as a group card", () => {
    const ocr = entry({
      workflow: "ocr",
      id: "ocr-session-single",
      runId: "ocr-run-single",
      status: "done",
      step: "approved",
      data: { archetype: "preview", mode: "prepare" },
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

    // A single-signer PDF stays an OCR preview card after approval; signer
    // count does not change the preview row shape.
    assert.equal(result.groupRows.length, 1);
    assert.equal(result.groupRows[0]?.kind, "preview");
    assert.equal(result.groupRows[0]?.approvalState, "approved");
    assert.deepEqual(result.groupRows[0]?.members.map((e) => e.id), ["10000001"]);
    assert.deepEqual(result.flatEntries.map((e) => e.id), []);
  });

  it("excludes discarded preview rows from all surfaces", () => {
    const ocr = entry({
      workflow: "ocr",
      id: "ocr-discarded",
      runId: "ocr-run-discarded",
      status: "failed",
      step: "discarded",
      data: { archetype: "preview", mode: "prepare" },
    });

    const result = buildTrackerQueueSurfaces({
      entries: [ocr],
      delegationSourceEntries: [ocr],
    });

    assert.equal(result.groupRows.length, 0);
    assert.equal(result.flatEntries.length, 0);
  });

  it("does not include preview entries as members of their own parent", () => {
    // OCR row has parentRunId pointing to oath-upload; must not appear as a member
    const ocrPrepRow = entry({
      workflow: "ocr",
      id: "ocr-child",
      runId: "ocr-child-run",
      parentRunId: "oath-upload-run",
      status: "running",
      step: "awaiting-approval",
      data: { archetype: "preview" },
    });
    const oauthUpload = entry({
      workflow: "oath-upload",
      id: "upload-1",
      runId: "oath-upload-run",
      status: "running",
      data: { archetype: "single", delegationRole: "dispatch" },
    });

    const result = buildTrackerQueueSurfaces({
      entries: [oauthUpload, ocrPrepRow],
      delegationSourceEntries: [oauthUpload, ocrPrepRow],
    });

    // The important guard is that a preview is never folded into its own
    // approval members.
    const groupParentRunIds = result.groupRows.map((g) => g.parentRunId);
    assert.deepEqual(groupParentRunIds, ["ocr-child-run"]);
    assert.deepEqual(result.groupRows[0]?.members.map((e) => e.id), []);
  });

  it("surfaces one delegated OCR preview as a preview group", () => {
    const ocrPrepRow = entry({
      workflow: "ocr",
      id: "ocr-single",
      runId: "ocr-single-run",
      parentRunId: "oath-upload-run",
      status: "running",
      step: "awaiting-approval",
      data: { archetype: "preview", mode: "prepare", formType: "oath" },
    });

    const result = buildTrackerQueueSurfaces({
      entries: [ocrPrepRow],
      delegationSourceEntries: [ocrPrepRow],
    });

    assert.equal(result.groupRows.length, 1);
    assert.equal(result.groupRows[0]?.kind, "preview");
    assert.deepEqual(result.groupRows[0]?.members.map((e) => e.id), []);
    assert.deepEqual(result.flatEntries.map((e) => e.id), []);
  });

  it("keeps multiple delegated OCR previews as separate preview groups", () => {
    const first = entry({
      workflow: "ocr",
      id: "ocr-first",
      runId: "ocr-first-run",
      parentRunId: "oath-upload-run",
      status: "running",
      step: "awaiting-approval",
      data: { archetype: "preview", mode: "prepare", formType: "oath", parentSubject: "Oath · 7777" },
    });
    const second = entry({
      workflow: "ocr",
      id: "ocr-second",
      runId: "ocr-second-run",
      parentRunId: "oath-upload-run",
      status: "running",
      step: "awaiting-approval",
      data: { archetype: "preview", mode: "prepare", formType: "oath", parentSubject: "Oath · 7777" },
    });

    const result = buildTrackerQueueSurfaces({
      entries: [first, second],
      delegationSourceEntries: [first, second],
    });

    assert.equal(result.groupRows.length, 2);
    assert.deepEqual(result.groupRows.map((surface) => surface.kind), [
      "preview",
      "preview",
    ]);
    assert.deepEqual(result.groupRows.map((surface) => surface.parentRunId), [
      "ocr-first-run",
      "ocr-second-run",
    ]);
    assert.deepEqual(result.flatEntries.map((e) => e.id), []);
  });

  it("surfaces OCR eid lookup fan-out as flat delegation member rows", () => {
    const ocr = entry({
      workflow: "ocr",
      id: "ocr-session-1",
      runId: "ocr-run-1",
      status: "running",
      step: "awaiting-approval",
      data: { archetype: "preview", mode: "prepare", formType: "oath" },
    });
    const child = entry({
      workflow: "eid-lookup",
      id: "lookup-1",
      runId: "lookup-run-1",
      parentRunId: "ocr-run-1",
      status: "pending",
      data: {
        archetype: "single",
        parentSubject: "Oath · 1234",
      },
    });

    const result = buildTrackerQueueSurfaces({
      entries: [],
      delegationSourceEntries: [ocr, child],
      runtimePolicies: phase4Policies,
    });

    assert.equal(result.groupRows.length, 0);
    assert.deepEqual(result.flatEntries.map((e) => e.id), ["lookup-1"]);
  });

  it("groups multiple OCR lookup children as a delegated batch", () => {
    const ocr = entry({
      workflow: "ocr",
      id: "ocr-session-2",
      runId: "ocr-run-2",
      status: "running",
      step: "awaiting-approval",
      data: { archetype: "preview", mode: "prepare", formType: "oath" },
    });
    const lookup = entry({
      workflow: "eid-lookup",
      id: "lookup-2",
      runId: "lookup-run-2",
      parentRunId: "ocr-run-2",
      status: "pending",
      data: {
        archetype: "single",
        parentSubject: "Oath · 5678",
      },
    });
    const active = entry({
      workflow: "active-check",
      id: "active-2",
      runId: "active-run-2",
      parentRunId: "ocr-run-2",
      status: "pending",
      data: {
        archetype: "single",
        parentSubject: "Oath · 5678",
      },
    });

    const result = buildTrackerQueueSurfaces({
      entries: [],
      delegationSourceEntries: [ocr, lookup, active],
      runtimePolicies: phase4Policies,
    });

    assert.equal(result.groupRows.length, 1);
    assert.equal(result.groupRows[0]?.kind, "batch");
    assert.equal(result.groupRows[0]?.parentRunId, "ocr-run-2");
    assert.deepEqual(result.groupRows[0]?.members.map((e) => e.id), ["lookup-2", "active-2"]);
    assert.deepEqual(result.flatEntries.map((e) => e.id), []);
  });
});
