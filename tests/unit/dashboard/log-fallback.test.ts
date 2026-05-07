import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { deriveTrackerFallbackLog } from "../../../src/dashboard/components/log-panel/log-fallback.js";
import type { TrackerEntry } from "../../../src/dashboard/components/shared/types.js";

describe("deriveTrackerFallbackLog", () => {
  it("turns a terminal cancelled tracker row into an operator-visible log line", () => {
    const entry: TrackerEntry = {
      workflow: "active-check",
      id: "99999999",
      runId: "run-cancelled",
      status: "failed",
      step: "cancelled",
      error: "cancelled by user from dashboard",
      timestamp: "2026-05-06T00:38:40.446Z",
    };

    const fallback = deriveTrackerFallbackLog(entry, "run-cancelled");

    assert.ok(fallback);
    assert.equal(fallback.workflow, "active-check");
    assert.equal(fallback.itemId, "99999999");
    assert.equal(fallback.runId, "run-cancelled");
    assert.equal(fallback.level, "error");
    assert.equal(fallback.count, 1);
    assert.match(fallback.message, /Tracker state: failed/);
    assert.match(fallback.message, /cancelled by user from dashboard/);
  });

  it("returns null when there is no selected tracker entry", () => {
    assert.equal(deriveTrackerFallbackLog(null, null), null);
  });
});
