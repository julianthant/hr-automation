import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { enqueueItems, readQueueState } from "../../../../src/core/daemon/queue.js";
import { scanOrphanedQueueItems } from "../../../../src/tracker/dashboard/sweeps.js";
import { trackEvent } from "../../../../src/tracker/jsonl.js";

function tmpTracker(): string {
  return mkdtempSync(join(tmpdir(), "tracker-sweeps-"));
}

test("scanOrphanedQueueItems leaves fresh queued items alone while daemon spawn may still be in flight", async () => {
  const dir = tmpTracker();
  try {
    const [queued] = await enqueueItems("eid-lookup", [{ name: "Barahona Martell, Carlos D" }], () => "lookup-1", dir);
    assert.ok(queued);
    trackEvent(
      {
        workflow: "eid-lookup",
        timestamp: new Date().toISOString(),
        id: queued.id,
        runId: queued.runId,
        status: "pending",
        data: { name: "Barahona Martell, Carlos D" },
      },
      dir,
    );

    await scanOrphanedQueueItems(dir);

    const state = await readQueueState("eid-lookup", dir);
    assert.deepEqual(state.queued.map((item) => item.id), ["lookup-1"]);
    assert.equal(state.failed.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
