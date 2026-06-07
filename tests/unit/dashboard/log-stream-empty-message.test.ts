import { describe, it } from "vitest";
import assert from "node:assert/strict";

import { buildLogStreamItemKey, emptyStreamMessage, parseInitialTab } from "../../../src/dashboard/components/log-panel/LogStream.js";

describe("parseInitialTab", () => {
  it("defaults to the Logs surface with the All category", () => {
    assert.deepEqual(parseInitialTab(undefined), { surface: "logs", category: "all" });
  });

  it("maps surface deep-links onto the surface axis", () => {
    assert.deepEqual(parseInitialTab("preview"), { surface: "preview", category: "all" });
    assert.deepEqual(parseInitialTab("screenshots"), { surface: "screenshots", category: "all" });
    assert.deepEqual(parseInitialTab("edit-data"), { surface: "edit-data", category: "all" });
  });

  it("maps category deep-links (incl. Events) onto Logs + the category axis", () => {
    assert.deepEqual(parseInitialTab("events"), { surface: "logs", category: "events" });
    assert.deepEqual(parseInitialTab("errors"), { surface: "logs", category: "errors" });
    assert.deepEqual(parseInitialTab("debug"), { surface: "logs", category: "debug" });
  });

  it("falls back to Logs + All for an unknown tab key", () => {
    assert.deepEqual(parseInitialTab("nonsense"), { surface: "logs", category: "all" });
  });
});

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
