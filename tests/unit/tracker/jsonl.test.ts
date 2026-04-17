import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, rmSync } from "fs";
import {
  trackEvent,
  readEntries,
  toTypedValue,
  type TrackerEntry,
} from "../../../src/tracker/jsonl.js";

const TEST_DIR = ".tracker-test";

describe("JSONL tracker", () => {
  beforeEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  it("writes and reads entries", () => {
    const entry: TrackerEntry = {
      workflow: "test",
      timestamp: new Date().toISOString(),
      id: "emp-001",
      status: "done",
      data: { name: "Test Employee" },
    };
    trackEvent(entry, TEST_DIR);
    const entries = readEntries("test", TEST_DIR);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].id, "emp-001");
    assert.equal(entries[0].status, "done");
  });

  it("appends multiple entries", () => {
    trackEvent({ workflow: "test", timestamp: "t1", id: "a", status: "running" }, TEST_DIR);
    trackEvent({ workflow: "test", timestamp: "t2", id: "b", status: "done" }, TEST_DIR);
    const entries = readEntries("test", TEST_DIR);
    assert.equal(entries.length, 2);
  });

  it("returns empty array for missing file", () => {
    const entries = readEntries("nonexistent", TEST_DIR);
    assert.deepEqual(entries, []);
  });

  it("reads old-shape entries without typedData (backward compat)", () => {
    // Entry written in the pre-subsystem-D format — no typedData.
    const entry: TrackerEntry = {
      workflow: "legacy",
      timestamp: "2026-01-01T00:00:00.000Z",
      id: "legacy-1",
      status: "done",
      data: { wage: "12.5", active: "true" },
    };
    trackEvent(entry, TEST_DIR);
    const [got] = readEntries("legacy", TEST_DIR);
    assert.equal(got.data?.wage, "12.5");
    assert.equal(got.typedData, undefined);
  });

  it("writes and reads entries with typedData alongside data", () => {
    const entry: TrackerEntry = {
      workflow: "rich",
      timestamp: "2026-01-01T00:00:00.000Z",
      id: "rich-1",
      status: "running",
      data: { wage: "12.5", active: "true", start: "2026-04-17T00:00:00.000Z" },
      typedData: {
        wage: { type: "number", value: "12.5" },
        active: { type: "boolean", value: "true" },
        start: { type: "date", value: "2026-04-17T00:00:00.000Z" },
      },
    };
    trackEvent(entry, TEST_DIR);
    const [got] = readEntries("rich", TEST_DIR);
    assert.deepEqual(got.typedData, {
      wage: { type: "number", value: "12.5" },
      active: { type: "boolean", value: "true" },
      start: { type: "date", value: "2026-04-17T00:00:00.000Z" },
    });
  });
});

describe("toTypedValue", () => {
  it("classifies Date as date", () => {
    const d = new Date("2026-04-17T12:34:56.000Z");
    assert.deepEqual(toTypedValue(d), { type: "date", value: "2026-04-17T12:34:56.000Z" });
  });

  it("classifies number", () => {
    assert.deepEqual(toTypedValue(42), { type: "number", value: "42" });
    assert.deepEqual(toTypedValue(3.14), { type: "number", value: "3.14" });
  });

  it("classifies boolean", () => {
    assert.deepEqual(toTypedValue(true), { type: "boolean", value: "true" });
    assert.deepEqual(toTypedValue(false), { type: "boolean", value: "false" });
  });

  it("classifies string", () => {
    assert.deepEqual(toTypedValue("hello"), { type: "string", value: "hello" });
  });

  it("classifies null + undefined as null type", () => {
    assert.deepEqual(toTypedValue(null), { type: "null", value: "" });
    assert.deepEqual(toTypedValue(undefined), { type: "null", value: "" });
  });

  it("collapses objects to JSON string", () => {
    assert.deepEqual(toTypedValue({ a: 1 }), { type: "string", value: '{"a":1}' });
    assert.deepEqual(toTypedValue([1, 2]), { type: "string", value: "[1,2]" });
  });
});
