import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { defineWorkflow, runWorkflowBatch } from "../../../../src/core/index.js";
import { DEFAULT_DIR, dateLocal } from "../../../../src/tracker/jsonl.js";

/**
 * Tests covering the onboarding-parallel migration's CLI-adapter contract:
 * - `runWorkflowBatch` in pool mode pairs `onPreEmitPending` with per-item runIds
 *   so the dashboard shows one row per email keyed on the email itself.
 * - `opts.poolSize` override propagates through `runWorkflowBatch` into
 *   `runWorkflowPool` (covers `npm run onboarding:batch -- --workers <N>` where
 *   `<N>` overrides the workflow's `batch.poolSize = 4` default).
 *
 * Matches the kronos-reports precedent in
 * `tests/unit/workflows/old-kronos-reports/workflow.test.ts`. Uses a stub
 * workflow so we don't launch real CRM/UCPath/I9 browsers.
 */

function fakeSlot() {
  return {
    page: { bringToFront: async () => {} } as unknown as import("playwright").Page,
    context: { close: async () => {} } as never,
    browser: { close: async () => {} } as never,
  };
}

function cleanupWorkflow(workflow: string) {
  const today = dateLocal();
  for (const suffix of [".jsonl", "-logs.jsonl"]) {
    const path = join(DEFAULT_DIR, `${workflow}-${today}${suffix}`);
    if (existsSync(path)) rmSync(path);
  }
}

test("runWorkflowBatch (pool): onboarding-shaped onPreEmitPending paired with runId per email", async (t) => {
  const wfName = `onboarding-pool-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  t.after(() => cleanupWorkflow(wfName));

  const pendingEmissions: Array<{ email: string; runId: string }> = [];

  const wf = defineWorkflow({
    name: wfName,
    systems: [
      { id: "crm", login: async () => {} },
      { id: "ucpath", login: async () => {} },
      { id: "i9", login: async () => {} },
    ],
    steps: [
      "crm-auth",
      "extraction",
      "pdf-download",
      "ucpath-auth",
      "person-search",
      "i9-creation",
      "transaction",
    ] as const,
    schema: z.object({ email: z.string().email() }),
    authChain: "sequential",
    batch: { mode: "pool", poolSize: 2, preEmitPending: true },
    handler: async (ctx) => {
      await ctx.step("crm-auth", async () => {
        await new Promise((r) => setTimeout(r, 5));
      });
    },
  });

  const result = await runWorkflowBatch(
    wf,
    [
      { email: "a@ucsd.edu" },
      { email: "b@ucsd.edu" },
      { email: "c@ucsd.edu" },
    ],
    {
      launchFn: () => Promise.resolve(fakeSlot()),
      trackerStub: true,
      deriveItemId: (item) => (item as { email: string }).email,
      onPreEmitPending: (item, runId) => {
        pendingEmissions.push({
          email: (item as { email: string }).email,
          runId,
        });
      },
    },
  );

  assert.equal(result.total, 3);
  assert.equal(result.succeeded, 3);
  assert.equal(result.failed, 0);

  // Each email should have fired exactly one pending callback, keyed on
  // email in input order (pre-emit is synchronous before workers start).
  assert.deepEqual(
    pendingEmissions.map((e) => e.email),
    ["a@ucsd.edu", "b@ucsd.edu", "c@ucsd.edu"],
  );
  const uniqueRunIds = new Set(pendingEmissions.map((e) => e.runId));
  assert.equal(
    uniqueRunIds.size,
    3,
    "each email should get its own unique runId",
  );
});

test("runWorkflowBatch (pool): poolSize override with 4 emails → N launches", async () => {
  let launchCalls = 0;

  const wf = defineWorkflow({
    name: "onboarding-pool-override",
    systems: [{ id: "crm", login: async () => {} }],
    steps: ["crm-auth"] as const,
    schema: z.object({ email: z.string().email() }),
    // Default poolSize is 4 — runtime override below should bring it to 2.
    batch: { mode: "pool", poolSize: 4 },
    handler: async (ctx) => {
      await ctx.step("crm-auth", async () => {
        await new Promise((r) => setTimeout(r, 5));
      });
    },
  });

  const items = [
    { email: "w1@ucsd.edu" },
    { email: "w2@ucsd.edu" },
    { email: "w3@ucsd.edu" },
    { email: "w4@ucsd.edu" },
  ];

  const result = await runWorkflowBatch(wf, items, {
    launchFn: () => {
      launchCalls++;
      return Promise.resolve(fakeSlot());
    },
    trackerStub: true,
    poolSize: 2,
  });

  assert.equal(result.succeeded, 4);
  assert.equal(
    launchCalls,
    2,
    "opts.poolSize (2) should override wf.config.batch.poolSize (4) through runWorkflowBatch → runWorkflowPool",
  );
});
