import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { computeStepDurations, buildRunTimelines } from "../../../src/tracker/dashboard.js";

describe("computeStepDurations", () => {
  it("returns empty object for no entries", () => {
    assert.deepEqual(computeStepDurations([]), {});
  });

  it("handles a simple 3-step run ending in done", () => {
    // Timestamps: start=0s, step A=0s, step B=10s, step C=25s, done=100s
    const entries = [
      { timestamp: "2026-04-17T10:00:00.000Z", status: "pending" as const },
      { timestamp: "2026-04-17T10:00:00.000Z", status: "running" as const, step: "A" },
      { timestamp: "2026-04-17T10:00:10.000Z", status: "running" as const, step: "B" },
      { timestamp: "2026-04-17T10:00:25.000Z", status: "running" as const, step: "C" },
      { timestamp: "2026-04-17T10:01:40.000Z", status: "done" as const },
    ];
    const durations = computeStepDurations(entries);
    assert.equal(durations.A, 10_000, "A: 10s");
    assert.equal(durations.B, 15_000, "B: 15s");
    assert.equal(durations.C, 75_000, "C: 75s");
    assert.equal(Object.keys(durations).length, 3);
  });

  it("caps the final step with a failed event", () => {
    const entries = [
      { timestamp: "2026-04-17T10:00:00.000Z", status: "running" as const, step: "A" },
      { timestamp: "2026-04-17T10:00:05.000Z", status: "running" as const, step: "B" },
      { timestamp: "2026-04-17T10:00:07.000Z", status: "failed" as const },
    ];
    const durations = computeStepDurations(entries);
    assert.equal(durations.A, 5_000);
    assert.equal(durations.B, 2_000);
  });

  it("does not emit a duration for a still-running final step", () => {
    const entries = [
      { timestamp: "2026-04-17T10:00:00.000Z", status: "running" as const, step: "A" },
      { timestamp: "2026-04-17T10:00:12.000Z", status: "running" as const, step: "B" },
    ];
    const durations = computeStepDurations(entries);
    assert.equal(durations.A, 12_000);
    assert.equal(durations.B, undefined, "B is still running — no duration yet");
  });

  it("sorts unordered input before computing", () => {
    const entries = [
      { timestamp: "2026-04-17T10:00:25.000Z", status: "running" as const, step: "C" },
      { timestamp: "2026-04-17T10:00:00.000Z", status: "running" as const, step: "A" },
      { timestamp: "2026-04-17T10:01:40.000Z", status: "done" as const },
      { timestamp: "2026-04-17T10:00:10.000Z", status: "running" as const, step: "B" },
    ];
    const durations = computeStepDurations(entries);
    assert.equal(durations.A, 10_000);
    assert.equal(durations.B, 15_000);
    assert.equal(durations.C, 75_000);
  });

  it("ignores malformed timestamps", () => {
    const entries = [
      { timestamp: "not-a-date", status: "pending" as const },
      { timestamp: "2026-04-17T10:00:00.000Z", status: "running" as const, step: "A" },
      { timestamp: "also-not-a-date", status: "running" as const, step: "B" },
      { timestamp: "2026-04-17T10:00:20.000Z", status: "done" as const },
    ];
    const durations = computeStepDurations(entries);
    // Only A's end is bounded by the valid done event; B had no valid ts to start from.
    assert.equal(durations.A, 20_000);
  });

  it("handles a skipped terminal state like done/failed", () => {
    const entries = [
      { timestamp: "2026-04-17T10:00:00.000Z", status: "running" as const, step: "A" },
      { timestamp: "2026-04-17T10:00:03.000Z", status: "skipped" as const },
    ];
    const durations = computeStepDurations(entries);
    assert.equal(durations.A, 3_000);
  });

  it("does not emit a duration when a step re-emits the same name (no transition)", () => {
    // PeopleSoft may emit running/A twice in a row (markStep re-announce); we
    // want A to count as a single contiguous block.
    const entries = [
      { timestamp: "2026-04-17T10:00:00.000Z", status: "running" as const, step: "A" },
      { timestamp: "2026-04-17T10:00:02.000Z", status: "running" as const, step: "A" },
      { timestamp: "2026-04-17T10:00:05.000Z", status: "running" as const, step: "B" },
      { timestamp: "2026-04-17T10:00:10.000Z", status: "done" as const },
    ];
    const durations = computeStepDurations(entries);
    assert.equal(durations.A, 5_000);
    assert.equal(durations.B, 5_000);
  });

  it("absorbs the pending→first-running gap into step 1 so sum matches global elapsed", () => {
    // Realistic kernel shape: pending fires immediately at workflow start,
    // then the first `running` event (often auth:<system>) doesn't fire until
    // after browser launch + session setup — a ~5s gap in practice. Without
    // the anchor fix, that gap was silently dropped. With it, step 1's
    // duration = (step 2 start) - (pending ts), and the sum of durations
    // equals the global elapsed time the top-level timer shows.
    const entries = [
      { timestamp: "2026-04-17T10:00:00.000Z", status: "pending" as const },
      { timestamp: "2026-04-17T10:00:05.000Z", status: "running" as const, step: "auth:ucpath" },
      { timestamp: "2026-04-17T10:00:20.000Z", status: "running" as const, step: "transaction" },
      { timestamp: "2026-04-17T10:00:35.000Z", status: "done" as const },
    ];
    const durations = computeStepDurations(entries);
    assert.equal(durations["auth:ucpath"], 20_000, "auth absorbs the 5s pre-step gap (20s, not 15s)");
    assert.equal(durations.transaction, 15_000, "transaction unchanged");

    const totalElapsed = Date.parse("2026-04-17T10:00:35.000Z") - Date.parse("2026-04-17T10:00:00.000Z");
    const sum = Object.values(durations).reduce((a, b) => a + b, 0);
    assert.equal(sum, totalElapsed, "sum of step durations equals total elapsed time");
  });

  it("tiles elapsed time when no pending event is present (first running is the anchor)", () => {
    // Legacy fixtures / tests that don't emit `pending` should still behave
    // sensibly: the earliest timestamp seen (the first running event) becomes
    // the anchor, so nothing changes versus old behavior.
    const entries = [
      { timestamp: "2026-04-17T10:00:00.000Z", status: "running" as const, step: "A" },
      { timestamp: "2026-04-17T10:00:10.000Z", status: "running" as const, step: "B" },
      { timestamp: "2026-04-17T10:00:30.000Z", status: "done" as const },
    ];
    const durations = computeStepDurations(entries);
    assert.equal(durations.A, 10_000);
    assert.equal(durations.B, 20_000);
  });

  it("pool-item shape: pending → auth:ucpath → auth:crm → handler steps → done tiles exactly", () => {
    // Locks in the shape `runOneItem` emits when the batch runner injects
    // per-system authTimings before the handler runs. Each synthetic
    // `running` entry is stamped with the REAL observer-recorded startTs,
    // so the gap between each entry and the next step-bearing entry becomes
    // that step's duration. The whole run tiles exactly to the elapsed
    // between `pending` and `done` — no gaps lost, no overlap double-counted.
    const entries = [
      { timestamp: "2026-04-21T21:41:26.000Z", status: "pending" as const },
      { timestamp: "2026-04-21T21:41:28.762Z", status: "running" as const, step: "auth:ucpath" },
      { timestamp: "2026-04-21T21:41:44.000Z", status: "running" as const, step: "auth:crm" },
      { timestamp: "2026-04-21T21:42:13.000Z", status: "running" as const, step: "searching" },
      { timestamp: "2026-04-21T21:42:27.000Z", status: "running" as const, step: "cross-verification" },
      { timestamp: "2026-04-21T21:42:40.000Z", status: "done" as const },
    ];
    const durations = computeStepDurations(entries);

    // auth:ucpath spans pending (21:41:26) → auth:crm (21:41:44) = 18s
    assert.equal(durations["auth:ucpath"], 18_000, "auth:ucpath absorbs pre-step gap + its own window");
    // auth:crm spans auth:crm (21:41:44) → searching (21:42:13) = 29s
    assert.equal(durations["auth:crm"], 29_000, "auth:crm duration is crm-start → first handler step");
    // searching spans 21:42:13 → 21:42:27 = 14s
    assert.equal(durations.searching, 14_000, "searching duration");
    // cross-verification spans 21:42:27 → 21:42:40 = 13s
    assert.equal(durations["cross-verification"], 13_000, "cross-verification duration");

    const totalElapsed = Date.parse("2026-04-21T21:42:40.000Z") - Date.parse("2026-04-21T21:41:26.000Z");
    const sum = Object.values(durations).reduce((a, b) => a + b, 0);
    assert.equal(sum, totalElapsed, "pool-item durations tile exactly to total elapsed");
  });
});

describe("buildRunTimelines", () => {
  it("returns an empty map for no entries", () => {
    assert.equal(buildRunTimelines([]).size, 0);
  });

  it("assigns ordinal 1 to the chronologically earliest run, not the earliest runId", () => {
    // Two runs of the same item: runId `b` started FIRST, `a` second.
    // Alphabetical sort would mis-number them (`a` as #1); earliest-ts sort
    // is correct (`b` as #1).
    const entries = [
      { id: "item1", runId: "a", timestamp: "2026-04-17T10:00:10.000Z" },
      { id: "item1", runId: "a", timestamp: "2026-04-17T10:00:20.000Z" },
      { id: "item1", runId: "b", timestamp: "2026-04-17T10:00:00.000Z" },
      { id: "item1", runId: "b", timestamp: "2026-04-17T10:00:05.000Z" },
    ];
    const timelines = buildRunTimelines(entries);
    assert.equal(timelines.get("b")?.ordinal, 1, "b ran first → ordinal 1");
    assert.equal(timelines.get("a")?.ordinal, 2, "a ran second → ordinal 2");
  });

  it("captures the earliest/latest timestamp per run (synthetic auth + handler span)", () => {
    // Simulates a batch item: synthetic auth row at t=0, handler rows at t=12s/t=20s.
    // earliestTrackerTs must be the auth row's ts so the timer includes auth.
    const entries = [
      { id: "item1", runId: "uuid-1", timestamp: "2026-04-17T10:00:00.000Z" },
      { id: "item1", runId: "uuid-1", timestamp: "2026-04-17T10:00:12.000Z" },
      { id: "item1", runId: "uuid-1", timestamp: "2026-04-17T10:00:20.000Z" },
    ];
    const timelines = buildRunTimelines(entries);
    const t = timelines.get("uuid-1");
    assert.equal(t?.earliestTrackerTs, "2026-04-17T10:00:00.000Z");
    assert.equal(t?.latestTrackerTs, "2026-04-17T10:00:20.000Z");
    assert.equal(t?.ordinal, 1);
  });

  it("falls back to `${id}#1` when runId is absent", () => {
    const entries = [
      { id: "item1", timestamp: "2026-04-17T10:00:00.000Z" },
      { id: "item1", timestamp: "2026-04-17T10:00:30.000Z" },
    ];
    const timelines = buildRunTimelines(entries);
    assert.equal(timelines.get("item1#1")?.ordinal, 1);
    assert.equal(timelines.get("item1#1")?.earliestTrackerTs, "2026-04-17T10:00:00.000Z");
    assert.equal(timelines.get("item1#1")?.latestTrackerTs, "2026-04-17T10:00:30.000Z");
  });

  it("handles mixed legacy {id}#N and UUID runIds in one item's history", () => {
    // Real-world: an item ran once in legacy batch (item1#1), then re-ran
    // via a UUID-emitting pool worker. Ordinals must reflect chronology, not
    // runId shape.
    const entries = [
      { id: "item1", runId: "item1#1", timestamp: "2026-04-17T09:00:00.000Z" },
      { id: "item1", runId: "item1#1", timestamp: "2026-04-17T09:00:30.000Z" },
      { id: "item1", runId: "9f3ea-uuid", timestamp: "2026-04-17T10:00:00.000Z" },
      { id: "item1", runId: "9f3ea-uuid", timestamp: "2026-04-17T10:00:45.000Z" },
    ];
    const timelines = buildRunTimelines(entries);
    assert.equal(timelines.get("item1#1")?.ordinal, 1);
    assert.equal(timelines.get("9f3ea-uuid")?.ordinal, 2);
  });
});
