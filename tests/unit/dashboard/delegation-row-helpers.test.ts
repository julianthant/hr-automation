import { describe, it } from "vitest";
import assert from "node:assert/strict";

import {
  aggregateOperationCounts,
  dedupeMembersByLatestRun,
  pickPreviewChildren,
  computeOperationElapsed,
  resolveOperationAccent,
} from "../../../src/dashboard/components/ocr/delegation-row-helpers.js";
import type { TrackerEntry } from "../../../src/dashboard/components/shared/types.js";

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

describe("aggregateOperationCounts", () => {
  it("counts each status bucket", () => {
    // Distinct members have distinct ids (the item identity); aggregateOperationCounts
    // dedupes by id, so give each member a unique id.
    const result = aggregateOperationCounts([
      child({ id: "a", status: "done" }),
      child({ id: "b", status: "done" }),
      child({ id: "c", status: "running" }),
      child({ id: "d", status: "pending" }),
      child({ id: "e", status: "pending" }),
      child({ id: "f", status: "failed" }),
    ]);
    assert.deepEqual(result, {
      done: 2,
      running: 1,
      queued: 2,
      failed: 1,
      cancelled: 0,
      total: 6,
    });
  });

  it("treats skipped as done (terminal success)", () => {
    const result = aggregateOperationCounts([
      child({ id: "a", status: "skipped" }),
      child({ id: "b", status: "done" }),
    ]);
    assert.equal(result.done, 2);
  });

  it("returns all-zero counts for empty input", () => {
    assert.deepEqual(aggregateOperationCounts([]), {
      done: 0,
      running: 0,
      queued: 0,
      failed: 0,
      cancelled: 0,
      total: 0,
    });
  });

  it("counts cancelled members (failed+step=cancelled) in a separate cancelled bucket, not failed (E2E-103)", () => {
    // A member with status=failed but step=cancelled is a deliberate operator
    // action — it should land in `cancelled`, not `failed`, consistent with how
    // statusKeyForEntry classifies it for the per-member chip.
    const result = aggregateOperationCounts([
      child({ id: "a", status: "failed" }),
      child({ id: "b", status: "failed", step: "cancelled" }),
    ]);
    assert.equal(result.failed, 1, "only the genuinely-failed member counts as failed");
    assert.equal(result.cancelled, 1, "the cancelled member lands in its own bucket");
    assert.equal(result.total, 2);
  });

  it("collapses a retried member to its latest run — counts the subject once (ISS-003)", () => {
    // A 3-signer operation where signer "b" failed then was retried: the retry is
    // a NEW run (runId b#2, runOrdinal 2) under the SAME item id "b". The header
    // must read 3 members (2 done + 1 done-retry), NOT 4 with a stray failed.
    const result = aggregateOperationCounts([
      child({ id: "a", runId: "a#1", runOrdinal: 1, status: "done" }),
      child({ id: "b", runId: "b#1", runOrdinal: 1, status: "failed" }),
      child({ id: "b", runId: "b#2", runOrdinal: 2, status: "done" }),
      child({ id: "c", runId: "c#1", runOrdinal: 1, status: "done" }),
    ]);
    assert.equal(result.total, 3, "three distinct signers, not four attempts");
    assert.equal(result.done, 3, "the retried signer counts as done (latest run)");
    assert.equal(result.failed, 0, "the superseded failed original is not counted");
  });
});

describe("dedupeMembersByLatestRun", () => {
  it("keeps the highest runOrdinal per item id", () => {
    const out = dedupeMembersByLatestRun([
      child({ id: "b", runId: "b#1", runOrdinal: 1, status: "failed" }),
      child({ id: "b", runId: "b#2", runOrdinal: 2, status: "done" }),
    ]);
    assert.equal(out.length, 1);
    assert.equal(out[0]?.runId, "b#2");
    assert.equal(out[0]?.status, "done");
  });

  it("is a no-op when every member is a distinct item", () => {
    const out = dedupeMembersByLatestRun([
      child({ id: "a", status: "done" }),
      child({ id: "b", status: "running" }),
    ]);
    assert.equal(out.length, 2);
  });

  it("falls back to timestamp when runOrdinal is absent/equal", () => {
    const out = dedupeMembersByLatestRun([
      child({ id: "b", runId: "b#1", status: "failed", firstLogTs: "2026-05-01T09:00:00.000Z" }),
      child({ id: "b", runId: "b#2", status: "done", firstLogTs: "2026-05-01T10:00:00.000Z" }),
    ]);
    assert.equal(out.length, 1);
    assert.equal(out[0]?.status, "done", "later timestamp wins when runOrdinal is undefined");
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

  it("prefers person names and EIDs over technical subject labels for preview labels", () => {
    const out = pickPreviewChildren(
      [
        child({
          id: "10794813",
          data: {
            __subject: "Oath · 10794813",
            name: "Akitsugu Uchida",
            emplId: "10794813",
          },
        }),
        child({ id: "bad-eid", data: { name: "Carlos Barahona", emplId: "12345" } }),
        child({ id: "noname", data: { emplId: "10800001" } }),
      ],
      3,
    );
    assert.equal(out[0]?.name, "Akitsugu Uchida");
    assert.equal(out[1]?.name, "Carlos Barahona");
    assert.equal(out[2]?.name, "10800001");
  });

  it("uses EID before technical OCR retry ids for cancelled lookup children", () => {
    const out = pickPreviewChildren(
      [
        child({
          id: "ocr-oath-1ade2f20-p3-r0",
          status: "failed",
          step: "cancelled",
          data: {
            __name: "ocr-oath-1ade2f20-p3-r0",
            emplId: "10424984",
          },
        }),
      ],
      1,
    );
    assert.equal(out[0]?.name, "10424984");
  });

  it("resolves emplId from data.emplId or data.eid", () => {
    const out = pickPreviewChildren(
      [
        child({ id: "a", data: { emplId: "10000001" } }),
        child({ id: "b", data: { eid: "10000002" } }),
      ],
      2,
    );
    assert.equal(out[0]?.emplId, "10000001");
    assert.equal(out[1]?.emplId, "10000002");
  });
});

describe("computeOperationElapsed", () => {
  it("returns null when no child has any usable timestamp", () => {
    assert.equal(
      computeOperationElapsed([child({ timestamp: "", firstLogTs: undefined, lastLogTs: undefined })]),
      null,
    );
  });

  it("uses the earliest firstLogTs as start and latest lastLogTs as end", () => {
    const result = computeOperationElapsed([
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
    const result = computeOperationElapsed([
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
    const result = computeOperationElapsed([
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

describe("resolveOperationAccent", () => {
  it("returns destructive when any child failed", () => {
    assert.equal(
      resolveOperationAccent({ done: 1, running: 0, queued: 0, failed: 1, cancelled: 0, total: 2 }),
      "destructive",
    );
  });

  it("returns success when all children done", () => {
    assert.equal(
      resolveOperationAccent({ done: 5, running: 0, queued: 0, failed: 0, cancelled: 0, total: 5 }),
      "success",
    );
  });

  it("returns warning while running or queued", () => {
    assert.equal(
      resolveOperationAccent({ done: 1, running: 1, queued: 0, failed: 0, cancelled: 0, total: 2 }),
      "warning",
    );
    assert.equal(
      resolveOperationAccent({ done: 0, running: 0, queued: 3, failed: 0, cancelled: 0, total: 3 }),
      "warning",
    );
  });

  it("returns warning for empty batch (zero children)", () => {
    assert.equal(
      resolveOperationAccent({ done: 0, running: 0, queued: 0, failed: 0, cancelled: 0, total: 0 }),
      "warning",
    );
  });

  it("returns success (not destructive) when all non-done members are cancelled", () => {
    // A batch where some members were cancelled by the operator but none genuinely
    // failed should not go red — the operator chose to stop those rows.
    assert.equal(
      resolveOperationAccent({ done: 2, running: 0, queued: 0, failed: 0, cancelled: 1, total: 3 }),
      "success",
    );
  });
});
