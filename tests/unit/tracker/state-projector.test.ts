import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { openStateDb, closeStateDbForTests } from "../../../src/tracker/state/db.js";
import { rebuildProjectionForDate } from "../../../src/tracker/state/rebuild.js";

function tmpTracker(): string {
  return mkdtempSync(join(tmpdir(), "state-rebuild-"));
}

test("rebuildProjectionForDate replays tracker and log JSONL into SQLite", () => {
  const dir = tmpTracker();
  const date = "2026-05-04";
  try {
    appendFileSync(join(dir, `onboarding-${date}.jsonl`), JSON.stringify({
      workflow: "onboarding",
      timestamp: "2026-05-04T20:00:00.000Z",
      id: "jane",
      runId: "run-1",
      status: "running",
      step: "extraction",
      data: { name: "Jane" },
    }) + "\n");
    appendFileSync(join(dir, `onboarding-${date}-logs.jsonl`), JSON.stringify({
      workflow: "onboarding",
      itemId: "jane",
      runId: "run-1",
      level: "step",
      message: "Extracting",
      ts: "2026-05-04T20:00:10.000Z",
    }) + "\n");

    const db = openStateDb(dir);
    rebuildProjectionForDate(db, { dir, date });
    const run = db.prepare("SELECT latest_status, latest_step, last_log_message FROM runs").get() as {
      latest_status: string;
      latest_step: string;
      last_log_message: string;
    };
    assert.deepEqual(run, {
      latest_status: "running",
      latest_step: "extraction",
      last_log_message: "Extracting",
    });
  } finally {
    closeStateDbForTests(dir);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("rebuildProjectionForDate is idempotent and skips malformed lines", () => {
  const dir = tmpTracker();
  const date = "2026-05-04";
  try {
    appendFileSync(join(dir, `work-study-${date}.jsonl`), "{bad json}\n");
    appendFileSync(join(dir, `work-study-${date}.jsonl`), JSON.stringify({
      workflow: "work-study",
      timestamp: "2026-05-04T20:00:00.000Z",
      id: "10000001",
      runId: "run-1",
      status: "done",
    }) + "\n");

    const db = openStateDb(dir);
    rebuildProjectionForDate(db, { dir, date });
    rebuildProjectionForDate(db, { dir, date });
    const count = db.prepare("SELECT COUNT(*) AS n FROM run_events").get() as { n: number };
    assert.equal(count.n, 1);
  } finally {
    closeStateDbForTests(dir);
    rmSync(dir, { recursive: true, force: true });
  }
});
