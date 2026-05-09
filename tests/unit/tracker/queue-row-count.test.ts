import { test } from "node:test";
import assert from "node:assert/strict";

import type { TrackerEntry } from "../../../src/tracker/jsonl.js";
import {
  countSidebarRowsFromTrackerHistory,
  dedupeLatestByIdWithCarriedEmplId,
  groupMergedTrackerEntries,
} from "../../../src/tracker/queue-row-count.js";
import { isResolvedPrepEntry } from "../../../src/tracker/dashboard/prep-rows.js";

test("groupMergedTrackerEntries: two item ids, same emplId → one group", () => {
  const rows: TrackerEntry[] = [
    {
      workflow: "active-check",
      timestamp: "2026-05-09T18:00:00.000Z",
      id: "Doe, Jane",
      runId: "Doe, Jane#1",
      status: "done",
      data: { emplId: "10000001", name: "Doe, Jane" },
    },
    {
      workflow: "active-check",
      timestamp: "2026-05-09T18:05:00.000Z",
      id: "10000001",
      runId: "10000001#1",
      status: "done",
      data: { emplId: "10000001" },
    },
  ];
  const groups = groupMergedTrackerEntries(rows);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].siblings.length, 1);
});

test("countSidebarRowsFromTrackerHistory: merges + excludes resolved prep", () => {
  const raw: TrackerEntry[] = [
    {
      workflow: "emergency-contact",
      timestamp: "2026-05-09T10:00:00.000Z",
      id: "p1-100",
      runId: "r1",
      status: "done",
      step: "approved",
      data: { mode: "prepare", emplId: "100" },
    },
    {
      workflow: "active-check",
      timestamp: "2026-05-09T11:00:00.000Z",
      id: "Name, A",
      runId: "x#1",
      status: "done",
      data: { emplId: "200" },
    },
    {
      workflow: "active-check",
      timestamp: "2026-05-09T11:01:00.000Z",
      id: "200",
      runId: "y#1",
      status: "done",
      data: { emplId: "200" },
    },
  ];
  const n = countSidebarRowsFromTrackerHistory(raw, isResolvedPrepEntry);
  assert.equal(n, 1, "prep row excluded; two active-check rows collapse to one");
});

test("dedupeLatestByIdWithCarriedEmplId: carries emplId from older line", () => {
  const raw: TrackerEntry[] = [
    {
      workflow: "active-check",
      timestamp: "2026-05-09T12:00:00.000Z",
      id: "Name, B",
      status: "running",
      step: "checking",
      data: { emplId: "300" },
    },
    {
      workflow: "active-check",
      timestamp: "2026-05-09T12:05:00.000Z",
      id: "Name, B",
      status: "failed",
      step: "cancelled",
      data: {},
    },
  ];
  const deduped = dedupeLatestByIdWithCarriedEmplId(raw);
  assert.equal(deduped.length, 1);
  assert.equal(deduped[0].data?.emplId, "300");
});
