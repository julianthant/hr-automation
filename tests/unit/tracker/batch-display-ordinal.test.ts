import { test } from "vitest";
import assert from "node:assert/strict";
import {
  lowestAvailableBatchOrdinal,
  collectUsedBatchDisplayOrdinals,
} from "../../../src/tracker/batch-display-ordinal.js";
import { mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

test("lowestAvailableBatchOrdinal fills gaps", () => {
  assert.equal(lowestAvailableBatchOrdinal(new Set([1, 3])), 2);
  assert.equal(lowestAvailableBatchOrdinal(new Set()), 1);
  assert.equal(lowestAvailableBatchOrdinal(new Set([1, 2, 3])), 4);
});

test("collectUsedBatchDisplayOrdinals reads parent-linked ordinals", () => {
  const dir = join(tmpdir(), `batch-ord-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  try {
    const wf = "active-check";
    const d = "2026-05-11";
    const file = join(dir, `${wf}-${d}.jsonl`);
    writeFileSync(
      file,
      [
        JSON.stringify({
          workflow: wf,
          timestamp: "2026-05-11T12:00:00.000Z",
          id: "a",
          runId: "r1",
          parentRunId: "batch-1",
          status: "pending",
          data: { batchDisplayOrdinal: "1" },
        }),
        JSON.stringify({
          workflow: wf,
          timestamp: "2026-05-11T12:00:01.000Z",
          id: "b",
          runId: "r2",
          parentRunId: "batch-1",
          status: "pending",
          data: { batchDisplayOrdinal: "1" },
        }),
        JSON.stringify({
          workflow: wf,
          timestamp: "2026-05-11T12:00:02.000Z",
          id: "c",
          runId: "r3",
          parentRunId: "batch-2",
          status: "pending",
          data: { batchDisplayOrdinal: "3" },
        }),
      ].join("\n") + "\n",
    );
    const used = collectUsedBatchDisplayOrdinals(wf, dir, d);
    assert.deepEqual(used, new Set([1, 3]));
    assert.equal(lowestAvailableBatchOrdinal(used), 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
