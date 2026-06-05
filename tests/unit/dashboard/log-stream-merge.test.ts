import { describe, it } from "vitest";
import assert from "node:assert/strict";

import { mergeDisplayItems } from "../../../src/dashboard/components/log-panel/LogStream.js";
import type { LogEntry, RunEvent } from "../../../src/dashboard/components/shared/types.js";

// mergeDisplayItems builds the "all" tab's interleaved log + event stream.
// `step_change` events are dropped from the merge because every ctx.step
// transition already renders here as the richer `Phase: X` level-"step" log
// line — rendering the bare step_change event line too would double up each
// transition. The events still drive session state and remain in the dedicated
// Events tab (which bypasses this merge).
function log(partial: Partial<LogEntry> & { ts: string }): LogEntry & { count: number } {
  return {
    workflow: "onboarding",
    itemId: "alice@example.com",
    runId: "run-1",
    level: "step",
    message: "Phase: extraction",
    count: 1,
    ...partial,
  };
}

function event(partial: Partial<RunEvent> & { type: RunEvent["type"]; timestamp: string }): RunEvent {
  return { runId: "run-1", ...partial };
}

describe("mergeDisplayItems", () => {
  it("drops step_change events from the merged stream", () => {
    const merged = mergeDisplayItems(
      [log({ ts: "2026-05-15T12:00:00.000Z", message: "Phase: extraction" })],
      [event({ type: "step_change", timestamp: "2026-05-15T12:00:00.001Z", currentStep: "extraction" })],
    );
    assert.equal(merged.length, 1);
    assert.equal(merged[0]?.kind, "log");
  });

  it("keeps non-step_change events (e.g. screenshot, auth) in the merge", () => {
    const merged = mergeDisplayItems(
      [log({ ts: "2026-05-15T12:00:00.000Z" })],
      [
        event({ type: "step_change", timestamp: "2026-05-15T12:00:00.001Z", currentStep: "extraction" }),
        event({ type: "auth_complete", timestamp: "2026-05-15T12:00:01.000Z", system: "ucpath" }),
      ],
    );
    const kinds = merged.map((m) => (m.kind === "event" ? `event:${m.entry.type}` : "log"));
    assert.deepEqual(kinds, ["log", "event:auth_complete"]);
  });

  it("preserves chronological interleaving of the surviving items", () => {
    const merged = mergeDisplayItems(
      [
        log({ ts: "2026-05-15T12:00:00.000Z" }),
        log({ ts: "2026-05-15T12:00:02.000Z", message: "Phase done: extraction" }),
      ],
      [event({ type: "screenshot", timestamp: "2026-05-15T12:00:01.000Z", screenshotKind: "form" })],
    );
    assert.deepEqual(
      merged.map((m) => (m.kind === "event" ? "event" : "log")),
      ["log", "event", "log"],
    );
  });
});
