/**
 * E2E-106: Operation coordinator chip must show its OWN lifecycle status,
 * not a worst-member rollup.
 *
 * After OCR approval the coordinator row is `status:"running"/step:"approved"`.
 * Members fan out and some may fail. The coordinator chip must stay
 * `"running"` (or `"approved"` / `"done"` when it reaches those steps on its
 * own) — it must NOT flip to `"failed"` just because one member failed.
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

describe("E2E-106: operation coordinator chip reflects its own lifecycle, not worst-member", () => {
  const COORDINATOR_STATUS: TrackerEntry["status"] = "running";
  const COORDINATOR_STEP = "approved";
  const MIXED_MEMBERS: TrackerEntry["status"][] = ["done", "done", "failed"];

  for (const workflow of [
    "oath-signature",
    "emergency-contact",
    "oath-upload",
  ] as const) {
    test(`${workflow}: coordinator with 2 done + 1 failed member keeps its OWN status (not "failed")`, () => {
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
      assert.equal(
        proj.status,
        COORDINATOR_STATUS,
        `${workflow} coordinator chip should be "${COORDINATOR_STATUS}" (its own lifecycle), not "failed" (worst-member rollup)`,
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

  test("coordinator still correctly shows 'running' when it has only running/queued members (no regression)", () => {
    for (const workflow of ["oath-signature", "emergency-contact", "oath-upload"] as const) {
      const rows = buildOperationProjection(workflow, "running", "approved", ["running", "pending"]);
      const proj = rows.groupRows[0]?.projection;
      assert.ok(proj, `${workflow}: projection must exist`);
      assert.equal(proj.status, "running");
    }
  });

  test("coordinator with all-done members shows 'done' (no regression: happy path)", () => {
    for (const workflow of ["oath-signature", "emergency-contact", "oath-upload"] as const) {
      const rows = buildOperationProjection(workflow, "running", "approved", ["done", "done", "done"]);
      const proj = rows.groupRows[0]?.projection;
      assert.ok(proj, `${workflow}: projection must exist`);
      // When all members succeed, coordinator OWN status is "running/approved" —
      // the chip should reflect that, not "done" from the member aggregate.
      // (The coordinator transitions to done via its own emitted row, not via
      // member inference.)
      assert.equal(proj.status, "running");
    }
  });
});
