import { describe, it, beforeEach } from "vitest";
import assert from "node:assert/strict";
import { appendFileSync, existsSync, rmSync } from "fs";
import { join } from "node:path";
import {
  appendLogEntry,
  readLogEntries,
  readLogEntriesForDate,
  dateLocal,
  __resetParseCacheForTests,
} from "../../../src/tracker/jsonl.js";

const TEST_DIR = "generated/.tracker-log-validator-test";

describe("isLogEntry — readLogEntries boundary validation", () => {
  beforeEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    __resetParseCacheForTests();
  });

  it("passes through valid log entries", () => {
    const date = dateLocal();
    appendLogEntry({ workflow: "wf", itemId: "id-1", level: "step", message: "started", ts: `${date}T10:00:00.000Z` }, TEST_DIR);
    appendLogEntry({ workflow: "wf", itemId: "id-1", level: "success", message: "done", ts: `${date}T10:00:01.000Z` }, TEST_DIR);

    const entries = readLogEntries("wf", undefined, TEST_DIR);
    assert.equal(entries.length, 2);
    assert.equal(entries[0].message, "started");
    assert.equal(entries[1].message, "done");
  });

  it("drops a malformed JSON line (missing level) without poisoning valid entries", () => {
    const date = dateLocal();
    appendLogEntry({ workflow: "wf", itemId: "id-1", level: "step", message: "before bad line", ts: `${date}T10:00:00.000Z` }, TEST_DIR);

    // Manually append a line missing the required `level` field.
    const logPath = join(TEST_DIR, `wf-${date}-logs.jsonl`);
    appendFileSync(logPath, JSON.stringify({ workflow: "wf", itemId: "id-1", message: "no level here", ts: `${date}T10:00:00.500Z` }) + "\n");

    appendLogEntry({ workflow: "wf", itemId: "id-1", level: "success", message: "after bad line", ts: `${date}T10:00:01.000Z` }, TEST_DIR);

    const entries = readLogEntries("wf", undefined, TEST_DIR);
    assert.equal(entries.length, 2);
    assert.equal(entries[0].message, "before bad line");
    assert.equal(entries[1].message, "after bad line");
  });

  it("drops a tracker-entry-shaped line that accidentally landed in a logs JSONL", () => {
    const date = dateLocal();
    appendLogEntry({ workflow: "wf", itemId: "id-1", level: "step", message: "real log", ts: `${date}T10:00:00.000Z` }, TEST_DIR);

    // Manually append a tracker entry (wrong shape for LogEntry — no itemId, no level, no message).
    const logPath = join(TEST_DIR, `wf-${date}-logs.jsonl`);
    appendFileSync(
      logPath,
      JSON.stringify({ workflow: "wf", id: "id-1", runId: "run-1", timestamp: `${date}T10:00:00.000Z`, status: "done", data: {} }) + "\n",
    );

    const entries = readLogEntries("wf", undefined, TEST_DIR);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].message, "real log");
  });

  it("drops lines with an invalid level value", () => {
    const date = dateLocal();
    appendLogEntry({ workflow: "wf", itemId: "id-1", level: "error", message: "good", ts: `${date}T10:00:00.000Z` }, TEST_DIR);
    const logPath = join(TEST_DIR, `wf-${date}-logs.jsonl`);
    appendFileSync(
      logPath,
      JSON.stringify({ workflow: "wf", itemId: "id-1", level: "unknown-level", message: "bad level", ts: `${date}T10:00:01.000Z` }) + "\n",
    );

    const entries = readLogEntries("wf", undefined, TEST_DIR);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].message, "good");
  });
});

describe("isLogEntry — readLogEntriesForDate boundary validation", () => {
  beforeEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    __resetParseCacheForTests();
  });

  it("drops malformed lines in dated log file", () => {
    const date = dateLocal();
    appendLogEntry({ workflow: "wf", itemId: "id-1", level: "step", message: "good", ts: `${date}T10:00:00.000Z` }, TEST_DIR);

    const logPath = join(TEST_DIR, `wf-${date}-logs.jsonl`);
    appendFileSync(logPath, JSON.stringify({ workflow: "wf", itemId: "id-1", message: "missing level", ts: `${date}T10:00:01.000Z` }) + "\n");

    const entries = readLogEntriesForDate("wf", undefined, date, TEST_DIR);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].message, "good");
  });
});
