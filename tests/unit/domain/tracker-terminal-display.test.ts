import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  isTerminalNotFoundEntry,
  queueStatusDisplayLabel,
  TERMINAL_NOT_FOUND_LABEL,
} from "../../../src/domain/tracker-terminal-display.js";

describe("tracker-terminal-display", () => {
  it("eid-lookup name path marks emplId Not found", () => {
    assert.equal(
      isTerminalNotFoundEntry({
        workflow: "eid-lookup",
        status: "done",
        data: { emplId: "Not found", searchName: "Nobody, Jane" },
      }),
      true,
    );
    assert.equal(
      queueStatusDisplayLabel({
        workflow: "eid-lookup",
        status: "done",
        data: { emplId: "Not found" },
      }),
      TERMINAL_NOT_FOUND_LABEL,
    );
  });

  it("eid-lookup EID path marks hrStatus Not found", () => {
    assert.equal(
      isTerminalNotFoundEntry({
        workflow: "eid-lookup",
        status: "done",
        data: { emplId: "10873698", hrStatus: "Not found" },
      }),
      true,
    );
  });

  it("active-check uses activeStatus not-found or hrStatus", () => {
    assert.equal(
      isTerminalNotFoundEntry({
        workflow: "active-check",
        status: "done",
        data: { activeStatus: "not-found", hrStatus: "Not found" },
      }),
      true,
    );
  });

  it("does not fire on other workflows or non-done status", () => {
    assert.equal(isTerminalNotFoundEntry({ workflow: "onboarding", status: "done", data: {} }), false);
    assert.equal(
      isTerminalNotFoundEntry({
        workflow: "eid-lookup",
        status: "running",
        data: { emplId: "Not found" },
      }),
      false,
    );
  });
});
