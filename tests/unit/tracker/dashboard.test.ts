import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { computeStepDurations } from "../../../src/tracker/dashboard.js";

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
});
