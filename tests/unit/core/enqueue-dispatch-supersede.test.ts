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

test("a throwing supersedePriorRuns does not break the enqueue (best-effort)", async () => {
  // The wrapper logs a warn on failure; suppress it so the stderr audit stays
  // clean while we assert the throw is swallowed.
  const warnSpy = vi.spyOn(log, "warn").mockImplementation(() => {});
  try {
    const result = await enqueueFromHttp("separations", [{ docId: "4025" }], {
      trackerDir: tempTrackerDir(),
      supersedePriorRuns: () => {
        throw new Error("boom");
      },
    });
    assert.equal(result.ok, true);

    const mock = await enqueueMock();
    const [, , , opts] = mock.mock.calls[0] as [unknown, unknown[], unknown, PreparedHookOpts];
    // The hook must swallow the error so the new run still enqueues.
    await assert.doesNotReject(async () =>
      opts.onPreparedItems?.([{ itemId: "4025", runId: "run-1", input: { docId: "4025" } }]),
    );
    assert.equal(warnSpy.mock.calls.length, 1);
  } finally {
    warnSpy.mockRestore();
  }
});
