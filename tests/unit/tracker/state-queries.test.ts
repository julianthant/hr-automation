import { test } from "vitest";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { openStateDb, closeStateDbForTests } from "../../../src/tracker/state/db.js";
import { trackEvent, appendLogEntry } from "../../../src/tracker/jsonl.js";
import {
  queryEntriesPayload,
  queryProjectionHealth,
  queryPriorEntriesByKey,
  queryRunsForItem,
  selectLogsForRun,
  selectRunEventsForRun,
  mapRunEventRowToWire,
} from "../../../src/tracker/state/queries.js";

function tmpTracker(): string {
  return mkdtempSync(join(tmpdir(), "state-query-"));
}

test("queryEntriesPayload returns /events-compatible entries and counts", () => {
  const dir = tmpTracker();
  try {
    openStateDb(dir);
    trackEvent({
      workflow: "onboarding",
      timestamp: "2026-05-04T20:00:00.000Z",
      id: "jane",
      runId: "run-1",
      status: "running",
      step: "extraction",
      data: { __name: "Jane Doe" },
    }, dir);
    appendLogEntry({
      workflow: "onboarding",
      itemId: "jane",
      runId: "run-1",
      level: "step",
      message: "Extracting",
      ts: "2026-05-04T20:00:10.000Z",
    }, dir);
    const db = openStateDb(dir);
    const payload = queryEntriesPayload(db, { workflow: "onboarding", date: "2026-05-04" });
    assert.equal(payload.workflows.includes("onboarding"), true);
    assert.equal(payload.wfCounts.onboarding, 1);
    assert.equal(payload.entries.length, 1);
    const entry = payload.entries[0] as { id: string; firstLogTs?: string; lastLogMessage?: string; runOrdinal?: number };
    assert.equal(entry.id, "jane");
    assert.equal(entry.firstLogTs, "2026-05-04T20:00:00.000Z");
    assert.equal(entry.lastLogMessage, "Extracting");
    assert.equal(entry.runOrdinal, 1);
  } finally {
    closeStateDbForTests(dir);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("queryEntriesPayload hides retired workflows from dashboard rail metadata", () => {
  const dir = tmpTracker();
  try {
    openStateDb(dir);
    const day = "2026-05-04";
    for (const workflow of ["active-check", "eid-lookup", "person-lookup"]) {
      trackEvent({
        workflow,
        timestamp: `${day}T20:00:00.000Z`,
        id: `${workflow}-row`,
        runId: `${workflow}-run`,
        status: "done",
        data: { emplId: "10706431" },
      }, dir);
    }
    const db = openStateDb(dir);
    const payload = queryEntriesPayload(db, { workflow: "person-lookup", date: day });
    assert.deepEqual(payload.workflows, ["person-lookup"]);
    assert.equal(payload.wfCounts["person-lookup"], 1);
    assert.equal(payload.wfCounts["active-check"], undefined);
    assert.equal(payload.wfCounts["eid-lookup"], undefined);
  } finally {
    closeStateDbForTests(dir);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("queryEntriesPayload wfCounts merges same-day person-lookup items that share emplId", () => {
  const dir = tmpTracker();
  try {
    openStateDb(dir);
    const day = "2026-05-09";
    trackEvent(
      {
        workflow: "person-lookup",
        timestamp: `${day}T18:00:00.000Z`,
        id: "Doe, Jane",
        runId: "Doe, Jane#1",
        status: "done",
        data: { emplId: "10999999", name: "Doe, Jane" },
      },
      dir,
    );
    trackEvent(
      {
        workflow: "person-lookup",
        timestamp: `${day}T18:05:00.000Z`,
        id: "10999999",
        runId: "10999999#1",
        status: "done",
        data: { emplId: "10999999" },
      },
      dir,
    );
    const db = openStateDb(dir);
    const payload = queryEntriesPayload(db, { workflow: "person-lookup", date: day });
    assert.equal(payload.wfCounts["person-lookup"], 1);
    assert.equal(payload.entries.length, 2, "stream still lists latest event rows per run, not merged");
  } finally {
    closeStateDbForTests(dir);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("queryEntriesPayload wfCounts carries emplId from earlier person-lookup events when latest items row drops it", () => {
  const dir = tmpTracker();
  try {
    openStateDb(dir);
    const day = "2026-05-10";
    // Final row has no emplId (e.g. cancel cleanup), but earlier row resolved one — merges with sibling EID item.
    trackEvent(
      {
        workflow: "person-lookup",
        timestamp: `${day}T10:00:00.000Z`,
        id: "Runwithdata, Test",
        runId: "Runwithdata, Test#1",
        status: "running",
        step: "searching",
        data: { emplId: "77777001", searchName: "Runwithdata, Test" },
      },
      dir,
    );
    trackEvent(
      {
        workflow: "person-lookup",
        timestamp: `${day}T10:01:00.000Z`,
        id: "Runwithdata, Test",
        runId: "Runwithdata, Test#1",
        status: "failed",
        step: "cancelled",
        data: {},
      },
      dir,
    );
    trackEvent(
      {
        workflow: "person-lookup",
        timestamp: `${day}T11:01:00.000Z`,
        id: "77777001",
        runId: "77777001#1",
        status: "done",
        data: { emplId: "77777001" },
      },
      dir,
    );
    const db = openStateDb(dir);
    const payload = queryEntriesPayload(db, { workflow: "person-lookup", date: day });
    assert.equal(
      payload.wfCounts["person-lookup"],
      1,
      "SQLite rail count respects cross-event emplId carry + merge-by-emplId",
    );
  } finally {
    closeStateDbForTests(dir);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("queryEntriesPayload wfCounts includes approved OCR prep rows that still render in the queue", () => {
  // The rail count must match the queue's ALL count for the same workflow.
  // Approved OCR prep rows are terminal, but they still render as done rows in
  // the selected OCR queue until deleted, so backend wfCounts must include
  // them instead of relying on an active-workflow-only frontend override.
  const dir = tmpTracker();
  try {
    openStateDb(dir);
    const day = "2026-05-22";
    for (const id of ["prep-a", "prep-b", "prep-c"]) {
      trackEvent(
        {
          workflow: "ocr",
          timestamp: `${day}T12:00:00.000Z`,
          id,
          runId: `${id}#1`,
          status: "done",
          step: "approved",
          data: { mode: "prepare", pdfOriginalName: `${id}.pdf`, archetype: "operation" },
        },
        dir,
      );
    }
    const db = openStateDb(dir);
    const payload = queryEntriesPayload(db, { workflow: "ocr", date: day });
    assert.equal(
      payload.wfCounts.ocr,
      3,
      "approved OCR prep rows still count as rendered OCR queue surfaces",
    );
  } finally {
    closeStateDbForTests(dir);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("queryEntriesPayload wfCounts do not depend on the selected workflow", () => {
  const dir = tmpTracker();
  try {
    openStateDb(dir);
    const day = "2026-06-02";
    trackEvent(
      {
        workflow: "ocr",
        timestamp: `${day}T12:00:00.000Z`,
        id: "ocr-approved-prep",
        runId: "ocr-approved-run",
        status: "done",
        step: "approved",
        data: { mode: "prepare", pdfOriginalName: "approved.pdf", archetype: "preview" },
      },
      dir,
    );
    trackEvent(
      {
        workflow: "person-lookup",
        timestamp: `${day}T12:01:00.000Z`,
        id: "10874100",
        runId: "lookup-run",
        status: "done",
        data: { emplId: "10874100" },
      },
      dir,
    );
    trackEvent(
      {
        workflow: "crm-doc-download",
        timestamp: `${day}T12:02:00.000Z`,
        id: "crm-doc-1",
        runId: "crm-doc-run",
        status: "done",
        data: {},
      },
      dir,
    );

    const db = openStateDb(dir);
    const ocrSelected = queryEntriesPayload(db, { workflow: "ocr", date: day });
    const crmSelected = queryEntriesPayload(db, { workflow: "crm-doc-download", date: day });

    assert.deepEqual(ocrSelected.wfCounts, crmSelected.wfCounts);
    assert.equal(ocrSelected.wfCounts.ocr, 1);
    assert.equal(ocrSelected.wfCounts["person-lookup"], 1);
    assert.equal(ocrSelected.wfCounts["crm-doc-download"], 1);
  } finally {
    closeStateDbForTests(dir);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("queryEntriesPayload forward-merges a run that was cancelled after crossing midnight", () => {
  // Repro: an OCR review starts before local midnight (day D) and the operator
  // cancels it after midnight (day D+1). Tracker rows are date-partitioned, so
  // the terminal `failed/cancelled` row lands in D+1's file. The D view's
  // per-date query would otherwise show the run stuck at `running /
  // awaiting-approval` forever with a live timer. The forward merge folds the
  // D+1 terminal row back into the D event stream.
  const dir = tmpTracker();
  try {
    openStateDb(dir);
    const sessionId = "8efa4d4f-cross-midnight";
    const runId = "fd213bd9-cross-midnight";
    // Day D — run starts and parks at awaiting-approval (noon UTC → same
    // local calendar day in every realistic test-runner timezone).
    trackEvent({
      workflow: "ocr",
      timestamp: "2026-05-04T12:00:00.000Z",
      id: sessionId,
      runId,
      status: "running",
      step: "awaiting-approval",
      data: { mode: "prepare", formType: "verify", archetype: "preview", pdfOriginalName: "detect-test.pdf" },
    }, dir);
    // Day D+1 — operator cancels; terminal row lands in tomorrow's partition.
    trackEvent({
      workflow: "ocr",
      timestamp: "2026-05-05T12:00:00.000Z",
      id: sessionId,
      runId,
      status: "failed",
      step: "cancelled",
      data: { mode: "prepare", formType: "verify", archetype: "preview", pdfOriginalName: "detect-test.pdf" },
      error: "cancelled by user from dashboard",
    }, dir);
    const db = openStateDb(dir);

    // Sanity: the cancel row is genuinely in the NEXT day's partition.
    const dayAfter = queryEntriesPayload(db, { workflow: "ocr", date: "2026-05-05" });
    assert.equal(dayAfter.entries.length, 1);
    assert.equal((dayAfter.entries[0] as { status: string }).status, "failed");

    // The start-day view must now surface the cancel via the forward merge.
    const startDay = queryEntriesPayload(db, { workflow: "ocr", date: "2026-05-04" });
    const forRun = (startDay.entries as Array<{
      id: string; runId: string; status: string; step?: string; firstLogTs?: string; lastLogTs?: string;
    }>).filter((e) => e.id === sessionId && e.runId === runId);
    const cancelled = forRun.find((e) => e.status === "failed" && e.step === "cancelled");
    assert.ok(cancelled, "the after-midnight cancel row is merged into the start-day stream");
    // Latest-wins dedupe on the frontend collapses to this terminal row, so the
    // card flips from Running → Cancelled instead of ticking forever.
    assert.equal(
      cancelled.lastLogTs,
      "2026-05-05T12:00:00.000Z",
      "terminal entry carries the cancel timestamp",
    );
    assert.equal(
      cancelled.firstLogTs,
      "2026-05-04T12:00:00.000Z",
      "elapsed span spans the whole run — inherits the day-D start, not the D+1 partition start",
    );
  } finally {
    closeStateDbForTests(dir);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("queryEntriesPayload does not forward-merge a run that already terminated on its own day", () => {
  // Guard: a run that completed the same day it started must not pull in any
  // later-partition rows (no spurious duplication / cross-day bleed).
  const dir = tmpTracker();
  try {
    openStateDb(dir);
    const runId = "same-day-run";
    trackEvent({
      workflow: "ocr",
      timestamp: "2026-05-04T12:00:00.000Z",
      id: "same-day",
      runId,
      status: "running",
      step: "ocr",
      data: { mode: "prepare", archetype: "preview", pdfOriginalName: "a.pdf" },
    }, dir);
    trackEvent({
      workflow: "ocr",
      timestamp: "2026-05-04T12:05:00.000Z",
      id: "same-day",
      runId,
      status: "done",
      step: "approved",
      data: { mode: "prepare", archetype: "preview", pdfOriginalName: "a.pdf" },
    }, dir);
    // A later-day row for a DIFFERENT run — must never be merged into this one.
    trackEvent({
      workflow: "ocr",
      timestamp: "2026-05-06T12:00:00.000Z",
      id: "other",
      runId: "other-run",
      status: "failed",
      step: "cancelled",
      data: { mode: "prepare", archetype: "preview", pdfOriginalName: "b.pdf" },
    }, dir);
    const db = openStateDb(dir);
    const startDay = queryEntriesPayload(db, { workflow: "ocr", date: "2026-05-04" });
    const ids = new Set((startDay.entries as Array<{ id: string }>).map((e) => e.id));
    assert.equal(ids.has("other"), false, "an unrelated later-day run is not merged in");
    assert.equal(
      (startDay.entries as Array<{ runId: string }>).filter((e) => e.runId === runId).length,
      2,
      "the same-day run keeps exactly its two own events — no continuation pulled",
    );
  } finally {
    closeStateDbForTests(dir);
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── cross-midnight forward merge: per-run readers ─────────────────────────────
// queryEntriesPayload (the queue card) already forward-merges. These pin the
// SAME mechanism for the three OTHER date-scoped per-run readers a drill-down
// hits: the RunSelector/run-detail summary (queryRunsForItem), the run-event
// timeline (selectRunEventsForRun), and the log panel (selectLogsForRun). All
// three must agree with the card — never show a cross-midnight run stuck at its
// last pre-midnight state on its start-day view.

test("queryRunsForItem forward-merges a run cancelled after crossing midnight", () => {
  const dir = tmpTracker();
  try {
    openStateDb(dir);
    const itemId = "10000042";
    const runId = "run-cross-midnight";
    // Day D — run parks at running/wait-signatures (noon UTC → same local day).
    trackEvent({
      workflow: "oath-upload",
      timestamp: "2026-05-04T12:00:00.000Z",
      id: itemId,
      runId,
      status: "running",
      step: "wait-signatures",
    }, dir);
    // Day D+1 — operator cancels; terminal row lands in tomorrow's partition.
    trackEvent({
      workflow: "oath-upload",
      timestamp: "2026-05-05T12:00:00.000Z",
      id: itemId,
      runId,
      status: "failed",
      step: "cancelled",
      error: "cancelled by user from dashboard",
    }, dir);
    const db = openStateDb(dir);
    const runs = queryRunsForItem(db, { workflow: "oath-upload", itemId, date: "2026-05-04" });
    assert.equal(runs.length, 1);
    assert.equal(runs[0].status, "failed", "RunSelector reflects the after-midnight cancel, not stuck running");
    assert.equal(runs[0].step, "cancelled");
    assert.equal(runs[0].timestamp, "2026-05-05T12:00:00.000Z", "summary timestamp advances to the terminal row");
    assert.equal(runs[0].lastLogTs, "2026-05-05T12:00:00.000Z", "elapsed end spans into the next day");
    assert.equal(runs[0].firstLogTs, "2026-05-04T12:00:00.000Z", "elapsed start stays day D — whole-run span");
  } finally {
    closeStateDbForTests(dir);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("queryRunsForItem does not pull continuation for a run that terminated on its own day", () => {
  // Guard: a run done the same day it started must not absorb a later-partition
  // row even when the run_id is reused for a brand-new run days later.
  const dir = tmpTracker();
  try {
    openStateDb(dir);
    const itemId = "10000043";
    const runId = "run-reused";
    trackEvent({ workflow: "work-study", timestamp: "2026-05-04T12:00:00.000Z", id: itemId, runId, status: "running", step: "transaction" }, dir);
    trackEvent({ workflow: "work-study", timestamp: "2026-05-04T12:05:00.000Z", id: itemId, runId, status: "done" }, dir);
    // Reused run_id, a genuinely different logical run two days later.
    trackEvent({ workflow: "work-study", timestamp: "2026-05-06T12:00:00.000Z", id: itemId, runId, status: "running", step: "transaction" }, dir);
    const db = openStateDb(dir);
    const runs = queryRunsForItem(db, { workflow: "work-study", itemId, date: "2026-05-04" });
    assert.equal(runs.length, 1, "only the day-D run is summarized for the day-D view");
    assert.equal(runs[0].status, "done", "the terminal day-D run is NOT dragged back to running by the reused-id later run");
  } finally {
    closeStateDbForTests(dir);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("selectRunEventsForRun includes the after-midnight terminal event for a run open on its start day", () => {
  const dir = tmpTracker();
  try {
    openStateDb(dir);
    trackEvent({ workflow: "onboarding", timestamp: "2026-05-04T12:00:00.000Z", id: "jane", runId: "run-x", status: "running", step: "extraction" }, dir);
    trackEvent({ workflow: "onboarding", timestamp: "2026-05-05T12:00:00.000Z", id: "jane", runId: "run-x", status: "failed", step: "cancelled" }, dir);
    const db = openStateDb(dir);
    const rows = selectRunEventsForRun(db, { workflow: "onboarding", trackerDate: "2026-05-04", itemId: "jane", runId: "run-x" });
    assert.deepEqual(rows.map((r) => r.status), ["running", "failed"], "the next-day terminal event is folded into the start-day timeline");
  } finally {
    closeStateDbForTests(dir);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("selectRunEventsForRun does not pull later events for a run that ended on its start day", () => {
  const dir = tmpTracker();
  try {
    openStateDb(dir);
    trackEvent({ workflow: "onboarding", timestamp: "2026-05-04T12:00:00.000Z", id: "jane", runId: "run-x", status: "running", step: "extraction" }, dir);
    trackEvent({ workflow: "onboarding", timestamp: "2026-05-04T12:05:00.000Z", id: "jane", runId: "run-x", status: "done" }, dir);
    // Reused run_id on a later day — must stay out of the day-D timeline.
    trackEvent({ workflow: "onboarding", timestamp: "2026-05-06T12:00:00.000Z", id: "jane", runId: "run-x", status: "running", step: "extraction" }, dir);
    const db = openStateDb(dir);
    const rows = selectRunEventsForRun(db, { workflow: "onboarding", trackerDate: "2026-05-04", itemId: "jane", runId: "run-x" });
    assert.deepEqual(rows.map((r) => r.status), ["running", "done"], "a same-day terminal run pulls no continuation");
  } finally {
    closeStateDbForTests(dir);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("selectLogsForRun includes after-midnight log lines for a run still open on its start day", () => {
  const dir = tmpTracker();
  try {
    openStateDb(dir);
    // A run_event on D establishes the run as OPEN on its start day (the logs
    // continuation is gated on the run's day-D status, since logs carry none).
    trackEvent({ workflow: "work-study", timestamp: "2026-05-04T12:00:00.000Z", id: "10000001", runId: "run-a", status: "running", step: "transaction" }, dir);
    // Noon-apart on consecutive days → guaranteed-distinct local partitions in
    // any realistic runner timezone (the 23:59/00:01-UTC pair collapses to one
    // local day in negative-UTC zones and would not exercise the merge).
    appendLogEntry({ workflow: "work-study", itemId: "10000001", runId: "run-a", level: "step", message: "Before midnight", ts: "2026-05-04T12:30:00.000Z" }, dir);
    appendLogEntry({ workflow: "work-study", itemId: "10000001", runId: "run-a", level: "success", message: "After midnight", ts: "2026-05-05T12:00:00.000Z" }, dir);
    const db = openStateDb(dir);
    const rows = selectLogsForRun(db, { workflow: "work-study", trackerDate: "2026-05-04", itemId: "10000001", runId: "run-a" });
    assert.deepEqual(rows.map((r) => r.message), ["Before midnight", "After midnight"], "the start-day log panel shows the whole run, not just pre-midnight lines");
  } finally {
    closeStateDbForTests(dir);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("selectLogsForRun does not pull later logs for a run that ended on its start day", () => {
  const dir = tmpTracker();
  try {
    openStateDb(dir);
    trackEvent({ workflow: "work-study", timestamp: "2026-05-04T12:00:00.000Z", id: "10000001", runId: "run-a", status: "running", step: "transaction" }, dir);
    trackEvent({ workflow: "work-study", timestamp: "2026-05-04T12:05:00.000Z", id: "10000001", runId: "run-a", status: "done" }, dir);
    appendLogEntry({ workflow: "work-study", itemId: "10000001", runId: "run-a", level: "step", message: "On day D", ts: "2026-05-04T12:01:00.000Z" }, dir);
    // A later log under the reused run_id — must NOT bleed into the day-D panel.
    appendLogEntry({ workflow: "work-study", itemId: "10000001", runId: "run-a", level: "step", message: "Reused later", ts: "2026-05-06T12:00:00.000Z" }, dir);
    const db = openStateDb(dir);
    const rows = selectLogsForRun(db, { workflow: "work-study", trackerDate: "2026-05-04", itemId: "10000001", runId: "run-a" });
    assert.deepEqual(rows.map((r) => r.message), ["On day D"], "a terminal day-D run pulls no later logs");
  } finally {
    closeStateDbForTests(dir);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("mapRunEventRowToWire drops invalid typedData entries from projected rows", () => {
  const dir = tmpTracker();
  try {
    openStateDb(dir);
    trackEvent({
      workflow: "typed-check",
      timestamp: "2026-05-11T10:00:00.000Z",
      id: "typed-1",
      runId: "run-1",
      status: "running",
      data: { good: "42", bad: "legacy" },
    }, dir);
    const db = openStateDb(dir);
    db.prepare("UPDATE run_events SET typed_data_json = ?").run(JSON.stringify({
      good: { type: "number", value: "42" },
      bad: "legacy",
      wrongValue: { type: "boolean", value: true },
    }));
    const row = selectRunEventsForRun(db, {
      workflow: "typed-check",
      trackerDate: "2026-05-11",
      itemId: "typed-1",
      runId: "run-1",
    })[0];
    const entry = mapRunEventRowToWire(row);
    assert.ok(entry !== null, "expected entry to be non-null for valid status row");
    assert.deepEqual(entry.typedData, { good: { type: "number", value: "42" } });
  } finally {
    closeStateDbForTests(dir);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("queryProjectionHealth reports schemaVersion 0 when schema_version row is missing", () => {
  const dir = tmpTracker();
  try {
    const db = openStateDb(dir);
    db.prepare("DELETE FROM schema_version").run();
    const health = queryProjectionHealth(db, dir);
    assert.equal(health.schemaVersion, 0);
    assert.equal(health.ok, true);
  } finally {
    closeStateDbForTests(dir);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("queryEntriesPayload skips wfCount rows with unknown status", () => {
  const dir = tmpTracker();
  try {
    openStateDb(dir);
    const day = "2026-05-12";
    trackEvent({
      workflow: "status-check",
      timestamp: `${day}T10:00:00.000Z`,
      id: "status-1",
      runId: "run-1",
      status: "pending",
      data: {},
    }, dir);
    const db = openStateDb(dir);
    db.prepare("UPDATE items SET latest_status = 'paused' WHERE workflow = 'status-check'").run();
    const payload = queryEntriesPayload(db, { workflow: "status-check", date: day });
    assert.equal(payload.wfCounts["status-check"], 0);
  } finally {
    closeStateDbForTests(dir);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("queryRunsForItem returns /api/runs-compatible run summaries", () => {
  const dir = tmpTracker();
  try {
    openStateDb(dir);
    trackEvent({
      workflow: "work-study",
      timestamp: "2026-05-04T20:00:00.000Z",
      id: "10000001",
      runId: "run-1",
      status: "running",
      step: "transaction",
    }, dir);
    trackEvent({
      workflow: "work-study",
      timestamp: "2026-05-04T20:01:00.000Z",
      id: "10000001",
      runId: "run-1",
      status: "done",
    }, dir);
    const db = openStateDb(dir);
    const runs = queryRunsForItem(db, { workflow: "work-study", itemId: "10000001", date: "2026-05-04" });
    assert.equal(runs.length, 1);
    assert.equal(runs[0].status, "done");
    assert.equal(runs[0].runOrdinal, 1);
    assert.equal(runs[0].stepDurations?.transaction, 60_000);
  } finally {
    closeStateDbForTests(dir);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("queryRunsForItem assigns distinct run_ordinal in live-apply path (regression)", () => {
  // Repro: previously two runs for the same item both ended up with
  // run_ordinal=1 because the live applyTrackerEntry path never recomputed
  // ordinals — only the full rebuildProjectionForDate did. The dashboard
  // RunSelector then displayed both as "Run #1".
  const dir = tmpTracker();
  try {
    openStateDb(dir);
    // First run (older first_work_ts).
    trackEvent({
      workflow: "work-study",
      timestamp: "2026-05-04T20:00:00.000Z",
      id: "10000001",
      runId: "run-uuid-a",
      status: "running",
      step: "transaction",
    }, dir);
    trackEvent({
      workflow: "work-study",
      timestamp: "2026-05-04T20:01:00.000Z",
      id: "10000001",
      runId: "run-uuid-a",
      status: "done",
    }, dir);
    // Second run, same item, same day.
    trackEvent({
      workflow: "work-study",
      timestamp: "2026-05-04T20:05:00.000Z",
      id: "10000001",
      runId: "run-uuid-b",
      status: "running",
      step: "transaction",
    }, dir);
    const db = openStateDb(dir);
    const runs = queryRunsForItem(db, { workflow: "work-study", itemId: "10000001", date: "2026-05-04" });
    assert.equal(runs.length, 2);
    const a = runs.find((r) => r.runId === "run-uuid-a");
    const b = runs.find((r) => r.runId === "run-uuid-b");
    assert.ok(a && b, "both runs present");
    assert.equal(a.runOrdinal, 1, "first run gets ordinal 1");
    assert.equal(b.runOrdinal, 2, "second run gets ordinal 2");
  } finally {
    closeStateDbForTests(dir);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("selectLogsForRun filters by run identity and orders by timestamp", () => {
  const dir = tmpTracker();
  try {
    openStateDb(dir);
    appendLogEntry({
      workflow: "work-study",
      itemId: "10000001",
      runId: "run-a",
      level: "success",
      message: "Second",
      ts: "2026-05-04T20:00:10.000Z",
    }, dir);
    appendLogEntry({
      workflow: "work-study",
      itemId: "10000001",
      runId: "run-a",
      level: "step",
      message: "First",
      ts: "2026-05-04T20:00:00.000Z",
    }, dir);
    appendLogEntry({
      workflow: "work-study",
      itemId: "10000001",
      runId: "run-b",
      level: "error",
      message: "Different run",
      ts: "2026-05-04T20:00:05.000Z",
    }, dir);
    appendLogEntry({
      workflow: "onboarding",
      itemId: "10000001",
      runId: "run-a",
      level: "step",
      message: "Different workflow",
      ts: "2026-05-04T20:00:01.000Z",
    }, dir);
    const db = openStateDb(dir);
    const rows = selectLogsForRun(db, {
      workflow: "work-study",
      trackerDate: "2026-05-04",
      itemId: "10000001",
      runId: "run-a",
    });
    assert.deepEqual(rows.map((row) => row.message), ["First", "Second"]);
    assert.deepEqual(rows.map((row) => row.run_id), ["run-a", "run-a"]);

    const limited = selectLogsForRun(db, {
      workflow: "work-study",
      trackerDate: "2026-05-04",
      itemId: "10000001",
      runId: "run-a",
      limit: 1,
    });
    assert.deepEqual(limited.map((row) => row.message), ["First"]);
  } finally {
    closeStateDbForTests(dir);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("selectRunEventsForRun filters by run identity and orders by event timestamp", () => {
  const dir = tmpTracker();
  try {
    openStateDb(dir);
    trackEvent({
      workflow: "onboarding",
      timestamp: "2026-05-04T20:00:10.000Z",
      id: "jane",
      runId: "run-a",
      status: "done",
      data: { name: "Jane" },
    }, dir);
    trackEvent({
      workflow: "onboarding",
      timestamp: "2026-05-04T20:00:00.000Z",
      id: "jane",
      runId: "run-a",
      status: "running",
      step: "extraction",
    }, dir);
    trackEvent({
      workflow: "onboarding",
      timestamp: "2026-05-04T20:00:05.000Z",
      id: "jane",
      runId: "run-b",
      status: "failed",
    }, dir);
    trackEvent({
      workflow: "onboarding",
      timestamp: "2026-05-04T20:00:01.000Z",
      id: "john",
      runId: "run-a",
      status: "running",
    }, dir);
    const db = openStateDb(dir);
    const rows = selectRunEventsForRun(db, {
      workflow: "onboarding",
      trackerDate: "2026-05-04",
      itemId: "jane",
      runId: "run-a",
    });
    assert.deepEqual(rows.map((row) => row.status), ["running", "done"]);
    assert.deepEqual(rows.map((row) => row.item_id), ["jane", "jane"]);

    const limited = selectRunEventsForRun(db, {
      workflow: "onboarding",
      trackerDate: "2026-05-04",
      itemId: "jane",
      runId: "run-a",
      limit: 1,
    });
    assert.deepEqual(limited.map((row) => row.status), ["running"]);
  } finally {
    closeStateDbForTests(dir);
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── queryPriorEntriesByKey ────────────────────────────────────────────────────

test("queryPriorEntriesByKey: returns rows where data[key] === value", () => {
  const dir = tmpTracker();
  try {
    openStateDb(dir);
    // Two items with matching eid, one without.
    trackEvent({ workflow: "separations", timestamp: "2026-05-04T10:00:00.000Z", id: "doc-1", runId: "r1", status: "done", data: { eid: "10001" } }, dir);
    trackEvent({ workflow: "separations", timestamp: "2026-05-04T11:00:00.000Z", id: "doc-2", runId: "r2", status: "done", data: { eid: "10001" } }, dir);
    trackEvent({ workflow: "separations", timestamp: "2026-05-04T12:00:00.000Z", id: "doc-3", runId: "r3", status: "done", data: { eid: "99999" } }, dir);
    const db = openStateDb(dir);
    const rows = queryPriorEntriesByKey(db, {
      workflow: "separations",
      keyField: "eid",
      keyValue: "10001",
      cutoffDate: "2026-01-01",
    });
    assert.equal(rows.length, 2);
    // Both must have eid 10001.
    for (const row of rows) {
      assert.equal((row.data as Record<string, string>).eid, "10001");
    }
    // Should not include doc-3 (different eid).
    assert.equal(rows.find((r) => r.id === "doc-3"), undefined);
  } finally {
    closeStateDbForTests(dir);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("queryPriorEntriesByKey: respects cutoffDate — excludes rows before cutoff", () => {
  const dir = tmpTracker();
  try {
    openStateDb(dir);
    // Old entry (before cutoff).
    trackEvent({ workflow: "separations", timestamp: "2026-01-01T00:00:00.000Z", id: "doc-old", runId: "r-old", status: "done", data: { eid: "10002" } }, dir);
    // Recent entry (on or after cutoff).
    trackEvent({ workflow: "separations", timestamp: "2026-04-01T00:00:00.000Z", id: "doc-new", runId: "r-new", status: "done", data: { eid: "10002" } }, dir);
    const db = openStateDb(dir);
    const rows = queryPriorEntriesByKey(db, {
      workflow: "separations",
      keyField: "eid",
      keyValue: "10002",
      cutoffDate: "2026-03-01", // doc-old is on 2026-01-01, which is before this.
    });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, "doc-new");
  } finally {
    closeStateDbForTests(dir);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("queryPriorEntriesByKey: returns empty array when no match", () => {
  const dir = tmpTracker();
  try {
    openStateDb(dir);
    trackEvent({ workflow: "separations", timestamp: "2026-05-04T10:00:00.000Z", id: "doc-1", runId: "r1", status: "done", data: { eid: "10001" } }, dir);
    const db = openStateDb(dir);
    const rows = queryPriorEntriesByKey(db, {
      workflow: "separations",
      keyField: "eid",
      keyValue: "NOMATCH",
      cutoffDate: "2026-01-01",
    });
    assert.equal(rows.length, 0);
  } finally {
    closeStateDbForTests(dir);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("queryPriorEntriesByKey: excludeId omits the caller's own entry", () => {
  const dir = tmpTracker();
  try {
    openStateDb(dir);
    trackEvent({ workflow: "separations", timestamp: "2026-05-04T10:00:00.000Z", id: "doc-self", runId: "r1", status: "done", data: { eid: "10003" } }, dir);
    trackEvent({ workflow: "separations", timestamp: "2026-05-04T11:00:00.000Z", id: "doc-other", runId: "r2", status: "done", data: { eid: "10003" } }, dir);
    const db = openStateDb(dir);
    const rows = queryPriorEntriesByKey(db, {
      workflow: "separations",
      keyField: "eid",
      keyValue: "10003",
      excludeId: "doc-self",
      cutoffDate: "2026-01-01",
    });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, "doc-other");
  } finally {
    closeStateDbForTests(dir);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("queryPriorEntriesByKey: cancelled and discarded entries are excluded", () => {
  const dir = tmpTracker();
  try {
    openStateDb(dir);
    // A cancelled entry (status=failed, step=cancelled).
    trackEvent({ workflow: "separations", timestamp: "2026-05-04T09:00:00.000Z", id: "doc-cancelled", runId: "r1", status: "failed", step: "cancelled", data: { eid: "10004" } }, dir);
    // A discarded entry (status=failed, step=discarded).
    trackEvent({ workflow: "separations", timestamp: "2026-05-04T09:30:00.000Z", id: "doc-discarded", runId: "r2", status: "failed", step: "discarded", data: { eid: "10004" } }, dir);
    // A real failure (status=failed, step=something else) — should be included.
    trackEvent({ workflow: "separations", timestamp: "2026-05-04T10:00:00.000Z", id: "doc-failed", runId: "r3", status: "failed", step: "extraction", data: { eid: "10004" } }, dir);
    const db = openStateDb(dir);
    const rows = queryPriorEntriesByKey(db, {
      workflow: "separations",
      keyField: "eid",
      keyValue: "10004",
      cutoffDate: "2026-01-01",
    });
    // Only the real failure should be included; cancelled and discarded are excluded.
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, "doc-failed");
  } finally {
    closeStateDbForTests(dir);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("queryPriorEntriesByKey: dedupes by item_id keeping latest timestamp", () => {
  const dir = tmpTracker();
  try {
    openStateDb(dir);
    // Same item_id, two dates — should return only the latest.
    trackEvent({ workflow: "separations", timestamp: "2026-04-01T10:00:00.000Z", id: "doc-1", runId: "r1", status: "done", data: { eid: "10005" } }, dir);
    trackEvent({ workflow: "separations", timestamp: "2026-05-01T10:00:00.000Z", id: "doc-1", runId: "r2", status: "done", data: { eid: "10005" } }, dir);
    const db = openStateDb(dir);
    const rows = queryPriorEntriesByKey(db, {
      workflow: "separations",
      keyField: "eid",
      keyValue: "10005",
      cutoffDate: "2026-01-01",
    });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, "doc-1");
    // Should be the latest run (r2).
    assert.equal(rows[0].runId, "r2");
  } finally {
    closeStateDbForTests(dir);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("queryPriorEntriesByKey: trims whitespace in stored value — matches trimmed query value", () => {
  const dir = tmpTracker();
  try {
    openStateDb(dir);
    // Store an entry whose data value has surrounding whitespace.
    trackEvent({ workflow: "separations", timestamp: "2026-05-04T10:00:00.000Z", id: "doc-ws", runId: "r1", status: "done", data: { name: "  Jane Doe  " } }, dir);
    const db = openStateDb(dir);
    // Query with the trimmed value — must match despite stored whitespace.
    const rows = queryPriorEntriesByKey(db, {
      workflow: "separations",
      keyField: "name",
      keyValue: "Jane Doe",
      cutoffDate: "2026-01-01",
    });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, "doc-ws");
  } finally {
    closeStateDbForTests(dir);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("queryPriorEntriesByKey: key with special chars (quotes, dots) does not throw", () => {
  const dir = tmpTracker();
  try {
    openStateDb(dir);
    trackEvent({ workflow: "separations", timestamp: "2026-05-04T10:00:00.000Z", id: "doc-1", runId: "r1", status: "done", data: { normalKey: "val" } }, dir);
    const db = openStateDb(dir);
    // Keys with quotes/dots/special chars should not throw — they return no results
    // since those are not valid top-level data keys in practice.
    assert.doesNotThrow(() => {
      queryPriorEntriesByKey(db, { workflow: "separations", keyField: "key'with'quotes", keyValue: "val", cutoffDate: "2026-01-01" });
    });
    assert.doesNotThrow(() => {
      queryPriorEntriesByKey(db, { workflow: "separations", keyField: "key.with.dots", keyValue: "val", cutoffDate: "2026-01-01" });
    });
  } finally {
    closeStateDbForTests(dir);
    rmSync(dir, { recursive: true, force: true });
  }
});
