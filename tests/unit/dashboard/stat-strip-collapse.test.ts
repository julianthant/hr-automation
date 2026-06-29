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

/**
 * ISS-005: an approved operation coordinator is a perpetual `running`/
 * `step=approved` row (it never reaches a terminal row) that ALSO owns a synth
 * member rollup. Before the fix it was counted twice — the coordinator as
 * Active + the synth as Done — because `isApprovedPrepForQueueStrip` drops only
 * archetype `batch` prep anchors, never `operation` coordinators. The
 * coordinator must be dropped (its members' synth rollup represents it), so a
 * fully-done operation counts as exactly 1 Done, 0 Active/Failed.
 */
test("collapseEntriesForStatStrip: an approved operation counts as its done rollup, not coordinator+synth (ISS-005)", () => {
  const opRun = "op-run";
  const input: TrackerEntry[] = [
    {
      id: "op",
      status: "running",
      step: "approved",
      workflow: "oath-signature",
      timestamp: "2026-06-29T12:00:00.000Z",
      runId: opRun,
      data: { archetype: "operation" },
    },
    {
      id: "m1",
      status: "done",
      workflow: "oath-signature",
      timestamp: "2026-06-29T12:00:01.000Z",
      runId: "m1",
      parentRunId: opRun,
      data: { archetype: "operation-member" },
    },
    {
      id: "m2",
      status: "done",
      workflow: "oath-signature",
      timestamp: "2026-06-29T12:00:02.000Z",
      runId: "m2",
      parentRunId: opRun,
      data: { archetype: "operation-member" },
    },
  ];

  const out = collapseEntriesForStatStrip(input);
  // Coordinator dropped; exactly one synth rollup row remains.
  assert.equal(out.length, 1);
  const counts = countEntriesByQueueStatus(out);
  assert.equal(counts.done, 1);
  assert.equal(counts.running ?? 0, 0);
  assert.equal(counts.failed ?? 0, 0);
});

/**
 * ISS-010: the synth rollup decided status with raw `m.status === "failed"`,
 * which also matched a cancelled member (`failed` + `step=cancelled`). It must
 * route through the canonical status key so a cancelled member counts under
 * Cancel, not Failed (the E2E-009 invariant).
 */
test("collapseEntriesForStatStrip: a cancelled member rolls up to Cancel, not Failed (ISS-010)", () => {
  const pid = "batch-cancel";
  const input = [
    row("c1", "done", { parentRunId: pid }),
    row("c2", "failed", { parentRunId: pid, step: "cancelled" }),
  ];

  const out = collapseEntriesForStatStrip(input);
  assert.equal(out.length, 1);
  const counts = countEntriesByQueueStatus(out);
  assert.equal(counts.cancelled, 1);
  assert.equal(counts.failed ?? 0, 0);
});

test("collapseEntriesForStatStrip: a genuine member failure still rolls up to Failed (precedence over cancel)", () => {
  const pid = "batch-mixed";
  const input = [
    row("f1", "failed", { parentRunId: pid }),
    row("f2", "failed", { parentRunId: pid, step: "cancelled" }),
  ];

  const out = collapseEntriesForStatStrip(input);
  const counts = countEntriesByQueueStatus(out);
  assert.equal(counts.failed, 1);
  assert.equal(counts.cancelled ?? 0, 0);
});
