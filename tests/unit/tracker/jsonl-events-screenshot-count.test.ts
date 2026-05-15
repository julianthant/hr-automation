import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openStateDb, closeStateDbForTests } from "../../../src/tracker/state/db.js";
import { trackEvent } from "../../../src/tracker/jsonl.js";
import { buildJsonlEventsPayload } from "../../../src/tracker/dashboard/hono/routes/entries-payload.js";

test("buildJsonlEventsPayload uses SQLite screenshot_count when projection DB is ready", () => {
  const dir = mkdtempSync(join(tmpdir(), "jsonl-events-shots-"));
  try {
    const db = openStateDb(dir);
    trackEvent({
      workflow: "work-study",
      timestamp: "2026-05-15T10:00:00.000Z",
      id: "10800001",
      runId: "run-1",
      status: "failed",
      step: "transaction",
      data: {},
    }, dir);
    db.prepare("UPDATE runs SET screenshot_count = 3 WHERE run_id = ?").run("run-1");

    const payload = buildJsonlEventsPayload("work-study", "2026-05-15", "2026-05-15", dir);
    assert.equal(payload.entries[0]?.screenshotCount, 3);
  } finally {
    closeStateDbForTests(dir);
    rmSync(dir, { recursive: true, force: true });
  }
});
