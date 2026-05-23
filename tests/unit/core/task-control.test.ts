import { describe, it } from "vitest";
import assert from "node:assert/strict";
import {
  CONTROL_ACTIONS,
  describeControlAction,
} from "../../../src/core/task-control.js";

describe("task control vocabulary", () => {
  it("defines the exact operator controls used by later SQLite phases", () => {
    assert.deepEqual(CONTROL_ACTIONS, [
      "cancel-queued",
      "cancel-current",
      "drain-worker",
      "stop-worker",
      "kill-browser",
      "force-kill-worker",
    ]);
  });

  it("describes cancel queued without browser disruption", () => {
    assert.equal(describeControlAction("cancel-queued").browserDisruption, false);
  });
});
