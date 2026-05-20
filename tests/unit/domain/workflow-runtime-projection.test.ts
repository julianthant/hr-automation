import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  buildProjectionFromQueueSurface,
  buildWorkflowRunProjection,
} from "../../../src/domain/workflow-runtime/projection.js";
import { buildTrackerQueueSurfaces } from "../../../src/tracker/queue-surfaces.js";
import type { TrackerEntry } from "../../../src/tracker/jsonl.js";

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
});
