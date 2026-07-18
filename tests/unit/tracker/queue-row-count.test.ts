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

test("groupMergedTrackerEntries: EID-keyed search stays primary over a newer name search", () => {
  // OCR often fans out BOTH an EID lookup and a name lookup for the same
  // person. The name run finishes later, but Search must still show the
  // original query (the EID), not the name-search sibling's typed name.
  const rows: TrackerEntry[] = [
    {
      workflow: "person-lookup",
      timestamp: "2026-07-17T15:38:46.000Z",
      id: "ocr-…-r0-n0",
      runId: "eid-run",
      status: "done",
      data: {
        emplId: "10848084",
        searchName: "10848084",
        resolvedName: "Macias, Isabel",
        __subjectKind: "eid",
      },
    },
    {
      workflow: "person-lookup",
      timestamp: "2026-07-17T15:39:10.000Z",
      id: "ocr-…-r0-n1",
      runId: "name-run",
      status: "done",
      data: {
        emplId: "10848084",
        searchName: "Macias, Isabel",
        resolvedName: "Macias, Isabel",
        __subjectKind: "person",
      },
    },
  ];
  const groups = groupMergedTrackerEntries(rows);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].primary.runId, "eid-run");
  assert.equal(groups[0].primary.data?.searchName, "10848084");
  assert.equal(groups[0].siblings.length, 1);
  assert.equal(groups[0].siblings[0].data?.searchName, "Macias, Isabel");
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
      data: { archetype: "operation", mode: "prepare", emplId: "100" },
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
      data: { archetype: "operation", mode: "prepare", formType: "oath" },
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
    parentRunId: "ocr-batch",
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
      data: { archetype: "operation", mode: "prepare", fannedOutCount: "1" },
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

/**
 * A DISCARDED OCR prep coordinator is retired: the dashboard drops it before
 * rendering (`isDiscardedPrepRow`, keyed on `mode === "prepare"`), so it must
 * not reach `wfCounts` either. The backend's discard filter used to be gated on
 * `isPreviewAnchor`, which only matched shape `preview` (+ a legacy ocr/batch
 * compat branch) — an `operation` prep coordinator (separations' "Run I-9
 * Check", oath-signature, emergency-contact, onbase) slipped through and the
 * rail badge read one HIGHER than the rendered queue per discarded prep.
 */
test("countSidebarRowsFromTrackerHistory: a discarded `operation` prep coordinator is not counted", () => {
  const raw: TrackerEntry[] = [
    {
      workflow: "separations",
      timestamp: "2026-07-16T19:28:20.302Z",
      id: "ocr-prep-discarded",
      runId: "r-discarded",
      status: "failed",
      step: "discarded",
      data: { archetype: "operation", mode: "prepare", queueRowKind: "file" },
    },
    {
      workflow: "separations",
      timestamp: "2026-07-16T21:36:20.000Z",
      id: "ocr-prep-live",
      runId: "r-live",
      status: "done",
      step: "i9-check",
      data: { archetype: "operation", mode: "prepare", queueRowKind: "file" },
    },
  ];

  assert.equal(countSidebarRowsFromTrackerHistory(raw), 1);
});

/** An APPROVED prep coordinator still renders in the queue, so it stays counted. */
test("countSidebarRowsFromTrackerHistory: an approved `operation` prep coordinator IS still counted", () => {
  const raw: TrackerEntry[] = [
    {
      workflow: "separations",
      timestamp: "2026-07-16T21:36:20.000Z",
      id: "ocr-prep-approved",
      runId: "r-approved",
      status: "done",
      step: "approved",
      data: { archetype: "operation", mode: "prepare", queueRowKind: "file" },
    },
  ];

  assert.equal(countSidebarRowsFromTrackerHistory(raw), 1);
});
