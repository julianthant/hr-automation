import { test } from "vitest";
import assert from "node:assert/strict";

import type { TrackerEntry } from "../../../src/tracker/jsonl.js";
import {
  countSidebarRowsFromTrackerHistory,
  countSidebarQueuedRowsFromTrackerHistory,
} from "../../../src/tracker/queue-row-count.js";
import {
  PERSON_LOOKUP_WORKFLOW_RUNTIME_POLICY,
} from "../../../src/workflows/person-lookup/workflow.js";

/**
 * ISS-002 regression pin: the rail "queued" sub-badge must use the SAME
 * collapsed top-level-surface model as the total, so `queued <= total` always.
 *
 * person-lookup's queue is entirely delegated OCR-enrichment members
 * (`alwaysOperationDelegatedMembers: true` → each `parentRunId` group is one batch
 * ANCHOR surface). The old rail read the RAW SQLite per-workflow queued task
 * count (every queued member), which diverged from the collapsed total — the
 * field bug behind "53 queued / 18 total".
 */

const personLookupPolicies = new Map([
  ["person-lookup", PERSON_LOOKUP_WORKFLOW_RUNTIME_POLICY],
]);

/** N parent anchors, each with `membersPerParent` queued (pending) delegated members. */
function buildAllDelegatedQueuedHistory(
  parentCount: number,
  membersPerParent: number,
): TrackerEntry[] {
  const rows: TrackerEntry[] = [];
  for (let p = 0; p < parentCount; p++) {
    for (let m = 0; m < membersPerParent; m++) {
      rows.push({
        workflow: "person-lookup",
        timestamp: `2026-06-16T12:${String(p).padStart(2, "0")}:${String(m).padStart(2, "0")}.000Z`,
        id: `lookup-${p}-${m}`,
        runId: `lookup-${p}-${m}#1`,
        parentRunId: `ocr-parent-${p}`,
        status: "pending",
        data: { archetype: "operation-member" },
      });
    }
  }
  return rows;
}

test("ISS-002: collapsed-queued count = queued ANCHORS, not raw delegated members (queued <= total)", () => {
  // 18 parent anchors, 53 total delegated members all queued (>1 member on
  // some parents reproduces queued-members > anchors, i.e. raw 53 vs 18).
  const parentCount = 18;
  const memberRows: TrackerEntry[] = [];
  let memberId = 0;
  // Distribute 53 members across 18 parents (some parents have >1 member).
  const distribution = [2, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3]; // sums to 53
  assert.equal(
    distribution.reduce((a, b) => a + b, 0),
    53,
    "fixture: 53 delegated members total",
  );
  assert.equal(distribution.length, parentCount, "fixture: 18 parent anchors");
  for (let p = 0; p < parentCount; p++) {
    for (let m = 0; m < distribution[p]!; m++) {
      memberRows.push({
        workflow: "person-lookup",
        timestamp: `2026-06-16T12:${String(p).padStart(2, "0")}:${String(m).padStart(2, "0")}.000Z`,
        id: `lookup-${memberId}`,
        runId: `lookup-${memberId}#1`,
        parentRunId: `ocr-parent-${p}`,
        status: "pending",
        data: { archetype: "operation-member" },
        step: "searching",
      });
      memberId++;
    }
  }
  assert.equal(memberRows.length, 53, "fixture: 53 raw queued member rows");

  const total = countSidebarRowsFromTrackerHistory(
    memberRows,
    () => false,
    personLookupPolicies,
  );
  const queued = countSidebarQueuedRowsFromTrackerHistory(
    memberRows,
    () => false,
    personLookupPolicies,
  );

  // Total collapses to the 18 operation anchors.
  assert.equal(total, parentCount, "total collapses to 18 operation anchors");
  // The bug: raw queued depth would be 53 (> total). Collapsed-queued must be
  // the 18 queued anchors, never the raw member count.
  assert.equal(queued, parentCount, "collapsed-queued = 18 queued anchors, not 53 raw members");
  assert.ok(queued <= total, "queued must never exceed total");
  assert.notEqual(queued, 53, "collapsed-queued must NOT be the raw member count");
});

test("ISS-002: a queued anchor and a done anchor → total counts both, queued counts only the queued one", () => {
  // Parent A: all members done. Parent B: members queued.
  const rows: TrackerEntry[] = [
    {
      workflow: "person-lookup",
      timestamp: "2026-06-16T12:00:00.000Z",
      id: "done-1",
      runId: "done-1#1",
      parentRunId: "parent-A",
      status: "done",
      data: { archetype: "operation-member" },
    },
    {
      workflow: "person-lookup",
      timestamp: "2026-06-16T12:01:00.000Z",
      id: "queued-1",
      runId: "queued-1#1",
      parentRunId: "parent-B",
      status: "pending",
      data: { archetype: "operation-member" },
    },
  ];
  const total = countSidebarRowsFromTrackerHistory(rows, () => false, personLookupPolicies);
  const queued = countSidebarQueuedRowsFromTrackerHistory(rows, () => false, personLookupPolicies);
  assert.equal(total, 2, "two anchors total");
  assert.equal(queued, 1, "only the queued anchor counts as queued");
  assert.ok(queued <= total);
});

test("ISS-002: non-delegated single workflow — collapsed-queued == raw queued (oath-upload-style)", () => {
  // Two queued single tickets + one done single ticket — no delegation, so
  // collapsed == raw: 2 queued / 3 total (the finding's must-not-regress case).
  const rows: TrackerEntry[] = [
    {
      workflow: "oath-upload",
      timestamp: "2026-06-16T12:00:00.000Z",
      id: "t1",
      runId: "t1#1",
      status: "pending",
      data: { archetype: "single" },
    },
    {
      workflow: "oath-upload",
      timestamp: "2026-06-16T12:01:00.000Z",
      id: "t2",
      runId: "t2#1",
      status: "pending",
      data: { archetype: "single" },
    },
    {
      workflow: "oath-upload",
      timestamp: "2026-06-16T12:02:00.000Z",
      id: "t3",
      runId: "t3#1",
      status: "done",
      data: { archetype: "single" },
    },
  ];
  const total = countSidebarRowsFromTrackerHistory(rows);
  const queued = countSidebarQueuedRowsFromTrackerHistory(rows);
  assert.equal(total, 3, "three single tickets total");
  assert.equal(queued, 2, "two queued tickets — collapsed == raw for non-delegated singles");
});

// Keep the helper referenced so an unused-export lint never trips.
void buildAllDelegatedQueuedHistory;
