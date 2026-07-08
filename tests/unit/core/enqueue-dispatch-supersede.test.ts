/**
 * Proves enqueueFromHttp wires its `supersedePriorRuns` option into the
 * kernel's `onPreparedItems` hook — the seam that enforces "one active run per
 * queue row" (cancel prior runs for an item before the new one is written).
 * The control-plane cancellation itself is covered by
 * tests/unit/control/supersede.test.ts; here we only assert the plumbing.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, beforeEach, vi } from "vitest";
import assert from "node:assert/strict";

import { enqueueFromHttp } from "../../../src/core/daemon/enqueue-dispatch.js";
import { log } from "../../../src/utils/log.js";

vi.mock("../../../src/core/daemon/client.js", () => ({
  ensureDaemonsAndEnqueue: vi.fn().mockResolvedValue({ enqueued: [], daemons: [] }),
}));

async function enqueueMock() {
  const client = await import("../../../src/core/daemon/client.js");
  return client.ensureDaemonsAndEnqueue as ReturnType<typeof vi.fn>;
}

function tempTrackerDir(): string {
  return mkdtempSync(join(tmpdir(), "enqueue-dispatch-supersede-"));
}

type PreparedHookOpts = {
  onPreparedItems?: (
    items: Array<{ itemId: string; runId: string; input: unknown }>,
  ) => Promise<void> | void;
};

beforeEach(async () => {
  (await enqueueMock()).mockClear();
});

test("enqueueFromHttp forwards supersedePriorRuns through onPreparedItems with {itemId,runId}", async () => {
  const calls: Array<Array<{ itemId: string; runId: string }>> = [];

  const result = await enqueueFromHttp("separations", [{ docId: "4025" }], {
    trackerDir: tempTrackerDir(),
    supersedePriorRuns: (items) => {
      calls.push(items);
    },
  });
  assert.equal(result.ok, true);

  const mock = await enqueueMock();
  const [, , , opts] = mock.mock.calls[0] as [unknown, unknown[], unknown, PreparedHookOpts];
  assert.equal(typeof opts.onPreparedItems, "function");

  // Simulate the kernel firing the hook after assigning stable ids.
  await opts.onPreparedItems?.([
    { itemId: "4025", runId: "run-1", input: { docId: "4025" } },
  ]);

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], [{ itemId: "4025", runId: "run-1" }]);
});

test("enqueueFromHttp omits onPreparedItems when no supersedePriorRuns is supplied", async () => {
  await enqueueFromHttp("separations", [{ docId: "4025" }], { trackerDir: tempTrackerDir() });

  const mock = await enqueueMock();
  const [, , , opts] = mock.mock.calls[0] as [unknown, unknown, unknown, PreparedHookOpts];
  assert.equal(opts.onPreparedItems, undefined);
});

test("a throwing supersedePriorRuns fails loud and blocks the enqueue (no duplicate run)", async () => {
  // The wrapper logs an error on failure; suppress it so the stderr audit
  // stays clean while we assert the throw propagates instead of being
  // swallowed.
  const errorSpy = vi.spyOn(log, "error").mockImplementation(() => {});
  try {
    const mock = await enqueueMock();
    // Simulate the kernel's real ensureDaemonsAndEnqueue: `onPreparedItems`
    // is awaited directly, so a throw there rejects the enqueue call itself
    // (mirrors client.ts — no pending row / task row is written on this path).
    mock.mockImplementation(async (_wf, _inputs, _flags, opts) => {
      await opts.onPreparedItems?.([{ itemId: "4025", runId: "run-1", input: { docId: "4025" } }]);
      return { enqueued: [], daemons: [] };
    });

    const result = await enqueueFromHttp("separations", [{ docId: "4025" }], {
      trackerDir: tempTrackerDir(),
      supersedePriorRuns: () => {
        throw new Error("boom");
      },
    });

    // A failed supersede must not fall through to a duplicate enqueue: the
    // call reports failure instead of {ok:true}.
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /supersedePriorRuns failed/);
    assert.match(result.error ?? "", /boom/);
    // Logged twice: once at the onPreparedItems raise site (names the items),
    // once by enqueueFromHttp's outer catch (the generic per-call error log).
    assert.equal(errorSpy.mock.calls.length, 2);
  } finally {
    errorSpy.mockRestore();
  }
});

test("two concurrent supersede-guarded enqueues for the same workflow serialize (no interleaving)", async () => {
  // The concurrent-enqueue supersede race: supersedePriorRuns lists prior
  // active runs then cancels them (read-then-cancel), and enqueueTasks only
  // adopts a row on an exact (workflow,itemId,runId) match — a fresh runId
  // always writes a NEW row. Two enqueues interleaving at their await points
  // could each observe "no prior run" and BOTH go live for the same person.
  // enqueueFromHttp therefore holds a per-workflow mutex across the
  // supersede→enqueue critical section; this pins that the second call's
  // supersede only fires after the first call's enqueue fully completes, so
  // it sees (and cancels) the first run.
  const events: string[] = [];
  let call = 0;

  const mock = await enqueueMock();
  mock.mockImplementation(async (_wf, _inputs, _flags, opts: PreparedHookOpts) => {
    const n = ++call;
    events.push(`enqueue-${n}:start`);
    await opts.onPreparedItems?.([{ itemId: "4025", runId: `run-${n}`, input: { docId: "4025" } }]);
    // Hold the critical section long enough for the second caller to arrive
    // and contend on the lock — an unserialized implementation would let its
    // supersede/enqueue interleave right here.
    await new Promise((r) => setTimeout(r, 50));
    events.push(`enqueue-${n}:done`);
    return { enqueued: [], daemons: [] };
  });

  const dir = tempTrackerDir();
  const supersede = (items: Array<{ itemId: string; runId: string }>) => {
    events.push(`supersede:${items[0]?.runId}`);
  };

  // Start call 1, then start call 2 only once call 1 is INSIDE its critical
  // section (after its dynamic imports settled). NOT Promise.all in the same
  // tick: two simultaneous FIRST dynamic imports of the mocked "./client.js"
  // race vitest's module-mock interception and the loser receives the REAL
  // module (observed: the real ensureDaemonsAndEnqueue ran and spawned a
  // daemon). The race under test is the supersede→enqueue critical section,
  // which this staggered start still fully contends.
  const p1 = enqueueFromHttp("separations", [{ docId: "4025" }], { trackerDir: dir, supersedePriorRuns: supersede });
  while (!events.includes("enqueue-1:start")) {
    await new Promise((r) => setTimeout(r, 1));
  }
  const p2 = enqueueFromHttp("separations", [{ docId: "4025" }], { trackerDir: dir, supersedePriorRuns: supersede });
  const [r1, r2] = await Promise.all([p1, p2]);

  assert.equal(r1.ok, true);
  assert.equal(r2.ok, true);
  // Strict serialization: the whole first critical section (start → supersede
  // → done) completes before the second one begins.
  assert.deepEqual(events, [
    "enqueue-1:start",
    "supersede:run-1",
    "enqueue-1:done",
    "enqueue-2:start",
    "supersede:run-2",
    "enqueue-2:done",
  ]);
});

test("unguarded enqueues (no supersedePriorRuns) do not take the serialization lock", async () => {
  // Delegated / fan-out enqueues call enqueueFromHttp without the supersede
  // guard; they must not queue behind a slow guarded input run.
  const events: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  let call = 0;

  const mock = await enqueueMock();
  mock.mockImplementation(async (_wf, _inputs, _flags, opts: PreparedHookOpts) => {
    const n = ++call;
    events.push(`enqueue-${n}:start`);
    if (opts.onPreparedItems) {
      await opts.onPreparedItems([{ itemId: "4025", runId: `run-${n}`, input: { docId: "4025" } }]);
      await gate; // guarded call holds the lock until released
    }
    events.push(`enqueue-${n}:done`);
    return { enqueued: [], daemons: [] };
  });

  const dir = tempTrackerDir();
  const guarded = enqueueFromHttp("separations", [{ docId: "4025" }], {
    trackerDir: dir,
    supersedePriorRuns: () => {},
  });
  // Yield so the guarded call enters its critical section first.
  await new Promise((r) => setTimeout(r, 5));
  const unguarded = await enqueueFromHttp("separations", [{ docId: "4026" }], { trackerDir: dir });

  assert.equal(unguarded.ok, true);
  assert.ok(
    events.includes("enqueue-2:done") && !events.includes("enqueue-1:done"),
    `unguarded enqueue must complete while the guarded one still holds the lock (events: ${events.join(", ")})`,
  );
  release();
  assert.equal((await guarded).ok, true);
});
