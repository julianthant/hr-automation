import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  detectFailurePattern,
  type FailurePattern,
} from "../../../src/tracker/failure-detector.js";
import type { TrackerEntry } from "../../../src/tracker/jsonl.js";

// Fixed "now" so we can reason about timestamps in ms offsets.
const NOW_MS = Date.UTC(2026, 3, 18, 12, 0, 0); // 2026-04-18T12:00:00Z
const now = () => NOW_MS;

function failedEntry(
  workflow: string,
  error: string,
  offsetFromNowMs: number,
  id: string = "item",
): TrackerEntry {
  return {
    workflow,
    timestamp: new Date(NOW_MS + offsetFromNowMs).toISOString(),
    id,
    status: "failed",
    error,
  };
}

describe("detectFailurePattern", () => {
  it("returns [] when nothing matches the threshold", () => {
    const entries: TrackerEntry[] = [
      failedEntry("onboarding", "Browser closed unexpectedly", -60_000),
      failedEntry("onboarding", "Browser closed unexpectedly", -120_000),
      // Only 2 failures — threshold default is 3.
    ];
    const out = detectFailurePattern(entries, { now });
    assert.deepEqual(out, []);
  });

  it("returns a single pattern when threshold is reached inside the window", () => {
    const entries: TrackerEntry[] = [
      failedEntry("onboarding", "Browser closed unexpectedly", -60_000, "a"),
      failedEntry("onboarding", "Browser closed unexpectedly", -120_000, "b"),
      failedEntry("onboarding", "Browser closed unexpectedly", -180_000, "c"),
    ];
    const out = detectFailurePattern(entries, { now });
    assert.equal(out.length, 1);
    const p = out[0] as FailurePattern;
    assert.equal(p.workflow, "onboarding");
    assert.equal(p.error, "Browser closed unexpectedly");
    assert.equal(p.count, 3);
    // firstTs should be the oldest (180s ago), lastTs the most recent (60s ago).
    assert.equal(p.firstTs, new Date(NOW_MS - 180_000).toISOString());
    assert.equal(p.lastTs, new Date(NOW_MS - 60_000).toISOString());
  });

  it("excludes failures older than the window", () => {
    const entries: TrackerEntry[] = [
      failedEntry("onboarding", "X", -60_000, "a"),
      failedEntry("onboarding", "X", -120_000, "b"),
      // 20 min ago — outside the default 10-min window.
      failedEntry("onboarding", "X", -20 * 60_000, "c"),
    ];
    const out = detectFailurePattern(entries, { now });
    assert.deepEqual(out, [], "only 2 in-window failures — under threshold");
  });

  it("respects a custom windowMs", () => {
    const entries: TrackerEntry[] = [
      failedEntry("onboarding", "X", -60_000, "a"),
      failedEntry("onboarding", "X", -120_000, "b"),
      failedEntry("onboarding", "X", -12 * 60_000, "c"),
    ];
    // 15-min window pulls the 12-min-ago entry in.
    const out = detectFailurePattern(entries, { now, windowMs: 15 * 60_000 });
    assert.equal(out.length, 1);
    assert.equal(out[0].count, 3);
  });

  it("respects a custom thresholdN", () => {
    const entries: TrackerEntry[] = [
      failedEntry("onboarding", "X", -60_000, "a"),
      failedEntry("onboarding", "X", -120_000, "b"),
    ];
    const out = detectFailurePattern(entries, { now, thresholdN: 2 });
    assert.equal(out.length, 1);
    assert.equal(out[0].count, 2);
  });

  it("does not merge different errors or different workflows", () => {
    const entries: TrackerEntry[] = [
      failedEntry("onboarding", "Duo timed out", -30_000, "a"),
      failedEntry("onboarding", "Duo timed out", -60_000, "b"),
      failedEntry("onboarding", "Browser closed unexpectedly", -90_000, "c"),
      failedEntry("separations", "Duo timed out", -120_000, "d"),
      failedEntry("separations", "Duo timed out", -150_000, "e"),
    ];
    // Each bucket has <3 failures — no patterns.
    const out = detectFailurePattern(entries, { now });
    assert.deepEqual(out, []);
  });

  it("produces one pattern per distinct (workflow, error) when multiple qualify", () => {
    const entries: TrackerEntry[] = [
      failedEntry("onboarding", "Duo timed out", -10_000, "a"),
      failedEntry("onboarding", "Duo timed out", -20_000, "b"),
      failedEntry("onboarding", "Duo timed out", -30_000, "c"),
      failedEntry("separations", "Browser closed unexpectedly", -40_000, "d"),
      failedEntry("separations", "Browser closed unexpectedly", -50_000, "e"),
      failedEntry("separations", "Browser closed unexpectedly", -60_000, "f"),
    ];
    const out = detectFailurePattern(entries, { now });
    assert.equal(out.length, 2);
    const workflows = out.map((p) => p.workflow).sort();
    assert.deepEqual(workflows, ["onboarding", "separations"]);
  });

  it("suppresses re-alert inside cooldown window", () => {
    const entries: TrackerEntry[] = [
      failedEntry("onboarding", "X", -10_000, "a"),
      failedEntry("onboarding", "X", -20_000, "b"),
      failedEntry("onboarding", "X", -30_000, "c"),
    ];
    const cooldownState = new Map<string, number>();
    const first = detectFailurePattern(entries, { now, cooldownState });
    assert.equal(first.length, 1, "first scan alerts");
    // Second scan immediately — still within cooldown, should be suppressed.
    const second = detectFailurePattern(entries, { now, cooldownState });
    assert.equal(second.length, 0, "second scan suppressed by cooldown");
  });

  it("re-alerts after cooldown expires", () => {
    const entries: TrackerEntry[] = [
      failedEntry("onboarding", "X", -10_000, "a"),
      failedEntry("onboarding", "X", -20_000, "b"),
      failedEntry("onboarding", "X", -30_000, "c"),
    ];
    const cooldownState = new Map<string, number>();
    const first = detectFailurePattern(entries, { now, cooldownState, cooldownMs: 60_000 });
    assert.equal(first.length, 1);
    // Jump "now" forward past the cooldown (not the window — failures stay fresh).
    const laterNow = () => NOW_MS + 120_000;
    // Rebuild the entries relative to the new now, so they're still in-window.
    const freshEntries: TrackerEntry[] = [
      {
        ...entries[0],
        timestamp: new Date(NOW_MS + 120_000 - 10_000).toISOString(),
      },
      {
        ...entries[1],
        timestamp: new Date(NOW_MS + 120_000 - 20_000).toISOString(),
      },
      {
        ...entries[2],
        timestamp: new Date(NOW_MS + 120_000 - 30_000).toISOString(),
      },
    ];
    const second = detectFailurePattern(freshEntries, {
      now: laterNow,
      cooldownState,
      cooldownMs: 60_000,
    });
    assert.equal(second.length, 1, "cooldown expired — re-alert allowed");
  });

  it("ignores non-failed entries and failed entries without an error message", () => {
    const entries: TrackerEntry[] = [
      { workflow: "onboarding", timestamp: new Date(NOW_MS - 10_000).toISOString(), id: "a", status: "done" },
      { workflow: "onboarding", timestamp: new Date(NOW_MS - 20_000).toISOString(), id: "b", status: "running" },
      // failed but no error field — detector treats this as ineligible.
      { workflow: "onboarding", timestamp: new Date(NOW_MS - 30_000).toISOString(), id: "c", status: "failed" },
    ];
    const out = detectFailurePattern(entries, { now, thresholdN: 1 });
    assert.deepEqual(out, []);
  });
});
