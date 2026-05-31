import { test } from "vitest";
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

test("buildCliAdapter merges pendingExtras after standard pending data", async () => {
  const workflow = defineWorkflow({
    name: "cli-adapter-extras-test",
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
    buildInputs: (id: string) => [{ id }],
    deriveItemId: (item) => item.id,
    buildPendingData: (item) => ({ id: item.id, batchDisplayOrdinal: "old" }),
    parentRunId: () => "parent-A",
    pendingExtras: (_item, _itemId, runId, parentRunId) => ({
      batchDisplayOrdinal: "7",
      runIdEcho: runId,
      parentRunId: parentRunId ?? "",
    }),
    enqueue: async (_workflow, inputs, _flags, opts) => {
      assert.equal(opts?.parentRunId, "parent-A");
      opts?.onPreEmitPending?.(inputs[0], "run-A", opts.parentRunId, inputs[0].id);
    },
    track: (entry) => seen.push(entry),
  });

  await runner("A");

  const seenData = (seen[0] as { data: Record<string, string> }).data;
  // Trace id is non-deterministic (timestamp + runId fragment) — match its
  // shape, then deepEqual the rest of the stamped record.
  assert.match(seenData.__traceId, /^cl-\d{12}-runa$/);
  const { __traceId, ...rest } = seenData;
  assert.deepEqual(rest, {
    id: "A",
    batchDisplayOrdinal: "7",
    __subject: "Doc A",
    __subjectKind: "document",
    runIdEcho: "run-A",
    parentRunId: "parent-A",
    archetype: "single",
    queueRowKind: "person",
  });
});

test("buildCliAdapter forwards onPreEmitFailed through injected enqueue", async () => {
  const workflow = defineWorkflow({
    name: "cli-adapter-failed-test",
    systems: [],
    steps: ["done"] as const,
    schema: z.object({ id: z.string() }),
    handler: async () => {},
  });
  const seen: unknown[] = [];
  const runner = buildCliAdapter({
    workflow,
    emptyMessage: "no ids",
    buildInputs: (id: string) => [{ id }],
    deriveItemId: (item) => item.id,
    buildPendingData: (item) => ({ id: item.id }),
    onPreEmitFailed: (item, runId, error, itemId) => {
      seen.push({ item, runId, error, itemId });
    },
    enqueue: async (_workflow, inputs, _flags, opts) => {
      opts?.onPreEmitFailed?.(inputs[0], "run-A", "spawn failed", inputs[0].id);
    },
  });

  await runner("A");

  assert.deepEqual(seen, [
    {
      item: { id: "A" },
      runId: "run-A",
      error: "spawn failed",
      itemId: "A",
    },
  ]);
});
