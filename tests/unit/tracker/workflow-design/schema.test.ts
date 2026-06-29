/**
 * Backend validation guard for the design scaffold. Writes are validated HARD
 * (fail loud — house rule: no silent fallback), so the zod schema must reject
 * malformed specs and accept a well-formed one.
 */

import { test, describe } from "vitest";
import assert from "node:assert/strict";

import { WorkflowDesignSchema } from "../../../../src/tracker/workflow-design/schema.js";

const valid = {
  schemaVersion: 1,
  workflow: "oath-signature",
  generatedAt: "2026-01-01T00:00:00.000Z",
  nodes: [
    { id: "row", type: "row", position: { x: 0, y: 0 } },
    { id: "custom-1", type: "custom", position: { x: 10, y: 20 }, intent: { label: "Chip" } },
  ],
  edges: [{ id: "e1", source: "row", target: "custom-1", type: "custom" }],
};

describe("WorkflowDesignSchema", () => {
  test("accepts a well-formed spec", () => {
    assert.equal(WorkflowDesignSchema.safeParse(valid).success, true);
  });

  test("rejects a wrong schemaVersion", () => {
    assert.equal(WorkflowDesignSchema.safeParse({ ...valid, schemaVersion: 2 }).success, false);
  });

  test("rejects an unknown node type", () => {
    const bad = { ...valid, nodes: [{ id: "x", type: "frobnicate", position: { x: 0, y: 0 } }] };
    assert.equal(WorkflowDesignSchema.safeParse(bad).success, false);
  });

  test("rejects a node missing its position", () => {
    const bad = { ...valid, nodes: [{ id: "x", type: "custom" }] };
    assert.equal(WorkflowDesignSchema.safeParse(bad).success, false);
  });

  test("rejects an unknown edge type", () => {
    const bad = { ...valid, edges: [{ id: "e", source: "row", target: "custom-1", type: "telepathy" }] };
    assert.equal(WorkflowDesignSchema.safeParse(bad).success, false);
  });

  test("rejects unknown top-level keys (strict object)", () => {
    assert.equal(WorkflowDesignSchema.safeParse({ ...valid, surprise: true }).success, false);
  });

  test("accepts a spec with an action node and its op data", () => {
    const withAction = {
      ...valid,
      nodes: [
        ...valid.nodes,
        {
          id: "act-1",
          type: "action",
          position: { x: 0, y: 200 },
          action: {
            opId: "kuali.separationForm.eid#fill",
            kind: "fill",
            system: "kuali",
            label: "Fill EID",
            selectorFqn: "kuali.separationForm.eid",
            inputVar: "eid",
          },
        },
      ],
    };
    const result = WorkflowDesignSchema.safeParse(withAction);
    assert.equal(result.success, true);
    // The action op is not stripped — it survives the parse
    if (result.success) {
      const parsed = result.data;
      const act = parsed.nodes.find((n) => n.id === "act-1");
      assert.ok(act);
      assert.equal(act.type, "action");
      assert.deepEqual(act.action, {
        opId: "kuali.separationForm.eid#fill",
        kind: "fill",
        system: "kuali",
        label: "Fill EID",
        selectorFqn: "kuali.separationForm.eid",
        inputVar: "eid",
      });
    }
  });

  test("accepts an action node with only required op fields", () => {
    const minimal = {
      ...valid,
      nodes: [
        {
          id: "act-min",
          type: "action",
          position: { x: 0, y: 0 },
          action: { opId: "sys.el#click", kind: "click", system: "ucpath", label: "Click save" },
        },
      ],
    };
    assert.equal(WorkflowDesignSchema.safeParse(minimal).success, true);
  });
});
