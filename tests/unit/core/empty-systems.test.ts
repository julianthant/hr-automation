import { test } from "node:test";
import assert from "node:assert";
import { z } from "zod/v4";
import { defineWorkflow, runWorkflow } from "../../../src/core/index.js";

test("kernel runs a workflow with empty systems[]", async () => {
  let handlerRan = false;
  const wf = defineWorkflow({
    name: "test-empty-systems",
    label: "Test Empty Systems",
    systems: [],
    authSteps: false,
    steps: ["work"] as const,
    schema: z.object({ value: z.string() }),
    authChain: "sequential",
    detailFields: [{ key: "value", label: "Value" }],
    getName: (d) => d.value ?? "",
    getId:   (d) => d.value ?? "",
    handler: async (ctx, input) => {
      ctx.updateData({ value: input.value });
      await ctx.step("work", async () => {
        handlerRan = true;
      });
    },
  });

  await runWorkflow(wf, { value: "smoke" }, { trackerStub: true });
  assert.ok(handlerRan, "handler should have executed");
});
