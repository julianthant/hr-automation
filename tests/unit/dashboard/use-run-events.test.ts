import { test } from "node:test";
import assert from "node:assert/strict";

import {
  appendCappedRunEvents,
  capRunEventWindow,
  RAW_EVENTS_CAP,
} from "../../../src/dashboard/components/hooks/useRunEvents.js";
import type { RunEvent } from "../../../src/dashboard/components/shared/types.js";

function eventAt(i: number): RunEvent {
  return {
    type: "step_change",
    runId: "item-1#1",
    step: `step-${i}`,
    timestamp: `2026-05-14T10:00:${String(i % 60).padStart(2, "0")}.000Z`,
  };
}

test("capRunEventWindow retains only the newest raw event window", () => {
  const events = Array.from({ length: RAW_EVENTS_CAP + 3 }, (_, i) => eventAt(i));

  const capped = capRunEventWindow(events);

  assert.equal(capped.length, RAW_EVENTS_CAP);
  assert.equal(capped[0]?.step, "step-3");
  assert.equal(capped.at(-1)?.step, `step-${RAW_EVENTS_CAP + 2}`);
});

test("appendCappedRunEvents caps after merging SSE deltas", () => {
  const prev = Array.from({ length: RAW_EVENTS_CAP - 1 }, (_, i) => eventAt(i));
  const next = [eventAt(RAW_EVENTS_CAP), eventAt(RAW_EVENTS_CAP + 1)];

  const capped = appendCappedRunEvents(prev, next);

  assert.equal(capped.length, RAW_EVENTS_CAP);
  assert.equal(capped[0]?.step, "step-1");
  assert.equal(capped.at(-1)?.step, `step-${RAW_EVENTS_CAP + 1}`);
});
