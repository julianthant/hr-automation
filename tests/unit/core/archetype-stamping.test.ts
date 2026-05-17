import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { defineWorkflow } from "../../../src/core/kernel/workflow.js";
import { z } from "zod";

describe("archetype stamping on WorkflowConfig", () => {
  it("workflow with archetype: 'single' is reflected in metadata", () => {
    const wf = defineWorkflow({
      name: "test-single-archetype",
      label: "Test",
      archetype: "single",
      systems: [],
      steps: ["only"] as const,
      schema: z.object({ id: z.string() }),
      detailFields: [],
      getName: () => "",
      getId: (d) => d.id,
      operatorSubject: () => ({ value: "test", kind: "eid" as const }),
      handler: async () => {},
    });
    assert.equal(wf.archetype, "single");
  });

  it("workflow without archetype defaults to 'single' when no batch is declared", () => {
    const wf = defineWorkflow({
      name: "test-default-archetype",
      label: "Test",
      systems: [],
      steps: ["only"] as const,
      schema: z.object({ id: z.string() }),
      detailFields: [],
      getName: () => "",
      getId: (d) => d.id,
      operatorSubject: () => ({ value: "test", kind: "eid" as const }),
      handler: async () => {},
    });
    assert.equal(wf.archetype, "single");
  });

  it("workflow with batch declared defaults to 'batch'", () => {
    const wf = defineWorkflow({
      name: "test-batch-default-archetype",
      label: "Test",
      systems: [],
      steps: ["only"] as const,
      batch: { mode: "sequential", preEmitPending: true, betweenItems: ["reset"] },
      schema: z.object({ id: z.string() }),
      detailFields: [],
      getName: () => "",
      getId: (d) => d.id,
      operatorSubject: () => ({ value: "test", kind: "eid" as const }),
      handler: async () => {},
    });
    assert.equal(wf.archetype, "batch");
  });
});
