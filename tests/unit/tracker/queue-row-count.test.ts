import { test } from "vitest";
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
      data: { archetype: "batch-parent", mode: "prepare", emplId: "100" },
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

test("countSidebarRowsFromTrackerHistory: approved OCR review rows are resolved and hidden", () => {
  // New approval contract (2026-05-25): OCR `done` is only emitted after
  // operator approves, so approved rows are resolved-prep — they drop out
  // of the active sidebar count, just like discarded rows do.
  const raw: TrackerEntry[] = [
    {
      workflow: "ocr",
      timestamp: "2026-05-09T10:00:00.000Z",
      id: "ocr-session-1",
      runId: "ocr-run-1",
      status: "done",
      step: "approved",
      parentRunId: "origin-parent-run",
      data: { archetype: "batch-parent", mode: "prepare", formType: "oath" },
    },
  ];
  assert.equal(countSidebarRowsFromTrackerHistory(raw, isResolvedPrepEntry), 0);
});

test("countSidebarRowsFromTrackerHistory: discarded OCR review rows are hidden", () => {
  const raw: TrackerEntry[] = [
    {
      workflow: "ocr",
      timestamp: "2026-05-09T10:00:00.000Z",
      id: "ocr-session-1",
      runId: "ocr-run-1",
      status: "failed",
      step: "discarded",
      data: {},
    },
  ];
  assert.equal(countSidebarRowsFromTrackerHistory(raw, isResolvedPrepEntry), 0);
});

test("countSidebarRowsFromTrackerHistory: delegation batch collapses many children to one", () => {
  const raw: TrackerEntry[] = Array.from({ length: 75 }, (_, i) => ({
    workflow: "active-check",
    timestamp: `2026-05-09T12:${String(i).padStart(2, "0")}:00.000Z`,
    id: `employee-${i}`,
    runId: `run-${i}`,
    parentRunId: "ocr-batch-parent",
    status: "done" as const,
    step: "checking",
    data: {},
  }));
  assert.equal(countSidebarRowsFromTrackerHistory(raw, isResolvedPrepEntry), 1);
});

test("countSidebarRowsFromTrackerHistory: legacy approved OCR parent plus child counts as one row", () => {
  const raw: TrackerEntry[] = [
    {
      workflow: "oath-signature",
      timestamp: "2026-05-09T12:00:00.000Z",
      id: "ocr-prep-session-1",
      runId: "parent-run-1",
      status: "done",
      step: "approved",
      data: { archetype: "batch-parent", mode: "prepare", fannedOutCount: "1" },
    },
    {
      workflow: "oath-signature",
      timestamp: "2026-05-09T12:01:00.000Z",
      id: "ocr-oath-run-1-r0",
      runId: "child-run-1",
      parentRunId: "parent-run-1",
      status: "done",
      data: { emplId: "10000001" },
    },
  ];
  assert.equal(countSidebarRowsFromTrackerHistory(raw, isResolvedPrepEntry), 1);
});

test("countSidebarRowsFromTrackerHistory: two distinct parent batches → two strip rows", () => {
  const raw: TrackerEntry[] = [
    {
      workflow: "active-check",
      timestamp: "2026-05-09T12:00:00.000Z",
      id: "a",
      runId: "a#1",
      parentRunId: "p1",
      status: "done",
      data: {},
    },
    {
      workflow: "active-check",
      timestamp: "2026-05-09T12:01:00.000Z",
      id: "b",
      runId: "b#1",
      parentRunId: "p2",
      status: "done",
      data: {},
    },
  ];
  assert.equal(countSidebarRowsFromTrackerHistory(raw, isResolvedPrepEntry), 2);
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
