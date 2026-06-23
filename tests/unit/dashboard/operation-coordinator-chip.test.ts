/**
 * E2E-106: Operation coordinator chip must NOT show a worst-member rollup.
 *
 * After OCR approval the coordinator row is `status:"running"/step:"approved"`.
 * Members fan out and some may fail. The coordinator chip must NEVER flip to
 * `"failed"` just because one member failed — a partly-failed fan-out reads
 * "done" at the coordinator level, with the failures visible in the member
 * tally (StatusCounts).
 *
 * The coordinator's lifecycle also COMPLETES when the fan-out completes: while
 * members are still in flight the chip stays `"running"`, and once every member
 * is terminal it flips to `"done"` (the coordinator is a display-only row with
 * no daemon task, so the member rollup is the only completion signal).
 *
 * The rule must be identical across all three operation workflows:
 * oath-signature, emergency-contact, and oath-upload.
 */

import { test, describe } from "vitest";
import assert from "node:assert/strict";

import { buildQueueProjectionRows } from "../../../src/dashboard/components/queue-panel/queue-surface-classifier.js";
import type { TrackerEntry } from "../../../src/dashboard/components/shared/types.js";

const TS = "2026-06-16T10:00:00.000Z";

function entry(
  overrides: Partial<TrackerEntry> & Pick<TrackerEntry, "id" | "workflow" | "status">,
): TrackerEntry {
  return {
    timestamp: TS,
    data: { archetype: "single" },
    ...overrides,
  } as TrackerEntry;
}

/**
 * Build a minimal operation surface for one of the three coordinator workflows.
 *
 * coordinatorStatus / coordinatorStep: the coordinator's OWN latest lifecycle state.
 * memberStatuses: each fanned-out child's status.
 */
function buildOperationProjection(
  workflow: "oath-signature" | "emergency-contact" | "oath-upload",
  coordinatorStatus: TrackerEntry["status"],
  coordinatorStep: string,
  memberStatuses: TrackerEntry["status"][],
) {
  const coordId = `coord-${workflow}`;
  const coordRunId = `coord-run-${workflow}`;

  const coordinator = entry({
    workflow,
    id: coordId,
    runId: coordRunId,
    status: coordinatorStatus,
    step: coordinatorStep,
    data: {
      archetype: "operation",
      queueRowKind: "file",
      pdfOriginalName: "doc.pdf",
      ocrStatus: "approved",
      ocrStep: "approved",
    },
  });

  // Members are operation-member rows delegated from the OCR run (parentRunId =
  // ocr run id, but they appear in the coordinator's member list via
  // buildTrackerQueueSurfaces). For the projection test, supply them directly.
  const childWorkflow =
    workflow === "emergency-contact" ? "emergency-contact" : "oath-signature";
  const members = memberStatuses.map((status, i) =>
    entry({
      workflow: childWorkflow,
      id: `member-${i}`,
      runId: `member-run-${i}`,
      parentRunId: coordRunId,
      status,
      data: { archetype: "operation-member", queueRowKind: "person", name: `Person ${i}` },
    }),
  );

  // buildQueueProjectionRows classifies surfaces automatically. We pass
  // the coordinator as the main entry and all entries as delegation sources.
  const allEntries = [coordinator, ...members];
  return buildQueueProjectionRows({
    entries: [coordinator],
    delegationSourceEntries: allEntries,
    workflow,
    workflowLabel: workflow,
  });
}

// ---------------------------------------------------------------------------
// Pin red: coordinator with done+failed members must show ITS OWN status
// ---------------------------------------------------------------------------

describe("E2E-106: operation coordinator chip never shows a worst-member 'failed' rollup", () => {
  const COORDINATOR_STATUS: TrackerEntry["status"] = "running";
  const COORDINATOR_STEP = "approved";
  // All members terminal (2 done + 1 failed): the fan-out is complete, so the
  // coordinator flips to "done" — and crucially NOT "failed" from the failed
  // member (the failure stays in the StatusCounts tally).
  const MIXED_MEMBERS: TrackerEntry["status"][] = ["done", "done", "failed"];

  for (const workflow of [
    "oath-signature",
    "emergency-contact",
    "oath-upload",
  ] as const) {
    test(`${workflow}: all-terminal fan-out with a failed member reads "done", never "failed"`, () => {
      const rows = buildOperationProjection(
        workflow,
        COORDINATOR_STATUS,
        COORDINATOR_STEP,
        MIXED_MEMBERS,
      );

      // There should be exactly one group row (the operation coordinator).
      assert.equal(rows.groupRows.length, 1, "expected one operation group row");
      const proj = rows.groupRows[0]?.projection;
      assert.ok(proj, "projection must exist");
      assert.notEqual(
        proj.status,
        "failed",
        `${workflow} coordinator chip must NOT be "failed" from a worst-member rollup`,
      );
      assert.equal(
        proj.status,
        "done",
        `${workflow} coordinator chip should be "done" once every member is terminal`,
      );
    });
  }

  test("all three workflows yield identical coordinator chip status for the same mixed member set", () => {
    const statuses = (
      [
        "oath-signature",
        "emergency-contact",
        "oath-upload",
      ] as const
    ).map((wf) => {
      const rows = buildOperationProjection(wf, COORDINATOR_STATUS, COORDINATOR_STEP, MIXED_MEMBERS);
      const proj = rows.groupRows[0]?.projection;
      assert.ok(proj, `${wf}: projection must exist`);
      return proj.status;
    });

    // All three must agree.
    assert.equal(statuses[0], statuses[1], "oath-signature and emergency-contact must produce the same coordinator status");
    assert.equal(statuses[1], statuses[2], "emergency-contact and oath-upload must produce the same coordinator status");
  });

  test("coordinator in 'done' state with a failed member stays 'done'", () => {
    for (const workflow of ["oath-signature", "emergency-contact", "oath-upload"] as const) {
      const rows = buildOperationProjection(workflow, "done", "done", ["done", "failed"]);
      const proj = rows.groupRows[0]?.projection;
      assert.ok(proj, `${workflow}: projection must exist`);
      assert.equal(
        proj.status,
        "done",
        `${workflow}: coordinator at "done" step should stay "done", not become "failed"`,
      );
    }
  });

  test("coordinator still shows 'running' while members are in flight (running/queued)", () => {
    for (const workflow of ["oath-signature", "emergency-contact", "oath-upload"] as const) {
      const rows = buildOperationProjection(workflow, "running", "approved", ["running", "pending"]);
      const proj = rows.groupRows[0]?.projection;
      assert.ok(proj, `${workflow}: projection must exist`);
      assert.equal(proj.status, "running");
    }
  });

  test("coordinator flips to 'done' once the whole fan-out is terminal (all members done)", () => {
    for (const workflow of ["oath-signature", "emergency-contact", "oath-upload"] as const) {
      const rows = buildOperationProjection(workflow, "running", "approved", ["done", "done", "done"]);
      const proj = rows.groupRows[0]?.projection;
      assert.ok(proj, `${workflow}: projection must exist`);
      // The coordinator has no daemon task to emit its own terminal row, so the
      // member rollup is the completion signal: every member terminal → "done".
      assert.equal(proj.status, "done");
    }
  });

  test("a single completed member flips the coordinator to 'done' (matches the rendered fan-out)", () => {
    for (const workflow of ["oath-signature", "emergency-contact", "oath-upload"] as const) {
      const rows = buildOperationProjection(workflow, "running", "approved", ["done"]);
      const proj = rows.groupRows[0]?.projection;
      assert.ok(proj, `${workflow}: projection must exist`);
      assert.equal(proj.status, "done");
    }
  });
});
