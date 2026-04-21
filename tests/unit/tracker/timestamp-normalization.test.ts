import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getEventSortKey } from "../../../src/tracker/dashboard.js";

describe("getEventSortKey", () => {
  it("returns ISO timestamp when present", () => {
    const key = getEventSortKey({ type: "workflow_start", timestamp: "2026-04-20T10:00:00.000Z" } as never);
    assert.strictEqual(key, "2026-04-20T10:00:00.000Z");
  });

  it("falls back to ts (numeric) converted to ISO when timestamp missing", () => {
    // 1776722504377 ms = 2026-04-20T22:01:44.377Z
    const key = getEventSortKey({ type: "screenshot", ts: 1776722504377 } as never);
    assert.strictEqual(key, "2026-04-20T22:01:44.377Z");
  });

  it("returns empty string when neither timestamp nor ts is present", () => {
    const key = getEventSortKey({ type: "unknown" } as never);
    assert.strictEqual(key, "");
  });
});
