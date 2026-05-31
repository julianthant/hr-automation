import { describe, it } from "vitest";
import assert from "node:assert/strict";

import {
  isTerminalNotFoundEntry,
  queueStatusDisplayLabel,
  TERMINAL_NOT_FOUND_LABEL,
} from "../../../src/domain/tracker-terminal-display.js";

describe("tracker-terminal-display", () => {
  it("person-lookup marks activeStatus not-found", () => {
    assert.equal(
      isTerminalNotFoundEntry({
        workflow: "person-lookup",
        status: "done",
        data: { activeStatus: "not-found", searchName: "Nobody, Jane" },
      }),
      true,
    );
    assert.equal(
      queueStatusDisplayLabel({
        workflow: "person-lookup",
        status: "done",
        data: { activeStatus: "not-found" },
      }),
      TERMINAL_NOT_FOUND_LABEL,
    );
  });

  it("does not fire on other workflows or non-done status", () => {
    assert.equal(isTerminalNotFoundEntry({ workflow: "onboarding", status: "done", data: {} }), false);
    assert.equal(
      isTerminalNotFoundEntry({
        workflow: "person-lookup",
        status: "running",
        data: { activeStatus: "not-found" },
      }),
      false,
    );
  });
});
