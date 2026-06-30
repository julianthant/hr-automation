import { test } from "vitest";
import assert from "node:assert/strict";
import {
  sortQueueEntriesForDisplay,
  sortDaemonOperationParentIds,
  isQueueSortMode,
  DEFAULT_QUEUE_SORT_MODE,
} from "../../../src/dashboard/components/queue-panel/queue-sort.js";
import type { TrackerEntry } from "../../../src/dashboard/components/shared/types.js";

function entry(partial: Partial<TrackerEntry> & Pick<TrackerEntry, "id">): TrackerEntry {
  return {
    workflow: "person-lookup",
    timestamp: "2026-05-11T12:00:00.000Z",
    status: "done",
    ...partial,
  };
}

test("isQueueSortMode guards known values", () => {
  assert.equal(isQueueSortMode("start-newest"), true);
  assert.equal(isQueueSortMode("nope"), false);
  assert.equal(DEFAULT_QUEUE_SORT_MODE, "start-newest");
});

test("sortQueueEntriesForDisplay pins terminal Not found rows last", () => {
  const rows: TrackerEntry[] = [
    entry({
      id: "zebra",
      firstLogTs: "2026-05-11T12:01:00.000Z",
      data: { name: "Zebra" },
    }),
    entry({
      id: "nf",
      firstLogTs: "2026-05-11T12:00:00.000Z",
      data: { activeStatus: "not-found", searchName: "Missing" },
    }),
    entry({
      id: "alpha",
      firstLogTs: "2026-05-11T12:02:00.000Z",
      data: { name: "Alpha" },
    }),
  ];
  const sorted = sortQueueEntriesForDisplay(rows, "label-asc");
  assert.deepEqual(
    sorted.map((r) => r.id),
    ["alpha", "zebra", "nf"],
  );
});

test("sortQueueEntriesForDisplay interleaves terminal Not found by time for start-oldest", () => {
  const rows: TrackerEntry[] = [
    entry({
      id: "alpha",
      firstLogTs: "2026-05-11T12:03:00.000Z",
      data: { name: "Alpha" },
    }),
    entry({
      id: "nf",
      firstLogTs: "2026-05-11T12:02:00.000Z",
      data: { activeStatus: "not-found", searchName: "Missing" },
    }),
    entry({
      id: "zebra",
      firstLogTs: "2026-05-11T12:01:00.000Z",
      data: { name: "Zebra" },
    }),
  ];
  const sorted = sortQueueEntriesForDisplay(rows, "start-oldest");
  assert.deepEqual(
    sorted.map((r) => r.id),
    ["zebra", "nf", "alpha"],
  );
});

test("start-oldest orders by firstLogTs ascending among non–not-found rows", () => {
  const rows: TrackerEntry[] = [
    entry({
      id: "c",
      firstLogTs: "2026-05-11T12:03:00.000Z",
      data: {},
    }),
    entry({
      id: "a",
      firstLogTs: "2026-05-11T12:01:00.000Z",
      data: {},
    }),
    entry({
      id: "b",
      firstLogTs: "2026-05-11T12:02:00.000Z",
      data: {},
    }),
  ];
  const sorted = sortQueueEntriesForDisplay(rows, "start-oldest");
  assert.deepEqual(
    sorted.map((r) => r.id),
    ["a", "b", "c"],
  );
});

test("label-desc respects displayNames map", () => {
  const rows: TrackerEntry[] = [
    entry({ id: "id-a", data: {} }),
    entry({ id: "id-b", data: {} }),
  ];
  const names = new Map<string, string>([
    ["id-a", "Charlie"],
    ["id-b", "Alpha"],
  ]);
  const sorted = sortQueueEntriesForDisplay(rows, "label-desc", names);
  assert.deepEqual(
    sorted.map((r) => r.id),
    ["id-a", "id-b"],
  );
});

test("sortDaemonOperationParentIds orders by batch title for label-asc", () => {
  const membersByParent = new Map<string, TrackerEntry[]>();
  membersByParent.set("p-later", [
    entry({
      id: "m1",
      data: { batchDisplayOrdinal: "2" },
      firstLogTs: "2026-05-11T14:00:00.000Z",
    }),
  ]);
  membersByParent.set("p-earlier", [
    entry({
      id: "m2",
      data: { batchDisplayOrdinal: "1" },
      firstLogTs: "2026-05-11T13:00:00.000Z",
    }),
  ]);
  const ids = sortDaemonOperationParentIds(
    ["p-later", "p-earlier"],
    membersByParent,
    "label-asc",
    "Person Lookup",
  );
  assert.deepEqual(ids, ["p-earlier", "p-later"]);
});

test("sortQueueEntriesForDisplay interleaves terminal Not found by time for start-newest", () => {
  const rows: TrackerEntry[] = [
    entry({
      id: "alpha",
      firstLogTs: "2026-05-11T12:03:00.000Z",
      data: { name: "Alpha" },
    }),
    entry({
      id: "nf",
      firstLogTs: "2026-05-11T12:02:00.000Z",
      data: { activeStatus: "not-found", searchName: "Missing" },
    }),
    entry({
      id: "zebra",
      firstLogTs: "2026-05-11T12:01:00.000Z",
      data: { name: "Zebra" },
    }),
  ];
  const sorted = sortQueueEntriesForDisplay(rows, "start-newest");
  assert.deepEqual(
    sorted.map((r) => r.id),
    ["alpha", "nf", "zebra"],
  );
});

test("sortDaemonOperationParentIds time sort orders all–not-found batches by time like others", () => {
  const membersByParent = new Map<string, TrackerEntry[]>();
  membersByParent.set("nf", [
    entry({
      id: "n1",
      status: "done",
      data: { activeStatus: "not-found" },
      firstLogTs: "2026-05-11T16:00:00.000Z",
    }),
  ]);
  membersByParent.set("ok", [
    entry({
      id: "o1",
      status: "done",
      data: { name: "Later" },
      firstLogTs: "2026-05-11T15:00:00.000Z",
    }),
  ]);
  const ids = sortDaemonOperationParentIds(
    ["nf", "ok"],
    membersByParent,
    "start-newest",
    "Person Lookup",
  );
  assert.deepEqual(ids, ["nf", "ok"]);
});

test("sortDaemonOperationParentIds label sort still sinks all–not-found batches last", () => {
  const membersByParent = new Map<string, TrackerEntry[]>();
  membersByParent.set("p-nf", [
    entry({
      id: "n1",
      status: "done",
      data: { activeStatus: "not-found", batchDisplayOrdinal: "1" },
      firstLogTs: "2026-05-11T10:00:00.000Z",
    }),
  ]);
  membersByParent.set("p-ok", [
    entry({
      id: "o1",
      status: "done",
      data: { batchDisplayOrdinal: "2" },
      firstLogTs: "2026-05-11T15:00:00.000Z",
    }),
  ]);
  const ids = sortDaemonOperationParentIds(
    ["p-nf", "p-ok"],
    membersByParent,
    "label-asc",
    "Person Lookup",
  );
  assert.deepEqual(ids, ["p-ok", "p-nf"]);
});
