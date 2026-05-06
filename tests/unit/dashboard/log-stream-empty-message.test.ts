import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { emptyStreamMessage } from "../../../src/dashboard/components/LogStream.js";

describe("emptyStreamMessage", () => {
  it("uses an events-specific empty state for the Events tab", () => {
    assert.equal(emptyStreamMessage("events"), "No run events for this row");
  });

  it("keeps the log empty state for log tabs", () => {
    assert.equal(emptyStreamMessage(undefined), "No logs yet");
  });
});
