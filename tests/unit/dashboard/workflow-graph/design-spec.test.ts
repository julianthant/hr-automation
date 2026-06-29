/**
 * Unit tests for the graph ↔ design-scaffold projections. graphToDesignSpec must
 * capture the WHOLE graph (config slices + intent), and designSpecToGraph must
 * recover the intent nodes + a position overlay. Determinism matters — the spec
 * is persisted and re-generated, so the same graph must yield the same spec.
 */

import { test, describe } from "vitest";
import assert from "node:assert/strict";

import { graphToDesignSpec, designSpecToGraph } from "../../../../src/dashboard/components/workflow-modifier/graph/design-spec.js";
import {
  NODE_ROW,
  NODE_ACTION,
  NODE_CUSTOM,
  NODE_NOTE,
  NODE_GROUP,
  type GraphModel,
  type GraphNode,
} from "../../../../src/dashboard/components/workflow-modifier/graph/graph-types.js";

function model(): GraphModel {
  const row: GraphNode = {
    id: "row",
    type: NODE_ROW,
    position: { x: 0, y: 40 },
    data: {
      workflowLabel: "Demo",
      title: { scheme: "pdf-filename" },
      subtitle: { scheme: "eid-else-trace" },
      trace: { scheme: "code-time-runid" },
      titleOverride: { scheme: "pdf-filename" },
      sampleVars: {},
    },
  };
  const custom: GraphNode = {
    id: "custom-1",
    type: NODE_CUSTOM,
    position: { x: 100, y: 560 },
    data: {
      label: "Status chip",
      description: "shows live status",
      look: "dot on the left",
      references: ["EntryItem.tsx"],
      exampleData: { status: "running" },
    },
  };
  const note: GraphNode = {
    id: "note-1",
    type: NODE_NOTE,
    position: { x: 220, y: 600 },
    data: { text: "remember the trace id" },
  };
  const group: GraphNode = {
    id: "group-1",
    type: NODE_GROUP,
    position: { x: 320, y: 700 },
    data: { label: "Header zone" },
  };
  return { nodes: [row, custom, note, group], edges: [] };
}

describe("graphToDesignSpec", () => {
  test("captures config slices + intent for every node", () => {
    const spec = graphToDesignSpec(model(), "demo", "2026-01-01T00:00:00.000Z");
    assert.equal(spec.schemaVersion, 1);
    assert.equal(spec.workflow, "demo");
    assert.equal(spec.generatedAt, "2026-01-01T00:00:00.000Z");
    assert.equal(spec.nodes.length, 4);

    const row = spec.nodes.find((n) => n.id === "row");
    assert.deepEqual(row?.config, { title: { scheme: "pdf-filename" } });
    assert.equal(row?.type, "row");

    const custom = spec.nodes.find((n) => n.id === "custom-1");
    assert.equal(custom?.type, "custom");
    assert.deepEqual(custom?.intent, {
      label: "Status chip",
      description: "shows live status",
      look: "dot on the left",
      references: ["EntryItem.tsx"],
      exampleData: { status: "running" },
    });

    const note = spec.nodes.find((n) => n.id === "note-1");
    assert.deepEqual(note?.intent, { description: "remember the trace id" });

    const group = spec.nodes.find((n) => n.id === "group-1");
    assert.deepEqual(group?.intent, { label: "Header zone" });
  });

  test("is deterministic in the graph", () => {
    const a = graphToDesignSpec(model(), "demo", "2026-01-01T00:00:00.000Z");
    const b = graphToDesignSpec(model(), "demo", "2026-01-01T00:00:00.000Z");
    assert.deepEqual(a, b);
  });
});

describe("designSpecToGraph", () => {
  test("recovers intent nodes + a full position overlay", () => {
    const spec = graphToDesignSpec(model(), "demo", "2026-01-01T00:00:00.000Z");
    const overlay = designSpecToGraph(spec);

    // positions for every node (config + intent)
    assert.deepEqual(overlay.positions.row, { x: 0, y: 40 });
    assert.deepEqual(overlay.positions["custom-1"], { x: 100, y: 560 });

    // only intent nodes are rebuilt
    assert.deepEqual(
      overlay.intentNodes.map((n) => n.id).sort(),
      ["custom-1", "group-1", "note-1"],
    );

    const custom = overlay.intentNodes.find((n) => n.id === "custom-1");
    assert.ok(custom && custom.type === NODE_CUSTOM);
    assert.equal(custom.data.label, "Status chip");
    assert.deepEqual(custom.data.references, ["EntryItem.tsx"]);

    const note = overlay.intentNodes.find((n) => n.id === "note-1");
    assert.ok(note && note.type === NODE_NOTE);
    assert.equal(note.data.text, "remember the trace id");

    const group = overlay.intentNodes.find((n) => n.id === "group-1");
    assert.ok(group && group.type === NODE_GROUP);
    assert.equal(group.data.label, "Header zone");
  });

  test("action node round-trips through graphToDesignSpec → designSpecToGraph with op data + position", () => {
    const actionNode: GraphNode = {
      id: "act-1",
      type: NODE_ACTION,
      position: { x: 50, y: 300 },
      data: {
        opId: "kuali.separationForm.eid#fill",
        kind: "fill",
        system: "kuali",
        label: "Fill EID",
        selectorFqn: "kuali.separationForm.eid",
        inputVar: "eid",
        note: "8 digits",
      },
    };
    const m: GraphModel = { nodes: [actionNode], edges: [] };
    const spec = graphToDesignSpec(m, "separations", "2026-01-01T00:00:00.000Z");

    // Spec captures the action type and op data
    assert.equal(spec.nodes.length, 1);
    const sn = spec.nodes[0];
    assert.equal(sn.type, "action");
    assert.deepEqual(sn.action, {
      opId: "kuali.separationForm.eid#fill",
      kind: "fill",
      system: "kuali",
      label: "Fill EID",
      selectorFqn: "kuali.separationForm.eid",
      inputVar: "eid",
      note: "8 digits",
    });
    // No intent or config on an action node
    assert.equal(sn.intent, undefined);
    assert.equal(sn.config, undefined);

    // designSpecToGraph puts the action node in intentNodes (for the GraphCanvas gate)
    const overlay = designSpecToGraph(spec);
    assert.deepEqual(overlay.positions["act-1"], { x: 50, y: 300 });
    assert.equal(overlay.intentNodes.length, 1);
    const rebuilt = overlay.intentNodes[0];
    assert.ok(rebuilt && rebuilt.type === NODE_ACTION);
    assert.equal(rebuilt.data.opId, "kuali.separationForm.eid#fill");
    assert.equal(rebuilt.data.kind, "fill");
    assert.equal(rebuilt.data.system, "kuali");
    assert.equal(rebuilt.data.label, "Fill EID");
    assert.equal(rebuilt.data.selectorFqn, "kuali.separationForm.eid");
    assert.equal(rebuilt.data.inputVar, "eid");
    assert.equal(rebuilt.data.note, "8 digits");
    assert.deepEqual(rebuilt.position, { x: 50, y: 300 });
  });
});
