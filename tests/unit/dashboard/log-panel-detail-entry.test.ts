import { test } from "vitest";
import assert from "node:assert/strict";

import { resolveDetailEntry } from "../../../src/dashboard/components/log-panel/LogPanel.js";
import type { TrackerEntry } from "../../../src/dashboard/components/shared/types.js";

function entry(overrides: Partial<TrackerEntry> = {}): TrackerEntry {
  return {
    workflow: "person-lookup",
    timestamp: "2026-06-06T18:00:00.000Z",
    id: "item-1",
    runId: "run-2",
    status: "done",
    data: { archetype: "single", __name: "Live Person" },
    typedData: { name: "Live Person" },
    ...overrides,
  } as unknown as TrackerEntry;
}

test("the live run always renders the (live) entry, regardless of activeRunData", () => {
  const e = entry();
  assert.equal(resolveDetailEntry(e, true, undefined), e);
  assert.equal(resolveDetailEntry(e, true, { __name: "Ignored" }), e);
});

test("a historical run with its own recorded data renders that run's data, with typedData cleared", () => {
  const e = entry();
  const result = resolveDetailEntry(e, false, { __name: "Historical Person" });
  assert.ok(result);
  assert.deepEqual(result.data, { __name: "Historical Person" });
  assert.equal(result.typedData, undefined);
  // Everything else about the entry is preserved.
  assert.equal(result.id, e.id);
  assert.equal(result.runId, e.runId);
});

test("FAIL LOUD: a historical run with no recorded data returns null — never the live entry's data", () => {
  const e = entry();
  assert.equal(resolveDetailEntry(e, false, undefined), null);
});
