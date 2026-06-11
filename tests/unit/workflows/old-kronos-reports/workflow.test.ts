import { test } from "vitest";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { defineWorkflow, runWorkflowBatch } from "../../../../src/core/index.js";

/**
 * Tests covering the kronos-reports pool-mode contract:
 * - `runWorkflowBatch` in pool mode pairs `onPreEmitPending` with per-item runIds
 *   (the dashboard's "show the queue before auth finishes" shape).
 * - `opts.poolSize` override propagates through `runWorkflowBatch` into
 *   `runWorkflowPool`.
 *
 * These sit alongside `tests/unit/core/pool.test.ts` but verify the shape the
 * retired kronos adapter used, not just the direct `runWorkflowPool` path.
 */

function fakeSlot() {
  return {
    page: { bringToFront: async () => {} } as unknown as import("playwright").Page,
    context: { close: async () => {} } as never,
    browser: { close: async () => {} } as never,
  };
}

function makeTmp(): string {
  return mkdtempSync(join(tmpdir(), "kronos-test-"));
}

function cleanupDir(dir: string): void {
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
}

test("runWorkflowBatch (pool): onPreEmitPending paired with runId per employeeId", async (t) => {
  const wfName = `kronos-pool-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const tmp = makeTmp();
  t.onTestFinished(() => cleanupDir(tmp));

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
      trackerDir: tmp,
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

test("runWorkflowBatch (pool): opts.poolSize overrides wf.config.batch.poolSize", async (t) => {
  const tmp = makeTmp();
  t.onTestFinished(() => cleanupDir(tmp));
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
    trackerDir: tmp,
    poolSize: 2,
  });

  assert.equal(result.succeeded, 6);
  assert.equal(
    launchCalls,
    2,
    "opts.poolSize (2) should override wf.config.batch.poolSize (4) through runWorkflowBatch → runWorkflowPool",
  );
});
