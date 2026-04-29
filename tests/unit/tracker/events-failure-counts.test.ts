import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { computeFailureCounts } from "../../../src/tracker/dashboard.js";
import type { TrackerEntry } from "../../../src/tracker/jsonl.js";

function entry(p: Partial<TrackerEntry>): TrackerEntry {
  return {
    workflow: "separations",
    timestamp: "2026-04-28T10:00:00.000Z",
    id: "DOC-1",
    runId: "DOC-1#1",
    status: "done",
    data: {},
    ...p,
  };
}

describe("computeFailureCounts", () => {
  it("counts unique ids whose latest entry per runId is failed", () => {
    const entries = [
      entry({ id: "A", status: "running", timestamp: "2026-04-28T10:00:00Z" }),
      entry({ id: "A", status: "failed", timestamp: "2026-04-28T10:05:00Z" }),
      entry({ id: "B", status: "done", timestamp: "2026-04-28T10:10:00Z" }),
      entry({ id: "C", status: "failed", timestamp: "2026-04-28T10:12:00Z" }),
    ];
    assert.equal(computeFailureCounts(entries), 2); // A, C
  });

  it("collapses retries: B#1 failed then B#2 done → not counted", () => {
    const entries = [
      entry({ id: "B", runId: "B#1", status: "failed", timestamp: "2026-04-28T10:00:00Z" }),
      entry({ id: "B", runId: "B#2", status: "done", timestamp: "2026-04-28T10:10:00Z" }),
    ];
    // The latest run for id B is done, so B should NOT be counted as a failure.
    // (computeFailureCounts dedupes by id, keeping latest run.)
    assert.equal(computeFailureCounts(entries), 0);
  });

  it("counts B if its latest run is failed regardless of older run state", () => {
    const entries = [
      entry({ id: "B", runId: "B#1", status: "done", timestamp: "2026-04-28T10:00:00Z" }),
      entry({ id: "B", runId: "B#2", status: "failed", timestamp: "2026-04-28T10:10:00Z" }),
    ];
    assert.equal(computeFailureCounts(entries), 1);
  });

  it("returns 0 for an empty list", () => {
    assert.equal(computeFailureCounts([]), 0);
  });
});
