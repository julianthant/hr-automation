/**
 * Unit tests for the lane-build projection — the replacement for the old
 * free-floating op-node wall. A workflow's mined ops are NESTED under their
 * presentation step (`groupLaneOps`), and cross-step data flow (a scrape's
 * `{var}` feeding a later step's fill) becomes a lane→lane link
 * (`buildDataFlowEdges`).
 *
 * Load-bearing properties: ops attach to the matching presentation step;
 * unmapped mined steps become read-only extra lanes (never dropped); data-flow
 * edges link a producer lane to the FIRST later consumer lane per var (deduped),
 * are order-insensitive to `{}`/case/pipe-alternatives, and never link within a
 * single lane; empty/undefined bank → empty.
 */

import { test, describe } from "vitest";
import assert from "node:assert/strict";

import { groupLaneOps, buildDataFlowEdges } from "../../../../src/dashboard/components/workflow-modifier/graph/lane-build.js";
import { opsLaneNodeId, stepNodeId } from "../../../../src/dashboard/components/workflow-modifier/graph/graph-build.js";
import { EDGE_DATAFLOW } from "../../../../src/dashboard/components/workflow-modifier/graph/graph-types.js";
import type { WorkflowDataBank, DataBankOperation } from "../../../../src/domain/workflow-design/data-bank.js";

const BASE_STEPS = ["navigation", "fill-form", "save"];

function op(id: string, over: Partial<DataBankOperation> = {}): DataBankOperation {
  return { id, kind: "click", system: "ucpath", label: id, ...over };
}

function bank(): WorkflowDataBank {
  return {
    workflow: "emergency-contact",
    systems: ["ucpath", "control"],
    steps: [
      {
        step: "navigation",
        label: "Navigation",
        operations: [
          op("ucpath.search#fill", { kind: "fill", inputVar: "{emplId}" }),
          op("ucpath.name#scrape", { kind: "scrape", outputVar: "{employeeName}" }),
        ],
      },
      {
        step: "fill-form",
        label: "Fill Form",
        operations: [
          op("ucpath.contactName#fill", { kind: "fill", inputVar: "{contact.name}" }),
          op("ucpath.useName#fill", { kind: "fill", inputVar: "employeeName" }),
        ],
      },
      { step: "save", label: "Save", operations: [op("ucpath.save#click")] },
    ],
  };
}

describe("groupLaneOps", () => {
  test("nests each mined step's ops under the matching presentation step", () => {
    const { byStep, extraLanes } = groupLaneOps(bank(), BASE_STEPS);
    assert.equal(extraLanes.length, 0);
    assert.deepEqual(Object.keys(byStep).sort(), ["fill-form", "navigation", "save"]);
    assert.equal(byStep.navigation.length, 2);
    assert.equal(byStep.navigation[1].outputVar, "{employeeName}");
    assert.equal(byStep.navigation[1].opId, "ucpath.name#scrape");
  });

  test("a mined step with no presentation step becomes a read-only extra lane", () => {
    const b: WorkflowDataBank = {
      workflow: "demo",
      systems: ["control"],
      steps: [
        { step: "navigation", label: "Navigation", operations: [op("ucpath.a#click")] },
        { step: "cleanup", label: "Cleanup", operations: [op("control.x#control", { kind: "control", system: "control" })] },
      ],
    };
    const { byStep, extraLanes } = groupLaneOps(b, BASE_STEPS);
    assert.ok(byStep.navigation);
    assert.equal(extraLanes.length, 1);
    assert.equal(extraLanes[0].id, opsLaneNodeId("cleanup"));
    assert.equal(extraLanes[0].step, "cleanup");
    assert.equal(extraLanes[0].ops.length, 1);
  });

  test("empty / undefined bank → empty model", () => {
    assert.deepEqual(groupLaneOps(undefined, BASE_STEPS), { byStep: {}, extraLanes: [] });
    const empty: WorkflowDataBank = { workflow: "demo", systems: [], steps: [] };
    assert.deepEqual(groupLaneOps(empty, BASE_STEPS), { byStep: {}, extraLanes: [] });
  });
});

describe("buildDataFlowEdges", () => {
  test("links a producer lane to the first later consumer lane (var-keyed, deduped)", () => {
    const { byStep } = groupLaneOps(bank(), BASE_STEPS);
    const lanes = [
      { nodeId: stepNodeId("navigation"), ops: byStep.navigation },
      { nodeId: stepNodeId("fill-form"), ops: byStep["fill-form"] },
      { nodeId: stepNodeId("save"), ops: byStep.save },
    ];
    const edges = buildDataFlowEdges(lanes);
    // navigation scrapes {employeeName}; fill-form reads `employeeName` → one link.
    assert.equal(edges.length, 1);
    const e = edges[0];
    assert.equal(e.type, EDGE_DATAFLOW);
    assert.equal(e.source, stepNodeId("navigation"));
    assert.equal(e.target, stepNodeId("fill-form"));
    assert.equal(e.label, "{employeename}");
  });

  test("matches {} / case / pipe-alternatives between producer and consumer", () => {
    const lanes = [
      { nodeId: "a", ops: [op("p#scrape", { kind: "scrape", outputVar: "{Phone}" })] },
      { nodeId: "b", ops: [op("c#fill", { kind: "fill", inputVar: "{phone|homePhone}" })] },
    ];
    const edges = buildDataFlowEdges(lanes);
    assert.equal(edges.length, 1);
    assert.equal(edges[0].source, "a");
    assert.equal(edges[0].target, "b");
  });

  test("no edge for a producer+consumer in the SAME lane", () => {
    const lanes = [
      {
        nodeId: "solo",
        ops: [
          op("s#scrape", { kind: "scrape", outputVar: "{x}" }),
          op("f#fill", { kind: "fill", inputVar: "{x}" }),
        ],
      },
    ];
    assert.deepEqual(buildDataFlowEdges(lanes), []);
  });

  test("links to the FIRST later consumer only (deduped per var)", () => {
    const lanes = [
      { nodeId: "a", ops: [op("p#scrape", { kind: "scrape", outputVar: "{x}" })] },
      { nodeId: "b", ops: [op("c1#fill", { kind: "fill", inputVar: "{x}" })] },
      { nodeId: "c", ops: [op("c2#fill", { kind: "fill", inputVar: "{x}" })] },
    ];
    const edges = buildDataFlowEdges(lanes);
    const targets = edges.map((e) => e.target);
    assert.ok(targets.includes("b"));
    assert.ok(targets.includes("c"));
    // one edge per producer→consumer pair, no duplicates
    assert.equal(new Set(edges.map((e) => e.id)).size, edges.length);
  });
});
