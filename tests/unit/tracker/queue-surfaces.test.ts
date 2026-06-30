import { describe, it } from "vitest";
import assert from "node:assert/strict";

import {
  buildTrackerQueueSurfaces,
  countTopLevelQueueSurfaceRows,
} from "../../../src/tracker/queue-surfaces.js";
import type { TrackerEntry } from "../../../src/tracker/jsonl.js";
import { OCR_WORKFLOW_RUNTIME_POLICY } from "../../../src/workflows/ocr/workflow.js";
import { OATH_SIGNATURE_WORKFLOW_RUNTIME_POLICY } from "../../../src/workflows/oath-signature/workflow.js";
import { DEFAULT_WORKFLOW_RUNTIME_POLICY } from "../../../src/domain/workflow-runtime/default-policy.js";

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

  it("classifies stamped batch rows as operation anchors", () => {
    const row = entry({
      workflow: "some-future-workflow",
      id: "future-prep-1",
      runId: "future-run-1",
      status: "running",
      step: "awaiting-approval",
      data: { archetype: "operation" },
    });

    const result = buildTrackerQueueSurfaces({
      entries: [row],
      delegationSourceEntries: [row],
    });

    assert.equal(result.groupRows.length, 1);
    assert.equal(result.groupRows[0]?.kind, "operation");
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

  it("renders a lone delegated member as a one-member batch when its workflow opts into alwaysOperationDelegatedMembers", () => {
    // Regression (2026-06-02): in the signer's OWN tab the OCR preview anchor is
    // absent, so the lone fanned-out signer fell into the anchorless
    // delegated-member path and rendered as a flat single. oath-signature opts
    // into alwaysOperationDelegatedMembers, so it must stay a one-member batch.
    const signer = entry({
      workflow: "oath-signature",
      id: "10874100",
      runId: "signer-run-1",
      parentRunId: "ocr-run-x",
      status: "done",
      data: { archetype: "single" },
    });
    const result = buildTrackerQueueSurfaces({
      entries: [signer],
      delegationSourceEntries: [signer],
      runtimePolicies: new Map([["oath-signature", OATH_SIGNATURE_WORKFLOW_RUNTIME_POLICY]]),
    });
    assert.equal(result.groupRows.length, 1, "one operation surface");
    assert.equal(result.groupRows[0]?.kind, "operation");
    assert.deepEqual(result.groupRows[0]?.members.map((e) => e.id), ["10874100"]);
    assert.deepEqual(result.flatEntries.map((e) => e.id), [], "no flat single");
  });

  it("renders a lone delegated member flat when its workflow does NOT opt into alwaysOperationDelegatedMembers", () => {
    const child = entry({
      workflow: "work-study",
      id: "ws-1",
      runId: "ws-run-1",
      parentRunId: "some-parent",
      status: "done",
      data: { archetype: "single" },
    });
    const result = buildTrackerQueueSurfaces({
      entries: [child],
      delegationSourceEntries: [child],
      runtimePolicies: new Map([["work-study", DEFAULT_WORKFLOW_RUNTIME_POLICY]]),
    });
    assert.equal(result.groupRows.length, 0, "no batch surface");
    assert.deepEqual(result.flatEntries.map((e) => e.id), ["ws-1"], "renders flat");
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
    assert.equal(result.groupRows[0]?.kind, "operation");
    assert.equal(result.groupRows[0]?.parentRunId, "ocr-run-2");
    assert.deepEqual(result.groupRows[0]?.members.map((e) => e.id), ["lookup-2", "active-2"]);
    assert.deepEqual(result.flatEntries.map((e) => e.id), []);
  });

  it("renders an operation coordinator as an operation surface with the OCR status link before approval", () => {
    // The target-workflow operation row lives in the oath-signature panel. The
    // OCR review row stays in the OCR panel (workflow-scoped payload), so the
    // operation row carries its own denormalized OCR status for display.
    const operation = entry({
      workflow: "oath-signature",
      id: "op-1",
      runId: "op-run-1",
      status: "running",
      data: {
        archetype: "operation",
        queueRowKind: "file",
        pdfOriginalName: "oaths.pdf",
        ocrRunId: "ocr-run-1",
        ocrSessionId: "ocr-session-1",
        ocrStatus: "running",
        ocrStep: "awaiting-approval",
      },
    });

    const result = buildTrackerQueueSurfaces({
      entries: [operation],
      delegationSourceEntries: [operation],
    });

    assert.equal(result.groupRows.length, 1);
    const surface = result.groupRows[0];
    assert.equal(surface?.kind, "operation");
    assert.equal(surface?.parentRunId, "op-run-1");
    assert.deepEqual(surface?.members.map((e) => e.id), [], "no members before approval");
    // OCR status comes through as a lightweight link, never a duplicated row.
    assert.equal(surface?.kind === "operation" ? surface.ocr?.runId : null, "ocr-run-1");
    assert.equal(surface?.kind === "operation" ? surface.ocr?.status : null, "running");
    assert.equal(surface?.kind === "operation" ? surface.ocr?.step : null, "awaiting-approval");
    assert.equal(
      countTopLevelQueueSurfaceRows({ entries: [operation], delegationSourceEntries: [operation] }),
      1,
      "operation row is one top-level queue row",
    );
    assert.deepEqual(result.flatEntries.map((e) => e.id), []);
  });

  it("summarizes signer children under the operation surface after approval without duplicating the OCR row", () => {
    const operation = entry({
      workflow: "oath-signature",
      id: "op-2",
      runId: "op-run-2",
      status: "running",
      data: {
        archetype: "operation",
        queueRowKind: "file",
        pdfOriginalName: "oaths.pdf",
        ocrRunId: "ocr-run-2",
      },
    });
    const ocr = entry({
      workflow: "ocr",
      id: "ocr-session-2",
      runId: "ocr-run-2",
      parentRunId: "op-run-2",
      status: "done",
      step: "approved",
      data: { archetype: "preview", mode: "prepare", formType: "oath" },
    });
    const signer1 = entry({
      workflow: "oath-signature",
      id: "10000001",
      runId: "signer-run-1",
      parentRunId: "op-run-2",
      status: "running",
      data: { archetype: "operation-member" },
    });
    const signer2 = entry({
      workflow: "oath-signature",
      id: "10000002",
      runId: "signer-run-2",
      parentRunId: "op-run-2",
      status: "pending",
      data: { archetype: "operation-member" },
    });

    const result = buildTrackerQueueSurfaces({
      entries: [operation, signer1, signer2],
      delegationSourceEntries: [operation, ocr, signer1, signer2],
      runtimePolicies: new Map([["oath-signature", OATH_SIGNATURE_WORKFLOW_RUNTIME_POLICY]]),
    });

    // ONE operation surface — the signers fold in as members, NOT a second batch
    // surface (the operation anchor claims their parentRunId).
    assert.equal(result.groupRows.length, 1);
    const surface = result.groupRows[0];
    assert.equal(surface?.kind, "operation");
    assert.deepEqual(surface?.members.map((e) => e.id), ["10000001", "10000002"]);
    assert.equal(
      surface?.members.some((m) => m.workflow === "ocr"),
      false,
      "OCR preview is not folded into the operation members",
    );
    assert.deepEqual(result.flatEntries.map((e) => e.id), []);
  });

  it("operation surface reflects a discarded OCR prep through the denormalized status link", () => {
    // The discard route stamps the terminal OCR status back onto the operation
    // row (the OCR review row is in a different panel), so the operation surface
    // reads "discarded" from its own data.
    const operation = entry({
      workflow: "emergency-contact",
      id: "op-3",
      runId: "op-run-3",
      status: "failed",
      data: {
        archetype: "operation",
        queueRowKind: "file",
        pdfOriginalName: "contacts.pdf",
        ocrRunId: "ocr-run-3",
        ocrStatus: "discarded",
        ocrStep: "discarded",
      },
    });

    const result = buildTrackerQueueSurfaces({
      entries: [operation],
      delegationSourceEntries: [operation],
    });

    assert.equal(result.groupRows.length, 1);
    const surface = result.groupRows[0];
    assert.equal(surface?.kind, "operation");
    assert.equal(surface?.kind === "operation" ? surface.ocr?.status : null, "discarded");
    assert.equal(surface?.kind === "operation" ? surface.ocr?.step : null, "discarded");
  });
});
