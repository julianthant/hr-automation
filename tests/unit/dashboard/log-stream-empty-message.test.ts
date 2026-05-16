import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { buildLogStreamItemKey, emptyStreamMessage } from "../../../src/dashboard/components/log-panel/LogStream.js";

describe("emptyStreamMessage", () => {
  it("uses an events-specific empty state for the Events tab", () => {
    assert.equal(emptyStreamMessage("events"), "No run events for this row");
  });

  it("uses an explicit empty state for log tabs without implying logs are missing", () => {
    assert.equal(emptyStreamMessage(undefined), "No log entries for this row");
  });
});

describe("buildLogStreamItemKey", () => {
  it("uses log identity fields instead of render position", () => {
    const item = {
      kind: "log" as const,
      entry: {
        workflow: "ocr",
        itemId: "item-1",
        runId: "run-1",
        level: "step" as const,
        message: "processing",
        ts: "2026-05-15T12:00:00.000Z",
        count: 2,
      },
    };

    assert.equal(
      buildLogStreamItemKey(item),
      "log-item-1-run-1-2026-05-15T12:00:00.000Z-2",
    );
  });

  it("uses event identity fields instead of render position", () => {
    const item = {
      kind: "event" as const,
      entry: {
        type: "screenshot" as const,
        runId: "run-1",
        currentItemId: "item-1",
        timestamp: "2026-05-15T12:00:00.000Z",
        screenshotKind: "form" as const,
        screenshotLabel: "after-submit",
      },
    };

    assert.equal(
      buildLogStreamItemKey(item),
      "evt-screenshot-run-1-item-1-2026-05-15T12:00:00.000Z-form-after-submit",
    );
  });
});
