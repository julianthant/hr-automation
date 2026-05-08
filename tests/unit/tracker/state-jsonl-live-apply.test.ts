import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { openStateDb, closeStateDbForTests } from "../../../src/tracker/state/db.js";
import { trackEvent, appendLogEntry } from "../../../src/tracker/jsonl.js";
import { emitSessionEvent } from "../../../src/tracker/session-events.js";

function tmpTracker(): string {
  return mkdtempSync(join(tmpdir(), "state-live-"));
}

test("trackEvent appends JSONL and applies the same tracker event to SQLite", () => {
  const dir = tmpTracker();
  try {
    const db = openStateDb(dir);
    trackEvent({
      workflow: "onboarding",
      timestamp: "2026-05-04T20:00:00.000Z",
      id: "jane@ucsd.edu",
      runId: "run-1",
      status: "running",
      step: "extraction",
      data: { employeeName: "Jane Doe" },
    }, dir);

    const row = db.prepare("SELECT workflow, item_id, run_id, latest_status, latest_step FROM runs").get() as {
      workflow: string;
      item_id: string;
      run_id: string;
      latest_status: string;
      latest_step: string;
    };
    assert.deepEqual({ ...row }, {
      workflow: "onboarding",
      item_id: "jane@ucsd.edu",
      run_id: "run-1",
      latest_status: "running",
      latest_step: "extraction",
    });
  } finally {
    closeStateDbForTests(dir);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("appendLogEntry applies log rows and updates run log summary", () => {
  const dir = tmpTracker();
  try {
    const db = openStateDb(dir);
    trackEvent({
      workflow: "onboarding",
      timestamp: "2026-05-04T20:00:00.000Z",
      id: "jane@ucsd.edu",
      runId: "run-1",
      status: "running",
    }, dir);
    appendLogEntry({
      workflow: "onboarding",
      itemId: "jane@ucsd.edu",
      runId: "run-1",
      level: "step",
      message: "Extracting CRM data",
      ts: "2026-05-04T20:00:10.000Z",
    }, dir);
    const row = db.prepare("SELECT first_log_ts, last_log_ts, last_log_message FROM runs").get() as {
      first_log_ts: string;
      last_log_ts: string;
      last_log_message: string;
    };
    assert.equal(row.first_log_ts, "2026-05-04T20:00:10.000Z");
    assert.equal(row.last_log_ts, "2026-05-04T20:00:10.000Z");
    assert.equal(row.last_log_message, "Extracting CRM data");
  } finally {
    closeStateDbForTests(dir);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("emitSessionEvent applies session events when the projection DB exists", () => {
  const dir = tmpTracker();
  try {
    const db = openStateDb(dir);
    emitSessionEvent({
      type: "workflow_start",
      workflowInstance: "Onboarding 1",
      runId: "run-1",
    }, dir);
    const row = db.prepare("SELECT tracker_date, event_type, workflow_instance, run_id FROM session_events").get() as {
      tracker_date: string;
      event_type: string;
      workflow_instance: string;
      run_id: string;
    };
    assert.equal(row.event_type, "workflow_start");
    assert.equal(row.workflow_instance, "Onboarding 1");
    assert.equal(row.run_id, "run-1");
    assert.match(row.tracker_date, /^\d{4}-\d{2}-\d{2}$/);
  } finally {
    closeStateDbForTests(dir);
    rmSync(dir, { recursive: true, force: true });
  }
});
