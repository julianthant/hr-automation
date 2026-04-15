import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, rmSync } from "fs";
import { trackEvent, readEntries, type TrackerEntry } from "../../../src/tracker/jsonl.js";

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
});
