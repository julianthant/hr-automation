import { test } from "vitest";
import assert from "node:assert/strict";

import { collapseEntriesForStatStrip } from "../../../src/dashboard/components/queue-panel/stat-strip-collapse.js";
import { countEntriesByQueueStatus } from "../../../src/dashboard/components/queue-panel/queue-status.js";
import type { TrackerEntry } from "../../../src/dashboard/components/shared/types.js";

function row(
  id: string,
  status: TrackerEntry["status"],
  opts: Partial<Pick<TrackerEntry, "workflow" | "parentRunId" | "timestamp" | "step">> = {},
): TrackerEntry {
  return {
    id,
    status,
    workflow: opts.workflow ?? "active-check",
    timestamp: opts.timestamp ?? "2026-05-11T12:00:00.000Z",
    runId: id,
    data: {},
    ...(opts.parentRunId !== undefined ? { parentRunId: opts.parentRunId } : {}),
    ...(opts.step !== undefined ? { step: opts.step } : {}),
  };
}

test("collapseEntriesForStatStrip merges same-parent daemon members into one row", () => {
  const pid = "batch-run";
  const input = [
    row("id1", "done", { parentRunId: pid }),
    row("id2", "done", { parentRunId: pid }),
    row("solo", "running"),
  ];

  const out = collapseEntriesForStatStrip(input);
  assert.equal(out.length, 2);

  const counts = countEntriesByQueueStatus(out);
  assert.equal(counts.done, 1);
  assert.equal(counts.running, 1);
});

test("collapseEntriesForStatStrip rollup prefers queue bucket when any child is queued", () => {
  const pid = "p2";
  const input = [
    row("id1", "done", { parentRunId: pid }),
    row("id2", "pending", { parentRunId: pid }),
  ];

  const out = collapseEntriesForStatStrip(input);
  assert.equal(out.length, 1);
  const counts = countEntriesByQueueStatus(out);
  assert.equal(counts.pending, 1);
});

test("collapseEntriesForStatStrip two distinct batches → two synth rows + done rollup", () => {
  const input = [
    row("a1", "done", { parentRunId: "batch-a" }),
    row("a2", "done", { parentRunId: "batch-a" }),
    row("b1", "done", { parentRunId: "batch-b" }),
  ];

  const collapsed = collapseEntriesForStatStrip(input);
  assert.equal(collapsed.length, 2);
  const counts = countEntriesByQueueStatus(collapsed);
  assert.equal(counts.done, 2);
});
