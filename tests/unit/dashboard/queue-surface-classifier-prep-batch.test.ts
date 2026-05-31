import { test } from "vitest";
import assert from "node:assert/strict";
import { buildQueueSurfaces } from "../../../src/dashboard/components/queue-panel/queue-surface-classifier.js";
import type { TrackerEntry } from "../../../src/dashboard/components/shared/types.js";

function prepParent(overrides: Partial<TrackerEntry> = {}): TrackerEntry {
  return {
    workflow: "ocr",
    timestamp: "2026-05-14T06:00:00Z",
    id: "ocr-prep-abc",
    runId: "parent-1234",
    status: "running",
    step: "ocr",
    data: {
      archetype: "preview",
      __name: "OCR · #1234",
      __id: "ocr-prep-abc",
      mode: "prepare",
      pdfOriginalName: "x.pdf",
    },
    ...overrides,
  } as TrackerEntry;
}

test("pre-approval prep parent renders as preview surface without request child rows", () => {
  const surfaces = buildQueueSurfaces({
    entries: [prepParent()],
    delegationSourceEntries: [],
    workflow: "ocr",
    workflowLabel: "OCR",
  });
  assert.equal(surfaces.groupRows.length, 1);
  assert.equal(surfaces.groupRows[0]!.kind, "preview");
  assert.equal(surfaces.flatEntries.length, 0);
});

test("post-approval prep parent + multiple kernel children stays grouped", () => {
  const approved = prepParent({ status: "done", step: "approved" });
  const child1: TrackerEntry = {
    workflow: "oath-signature",
    timestamp: "2026-05-14T06:00:00Z",
    id: "10874100",
    runId: "kernel-1",
    parentRunId: "parent-1234",
    status: "running",
    data: {
      __name: "Oath Signature · #1234",
      __id: "10874100",
      emplId: "10874100",
      parentSubject: "Oath Signature · #1234",
    },
  } as TrackerEntry;
  const child2: TrackerEntry = {
    workflow: "oath-signature",
    timestamp: "2026-05-14T06:00:00Z",
    id: "10874101",
    runId: "kernel-2",
    parentRunId: "parent-1234",
    status: "running",
    data: {
      __name: "Oath Signature · #1234",
      __id: "10874101",
      emplId: "10874101",
      parentSubject: "Oath Signature · #1234",
    },
  } as TrackerEntry;
  const surfaces = buildQueueSurfaces({
    entries: [approved, child1, child2],
    delegationSourceEntries: [child1, child2],
    workflow: "ocr",
    workflowLabel: "OCR",
  });
  assert.equal(surfaces.groupRows.length, 1);
  assert.equal(surfaces.groupRows[0]!.members.length, 2);
});

test("post-approval prep parent + single kernel child stays grouped", () => {
  const approved = prepParent({ status: "done", step: "approved" });
  const child1: TrackerEntry = {
    workflow: "oath-signature",
    timestamp: "2026-05-14T06:00:00Z",
    id: "10874100",
    runId: "kernel-1",
    parentRunId: "parent-1234",
    status: "running",
    data: {
      __name: "Oath Signature · #1234",
      __id: "10874100",
      emplId: "10874100",
      parentSubject: "Oath Signature · #1234",
    },
  } as TrackerEntry;
  const surfaces = buildQueueSurfaces({
    entries: [approved, child1],
    delegationSourceEntries: [child1],
    workflow: "ocr",
    workflowLabel: "OCR",
  });
  // A single-signer PDF must remain a batch card after OCR approval — it
  // must not collapse into a flat single row.
  assert.equal(surfaces.groupRows.length, 1);
  assert.equal(surfaces.groupRows[0]!.kind, "preview");
  assert.equal(surfaces.groupRows[0]!.members.length, 1);
  assert.equal(surfaces.flatEntries.length, 0);
});

test("prep parent with 0 members still renders as group surface (not flat)", () => {
  const surfaces = buildQueueSurfaces({
    entries: [prepParent()],
    delegationSourceEntries: [],
    workflow: "ocr",
    workflowLabel: "OCR",
  });
  assert.equal(surfaces.groupRows.length, 1);
  assert.equal(surfaces.groupRows[0]!.kind, "preview");
  assert.equal(surfaces.flatEntries.length, 0);
});

test("discarded prep parent is excluded from all surfaces", () => {
  const discarded = prepParent({ status: "failed", step: "discarded" });
  const surfaces = buildQueueSurfaces({
    entries: [discarded],
    delegationSourceEntries: [],
    workflow: "ocr",
    workflowLabel: "OCR",
  });
  assert.equal(surfaces.groupRows.length, 0);
  assert.equal(surfaces.flatEntries.length, 0);
});

test("ocr-workflow awaiting-approval row renders as a group card (preview archetype)", () => {
  const ocrRow: TrackerEntry = {
    workflow: "ocr",
    timestamp: "2026-05-14T06:00:00Z",
    id: "ocr-session-x",
    runId: "ocr-run-x",
    status: "running",
    step: "awaiting-approval",
    data: { archetype: "preview", mode: "prepare", formType: "oath" },
  } as TrackerEntry;
  const surfaces = buildQueueSurfaces({
    entries: [ocrRow],
    delegationSourceEntries: [ocrRow],
    workflow: "ocr",
    workflowLabel: "OCR",
  });
  assert.equal(surfaces.groupRows.length, 1);
  assert.equal(surfaces.groupRows[0]?.kind, "preview");
  assert.equal(surfaces.groupRows[0]?.approvalState, "awaiting-approval");
  assert.equal(surfaces.flatEntries.length, 0);
});
