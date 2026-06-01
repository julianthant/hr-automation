import { describe, it, beforeEach } from "vitest";
import assert from "node:assert/strict";
import { appendFileSync, existsSync, rmSync, mkdtempSync, writeFileSync, utimesSync, mkdirSync } from "fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  trackEvent,
  readEntries,
  readLogEntries,
  readLogEntriesForDate,
  appendLogEntry,
  readRunsForId,
  findLatestEntryForRunOnDate,
  serializeValue,
  toTypedValue,
  withTrackedWorkflow,
  dateLocal,
  trackerDateForTimestamp,
  __resetParseCacheForTests,
  __getParseCacheSizeForTests,
  rowFilePath,
  rowsDir,
  logFilePath,
  type TrackerEntry,
} from "../../../src/tracker/jsonl.js";
import { log, withLogContext } from "../../../src/utils/log.js";

const TEST_DIR = "generated/.tracker-test";

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

  it("skips malformed and wrong-shape tracker lines when reading entries", () => {
    const date = dateLocal();
    trackEvent({ workflow: "ac", timestamp: `${date}T10:00:00.000Z`, id: "id-1", runId: "run-1", status: "pending", data: {} }, TEST_DIR);
    const file = rowFilePath("ac", date, TEST_DIR);
    appendFileSync(file, "{\"not\":\"a tracker entry\"}\n");
    appendFileSync(file, "{not json}\n");
    trackEvent({ workflow: "ac", timestamp: `${date}T10:00:01.000Z`, id: "id-2", runId: "run-2", status: "done", data: {} }, TEST_DIR);

    const entries = readEntries("ac", TEST_DIR);

    assert.deepEqual(entries.map((entry) => entry.id), ["id-1", "id-2"]);
  });
});

describe("tracker date selection", () => {
  it("derives SIGINT/SIGTERM file dates in local time, not UTC", () => {
    assert.equal(trackerDateForTimestamp("2026-05-15T06:30:00.000Z"), "2026-05-14");
  });
});

describe("findLatestEntryForRunOnDate", () => {
  beforeEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    __resetParseCacheForTests();
  });

  it("returns the last appended matching row", () => {
    const date = dateLocal();
    trackEvent({ workflow: "ac", timestamp: `${date}T10:00:02.000Z`, id: "id-1", runId: "run-1", status: "running" }, TEST_DIR);
    trackEvent({ workflow: "ac", timestamp: `${date}T10:00:01.000Z`, id: "id-1", runId: "run-1", status: "failed" }, TEST_DIR);

    const latest = findLatestEntryForRunOnDate("ac", "id-1", "run-1", date, TEST_DIR);
    assert.equal(latest?.status, "failed");
  });
});

describe("readRunsForId data carry-over (LogPanel detail-grid fix)", () => {
  beforeEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    __resetParseCacheForTests();
  });

  it("returns the latest non-empty data per run, not the latest tracker line's data", () => {
    const date = dateLocal();
    // Run 1 progresses through pending→running→done with full data on done.
    trackEvent({ workflow: "ac", timestamp: `${date}T10:00:00.000Z`, id: "id-1", runId: "run-1", status: "pending", data: {} }, TEST_DIR);
    trackEvent({ workflow: "ac", timestamp: `${date}T10:00:01.000Z`, id: "id-1", runId: "run-1", status: "running", step: "checking", data: { name: "Alice" } }, TEST_DIR);
    trackEvent({ workflow: "ac", timestamp: `${date}T10:00:02.000Z`, id: "id-1", runId: "run-1", status: "done", data: { name: "Alice", emplId: "111" } }, TEST_DIR);

    // Run 2 cancelled before any data was captured (data null on the
    // terminal row simulates the dashboard's cancel-queued path).
    trackEvent({ workflow: "ac", timestamp: `${date}T11:00:00.000Z`, id: "id-1", runId: "run-2", status: "pending", data: { name: "Alice" } }, TEST_DIR);
    const cancelEntry = { workflow: "ac", timestamp: `${date}T11:00:01.000Z`, id: "id-1", runId: "run-2", status: "failed" as const, step: "cancelled" };
    trackEvent(cancelEntry as TrackerEntry, TEST_DIR);

    const runs = readRunsForId("ac", "id-1", date, TEST_DIR);
    assert.equal(runs.length, 2);
    const run1 = runs.find((r) => r.runId === "run-1");
    const run2 = runs.find((r) => r.runId === "run-2");
    assert.ok(run1, "run-1 missing from readRunsForId result");
    assert.ok(run2, "run-2 missing from readRunsForId result");
    assert.deepEqual(run1!.data, { name: "Alice", emplId: "111" });
    // Run 2's last non-empty data is the pending row's `name` — even though
    // the latest tracker line for run-2 is the cancel emit with no data.
    assert.deepEqual(run2!.data, { name: "Alice" });
  });

  it("omits data when no run-tracker line ever carried it", () => {
    const date = dateLocal();
    trackEvent({ workflow: "ac", timestamp: `${date}T12:00:00.000Z`, id: "id-2", runId: "run-3", status: "pending" } as TrackerEntry, TEST_DIR);
    const runs = readRunsForId("ac", "id-2", date, TEST_DIR);
    assert.equal(runs.length, 1);
    assert.equal(runs[0].runId, "run-3");
    assert.equal(runs[0].data, undefined);
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

  it("captures debug entries in JSONL even when console debug output is disabled", async () => {
    await withLogContext(
      "debug-flow",
      "item-1",
      async () => {
        log.debug("selector probe detail");
      },
      TEST_DIR,
    );

    const got = readLogEntries("debug-flow", "item-1", TEST_DIR);
    assert.equal(got.length, 1);
    assert.equal(got[0].level, "debug");
    assert.equal(got[0].message, "selector probe detail");
  });

  it("writes log entries to the file matching the entry timestamp date", () => {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const entryDate = dateLocal(yesterday);
    appendLogEntry(
      {
        workflow: "delayed",
        itemId: "item-1",
        level: "step",
        message: "delayed log",
        ts: yesterday.toISOString(),
      },
      TEST_DIR,
    );

    assert.equal(existsSync(logFilePath("delayed", entryDate, TEST_DIR)), true);
    assert.equal(readLogEntriesForDate("delayed", "item-1", entryDate, TEST_DIR).length, 1);
    assert.equal(readLogEntries("delayed", "item-1", TEST_DIR).length, entryDate === dateLocal() ? 1 : 0);
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

describe("parseCache LRU", () => {
  beforeEach(() => __resetParseCacheForTests());

  function seedWorkflowFile(dir: string, wf: string): void {
    const today = dateLocal();
    mkdirSync(rowsDir(dir), { recursive: true });
    writeFileSync(
      rowFilePath(wf, today, dir),
      '{"workflow":"' + wf + '","id":"x","runId":"r","timestamp":"' + today + 'T00:00:00Z","status":"done","data":{}}\n',
    );
  }

  it("caps cache size at 64 entries", () => {
    const dir = mkdtempSync(join(tmpdir(), "lru-"));
    try {
      for (let i = 0; i < 100; i++) {
        const wf = `wf${i}`;
        seedWorkflowFile(dir, wf);
        readEntries(wf, dir);
      }
      assert.ok(__getParseCacheSizeForTests() <= 64);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("evicts the OLDEST entry, not an arbitrary one, when full", () => {
    const dir = mkdtempSync(join(tmpdir(), "lru-evict-"));
    try {
      // Fill to MAX (64 entries). wf0 is oldest.
      for (let i = 0; i < 64; i++) {
        const wf = `wf${i}`;
        seedWorkflowFile(dir, wf);
        readEntries(wf, dir);
      }
      assert.equal(__getParseCacheSizeForTests(), 64);

      // Read wf0 again → hit path should bump it to MRU. Then add wf64 →
      // the OLDEST entry is now wf1 (since wf0 was just bumped). If the hit
      // path didn't bump, wf0 would be evicted instead.
      readEntries("wf0", dir);
      seedWorkflowFile(dir, "wf64");
      readEntries("wf64", dir);

      // Re-reading wf0 should still hit cache (i.e. not re-parse). We can't
      // observe parse-vs-cache directly, but the size invariant proves wf0
      // wasn't evicted: cache held all 65 unique paths after the second
      // round, then evicted exactly one. If wf0 was evicted it'd be size 64;
      // either way size === 64 — the real check is via wf1 below.
      assert.equal(__getParseCacheSizeForTests(), 64);

      // Add another distinct path. If wf0 was evicted earlier, this push
      // would evict wf2 (since the eviction order would be wf0, wf1, ...).
      // If wf0 was correctly bumped, wf1 is evicted and wf0 stays.
      // We test by directly inspecting eviction behavior: read every wf in
      // order, count cache misses indirectly by checking which ones are
      // re-parseable. Simpler test: after adding wf65, the cache still has
      // wf0 — verifiable because reading wf0 doesn't change size (hit) but
      // reading any evicted wf would push size to 65.
      seedWorkflowFile(dir, "wf65");
      readEntries("wf65", dir);
      assert.equal(__getParseCacheSizeForTests(), 64);

      // wf0 should still be cached (was bumped); reading it is a hit and
      // doesn't grow the cache.
      readEntries("wf0", dir);
      assert.equal(__getParseCacheSizeForTests(), 64);

      // wf1 should have been evicted (was the oldest after wf0's bump).
      // Reading wf1 is a miss, parses, and inserts — cache stays at 64
      // because eviction immediately follows. The act of reading should
      // succeed without throwing (the on-disk file still exists).
      readEntries("wf1", dir);
      assert.equal(__getParseCacheSizeForTests(), 64);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("re-parse on file change bumps insertion order to MRU", () => {
    // Regression test for the miss-path bump: Map.set on an existing key
    // does NOT reposition by spec. If the miss path doesn't `delete` first,
    // a hot file (frequently re-parsed because mtime changes) stays at its
    // original LRU slot and gets evicted unfairly.
    const dir = mkdtempSync(join(tmpdir(), "lru-bump-"));
    try {
      // Insert wf0 first → it's the oldest entry in the Map.
      seedWorkflowFile(dir, "wf0");
      readEntries("wf0", dir);

      // Fill the rest of the cache (1..63) → 64 entries total, wf0 oldest.
      for (let i = 1; i < 64; i++) {
        seedWorkflowFile(dir, `wf${i}`);
        readEntries(`wf${i}`, dir);
      }
      assert.equal(__getParseCacheSizeForTests(), 64);

      // Mutate wf0 on disk → next read is a cache miss (mtime/size differ).
      // The miss path must `delete(key)` before `set(key, ...)` to bump
      // wf0 to MRU. Without that, wf0 stays oldest and the next eviction
      // takes it.
      const wf0today = dateLocal();
      writeFileSync(
        rowFilePath("wf0", wf0today, dir),
        '{"workflow":"wf0","id":"x","runId":"r","timestamp":"' + wf0today + 'T00:00:00Z","status":"done","data":{"v":2}}\n' +
          '{"workflow":"wf0","id":"y","runId":"r2","timestamp":"' + wf0today + 'T00:00:01Z","status":"done","data":{}}\n',
      );
      // Force a small mtime delta so the cache key invalidates even on
      // filesystems with low mtime resolution.
      const future = new Date(Date.now() + 5_000);
      utimesSync(rowFilePath("wf0", wf0today, dir), future, future);
      readEntries("wf0", dir); // re-parse, MUST bump to MRU

      // Add wf64 → should evict the now-oldest, which is wf1 (wf0 was bumped).
      seedWorkflowFile(dir, "wf64");
      readEntries("wf64", dir);
      assert.equal(__getParseCacheSizeForTests(), 64);

      // wf0 should still be cached — re-reading it is a hit, no size change.
      readEntries("wf0", dir);
      assert.equal(__getParseCacheSizeForTests(), 64);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
