import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { buildQueueSurfaces } from "../../../src/dashboard/components/queue-panel/queue-surface-classifier.js";
import type { TrackerEntry } from "../../../src/dashboard/components/shared/types.js";

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
  it("keeps approved OCR approval delegation visible and folds passive children underneath", () => {
    const ocr = row({
      workflow: "ocr",
      id: "ocr-session-1",
      runId: "ocr-run-1",
      parentRunId: "oath-upload-run-1",
      status: "done",
      step: "approved",
      data: { mode: "prepare", formType: "oath", pdfOriginalName: "oath.pdf" },
    });
    const eid = row({
      workflow: "eid-lookup",
      id: "ocr-session-1-r0",
      runId: "eid-run-1",
      parentRunId: "ocr-run-1",
      status: "done",
      data: { searchName: "Doe, Jane", emplId: "10000001" },
    });

    const surfaces = buildQueueSurfaces({
      entries: [ocr],
      delegationSourceEntries: [ocr, eid],
      workflow: "ocr",
      workflowLabel: "OCR",
    });

    assert.equal(surfaces.groupRows.length, 1);
    assert.equal(surfaces.groupRows[0]?.kind, "approval-delegation");
    assert.equal(surfaces.groupRows[0]?.parentRunId, "ocr-run-1");
    assert.equal(surfaces.groupRows[0]?.approvalState, "approved");
    assert.deepEqual(surfaces.groupRows[0]?.members.map((entry) => entry.id), [
      "ocr-session-1-r0",
    ]);
    assert.deepEqual(surfaces.flatEntries.map((entry) => entry.id), []);
  });

  it("classifies non-approval parentRunId groups as batch rows", () => {
    const a = row({
      workflow: "eid-lookup",
      id: "a",
      runId: "run-a",
      parentRunId: "batch-1",
      status: "pending",
    });
    const b = row({
      workflow: "eid-lookup",
      id: "b",
      runId: "run-b",
      parentRunId: "batch-1",
      status: "done",
    });

    const surfaces = buildQueueSurfaces({
      entries: [a, b],
      delegationSourceEntries: [a, b],
      workflow: "eid-lookup",
      workflowLabel: "EID Lookup",
    });

    assert.equal(surfaces.groupRows.length, 1);
    assert.equal(surfaces.groupRows[0]?.kind, "batch");
    assert.equal(surfaces.groupRows[0]?.parentRunId, "batch-1");
    assert.deepEqual(surfaces.groupRows[0]?.members.map((entry) => entry.id), ["a", "b"]);
    assert.deepEqual(surfaces.flatEntries.map((entry) => entry.id), []);
  });

  it("leaves awaiting approval OCR rows flat until they are approved", () => {
    const ocr = row({
      workflow: "ocr",
      id: "ocr-session-2",
      runId: "ocr-run-2",
      status: "running",
      step: "awaiting-approval",
      data: { mode: "prepare", formType: "emergency-contact" },
    });

    const surfaces = buildQueueSurfaces({
      entries: [ocr],
      delegationSourceEntries: [ocr],
      workflow: "ocr",
      workflowLabel: "OCR",
    });

    assert.equal(surfaces.groupRows.length, 0);
    assert.deepEqual(surfaces.flatEntries.map((entry) => entry.id), ["ocr-session-2"]);
  });

  it("removes discarded approval rows from all surfaces", () => {
    const discarded = row({
      workflow: "ocr",
      id: "ocr-session-3",
      runId: "ocr-run-3",
      status: "failed",
      step: "discarded",
      data: { mode: "prepare", formType: "oath" },
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

      const surfaces = buildQueueSurfaces({
        entries: [ocr],
        delegationSourceEntries: [ocr, downstream],
        workflow: "ocr",
        workflowLabel: "OCR",
      });

      assert.equal(surfaces.groupRows[0]?.kind, "approval-delegation");
      assert.equal(surfaces.groupRows[0]?.parentRunId, `${origin}-ocr-run`);
      assert.deepEqual(surfaces.groupRows[0]?.members.map((entry) => entry.id), [
        `${origin}-child-1`,
      ]);
    });
  }
});
