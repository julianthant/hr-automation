import { test } from "vitest";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openStateDb, closeStateDbForTests } from "../../../src/tracker/state/db.js";
import { trackEvent, trackEventForDate } from "../../../src/tracker/jsonl.js";
import { buildJsonlEventsPayload } from "../../../src/tracker/dashboard/hono/routes/entries-payload.js";
import "../../../src/workflows/oath-upload/workflow.js";

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

test("buildJsonlEventsPayload returns only the oath-upload root row (no children nest under it)", () => {
  // Oath Upload no longer parents OCR / signature children. The synthesized
  // oath-signature batch row owns those children, so the oath-upload events
  // payload should contain just the single root row.
  const dir = mkdtempSync(join(tmpdir(), "jsonl-events-oath-context-"));
  try {
    openStateDb(dir);
    const date = "2026-05-20";
    trackEventForDate({
      workflow: "oath-upload",
      timestamp: "2026-05-20T10:00:00.000Z",
      id: "upload-session",
      runId: "oath-upload-run",
      status: "running",
      step: "wait-signatures",
      data: { archetype: "single", pdfOriginalName: "oath.pdf" },
    }, date, dir);
    // Children parented to the synthesized oath-signature row (different runId)
    // — these should NOT appear in oath-upload's events payload.
    trackEventForDate({
      workflow: "ocr",
      timestamp: "2026-05-20T10:01:00.000Z",
      id: "ocr-session",
      runId: "ocr-run",
      parentRunId: "synthesized-oath-signature-run",
      status: "done",
      step: "approved",
      data: { archetype: "batch-parent", mode: "prepare", formType: "oath" },
    }, date, dir);
    trackEventForDate({
      workflow: "oath-signature",
      timestamp: "2026-05-20T10:02:00.000Z",
      id: "10000001",
      runId: "signature-run",
      parentRunId: "synthesized-oath-signature-run",
      status: "pending",
      data: { archetype: "delegate-child", name: "Jane Doe", emplId: "10000001" },
    }, date, dir);

    const payload = buildJsonlEventsPayload("oath-upload", date, "2026-05-21", dir);

    assert.deepEqual(
      payload.entries
        .map((entry) => [entry.workflow, entry.id, entry.parentRunId ?? "root"])
        .sort((a, b) => `${a[0]}:${a[1]}`.localeCompare(`${b[0]}:${b[1]}`)),
      [["oath-upload", "upload-session", "root"]],
    );
  } finally {
    closeStateDbForTests(dir);
    rmSync(dir, { recursive: true, force: true });
  }
});
