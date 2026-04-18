import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { defineWorkflow, runWorkflowBatch } from "../../../../src/core/index.js";
import { DEFAULT_DIR } from "../../../../src/tracker/jsonl.js";

/**
 * Tests covering the separations migration's shape:
 * - 4-system interleaved auth chain declares correctly on `defineWorkflow`
 * - `ctx.parallel` with 4 keys returns `PromiseSettledResult` per key,
 *   mixing fulfilled + rejected results the same way Phase-1 does
 * - `runWorkflowBatch` sequential mode + `deriveItemId` + `onPreEmitPending`
 *   pair per-docId pending emissions with kernel-internal runIds
 *
 * These sit alongside `schema.test.ts` (pure-function coverage for date math
 * + reason code mapping) and exercise the kernel-level surface the migration
 * depends on. Live browser runs are out of scope — verification via launchFn
 * injection (same pattern as kronos-reports workflow.test.ts).
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
    const p = join(DEFAULT_DIR, `${workflow}-${today}${suffix}`);
    if (existsSync(p)) rmSync(p);
  }
}

test("separations shape: 4-system interleaved authChain declares correctly", () => {
  const wf = defineWorkflow({
    name: `separations-auth-${Date.now()}`,
    systems: [
      { id: "kuali", login: async () => {} },
      { id: "old-kronos", login: async () => {} },
      { id: "new-kronos", login: async () => {} },
      { id: "ucpath", login: async () => {} },
    ],
    steps: ["launching", "authenticating"] as const,
    schema: z.object({ docId: z.string() }),
    authChain: "interleaved",
    handler: async () => {},
  });

  assert.equal(wf.config.authChain, "interleaved");
  assert.equal(wf.config.systems.length, 4);
  assert.deepEqual(
    wf.config.systems.map((s) => s.id),
    ["kuali", "old-kronos", "new-kronos", "ucpath"],
  );
});

test("separations shape: ctx.parallel returns 4-keyed PromiseSettledResult (Phase-1 pattern)", async (t) => {
  const wfName = `separations-parallel-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  t.after(() => cleanupWorkflow(wfName));

  const wf = defineWorkflow({
    name: wfName,
    systems: [{ id: "a", login: async () => {} }],
    steps: ["fan"] as const,
    schema: z.object({ id: z.string() }),
    handler: async (ctx) => {
      await ctx.step("fan", async () => {
        // Mirrors Phase-1's 4-way fan-out: 3 fulfilled + 1 rejected, each
        // returning distinct shapes. Fallback semantics: the handler reads
        // .status === "fulfilled" / "rejected" and logs errors on the latter.
        const r = await ctx.parallel({
          oldK: async () => ({ found: true, date: "03/20/2026" as string | null }),
          newK: async () => ({ found: false, date: null as string | null }),
          jobSummary: async () => ({ deptId: "000412", departmentDescription: "HOUSING" }),
          kualiTimekeeper: async () => { throw new Error("fill failed"); },
        });
        assert.equal(r.oldK.status, "fulfilled");
        assert.equal(r.newK.status, "fulfilled");
        assert.equal(r.jobSummary.status, "fulfilled");
        assert.equal(r.kualiTimekeeper.status, "rejected");
        if (r.oldK.status === "fulfilled") {
          assert.equal(r.oldK.value.found, true);
          assert.equal(r.oldK.value.date, "03/20/2026");
        }
        if (r.kualiTimekeeper.status === "rejected") {
          assert.match((r.kualiTimekeeper.reason as Error).message, /fill failed/);
        }
      });
    },
  });

  const result = await runWorkflowBatch(wf, [{ id: "only" }], {
    launchFn: () => Promise.resolve(fakeSlot()),
    trackerStub: true,
  });
  assert.equal(result.succeeded, 1);
  assert.equal(result.failed, 0);
});

test("separations shape: runWorkflowBatch (sequential) + deriveItemId threads docId through onPreEmitPending", async (t) => {
  const wfName = `separations-batch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  t.after(() => cleanupWorkflow(wfName));

  const pendings: Array<{ docId: string; runId: string }> = [];

  const wf = defineWorkflow({
    name: wfName,
    systems: [
      { id: "kuali", login: async () => {} },
      { id: "old-kronos", login: async () => {} },
      { id: "new-kronos", login: async () => {} },
      { id: "ucpath", login: async () => {} },
    ],
    steps: [
      "launching",
      "authenticating",
      "kuali-extraction",
      "kronos-search",
      "ucpath-job-summary",
      "ucpath-transaction",
      "kuali-finalization",
    ] as const,
    schema: z.object({ docId: z.string().min(1) }),
    authChain: "interleaved",
    batch: { mode: "sequential", preEmitPending: true, betweenItems: ["reset-browsers"] },
    detailFields: [
      { key: "name", label: "Employee" },
      { key: "eid", label: "EID" },
      { key: "docId", label: "Doc ID" },
    ],
    handler: async (ctx, input) => {
      ctx.updateData({ docId: input.docId });
      ctx.markStep("launching");
      ctx.markStep("authenticating");
      await ctx.step("kuali-extraction", async () => {});
      await ctx.step("kronos-search", async () => {
        const r = await ctx.parallel({
          oldK: async () => 1,
          newK: async () => 2,
          jobSummary: async () => 3,
          kualiTimekeeper: async () => 4,
        });
        assert.ok(r.oldK.status === "fulfilled");
      });
      await ctx.step("ucpath-job-summary", async () => {});
      await ctx.step("ucpath-transaction", async () => {});
      await ctx.step("kuali-finalization", async () => {});
    },
  });

  const result = await runWorkflowBatch(
    wf,
    [{ docId: "DOC-1" }, { docId: "DOC-2" }, { docId: "DOC-3" }],
    {
      launchFn: () => Promise.resolve(fakeSlot()),
      trackerStub: true,
      deriveItemId: (item) => (item as { docId: string }).docId,
      onPreEmitPending: (item, runId) => {
        pendings.push({ docId: (item as { docId: string }).docId, runId });
      },
    },
  );

  assert.equal(result.total, 3);
  assert.equal(result.succeeded, 3);
  assert.equal(result.failed, 0);

  // Each docId should have fired exactly one pending callback in input order.
  assert.deepEqual(
    pendings.map((e) => e.docId),
    ["DOC-1", "DOC-2", "DOC-3"],
  );
  const uniqueRunIds = new Set(pendings.map((e) => e.runId));
  assert.equal(uniqueRunIds.size, 3, "each docId should get its own unique runId");
});
