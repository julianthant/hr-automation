import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { emptyStreamMessage } from "../../../src/dashboard/components/log-panel/LogStream.js";

describe("emptyStreamMessage", () => {
  it("uses an events-specific empty state for the Events tab", () => {
    assert.equal(emptyStreamMessage("events"), "No run events for this row");
  });

  it("uses an explicit empty state for log tabs without implying logs are missing", () => {
    assert.equal(emptyStreamMessage(undefined), "No log entries for this row");
  });
});
