import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout } from "node:timers/promises";

import { appendLogEntry, getLogsJsonlPathForDate, type LogEntry } from "../../../../../src/tracker/jsonl.js";
import { logsTopic } from "../../../../../src/tracker/dashboard/hono/topics-emitters.js";
import { closeStateDbForTests, openStateDb } from "../../../../../src/tracker/state/db.js";

function tmpTracker(): string {
  return mkdtempSync(join(tmpdir(), "topics-emitters-"));
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
