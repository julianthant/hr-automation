import { test } from "vitest";
import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { randomUUID } from "node:crypto";

import {
  createDelegationRuntime,
  makeGatedWorkflow,
  createGateCoordinator,
  readQueueStateIncludingTerminals,
} from "./_runtime/index.js";

const REAL_TRACKER_DIR = ".tracker";

function snapshotRealTracker(): string[] | null {
  if (!existsSync(REAL_TRACKER_DIR)) return null;
  return readdirSync(REAL_TRACKER_DIR).sort();
}

async function waitForQueue(
  workflow: string,
  dir: string,
  pred: (st: Awaited<ReturnType<typeof readQueueStateIncludingTerminals>>) => boolean,
  timeoutMs = 10_000,
): Promise<void> {
  const start = Date.now();
  for (;;) {
    const st = await readQueueStateIncludingTerminals(workflow, dir);
    if (pred(st)) return;
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitForQueue(${workflow}) timed out: ${JSON.stringify(st)}`);
    }
    await new Promise((r) => setTimeout(r, 25));
  }
}

/**
 * Star-case proof: parentRunId-enqueued independent child runs (the
 * OCR → oath-signature fan-out shape), each gated at a `transaction` stage,
 * with one cancelled mid-hold and siblings unaffected. Exercises every generic
 * harness method end-to-end through the REAL daemon (no browser, temp root).
 */
test("delegation harness — 3-child fan-out, cancel one mid-hold, siblings unaffected, projection correct", async (t) => {
  const before = snapshotRealTracker();

  const rt = await createDelegationRuntime({
    workflows: [
      {
        // 3 racing daemon instances so all 3 children hold `transaction`
        // concurrently (a single daemon's claim loop is serial).
        workflow: {
          name: "harness-child",
          code: "hc",
          stages: ["load", "transaction", "finalize"],
          gatedStages: ["transaction"],
          archetype: "single",
          inputSubject: "name",
        },
        instances: 3,
      },
    ],
    idleTimeoutMs: 30_000,
  });
  t.onTestFinished(() => rt.cleanup());

  // 1. Fan out 3 children under one parentRunId, all gated at `transaction`.
  rt.holdAll("harness-child", "transaction");
  const parentRunId = randomUUID();
  const c1 = await rt.enqueue("harness-child", { id: "alice", name: "Alice Adams" }, { parentRunId, renderAs: "operation" });
  const c2 = await rt.enqueue("harness-child", { id: "bob", name: "Bob Brown" }, { parentRunId, renderAs: "operation" });
  const c3 = await rt.enqueue("harness-child", { id: "carol", name: "Carol Clark" }, { parentRunId, renderAs: "operation" });

  // 2. All 3 reached the held `transaction` stage.
  await rt.waitForEvent("step:start", { step: "transaction", count: 3 });

  // 3. Cancel child2 via the REAL control-layer cancel path.
  await rt.cancel(c2.runId);

  // child2 reaches a terminal (failed + cancelled), siblings stay claimed/held.
  await waitForQueue("harness-child", rt.trackerDir, (st) =>
    st.failed.some((i) => i.runId === c2.runId),
  );
  await rt.waitForEvent("run:terminal", { runId: c2.runId, occasion: "cancelled" });

  // Siblings are still in flight (claimed), NOT terminal.
  const midState = await readQueueStateIncludingTerminals("harness-child", rt.trackerDir);
  assert.equal(
    midState.done.some((i) => i.runId === c1.runId || i.runId === c3.runId),
    false,
    "siblings must NOT be done while still held",
  );
  assert.equal(
    midState.failed.some((i) => i.runId === c1.runId || i.runId === c3.runId),
    false,
    "siblings must NOT be failed by the cancel of child2",
  );

  // 4. Release child1 + child3 → both reach done.
  rt.release(c1.runId, "transaction");
  rt.release(c3.runId, "transaction");
  await rt.waitForEvent("run:terminal", { runId: c1.runId, occasion: "completed" });
  await rt.waitForEvent("run:terminal", { runId: c3.runId, occasion: "completed" });
  await waitForQueue("harness-child", rt.trackerDir, (st) =>
    [c1.runId, c3.runId].every((id) => st.done.some((i) => i.runId === id)),
  );

  // 5. Dashboard projection asserts.
  const dash = rt.dashboard();

  // children() finds exactly the 3 child runs under the parent.
  const kids = await rt.children(parentRunId);
  assert.equal(kids.length, 3, "exactly 3 children under the parent");
  const kidRunIds = new Set(kids.map((k) => k.runId));
  assert.deepEqual(
    kidRunIds,
    new Set([c1.runId, c2.runId, c3.runId]),
    "children() returns the 3 enqueued child runs",
  );

  // Every child row is a delegated batch-member under the parent.
  for (const c of [c1, c2, c3]) {
    const row = dash.row("harness-child", c.runId);
    assert.equal(row.parentRunId, parentRunId, `child ${c.itemId} parentRunId === parent`);
    assert.equal(row.archetype, "operation-member", `child ${c.itemId} is a batch-member`);
    // Subtitle rule: EID if present, else trace id (scrubbed). Person row →
    // resolved name title.
    assert.equal(row.subtitle, "<traceId>", `child ${c.itemId} subtitle is the trace id`);
  }
  assert.equal(dash.row("harness-child", c1.runId).title, "Alice Adams");
  assert.equal(dash.row("harness-child", c3.runId).title, "Carol Clark");

  // child2 cancelled; child1/child3 done.
  assert.equal(dash.row("harness-child", c2.runId).statusLabel, "Cancelled");
  assert.equal(dash.row("harness-child", c2.runId).status, "failed");
  assert.equal(dash.row("harness-child", c2.runId).step, "cancelled");
  assert.equal(dash.row("harness-child", c1.runId).statusLabel, "Done");
  assert.equal(dash.row("harness-child", c3.runId).statusLabel, "Done");

  // Group anchor: parent card over 3 members, subtitle = trace id.
  const anchor = dash.groupAnchor("harness-child", parentRunId);
  assert.equal(anchor.memberCount, 3, "group anchor has 3 members");
  assert.equal(anchor.subtitle, "<traceId>", "group anchor subtitle is the trace id");

  // No count drift: exactly 3 distinct child runs surfaced (no orphan / double).
  const allRunIds = kids.map((k) => k.runId);
  assert.equal(new Set(allRunIds).size, 3, "no duplicate child runs in projection");

  await rt.cleanup();

  // 7. The real `.tracker/` is untouched; the temp dir is gone.
  assert.deepEqual(snapshotRealTracker(), before, "real .tracker/ unchanged by the harness");
  assert.equal(existsSync(rt.trackerDir), false, "temp tracker dir removed by cleanup");
});

/**
 * In-process `delegateToAll` fan-out: proves `delegation:children-spawned`
 * fires on the PARENT's run log + `parentRunId` is stamped on children. The
 * parent's handler is a `customHandler` that calls the real `ctx.delegateToAll`.
 */
test("delegation harness — in-process delegateToAll fires children-spawned + stamps parentRunId", async (t) => {
  const before = snapshotRealTracker();
  const coordinator = createGateCoordinator();

  // Child: non-daemon-capable (not started as a daemon here) so delegateToAll
  // runs it IN-PROCESS inside the parent worker — exercises the in-process path.
  const child = makeGatedWorkflow(
    { name: "smoke-inproc-child", code: "ic", stages: ["work"], gatedStages: [] },
    coordinator,
  );

  // Parent: a gated workflow whose handler we override to fan out 3 children.
  const parent = makeGatedWorkflow(
    { name: "smoke-inproc-parent", code: "ip", stages: ["fanout"] },
    coordinator,
  );
  // Override the parent handler to call the real delegateToAll (in-process,
  // since the child is not daemon-capable here).
  const parentWithFanout = {
    ...parent,
    config: {
      ...parent.config,
      handler: async (ctx: Parameters<typeof parent.config.handler>[0]) => {
        await ctx.step("fanout", async () => {
          await ctx.delegateToAll(
            child,
            [
              { id: "k1", name: "Kid One" },
              { id: "k2", name: "Kid Two" },
              { id: "k3", name: "Kid Three" },
            ],
            { renderAs: "operation" },
          );
        });
      },
    },
  } as typeof parent;

  const rt = await createDelegationRuntime({
    workflows: [parentWithFanout],
    idleTimeoutMs: 30_000,
  });
  t.onTestFinished(() => rt.cleanup());

  const root = await rt.enqueue("smoke-inproc-parent", { id: "root", name: "Root Run" });

  // The parent's run log carries delegation:children-spawned (count 3).
  await rt.waitForEvent("delegation:children-spawned", {
    runId: root.runId,
    childWorkflow: "smoke-inproc-child",
  });
  await rt.waitForEvent("run:terminal", { runId: root.runId, occasion: "completed" });
  await waitForQueue("smoke-inproc-parent", rt.trackerDir, (st) =>
    st.done.some((i) => i.runId === root.runId),
  );

  // Children carry parentRunId === the parent's runId.
  const kids = await rt.children(root.runId);
  assert.equal(kids.length, 3, "3 in-process children stamped with parentRunId");
  for (const k of kids) {
    const row = rt.dashboard().row("smoke-inproc-child", k.runId);
    assert.equal(row.parentRunId, root.runId, "child parentRunId === parent runId");
  }

  await rt.cleanup();
  assert.deepEqual(snapshotRealTracker(), before, "real .tracker/ unchanged");
});
