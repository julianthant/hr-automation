/**
 * Unit tests for the two pure graph↔config projections behind the Workflow Graph
 * Editor — the testable seam (there is no dashboard component harness).
 *
 *   overrideToGraph(base, draft) → nodes/edges      (config → graph)
 *   graphToOverride(model, baseSteps) → override    (graph → config, sparse)
 *
 * The load-bearing properties: overrideToGraph lays the row → steps pipeline +
 * the delegation fan-out deterministically; graphToOverride is its inverse on the
 * config slice and stays sparse (defaults collapse to undefined, mirroring the
 * blueprint setters' `prune`).
 */

import { test, describe } from "vitest";
import assert from "node:assert/strict";

import {
  overrideToGraph,
  graphToOverride,
  ROW_NODE_ID,
  COORDINATOR_NODE_ID,
  PREP_NODE_ID,
  MEMBER_NODE_ID,
  stepNodeId,
  parseStepNodeId,
} from "../../../../src/dashboard/components/workflow-modifier/graph/graph-build.js";
import { prune } from "../../../../src/dashboard/components/workflow-modifier/blueprint-helpers.js";
import {
  NODE_ROW,
  NODE_STEP,
  NODE_DELEGATION_COORDINATOR,
  NODE_PREP,
  NODE_MEMBER,
  EDGE_SEQUENCE,
  EDGE_DELEGATION,
  EDGE_FOLD,
} from "../../../../src/dashboard/components/workflow-modifier/graph/graph-types.js";
import type { WorkflowMetadata } from "../../../../src/dashboard/lib/workflows-context.js";
import type { WorkflowOverride } from "../../../../src/domain/workflow-presentation/types.js";

const STEPS = ["auth:ucpath", "search", "verify", "submit"];

function base(name = "demo", label = "Demo", steps = STEPS): WorkflowMetadata {
  return { name, label, steps: [...steps], systems: [], detailFields: [] };
}

function typesOf(nodes: { type?: string }[]): string[] {
  return nodes.map((n) => n.type ?? "");
}

describe("overrideToGraph", () => {
  test("default non-delegating workflow → row + step pipeline, no delegation", () => {
    const { nodes, edges } = overrideToGraph(base(), {}, "demo");

    // row + 4 steps
    assert.equal(nodes.length, 5);
    assert.equal(nodes[0].id, ROW_NODE_ID);
    assert.equal(nodes[0].type, NODE_ROW);
    assert.deepEqual(
      nodes.slice(1).map((n) => n.id),
      STEPS.map(stepNodeId),
    );
    assert.ok(nodes.slice(1).every((n) => n.type === NODE_STEP));

    // row → step0 → … → step3 = 4 sequence edges, no delegation edges
    assert.equal(edges.length, 4);
    assert.ok(edges.every((e) => e.type === EDGE_SEQUENCE));
    assert.equal(edges[0].source, ROW_NODE_ID);
    assert.equal(edges[0].target, stepNodeId(STEPS[0]));
  });

  test("delegating workflow → coordinator/prep/member + delegation edges", () => {
    const { nodes, edges } = overrideToGraph(base("oath-signature", "Oath Signature"), {}, "oath-signature");

    const ids = nodes.map((n) => n.id);
    assert.ok(ids.includes(COORDINATOR_NODE_ID));
    assert.ok(ids.includes(PREP_NODE_ID));
    assert.ok(ids.includes(MEMBER_NODE_ID));
    assert.ok(typesOf(nodes).includes(NODE_DELEGATION_COORDINATOR));
    assert.ok(typesOf(nodes).includes(NODE_PREP));
    assert.ok(typesOf(nodes).includes(NODE_MEMBER));

    const delEdges = edges.filter((e) => e.type === EDGE_DELEGATION);
    assert.equal(delEdges.length, 3); // row→coordinator, coordinator→prep, coordinator→member
  });

  test("non-delegating workflow with a delegation override still gets the fan-out", () => {
    const draft: WorkflowOverride = {
      presentation: { delegation: { coordinatorLabelSuffix: "Operation" } },
    };
    const ids = overrideToGraph(base(), draft, "demo").nodes.map((n) => n.id);
    assert.ok(ids.includes(COORDINATOR_NODE_ID));
  });

  test("a folded step emits a fold edge from its host", () => {
    const draft: WorkflowOverride = {
      presentation: { steps: { rules: [{ step: "verify", foldInto: "search" }] } },
    };
    const { edges } = overrideToGraph(base(), draft, "demo");
    const fold = edges.filter((e) => e.type === EDGE_FOLD);
    assert.equal(fold.length, 1);
    assert.equal(fold[0].source, stepNodeId("search"));
    assert.equal(fold[0].target, stepNodeId("verify"));
  });

  test("override slices ride the node data (title override + step rule)", () => {
    const draft: WorkflowOverride = {
      presentation: {
        naming: { title: { scheme: "custom-template", template: "{name} ({emplId})" } },
        steps: { rules: [{ step: "verify", hidden: true }] },
      },
    };
    const { nodes } = overrideToGraph(base(), draft, "demo");
    const row = nodes.find((n) => n.id === ROW_NODE_ID);
    assert.ok(row && row.type === NODE_ROW);
    assert.deepEqual(row.data.titleOverride, { scheme: "custom-template", template: "{name} ({emplId})" });
    assert.equal(row.data.subtitleOverride, undefined);

    const verify = nodes.find((n) => n.id === stepNodeId("verify"));
    assert.ok(verify && verify.type === NODE_STEP);
    assert.equal(verify.data.hidden, true);
    assert.deepEqual(verify.data.overrideRule, { step: "verify", hidden: true });
  });
});

describe("graphToOverride", () => {
  test("empty draft round-trips to an empty (sparse) override", () => {
    const model = overrideToGraph(base(), {}, "demo");
    assert.deepEqual(graphToOverride(model, "demo", STEPS), {});
  });

  test("round-trips a full override and stays sparse (graph → override = prune(input))", () => {
    const input: WorkflowOverride = {
      presentation: {
        naming: { title: { scheme: "custom-template", template: "{name} ({emplId})" } },
        steps: {
          order: ["search", "auth:ucpath", "verify", "submit"],
          rules: [{ step: "verify", hidden: true }],
        },
        delegation: {
          coordinatorLabelSuffix: "Operation",
          memberTitle: { scheme: "person-name" },
          memberSubtitle: { scheme: "trace-only" },
        },
      },
    };
    const model = overrideToGraph(base(), input, "demo");
    const back = graphToOverride(model, "demo", STEPS);
    assert.deepEqual(back, prune(input));
  });

  test("step order matching the base order is NOT emitted (sparse)", () => {
    const draft: WorkflowOverride = {
      presentation: { steps: { order: [...STEPS] } }, // same as base → no real override
    };
    const model = overrideToGraph(base(), draft, "demo");
    assert.deepEqual(graphToOverride(model, "demo", STEPS), {});
  });

  test("idempotent: overrideToGraph(base, graphToOverride(...)) reproduces the node data", () => {
    const input: WorkflowOverride = {
      presentation: {
        naming: { subtitle: { scheme: "eid-only" } },
        delegation: { coordinatorLabelSuffix: "Operation" },
      },
    };
    const first = overrideToGraph(base("oath-signature", "Oath Signature"), input, "oath-signature");
    const back = graphToOverride(first, "oath-signature", STEPS);
    const second = overrideToGraph(base("oath-signature", "Oath Signature"), back, "oath-signature");
    assert.deepEqual(
      second.nodes.map((n) => n.data),
      first.nodes.map((n) => n.data),
    );
  });
});

describe("parseStepNodeId", () => {
  test("recovers the bare step from a step node id (round-trips stepNodeId)", () => {
    assert.equal(parseStepNodeId(stepNodeId("prepare-import")), "prepare-import");
    assert.equal(parseStepNodeId("step:foo"), "foo");
  });

  test("returns null for non-step node ids", () => {
    assert.equal(parseStepNodeId(ROW_NODE_ID), null);
    assert.equal(parseStepNodeId(COORDINATOR_NODE_ID), null);
    assert.equal(parseStepNodeId("opslane:kuali-extract"), null);
    assert.equal(parseStepNodeId("custom-abc123"), null);
  });
});
