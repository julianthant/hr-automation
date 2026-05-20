import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  buildProjectionFromQueueSurface,
  buildWorkflowRunProjection,
} from "../../../src/domain/workflow-runtime/projection.js";
import { buildTrackerQueueSurfaces } from "../../../src/tracker/queue-surfaces.js";
import type { TrackerEntry } from "../../../src/tracker/jsonl.js";
import { OCR_WORKFLOW_RUNTIME_POLICY } from "../../../src/workflows/ocr/workflow.js";
import { OATH_SIGNATURE_WORKFLOW_RUNTIME_POLICY } from "../../../src/workflows/oath-signature/workflow.js";
import { OATH_UPLOAD_WORKFLOW_RUNTIME_POLICY } from "../../../src/workflows/oath-upload/workflow.js";
import { EMERGENCY_CONTACT_WORKFLOW_RUNTIME_POLICY } from "../../../src/workflows/emergency-contact/workflow.js";

const phase4Policies = new Map([
  ["ocr", OCR_WORKFLOW_RUNTIME_POLICY],
  ["oath-signature", OATH_SIGNATURE_WORKFLOW_RUNTIME_POLICY],
  ["oath-upload", OATH_UPLOAD_WORKFLOW_RUNTIME_POLICY],
  ["emergency-contact", EMERGENCY_CONTACT_WORKFLOW_RUNTIME_POLICY],
]);

function entry(
  overrides: Partial<TrackerEntry> & Pick<TrackerEntry, "workflow" | "id" | "status">,
): TrackerEntry {
  return {
    timestamp: "2026-05-20T12:00:00.000Z",
    step: "searching",
    ...overrides,
  } as TrackerEntry;
}

describe("workflow runtime projection adapters", () => {
  it("projects a normal row as a normal surface", () => {
    const row = entry({
      workflow: "work-study",
      id: "Doe, Jane",
      runId: "work-study-run-1",
      status: "pending",
      data: { __queueTitle: "Doe, Jane", __queueTitleKind: "single" },
    });

    const projection = buildWorkflowRunProjection(row, {});

    assert.equal(projection.runId, "work-study-run-1");
    assert.equal(projection.workflowId, "work-study");
    assert.equal(projection.title, "Doe, Jane");
    assert.equal(projection.surfaceType, "normal");
  });

  it("projects an OCR approval delegation surface", () => {
    const ocr = entry({
      workflow: "ocr",
      id: "ocr-session-1",
      runId: "ocr-run-1",
      status: "running",
      step: "awaiting-approval",
      data: {
        archetype: "batch-parent",
        mode: "prepare",
        formType: "oath",
        pdfOriginalName: "oath-file.pdf",
      },
    });
    const surfaces = buildTrackerQueueSurfaces({
      entries: [ocr],
      delegationSourceEntries: [ocr],
    });

    const projection = buildProjectionFromQueueSurface(surfaces.groupRows[0]!, {});

    assert.equal(projection.surfaceType, "approval-delegation");
    assert.equal(projection.runId, "ocr-run-1");
    assert.equal(projection.title, "oath-file.pdf");
  });

  it("projects a daemon batch group as batch delegation", () => {
    const first = entry({
      workflow: "onboarding",
      id: "child-1",
      runId: "child-run-1",
      parentRunId: "parent-run-1",
      status: "pending",
      data: { __queueTitle: "Avery Admin", __queueTitleKind: "single" },
    });
    const second = entry({
      workflow: "onboarding",
      id: "child-2",
      runId: "child-run-2",
      parentRunId: "parent-run-1",
      status: "pending",
      data: { __queueTitle: "Bailey Benefits", __queueTitleKind: "single" },
    });
    const surfaces = buildTrackerQueueSurfaces({
      entries: [],
      delegationSourceEntries: [first, second],
    });

    const projection = buildProjectionFromQueueSurface(surfaces.groupRows[0]!, {
      workflowLabels: new Map([["onboarding", "Onboarding"]]),
    });

    assert.equal(projection.surfaceType, "batch-delegation");
    assert.deepEqual(
      projection.batchMembers.map((member) => member.runId),
      ["child-run-1", "child-run-2"],
    );
  });

  it("keeps OCR utility EID lookup children as delegation members", () => {
    const child = entry({
      workflow: "eid-lookup",
      id: "lookup-1",
      runId: "lookup-run-1",
      parentRunId: "ocr-run-1",
      status: "pending",
      data: {
        archetype: "delegate-child",
        originWorkflow: "ocr",
        __queueTitle: "Doe, Jane",
        __queueTitleKind: "single",
      },
    });
    const surfaces = buildTrackerQueueSurfaces({
      entries: [],
      delegationSourceEntries: [child],
    });

    const projection = buildWorkflowRunProjection(surfaces.flatEntries[0]!, {});

    assert.equal(projection.surfaceType, "delegation-member");
    assert.equal(projection.rowTypeLabel, "Delegation member");
  });

  it("does not expose a raw parent run id as the batch group subtitle", () => {
    const first = entry({
      workflow: "ocr",
      id: "ocr-first",
      runId: "ocr-first-run",
      parentRunId: "oath-batch-run-1234",
      status: "running",
      step: "awaiting-approval",
      data: {
        archetype: "batch-parent",
        mode: "prepare",
        formType: "oath",
        parentSubject: "Oath · 1234",
      },
    });
    const second = entry({
      workflow: "ocr",
      id: "ocr-second",
      runId: "ocr-second-run",
      parentRunId: "oath-batch-run-1234",
      status: "running",
      step: "awaiting-approval",
      data: {
        archetype: "batch-parent",
        mode: "prepare",
        formType: "oath",
        parentSubject: "Oath · 1234",
      },
    });
    const surfaces = buildTrackerQueueSurfaces({
      entries: [first, second],
      delegationSourceEntries: [first, second],
    });

    const projection = buildProjectionFromQueueSurface(surfaces.groupRows[0]!, {});

    assert.equal(projection.surfaceType, "batch-delegation");
    assert.equal(projection.title, "Oath · 1234");
    assert.notEqual(projection.subtitle, "oath-batch-run-1234");
    assert.equal(projection.subtitle, undefined);
  });

  it("projects a single OCR prep file as single delegation preview from policy", () => {
    const ocr = entry({
      workflow: "ocr",
      id: "ocr-session-single-file",
      runId: "ocr-run-0001",
      status: "running",
      step: "awaiting-approval",
      data: {
        archetype: "batch-parent",
        mode: "prepare",
        formType: "oath",
        pdfOriginalName: "single-oath.pdf",
      },
    });
    const surfaces = buildTrackerQueueSurfaces({
      entries: [ocr],
      delegationSourceEntries: [ocr],
      runtimePolicies: phase4Policies,
    });

    const projection = buildProjectionFromQueueSurface(surfaces.groupRows[0]!, {
      runtimePolicies: phase4Policies,
    });

    assert.equal(projection.surfaceType, "approval-delegation");
    assert.equal(projection.title, "single-oath.pdf");
    assert.equal(projection.rowTypeLabel, "Single delegation · Preview");
  });

  it("projects Oath Signature prep rows with PDF titles and file-run subtitles", () => {
    const prep = entry({
      workflow: "oath-signature",
      id: "ocr-prep-s1",
      runId: "oath-file-run-9876",
      status: "running",
      step: "ocr",
      data: {
        archetype: "batch-parent",
        mode: "prepare",
        pdfOriginalName: "packet-a.pdf",
        __queueTitle: "Oath · 1111",
        __queueTitleKind: "batch",
        parentSubject: "Oath · 1111",
      },
    });
    const projection = buildWorkflowRunProjection(prep, {
      runtimePolicies: phase4Policies,
    });

    assert.equal(projection.title, "packet-a.pdf");
    assert.equal(projection.subtitle, "Oath · 9876");
  });

  it("projects multiple Oath prep files as grouped singles with per-file subtitles", () => {
    const first = entry({
      workflow: "oath-signature",
      id: "ocr-prep-a",
      runId: "oath-file-run-1111",
      parentRunId: "oath-batch-run-9999",
      status: "running",
      step: "ocr",
      data: {
        archetype: "batch-parent",
        mode: "prepare",
        pdfOriginalName: "packet-a.pdf",
        parentSubject: "Oath · 9999",
        __queueTitle: "Oath · 9999",
        __queueTitleKind: "batch",
      },
    });
    const second = entry({
      workflow: "oath-signature",
      id: "ocr-prep-b",
      runId: "oath-file-run-2222",
      parentRunId: "oath-batch-run-9999",
      status: "running",
      step: "ocr",
      data: {
        archetype: "batch-parent",
        mode: "prepare",
        pdfOriginalName: "packet-b.pdf",
        parentSubject: "Oath · 9999",
        __queueTitle: "Oath · 9999",
        __queueTitleKind: "batch",
      },
    });
    const surfaces = buildTrackerQueueSurfaces({
      entries: [first, second],
      delegationSourceEntries: [first, second],
      runtimePolicies: phase4Policies,
    });

    const projection = buildProjectionFromQueueSurface(surfaces.groupRows[0]!, {
      runtimePolicies: phase4Policies,
    });

    assert.equal(projection.surfaceType, "batch-delegation");
    assert.equal(projection.title, "Oath · 9999");
    assert.deepEqual(
      projection.batchMembers.map((member) => [member.title, member.subtitle]),
      [
        ["packet-a.pdf", "Oath · 1111"],
        ["packet-b.pdf", "Oath · 2222"],
      ],
    );
  });

  it("keeps OCR utility EID and active-check rows flat under policy", () => {
    const lookup = entry({
      workflow: "eid-lookup",
      id: "lookup-1",
      runId: "lookup-run-1",
      parentRunId: "ocr-run-1",
      status: "pending",
      data: {
        archetype: "delegate-child",
        originWorkflow: "ocr",
        searchName: "Doe, Jane",
      },
    });
    const active = entry({
      workflow: "active-check",
      id: "active-1",
      runId: "active-run-1",
      parentRunId: "ocr-run-1",
      status: "pending",
      data: {
        archetype: "delegate-child",
        originWorkflow: "ocr",
        emplId: "10000001",
      },
    });

    const surfaces = buildTrackerQueueSurfaces({
      entries: [],
      delegationSourceEntries: [lookup, active],
      runtimePolicies: phase4Policies,
    });

    assert.equal(surfaces.groupRows.length, 0);
    assert.deepEqual(surfaces.flatEntries.map((row) => row.id), ["lookup-1", "active-1"]);
  });

  it("projects final Oath Signature rows as person-titled delegation members", () => {
    const finalRow = entry({
      workflow: "oath-signature",
      id: "ocr-oath-technical-r0",
      runId: "signature-run-1",
      parentRunId: "oath-file-run-9876",
      status: "pending",
      data: {
        archetype: "delegate-child",
        name: "Jane Doe",
        emplId: "10000001",
        __queueTitle: "Oath · 9876",
        __queueTitleKind: "batch",
      },
    });

    const projection = buildWorkflowRunProjection(finalRow, {
      runtimePolicies: phase4Policies,
    });

    assert.equal(projection.surfaceType, "delegation-member");
    assert.equal(projection.title, "Jane Doe");
    assert.equal(projection.actions.find((action) => action.kind === "cancel")?.scope, "row");
  });

  it("keeps the Oath Upload root projection anchored to the same root row", () => {
    const root = entry({
      workflow: "oath-upload",
      id: "upload-session-1",
      runId: "oath-upload-run-1",
      status: "running",
      step: "wait-signatures",
      data: {
        archetype: "batch-parent",
        pdfOriginalName: "upload-packet.pdf",
        __queueTitle: "Oath Upload · 0001",
        __queueTitleKind: "batch",
      },
    });
    const ocrChild = entry({
      workflow: "ocr",
      id: "ocr-session-1",
      runId: "ocr-run-1",
      parentRunId: "oath-upload-run-1",
      status: "running",
      step: "awaiting-approval",
      data: {
        archetype: "batch-parent",
        mode: "prepare",
        pdfOriginalName: "upload-packet.pdf",
        formType: "oath",
      },
    });
    const signatureChild = entry({
      workflow: "oath-signature",
      id: "10000001",
      runId: "signature-run-1",
      parentRunId: "oath-upload-run-1",
      status: "failed",
      data: {
        archetype: "delegate-child",
        name: "Jane Doe",
        emplId: "10000001",
      },
    });
    const surfaces = buildTrackerQueueSurfaces({
      entries: [root],
      delegationSourceEntries: [root, ocrChild, signatureChild],
      runtimePolicies: phase4Policies,
    });

    const projection = buildProjectionFromQueueSurface(surfaces.groupRows[0]!, {
      runtimePolicies: phase4Policies,
    });

    assert.equal(projection.workflowId, "oath-upload");
    assert.equal(projection.runId, "oath-upload-run-1");
    assert.equal(projection.itemId, "upload-session-1");
    assert.equal(projection.actions.find((action) => action.kind === "cancel")?.scope, "tree");
    assert.deepEqual(projection.batchMembers.map((member) => member.runId), [
      "ocr-run-1",
      "signature-run-1",
    ]);
  });
});
