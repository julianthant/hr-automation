import { test } from "node:test";
import assert from "node:assert/strict";

import {
  countEntriesByQueueStatus,
  entryMatchesStatusFilter,
  isQueueLikeEntry,
} from "../../../src/dashboard/components/queue-status.js";
import type { TrackerEntry } from "../../../src/dashboard/components/types.js";

function entry(status: TrackerEntry["status"], step?: string): TrackerEntry {
  return {
    workflow: "eid-lookup",
    id: `${status}-${step ?? "none"}`,
    timestamp: "2026-05-05T12:00:00.000Z",
    status,
    ...(step ? { step } : {}),
    data: {},
  };
}

test("isQueueLikeEntry treats auth-running rows as visible queue rows", () => {
  assert.equal(isQueueLikeEntry(entry("running", "auth:ucpath")), true);
  assert.equal(isQueueLikeEntry(entry("running", "searching")), false);
});

test("entryMatchesStatusFilter keeps Duo-waiting auth rows visible under Queue", () => {
  assert.equal(entryMatchesStatusFilter(entry("running", "auth:ucpath"), "pending"), true);
  assert.equal(entryMatchesStatusFilter(entry("running", "searching"), "pending"), false);
});

test("countEntriesByQueueStatus includes Duo-waiting auth rows in Queue count", () => {
  const counts = countEntriesByQueueStatus([
    entry("pending"),
    entry("running", "auth:ucpath"),
    entry("running", "searching"),
  ]);

  assert.equal(counts.pending, 2);
  assert.equal(counts.running, 2);
});
