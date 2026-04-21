import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, rmSync } from "fs";
import {
  trackEvent,
  readEntries,
  readLogEntries,
  appendLogEntry,
  serializeValue,
  toTypedValue,
  withTrackedWorkflow,
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

describe("serializeValue PII pass-through (redaction disabled)", () => {
  it("passes ssn values through unchanged when the key is 'ssn'", () => {
    assert.equal(serializeValue("123-45-6789", "ssn"), "123-45-6789");
    assert.equal(serializeValue("123456789", "ssn"), "123456789");
  });

  it("passes dob values (MM/DD/YYYY) through unchanged when the key is 'dob'", () => {
    assert.equal(serializeValue("01/15/1992", "dob"), "01/15/1992");
  });

  it("passes dob values through unchanged when the key is 'dateOfBirth' or 'birthdate'", () => {
    assert.equal(serializeValue("01/15/1992", "dateOfBirth"), "01/15/1992");
    assert.equal(serializeValue("1992-01-15", "birthdate"), "1992-01-15");
  });

  it("does not mask values for other keys (no blanket redaction)", () => {
    // effectiveDate is a legitimate YYYY-MM-DD that must round-trip intact.
    assert.equal(
      serializeValue("2026-04-17", "effectiveDate"),
      "2026-04-17"
    );
    assert.equal(serializeValue("12.5", "wage"), "12.5");
  });

  it("is a no-op when no key is provided (legacy calls)", () => {
    assert.equal(serializeValue("123-45-6789"), "123-45-6789");
  });

  it("passes a Date under a DOB key through as its ISO date", () => {
    const dob = new Date("1992-01-15T00:00:00.000Z");
    assert.equal(serializeValue(dob, "dob"), "1992-01-15");
  });
});

describe("appendLogEntry PII pass-through (redaction disabled)", () => {
  beforeEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  it("preserves SSN-shaped substrings in log messages", () => {
    appendLogEntry(
      {
        workflow: "scrub",
        itemId: "x",
        level: "error",
        message: "failed: SSN 123-45-6789 not found",
        ts: new Date().toISOString(),
      },
      TEST_DIR
    );
    const got = readLogEntries("scrub", undefined, TEST_DIR);
    assert.equal(got.length, 1);
    assert.equal(got[0].message, "failed: SSN 123-45-6789 not found");
  });

  it("preserves DOB-shaped substrings in log messages", () => {
    appendLogEntry(
      {
        workflow: "scrub2",
        itemId: "x",
        level: "error",
        message: "DOB 01/15/1992 didn't validate",
        ts: new Date().toISOString(),
      },
      TEST_DIR
    );
    const got = readLogEntries("scrub2", undefined, TEST_DIR);
    assert.equal(got[0].message, "DOB 01/15/1992 didn't validate");
  });
});

describe("withTrackedWorkflow preserves PII via updateData (redaction disabled)", () => {
  beforeEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  it("stores raw SSN / DOB in the entry data field (pass-through)", async () => {
    await withTrackedWorkflow(
      "pii-flow",
      "emp-007",
      async (_setStep: (s: string) => void, updateData: (d: Record<string, unknown>) => void) => {
        updateData({ ssn: "123-45-6789", dob: "01/15/1992", name: "Jane" });
      },
      { dir: TEST_DIR }
    );
    const entries = readEntries("pii-flow", TEST_DIR);
    // last entry is the "done" emit with merged data
    const last = entries[entries.length - 1];
    assert.equal(last.data?.ssn, "123-45-6789");
    assert.equal(last.data?.dob, "01/15/1992");
    assert.equal(last.data?.name, "Jane");
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
