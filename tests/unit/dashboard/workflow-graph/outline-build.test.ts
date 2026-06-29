/**
 * Unit tests for the merged sidebar's outline model — the page derives the same
 * spine the OutlineRail used to read from the live canvas, but purely from the
 * projection (`overrideToGraph`) + mined `laneOps`. Load-bearing properties:
 * numbered pipeline steps carry their op counts, unmapped extra lanes append
 * unnumbered, lane ids cover steps + extra lanes (the collapse-all set), and the
 * totals/system count aggregate every lane.
 */

import { test, describe } from "vitest";
import assert from "node:assert/strict";

import { buildOutlineModel } from "../../../../src/dashboard/components/workflow-modifier/graph/outline-build.js";
import type { ActionNodeData } from "../../../../src/dashboard/components/workflow-modifier/graph/graph-types.js";
import type { LaneOpsModel } from "../../../../src/dashboard/components/workflow-modifier/graph/lane-build.js";
import type { WorkflowMetadata } from "../../../../src/dashboard/lib/workflows-context.js";

const STEPS = ["auth:ucpath", "search", "verify", "submit"];

function base(): WorkflowMetadata {
  return { name: "demo", label: "Demo", steps: [...STEPS], systems: [], detailFields: [] };
}

function op(system: string): ActionNodeData {
  return { opId: `${system}.x#click`, kind: "click", system, label: "x" };
}

const laneOps: LaneOpsModel = {
  byStep: {
    search: [op("ucpath"), op("ucpath"), op("ucpath")],
    verify: [op("ucpath")],
  },
  extraLanes: [{ id: "ops-extra", step: "extra", label: "Extra lane", ops: [op("crm"), op("crm")] }],
};

describe("buildOutlineModel", () => {
  test("returns the empty model when there is no base", () => {
    const m = buildOutlineModel(null, {}, "demo", laneOps);
    assert.deepEqual(m, { steps: [], delegation: [], laneIds: [], stepCount: 0, totalOps: 0, systemCount: 0 });
  });

  test("numbers pipeline steps with op counts; appends unnumbered extra lanes", () => {
    const m = buildOutlineModel(base(), {}, "demo", laneOps);
    // 4 pipeline steps (numbered, in base order) + 1 extra lane (no number)
    assert.deepEqual(
      m.steps.map((s) => s.num),
      [1, 2, 3, 4, undefined],
    );
    assert.deepEqual(
      m.steps.map((s) => s.meta),
      ["0", "3", "1", "0", "2"], // auth:0, search:3, verify:1, submit:0, extra:2
    );
    assert.equal(m.steps[4].label, "Extra lane");
  });

  test("lane ids cover steps + extra lanes (the collapse-all set)", () => {
    const m = buildOutlineModel(base(), {}, "demo", laneOps);
    assert.equal(m.laneIds.length, 5);
    assert.ok(m.laneIds.includes("ops-extra"));
    assert.deepEqual(m.laneIds, m.steps.map((s) => s.id));
  });

  test("aggregates totals + distinct systems across every lane", () => {
    const m = buildOutlineModel(base(), {}, "demo", laneOps);
    assert.equal(m.stepCount, 5);
    assert.equal(m.totalOps, 6); // 3 + 1 + 2
    assert.equal(m.systemCount, 2); // ucpath + crm
  });

  test("a default non-delegating workflow has no delegation entries", () => {
    const m = buildOutlineModel(base(), {}, "demo", laneOps);
    assert.deepEqual(m.delegation, []);
  });
});
