import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { defineWorkflow, runWorkflowBatch } from "../../../../src/core/index.js";
import { DEFAULT_DIR } from "../../../../src/tracker/jsonl.js";

/**
 * Tests covering the kronos-reports migration's CLI-adapter contract:
 * - `runWorkflowBatch` in pool mode pairs `onPreEmitPending` with per-item runIds
 *   (the dashboard's "show the queue before auth finishes" shape).
 * - `opts.poolSize` override propagates through `runWorkflowBatch` into
 *   `runWorkflowPool` (covers the `npm run kronos -- --workers N` flag).
 *
 * These sit alongside `tests/unit/core/pool.test.ts` but verify the shape the
 * real kronos CLI adapter uses, not just the direct `runWorkflowPool` path.
 */

function fakeSlot() {
  return {
    page: { bringToFront: async () => {} } as unknown as import("playwright").Page,
    context: { close: async () => {} } as never,
    browser: { close: async () => {} } as never,
  };
}

function cleanupWorkflow(workflow: string) {
  const today = new Date().toISOString().slice(0, 10);
  for (const suffix of [".jsonl", "-logs.jsonl"]) {
    const path = join(DEFAULT_DIR, `${workflow}-${today}${suffix}`);
    if (existsSync(path)) rmSync(path);
  }
}

test("runWorkflowBatch (pool): onPreEmitPending paired with runId per employeeId", async (t) => {
  const wfName = `kronos-pool-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  t.after(() => cleanupWorkflow(wfName));

  const pendingEmissions: Array<{ employeeId: string; runId: string }> = [];

  const wf = defineWorkflow({
    name: wfName,
    systems: [{ id: "old-kronos", login: async () => {} }],
    steps: ["searching"] as const,
    schema: z.object({ employeeId: z.string() }),
    batch: { mode: "pool", poolSize: 2, preEmitPending: true },
    handler: async (ctx) => {
      await ctx.step("searching", async () => {
        await new Promise((r) => setTimeout(r, 5));
      });
    },
  });

  const result = await runWorkflowBatch(
    wf,
    [
      { employeeId: "10111" },
      { employeeId: "10222" },
      { employeeId: "10333" },
    ],
    {
      launchFn: () => Promise.resolve(fakeSlot()),
      trackerStub: true,
      deriveItemId: (item) => (item as { employeeId: string }).employeeId,
      onPreEmitPending: (item, runId) => {
        pendingEmissions.push({
          employeeId: (item as { employeeId: string }).employeeId,
          runId,
        });
      },
    },
  );

  assert.equal(result.total, 3);
  assert.equal(result.succeeded, 3);
  assert.equal(result.failed, 0);

  // Each item should have fired exactly one pending callback, keyed on
  // employeeId in input order (pre-emit is synchronous before workers start).
  assert.deepEqual(
    pendingEmissions.map((e) => e.employeeId),
    ["10111", "10222", "10333"],
  );
  const uniqueRunIds = new Set(pendingEmissions.map((e) => e.runId));
  assert.equal(
    uniqueRunIds.size,
    3,
    "each employeeId should get its own unique runId",
  );
});

test("runWorkflowBatch (pool): opts.poolSize overrides wf.config.batch.poolSize", async () => {
  let launchCalls = 0;

  const wf = defineWorkflow({
    name: "kronos-pool-override-via-batch",
    systems: [{ id: "old-kronos", login: async () => {} }],
    steps: ["searching"] as const,
    schema: z.object({ employeeId: z.string() }),
    // Default poolSize is 4 — runtime override below should bring this to 2.
    batch: { mode: "pool", poolSize: 4 },
    handler: async (ctx) => {
      await ctx.step("searching", async () => {
        await new Promise((r) => setTimeout(r, 5));
      });
    },
  });

  const items = Array.from({ length: 6 }, (_, i) => ({
    employeeId: `1000${i}0`,
  }));

  const result = await runWorkflowBatch(wf, items, {
    launchFn: () => {
      launchCalls++;
      return Promise.resolve(fakeSlot());
    },
    trackerStub: true,
    poolSize: 2,
  });

  assert.equal(result.succeeded, 6);
  assert.equal(
    launchCalls,
    2,
    "opts.poolSize (2) should override wf.config.batch.poolSize (4) through runWorkflowBatch → runWorkflowPool",
  );
});
