import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { buildCliAdapter, runCliEntry } from "../../../src/core/cli-adapter.js";
import { defineWorkflow } from "../../../src/core/index.js";

test("runCliEntry logs usage errors by setting process.exitCode", () => {
  const prior = process.exitCode;
  try {
    process.exitCode = undefined;
    assert.equal(runCliEntry(false, "missing input"), false);
    assert.equal(process.exitCode, 1);
  } finally {
    process.exitCode = prior;
  }
});

test("buildCliAdapter maps args to inputs and pre-emits pending rows through injected enqueue", async () => {
  const workflow = defineWorkflow({
    name: "cli-adapter-test",
    systems: [],
    steps: ["done"] as const,
    schema: z.object({ id: z.string() }),
    operatorSubject: (input) => ({ kind: "document", label: `Doc ${input.id}` }),
    handler: async () => {},
  });
  const seen: unknown[] = [];
  const runner = buildCliAdapter({
    workflow,
    emptyMessage: "no ids",
    buildInputs: (ids: string[]) => ids.map((id) => ({ id })),
    deriveItemId: (item) => item.id,
    buildPendingData: (item) => ({ id: item.id }),
    enqueue: async (_workflow, inputs, _flags, opts) => {
      assert.ok(opts);
      for (const input of inputs) {
        opts.onPreEmitPending?.(input, `run-${input.id}`, undefined, input.id);
      }
    },
    track: (entry) => seen.push(entry),
  });

  await runner(["A", "B"], { parallel: 2 });

  assert.deepEqual(
    seen.map((entry) => (entry as { id: string; data: Record<string, string> }).id),
    ["A", "B"],
  );
  assert.equal((seen[0] as { data: Record<string, string> }).data.__subject, "Doc A");
});
