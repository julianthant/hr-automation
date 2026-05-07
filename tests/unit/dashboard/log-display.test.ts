import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  filterLogsForDebugVisibility,
  isDebugLog,
} from "../../../src/dashboard/components/log-panel/log-display";

describe("dashboard log display filtering", () => {
  it("hides debug logs by default while preserving operator-facing logs", () => {
    const logs = [
      { level: "step", message: "starting" },
      { level: "debug", message: "raw selector probe" },
      { level: "warn", message: "selector fallback triggered: ucpath.x" },
    ];

    assert.deepEqual(filterLogsForDebugVisibility(logs, false), [
      { level: "step", message: "starting" },
      { level: "warn", message: "selector fallback triggered: ucpath.x" },
    ]);
  });

  it("shows debug logs when the operator enables the debug toggle", () => {
    const logs = [
      { level: "debug", message: "raw selector probe" },
      { level: "error", message: "failed" },
    ];

    assert.deepEqual(filterLogsForDebugVisibility(logs, true), logs);
  });

  it("classifies debug by structured level instead of message text", () => {
    assert.equal(isDebugLog({ level: "debug", message: "anything" }), true);
    assert.equal(isDebugLog({ level: "warn", message: "debug details are available" }), false);
  });
});
