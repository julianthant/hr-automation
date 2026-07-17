import { test, vi } from "vitest";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout } from "node:timers/promises";

import {
  appendLogEntry,
  dateLocal,
  getLogsJsonlPathForDate,
  trackEvent,
  type LogEntry,
} from "../../../../../src/tracker/jsonl.js";
import { emitSessionEvent, type SessionEvent } from "../../../../../src/tracker/session-events.js";
import {
  logsTopic,
  makeDeltaTopic,
  makeSnapshotTopic,
  runEventsTopic,
} from "../../../../../src/tracker/dashboard/hono/topics-emitters.js";
import { closeStateDbForTests, openStateDb } from "../../../../../src/tracker/state/db.js";

function tmpTracker(): string {
  return mkdtempSync(join(tmpdir(), "topics-emitters-"));
}

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
}

test("logsTopic uses SQLite projection when ready", async () => {
  const dir = tmpTracker();
  try {
    const db = openStateDb(dir);
    appendLogEntry({
      workflow: "work-study",
      itemId: "10000001",
      runId: "run-a",
      level: "step",
      message: "Filled comp rate",
      ts: "2026-05-04T20:00:00.000Z",
    }, dir);
    appendLogEntry({
      workflow: "work-study",
      itemId: "10000001",
      runId: "run-b",
      level: "error",
      message: "Different run",
      ts: "2026-05-04T20:00:01.000Z",
    }, dir);

    rmSync(getLogsJsonlPathForDate("work-study", dir, "2026-05-04"), { force: true });

    const firstPayload = Promise.withResolvers<LogEntry[]>();
    const stop = logsTopic(
      { workflow: "work-study", id: "10000001", runId: "run-a", date: "2026-05-04" },
      (data) => firstPayload.resolve(data as LogEntry[]),
      { dir, stateDb: db, projectionReady: true },
    );
    try {
      const payload = await Promise.race([
        firstPayload.promise,
        setTimeout(250, [] as LogEntry[]),
      ]);
      assert.deepEqual(payload.map((entry) => entry.message), ["Filled comp rate"]);
      assert.equal(payload[0].runId, "run-a");
    } finally {
      stop();
    }
  } finally {
    closeStateDbForTests(dir);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runEventsTopic uses SQLite tracker rows for workflowInstance attribution", async () => {
  const dir = tmpTracker();
  try {
    const db = openStateDb(dir);
    const date = dateLocal();
    const runStart = new Date(Date.now() - 1_000).toISOString();
    trackEvent({
      workflow: "work-study",
      timestamp: runStart,
      id: "10000001",
      runId: "run-a",
      status: "running",
      step: "transaction",
      data: { instance: "Work Study 1" },
    }, dir);
    emitSessionEvent({
      type: "auth_start",
      workflowInstance: "Work Study 1",
      system: "ucpath",
    }, dir);

    rmSync(join(dir, `work-study-${date}.jsonl`), { force: true });

    const firstPayload = Promise.withResolvers<SessionEvent[]>();
    const stop = runEventsTopic(
      { workflow: "work-study", runId: "run-a", date },
      (data) => firstPayload.resolve(data as SessionEvent[]),
      { dir, stateDb: db, projectionReady: true },
    );
    try {
      const payload = await Promise.race([
        firstPayload.promise,
        setTimeout(250, [] as SessionEvent[]),
      ]);
      assert.deepEqual(payload.map((event) => event.type), ["auth_start"]);
      assert.equal(payload[0].workflowInstance, "Work Study 1");
    } finally {
      stop();
    }
  } finally {
    closeStateDbForTests(dir);
    rmSync(dir, { recursive: true, force: true });
  }
});

// The duplicate-tails bug: a fetcher that is NOT strictly append-only (run-events
// folds in runId-less events into the SORTED MIDDLE; the logs projection can make
// equal-ms rows visible out of order). Positional `slice(sentCount)` re-emits the
// suffix after the inserted entry; the client appends it → the tail duplicates.
test("makeDeltaTopic identity delta does not re-send the suffix on a mid-array insert", async () => {
  vi.useFakeTimers();
  try {
    let current: Array<{ id: string }> = [{ id: "a" }, { id: "b" }, { id: "c" }];
    const sends: Array<Array<{ id: string }>> = [];
    const stop = makeDeltaTopic<{ id: string }>(
      () => current,
      (data) => sends.push(data),
      500,
      (e) => e.id,
    );
    try {
      await flushMicrotasks(); // immediate first tick
      assert.deepEqual(sends, [[{ id: "a" }, { id: "b" }, { id: "c" }]]);

      // `x` lands BETWEEN already-sent `a` and `b` (sorted-middle insertion).
      current = [{ id: "a" }, { id: "x" }, { id: "b" }, { id: "c" }];
      await vi.advanceTimersByTimeAsync(500);
      assert.equal(sends.length, 2);
      assert.deepEqual(sends[1], [{ id: "x" }], "only the new entry, not the b/c suffix again");

      // A steady tick with no new entries sends nothing.
      await vi.advanceTimersByTimeAsync(500);
      assert.equal(sends.length, 2, "no empty/duplicate batch when nothing changed");
    } finally {
      stop();
    }
  } finally {
    vi.useRealTimers();
  }
});

// Guard the fallback: with no keyOf, the legacy positional delta is unchanged
// (and still re-emits the suffix on a mid-array insert — the behavior identity
// tracking exists to fix). Pins that other future callers are unaffected.
test("makeDeltaTopic positional fallback (no keyOf) preserves slice-by-count behavior", async () => {
  vi.useFakeTimers();
  try {
    let current: Array<{ id: string }> = [{ id: "a" }, { id: "b" }, { id: "c" }];
    const sends: Array<Array<{ id: string }>> = [];
    const stop = makeDeltaTopic<{ id: string }>(
      () => current,
      (data) => sends.push(data),
      500,
    );
    try {
      await flushMicrotasks();
      assert.deepEqual(sends, [[{ id: "a" }, { id: "b" }, { id: "c" }]]);

      current = [{ id: "a" }, { id: "x" }, { id: "b" }, { id: "c" }];
      await vi.advanceTimersByTimeAsync(500);
      assert.deepEqual(sends[1], [{ id: "c" }], "positional delta sends only the trailing slice");
    } finally {
      stop();
    }
  } finally {
    vi.useRealTimers();
  }
});

test("makeSnapshotTopic suppresses identical payloads and re-sends on change", async () => {
  vi.useFakeTimers();
  try {
    let snapshot: Record<string, unknown> = { entries: [{ id: "a" }], counts: { a: 1 } };
    const sends: unknown[] = [];
    const stop = makeSnapshotTopic(
      () => snapshot,
      (data) => sends.push(data),
      1_000,
      "test-snapshot",
    );
    try {
      assert.equal(sends.length, 1, "first tick sends the full snapshot");

      // Identical payload (new object, same serialized form) → suppressed.
      snapshot = { entries: [{ id: "a" }], counts: { a: 1 } };
      await vi.advanceTimersByTimeAsync(3_000);
      assert.equal(sends.length, 1, "unchanged snapshots are not re-sent");

      snapshot = { entries: [{ id: "a" }, { id: "b" }], counts: { a: 2 } };
      await vi.advanceTimersByTimeAsync(1_000);
      assert.equal(sends.length, 2, "a changed snapshot is sent");
      assert.deepEqual(sends[1], snapshot);
    } finally {
      stop();
    }
  } finally {
    vi.useRealTimers();
  }
});

test("makeSnapshotTopic contains a fetcher throw to the tick and recovers", async () => {
  vi.useFakeTimers();
  try {
    let shouldThrow = false;
    let value = 1;
    const sends: unknown[] = [];
    const stop = makeSnapshotTopic(
      () => {
        if (shouldThrow) throw new Error("projection read failed");
        return { value };
      },
      (data) => sends.push(data),
      1_000,
      "test-snapshot",
    );
    try {
      assert.equal(sends.length, 1);

      shouldThrow = true;
      await vi.advanceTimersByTimeAsync(1_000); // must not blow up the interval
      assert.equal(sends.length, 1);

      shouldThrow = false;
      value = 2;
      await vi.advanceTimersByTimeAsync(1_000);
      assert.deepEqual(sends[1], { value: 2 }, "the interval survives the throw and recovers");
    } finally {
      stop();
    }
  } finally {
    vi.useRealTimers();
  }
});

test("makeDeltaTopic contains a fetcher rejection to the tick and recovers", async () => {
  vi.useFakeTimers();
  try {
    let shouldReject = false;
    let items: Array<{ id: string }> = [{ id: "a" }];
    const sends: Array<Array<{ id: string }>> = [];
    const stop = makeDeltaTopic<{ id: string }>(
      () => (shouldReject ? Promise.reject(new Error("read failed")) : Promise.resolve(items)),
      (data) => sends.push(data),
      500,
      (e) => e.id,
    );
    try {
      await flushMicrotasks();
      assert.equal(sends.length, 1);

      shouldReject = true;
      await vi.advanceTimersByTimeAsync(500); // an unhandled rejection here would fail the test run
      assert.equal(sends.length, 1);

      shouldReject = false;
      items = [{ id: "a" }, { id: "b" }];
      await vi.advanceTimersByTimeAsync(500);
      assert.deepEqual(sends[1], [{ id: "b" }], "delta stream resumes after the failed tick");
    } finally {
      stop();
    }
  } finally {
    vi.useRealTimers();
  }
});
