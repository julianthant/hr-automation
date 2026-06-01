import { describe, it } from "vitest";
import assert from "node:assert/strict";

import {
  buildQueueProjectionRows,
  buildQueueProjections,
  buildQueueSurfaces,
} from "../../../src/dashboard/components/queue-panel/queue-surface-classifier.js";
import type { TrackerEntry } from "../../../src/dashboard/components/shared/types.js";
import { OCR_WORKFLOW_RUNTIME_POLICY } from "../../../src/workflows/ocr/workflow.js";
import { PERSON_LOOKUP_WORKFLOW_RUNTIME_POLICY } from "../../../src/workflows/person-lookup/workflow.js";

const runtimePolicies = new Map([
  ["ocr", OCR_WORKFLOW_RUNTIME_POLICY],
  ["person-lookup", PERSON_LOOKUP_WORKFLOW_RUNTIME_POLICY],
]);

function row(
  overrides: Partial<TrackerEntry> & Pick<TrackerEntry, "workflow" | "id" | "status">,
): TrackerEntry {
  return {
    timestamp: "2026-05-13T12:00:00.000Z",
    step: "searching",
    ...overrides,
  } as TrackerEntry;
}

describe("buildQueueSurfaces", () => {
  it("builds projection rows from the same queue surfaces", () => {
    const a = row({
      workflow: "person-lookup",
      id: "a",
      runId: "run-a",
      parentRunId: "batch-1",
      status: "pending",
    });
    const b = row({
      workflow: "person-lookup",
      id: "b",
      runId: "run-b",
      parentRunId: "batch-1",
      status: "done",
    });

    const projections = buildQueueProjections({
      entries: [a, b],
      delegationSourceEntries: [a, b],
      workflow: "person-lookup",
      workflowLabel: "Person Lookup",
    });

    assert.equal(projections.length, 1);
    assert.equal(projections[0]?.surfaceType, "batch");
    assert.equal(projections[0]?.rowTypeLabel, "Batch");
    assert.deepEqual(projections[0]?.actions.map((action) => action.targets.map((target) => target.runId)), [
      ["run-a", "run-b"],
      ["run-a", "run-b"],
    ]);
  });

  it("gives a memberless OCR preview a flat parentProjection (renders as a single row, not a 0/0 batch)", () => {
    const ocr = row({
      workflow: "ocr",
      id: "ocr-session-1",
      runId: "ocr-run-1",
      status: "running",
      step: "awaiting-approval",
      data: {
        archetype: "preview",
        queueRowKind: "file",
        mode: "prepare",
        pdfOriginalName: "Xerox Scan_04282026111307.pdf",
        __traceId: "oc-095600-5603",
      },
    });
    const rows = buildQueueProjectionRows({
      entries: [ocr],
      delegationSourceEntries: [],
      workflow: "ocr",
      workflowLabel: "OCR",
      runtimePolicies,
    });
    const group = rows.groupRows[0];
    assert.ok(group, "expected a preview group row");
    assert.equal(group.surface.kind, "preview");
    assert.equal(group.surface.members.length, 0);
    // The flat parentProjection drives the EntryItem render: PDF-name title,
    // trace-id subtitle (never "OCR"), and a running row's only enabled action
    // is cancel.
    assert.ok(group.parentProjection, "expected a flat parentProjection");
    assert.equal(group.parentProjection!.title, "Xerox Scan_04282026111307.pdf");
    assert.equal(group.parentProjection!.subtitle, "oc-095600-5603");
    assert.deepEqual(
      group.parentProjection!.actions.filter((a) => a.enabled).map((a) => a.kind).sort(),
      ["cancel"],
    );
  });

  it("groups multiple OCR person-lookup children as a delegated batch", () => {
    const ocr = row({
      workflow: "ocr",
      id: "ocr-session-1",
      runId: "ocr-run-1",
      parentRunId: "oath-upload-run-1",
      status: "running",
      step: "awaiting-approval",
      data: { archetype: "preview", mode: "prepare", formType: "oath", pdfOriginalName: "oath.pdf" },
    });
    const eidA = row({
      workflow: "person-lookup",
      id: "ocr-session-1-r0",
      runId: "eid-run-1",
      parentRunId: "ocr-run-1",
      status: "done",
      data: { archetype: "single", searchName: "Doe, Jane", emplId: "10000001" },
    });
    const eidB = row({
      workflow: "person-lookup",
      id: "ocr-session-1-r1",
      runId: "eid-run-2",
      parentRunId: "ocr-run-1",
      status: "done",
      data: { archetype: "single", searchName: "Roe, Richard", emplId: "10000002" },
    });

    const surfaces = buildQueueSurfaces({
      entries: [ocr],
      delegationSourceEntries: [ocr, eidA, eidB],
      workflow: "ocr",
      workflowLabel: "OCR",
      runtimePolicies,
    });

    assert.equal(surfaces.groupRows.length, 1);
    assert.equal(surfaces.groupRows[0]?.kind, "preview");
    assert.deepEqual(surfaces.groupRows[0]?.members.map((entry) => entry.id), [
      "ocr-session-1-r0",
      "ocr-session-1-r1",
    ]);
    assert.deepEqual(surfaces.flatEntries.map((entry) => entry.id), []);
  });

  it("keeps a one-child approved OCR delegation as a group card", () => {
    const ocr = row({
      workflow: "ocr",
      id: "ocr-session-single",
      runId: "ocr-run-single",
      parentRunId: "oath-upload-run-single",
      status: "done",
      step: "approved",
      data: { archetype: "preview", mode: "prepare", formType: "oath", pdfOriginalName: "single-oath.pdf" },
    });
    const child = row({
      workflow: "oath-signature",
      id: "10000001",
      runId: "oath-child-run-single",
      parentRunId: "ocr-run-single",
      status: "running",
      data: { emplId: "10000001" },
    });

    const surfaces = buildQueueSurfaces({
      entries: [ocr],
      delegationSourceEntries: [ocr, child],
      workflow: "ocr",
      workflowLabel: "OCR",
    });

    // A single-signer prep row stays a batch card after approval.
    assert.equal(surfaces.groupRows.length, 1);
    assert.equal(surfaces.groupRows[0]?.kind, "preview");
    assert.deepEqual(surfaces.groupRows[0]?.members.map((entry) => entry.id), ["10000001"]);
    assert.deepEqual(surfaces.flatEntries.map((entry) => entry.id), []);
  });

  it("surfaces a single OCR-fan-out person-lookup child as a flat delegation member", () => {
    const eid = row({
      workflow: "person-lookup",
      id: "ocr-oath-run-1-r0",
      runId: "eid-run-single",
      parentRunId: "ocr-run-1",
      status: "done",
      data: {
        searchName: "Barahona Martell, Carlos D",
        taskRole: "child",
        parentSubject: "Oath · 1234",
      },
    });

    const surfaces = buildQueueSurfaces({
      entries: [],
      delegationSourceEntries: [eid],
      workflow: "oath-signature",
      workflowLabel: "Oath Signature",
      runtimePolicies,
    });

    assert.equal(surfaces.groupRows.length, 0);
    assert.deepEqual(surfaces.flatEntries.map((entry) => entry.id), ["ocr-oath-run-1-r0"]);
  });

  it("builds phase-5 projections with default group actions for separations batches", () => {
    const a = row({
      workflow: "separations",
      id: "3927",
      runId: "run-a",
      parentRunId: "batch-1",
      status: "pending",
      data: { docId: "3927", __queueTitle: "Employee A" },
    });
    const b = row({
      workflow: "separations",
      id: "3924",
      runId: "run-b",
      parentRunId: "batch-1",
      status: "done",
      data: { docId: "3924", __queueTitle: "Employee B" },
    });

    const projections = buildQueueProjections({
      entries: [a, b],
      delegationSourceEntries: [a, b],
      workflow: "separations",
      workflowLabel: "Separations",
      runtimePolicies,
    });

    assert.equal(projections.length, 1);
    assert.equal(projections[0]?.surfaceType, "batch");
    assert.equal(projections[0]?.rowTypeLabel, "Batch");
    assert.notEqual(projections[0]?.subtitle, "batch-1");
  });

  it("classifies non-approval parentRunId groups as batch rows", () => {
    const a = row({
      workflow: "person-lookup",
      id: "a",
      runId: "run-a",
      parentRunId: "batch-1",
      status: "pending",
    });
    const b = row({
      workflow: "person-lookup",
      id: "b",
      runId: "run-b",
      parentRunId: "batch-1",
      status: "done",
    });

    const surfaces = buildQueueSurfaces({
      entries: [a, b],
      delegationSourceEntries: [a, b],
      workflow: "person-lookup",
      workflowLabel: "Person Lookup",
    });

    assert.equal(surfaces.groupRows.length, 1);
    assert.equal(surfaces.groupRows[0]?.kind, "batch");
    assert.equal(surfaces.groupRows[0]?.parentRunId, "batch-1");
    assert.deepEqual(surfaces.groupRows[0]?.members.map((entry) => entry.id), ["a", "b"]);
    assert.deepEqual(surfaces.flatEntries.map((entry) => entry.id), []);
  });

  it("surfaces one delegated utility child as a flat delegation row", () => {
    const parent = row({
      workflow: "onboarding",
      id: "jane@example.edu",
      runId: "parent-run-1",
      timestamp: "2026-05-12T10:00:00.000Z",
      status: "running",
      data: { taskRole: "delegator", __subject: "Onboarding: jane@example.edu" },
    });
    const child = row({
      workflow: "crm-doc-download",
      id: "jane@example.edu",
      runId: "child-run-1",
      parentRunId: "parent-run-1",
      timestamp: "2026-05-12T10:01:00.000Z",
      status: "pending",
      data: {
        archetype: "single",
        taskRole: "utility",
        parentSubject: "Onboarding: jane@example.edu",
      },
    });

    const surfaces = buildQueueSurfaces({
      entries: [parent, child],
      delegationSourceEntries: [parent, child],
      workflow: "onboarding",
      workflowLabel: "Onboarding",
    });

    assert.equal(surfaces.groupRows.length, 0);
    assert.deepEqual(
      new Set(surfaces.flatEntries.map((entry) => entry.runId)),
      new Set(["parent-run-1", "child-run-1"]),
    );
  });

  it("keeps an approved OCR preview row visible without delegation members", () => {
    // Downstream entries (oath-signature) live in a different workflow's entries
    // list and are absent from delegationSourceEntries for the OCR queue view.
    const ocr = row({
      workflow: "ocr",
      id: "ocr-session-nochildren",
      runId: "ocr-run-nochildren",
      status: "done",
      step: "approved",
      data: { archetype: "preview", mode: "prepare", formType: "oath", pdfOriginalName: "single.pdf" },
    });

    const surfaces = buildQueueSurfaces({
      entries: [ocr],
      delegationSourceEntries: [ocr], // no downstream members
      workflow: "ocr",
      workflowLabel: "OCR",
    });

    assert.equal(surfaces.groupRows.length, 1);
    assert.equal(surfaces.groupRows[0]?.kind, "preview");
    assert.deepEqual(surfaces.groupRows[0]?.members.map((entry) => entry.id), []);
    assert.deepEqual(surfaces.flatEntries.map((e) => e.id), []);
  });

  it("renders awaiting-approval OCR row as a preview group card", () => {
    const ocr = row({
      workflow: "ocr",
      id: "ocr-session-2",
      runId: "ocr-run-2",
      status: "running",
      step: "awaiting-approval",
      data: { archetype: "preview", mode: "prepare", formType: "emergency-contact" },
    });

    const surfaces = buildQueueSurfaces({
      entries: [ocr],
      delegationSourceEntries: [ocr],
      workflow: "ocr",
      workflowLabel: "OCR",
    });

    assert.equal(surfaces.groupRows.length, 1);
    assert.equal(surfaces.groupRows[0]?.kind, "preview");
    assert.equal(surfaces.groupRows[0]?.approvalState, "awaiting-approval");
    assert.deepEqual(surfaces.flatEntries.map((entry) => entry.id), []);
  });

  it("removes discarded approval rows from all surfaces", () => {
    const discarded = row({
      workflow: "ocr",
      id: "ocr-session-3",
      runId: "ocr-run-3",
      status: "failed",
      step: "discarded",
      data: { archetype: "preview", mode: "prepare", formType: "oath" },
    });

    const surfaces = buildQueueSurfaces({
      entries: [discarded],
      delegationSourceEntries: [discarded],
      workflow: "ocr",
      workflowLabel: "OCR",
    });

    assert.equal(surfaces.groupRows.length, 0);
    assert.equal(surfaces.flatEntries.length, 0);
  });

  it("surfaces a single delegated OCR prepare row as a preview group", () => {
    const ocr = row({
      workflow: "ocr",
      id: "ocr-session-single",
      runId: "ocr-run-single",
      parentRunId: "oath-upload-run-single",
      status: "running",
      step: "awaiting-approval",
      data: { archetype: "preview", mode: "prepare", formType: "oath", pdfOriginalName: "single-oath.pdf" },
    });

    const surfaces = buildQueueSurfaces({
      entries: [ocr],
      delegationSourceEntries: [ocr],
      workflow: "ocr",
      workflowLabel: "OCR",
    });

    assert.equal(surfaces.groupRows.length, 1);
    assert.equal(surfaces.groupRows[0]?.kind, "preview");
    assert.deepEqual(surfaces.groupRows[0]?.members.map((entry) => entry.id), []);
    assert.deepEqual(surfaces.flatEntries.map((entry) => entry.id), []);
  });

  it("keeps multiple delegated OCR prepare rows as separate preview groups", () => {
    const first = row({
      workflow: "ocr",
      id: "ocr-session-first",
      runId: "ocr-run-first",
      parentRunId: "oath-upload-run-batch",
      status: "running",
      step: "awaiting-approval",
      data: { archetype: "preview", mode: "prepare", formType: "oath", pdfOriginalName: "first.pdf" },
    });
    const second = row({
      workflow: "ocr",
      id: "ocr-session-second",
      runId: "ocr-run-second",
      parentRunId: "oath-upload-run-batch",
      status: "running",
      step: "awaiting-approval",
      data: { archetype: "preview", mode: "prepare", formType: "oath", pdfOriginalName: "second.pdf" },
    });

    const surfaces = buildQueueSurfaces({
      entries: [first, second],
      delegationSourceEntries: [first, second],
      workflow: "ocr",
      workflowLabel: "OCR",
    });

    assert.equal(surfaces.groupRows.length, 2);
    assert.deepEqual(surfaces.groupRows.map((surface) => surface.kind), [
      "preview",
      "preview",
    ]);
    assert.deepEqual(surfaces.groupRows.map((surface) => surface.parentRunId), [
      "ocr-run-first",
      "ocr-run-second",
    ]);
    assert.deepEqual(surfaces.flatEntries.map((entry) => entry.id), []);
  });

  for (const origin of ["oath-upload", "oath-signature", "emergency-contact"] as const) {
    it(`keeps approved OCR approval delegation visible for ${origin}`, () => {
      const ocr = row({
        workflow: "ocr",
        id: `${origin}-ocr-session`,
        runId: `${origin}-ocr-run`,
        parentRunId: `${origin}-parent-run`,
        status: "done",
        step: "approved",
        data: {
          archetype: "preview",
          mode: "prepare",
          formType: origin === "emergency-contact" ? "emergency-contact" : "oath",
        },
      });
      const downstream = row({
        workflow: origin === "emergency-contact" ? "emergency-contact" : "oath-signature",
        id: `${origin}-child-1`,
        runId: `${origin}-child-run-1`,
        parentRunId: `${origin}-ocr-run`,
        status: "pending",
      });
      const downstream2 = row({
        workflow: origin === "emergency-contact" ? "emergency-contact" : "oath-signature",
        id: `${origin}-child-2`,
        runId: `${origin}-child-run-2`,
        parentRunId: `${origin}-ocr-run`,
        status: "pending",
      });

      const surfaces = buildQueueSurfaces({
        entries: [ocr],
        delegationSourceEntries: [ocr, downstream, downstream2],
        workflow: "ocr",
        workflowLabel: "OCR",
      });

      assert.equal(surfaces.groupRows[0]?.kind, "preview");
      assert.equal(surfaces.groupRows[0]?.parentRunId, `${origin}-ocr-run`);
      assert.deepEqual(surfaces.groupRows[0]?.members.map((entry) => entry.id), [
        `${origin}-child-1`,
        `${origin}-child-2`,
      ]);
    });
  }
});
