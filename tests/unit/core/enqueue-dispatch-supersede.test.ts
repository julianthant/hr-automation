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
