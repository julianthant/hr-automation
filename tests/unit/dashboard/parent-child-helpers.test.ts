import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  aggregateBatchCounts,
  pickPreviewChildren,
  computeBatchElapsed,
  resolveBatchAccent,
} from "../../../src/dashboard/components/ocr/parent-child-helpers.js";
import type { TrackerEntry } from "../../../src/dashboard/components/types.js";

function child(over: Partial<TrackerEntry>): TrackerEntry {
  return {
    workflow: "oath-signature",
    timestamp: "2026-05-01T09:43:00.000Z",
    id: "x",
    runId: "x#1",
    parentRunId: "prep-a3f1",
    status: "pending",
    data: {},
    ...over,
  };
}

describe("aggregateBatchCounts", () => {
  it("counts each status bucket", () => {
    const result = aggregateBatchCounts([
      child({ status: "done" }),
      child({ status: "done" }),
      child({ status: "running" }),
      child({ status: "pending" }),
      child({ status: "pending" }),
      child({ status: "failed" }),
    ]);
    assert.deepEqual(result, {
      done: 2,
      running: 1,
      queued: 2,
      failed: 1,
      total: 6,
    });
  });

  it("treats skipped as done (terminal success)", () => {
    const result = aggregateBatchCounts([
      child({ status: "skipped" }),
      child({ status: "done" }),
    ]);
    assert.equal(result.done, 2);
  });

  it("returns all-zero counts for empty input", () => {
    assert.deepEqual(aggregateBatchCounts([]), {
      done: 0,
      running: 0,
      queued: 0,
      failed: 0,
      total: 0,
    });
  });
});

describe("pickPreviewChildren", () => {
  it("orders running first, then queued, then done, then failed", () => {
    const kids = [
      child({ id: "a", status: "done", data: { name: "A" } }),
      child({ id: "b", status: "failed", data: { name: "B" } }),
      child({ id: "c", status: "running", data: { name: "C" } }),
      child({ id: "d", status: "pending", data: { name: "D" } }),
    ];
    const out = pickPreviewChildren(kids, 4);
    assert.deepEqual(
      out.map((k) => k.id),
      ["c", "d", "a", "b"],
    );
  });

  it("breaks ties on firstLogTs descending", () => {
    const kids = [
      child({ id: "old", status: "running", firstLogTs: "2026-05-01T09:40:00Z" }),
      child({ id: "new", status: "running", firstLogTs: "2026-05-01T09:42:00Z" }),
    ];
    const out = pickPreviewChildren(kids, 2);
    assert.deepEqual(
      out.map((k) => k.id),
      ["new", "old"],
    );
  });

  it("limits to n", () => {
    const kids = Array.from({ length: 10 }, (_, i) =>
      child({ id: `k${i}`, status: "pending" }),
    );
    assert.equal(pickPreviewChildren(kids, 3).length, 3);
  });

  it("returns at most all kids when n > kids.length", () => {
    const kids = [child({ id: "a" }), child({ id: "b" })];
    assert.equal(pickPreviewChildren(kids, 10).length, 2);
  });

  it("resolves name from data.name with fallback to id", () => {
    const out = pickPreviewChildren(
      [
        child({ id: "10794813", data: { name: "Akitsugu Uchida", emplId: "10794813" } }),
        child({ id: "noname", data: {} }),
      ],
      2,
    );
    assert.equal(out[0]?.name, "Akitsugu Uchida");
    assert.equal(out[1]?.name, "noname");
  });

  it("resolves emplId from data.emplId or data.eid", () => {
    const out = pickPreviewChildren(
      [
        child({ id: "a", data: { emplId: "111" } }),
        child({ id: "b", data: { eid: "222" } }),
      ],
      2,
    );
    assert.equal(out[0]?.emplId, "111");
    assert.equal(out[1]?.emplId, "222");
  });
});

describe("computeBatchElapsed", () => {
  it("returns null when no child has any usable timestamp", () => {
    assert.equal(
      computeBatchElapsed([child({ timestamp: "", firstLogTs: undefined, lastLogTs: undefined })]),
      null,
    );
  });

  it("uses the earliest firstLogTs as start and latest lastLogTs as end", () => {
    const result = computeBatchElapsed([
      child({
        firstLogTs: "2026-05-01T09:42:00.000Z",
        lastLogTs: "2026-05-01T09:43:00.000Z",
        status: "done",
      }),
      child({
        firstLogTs: "2026-05-01T09:42:30.000Z",
        lastLogTs: "2026-05-01T09:43:38.000Z",
        status: "running",
      }),
    ]);
    assert.equal(result?.startMs, Date.parse("2026-05-01T09:42:00.000Z"));
    assert.equal(result?.endMs, Date.parse("2026-05-01T09:43:38.000Z"));
    assert.equal(result?.frozen, false);
  });

  it("freezes (frozen=true) when every child is terminal", () => {
    const result = computeBatchElapsed([
      child({
        firstLogTs: "2026-05-01T09:42:00.000Z",
        lastLogTs: "2026-05-01T09:43:00.000Z",
        status: "done",
      }),
      child({
        firstLogTs: "2026-05-01T09:42:30.000Z",
        lastLogTs: "2026-05-01T09:44:00.000Z",
        status: "failed",
      }),
    ]);
    assert.equal(result?.frozen, true);
  });

  it("falls back to entry.timestamp when firstLogTs missing", () => {
    const result = computeBatchElapsed([
      child({
        timestamp: "2026-05-01T09:40:00.000Z",
        firstLogTs: undefined,
        lastLogTs: "2026-05-01T09:43:00.000Z",
        status: "done",
      }),
    ]);
    assert.equal(result?.startMs, Date.parse("2026-05-01T09:40:00.000Z"));
  });
});

describe("resolveBatchAccent", () => {
  it("returns destructive when any child failed", () => {
    assert.equal(
      resolveBatchAccent({ done: 1, running: 0, queued: 0, failed: 1, total: 2 }),
      "destructive",
    );
  });

  it("returns success when all children done", () => {
    assert.equal(
      resolveBatchAccent({ done: 5, running: 0, queued: 0, failed: 0, total: 5 }),
      "success",
    );
  });

  it("returns warning while running or queued", () => {
    assert.equal(
      resolveBatchAccent({ done: 1, running: 1, queued: 0, failed: 0, total: 2 }),
      "warning",
    );
    assert.equal(
      resolveBatchAccent({ done: 0, running: 0, queued: 3, failed: 0, total: 3 }),
      "warning",
    );
  });

  it("returns warning for empty batch (zero children)", () => {
    assert.equal(
      resolveBatchAccent({ done: 0, running: 0, queued: 0, failed: 0, total: 0 }),
      "warning",
    );
  });
});
