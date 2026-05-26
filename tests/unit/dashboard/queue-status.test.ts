import { test } from "vitest";
import assert from "node:assert/strict";

import {
  countEntriesByQueueStatus,
  entryMatchesStatusFilter,
  isQueueLikeEntry,
  queueGroupMatchesStatusFilter,
} from "../../../src/dashboard/components/queue-panel/queue-status.js";
import type { TrackerEntry } from "../../../src/dashboard/components/shared/types.js";

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

test("queueGroupMatchesStatusFilter shows batch when any member matches", () => {
  const parent = entry("done");
  assert.equal(
    queueGroupMatchesStatusFilter("failed", [entry("running"), entry("failed")]),
    true,
  );
  assert.equal(queueGroupMatchesStatusFilter("failed", [entry("done")]), false);
  assert.equal(queueGroupMatchesStatusFilter(null, [entry("pending")]), true);
  assert.equal(
    queueGroupMatchesStatusFilter("pending", [], parent),
    false,
  );
  assert.equal(queueGroupMatchesStatusFilter("done", [], parent), true);
});

test("OCR awaiting-approval rows count under Active, not Done", () => {
  // New approval contract (2026-05-25): awaiting-approval is status="running".
  const ocrAwaiting: TrackerEntry = {
    workflow: "ocr",
    id: "ocr-session-1",
    runId: "ocr-run-1",
    timestamp: "2026-05-12T12:00:00.000Z",
    status: "running",
    step: "awaiting-approval",
    data: { mode: "prepare" },
  };
  const counts = countEntriesByQueueStatus([ocrAwaiting, entry("done")]);

  assert.equal(counts.running, 1);
  assert.equal(counts.done, 1);
});

test("entryMatchesStatusFilter maps OCR awaiting-approval to Active pill, not Done", () => {
  // New approval contract (2026-05-25): awaiting-approval is status="running".
  const ocrAwaiting: TrackerEntry = {
    workflow: "ocr",
    id: "ocr-session-2",
    runId: "ocr-run-2",
    timestamp: "2026-05-12T12:00:00.000Z",
    status: "running",
    step: "awaiting-approval",
    data: {},
  };
  assert.equal(entryMatchesStatusFilter(ocrAwaiting, "running"), true);
  assert.equal(entryMatchesStatusFilter(ocrAwaiting, "done"), false);
});
