import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { trackEvent, dateLocal } from "../../../src/tracker/jsonl.js";
import {
  buildOathUploadDuplicateCheckHandler,
  buildOathUploadCancelHandler,
  sweepStuckOathUploadRows,
} from "../../../src/tracker/oath-upload-http.js";

test("buildOathUploadDuplicateCheckHandler: returns 400 on invalid hash", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oath-upload-dup-handler-bad-"));
  try {
    const h = buildOathUploadDuplicateCheckHandler({ trackerDir: dir });
    const r = await h({ hash: "not-a-sha256" });
    assert.equal(r.status, 400);
    assert.equal(r.body.ok, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("buildOathUploadDuplicateCheckHandler: returns priorRuns array for known hash", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oath-upload-dup-handler-"));
  try {
    const hash = "c".repeat(64);
    trackEvent({
      workflow: "oath-upload",
      timestamp: new Date().toISOString(),
      id: "s1",
      runId: "r1",
      status: "done",
      step: "submit",
      data: { pdfHash: hash, ticketNumber: "HRC0001", pdfOriginalName: "f.pdf" },
    }, dir);

    const h = buildOathUploadDuplicateCheckHandler({ trackerDir: dir });
    const r = await h({ hash });
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
    assert.ok(Array.isArray(r.body.priorRuns));
    assert.equal(r.body.priorRuns.length, 1);
    assert.equal(r.body.priorRuns[0].sessionId, "s1");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("buildOathUploadCancelHandler: writes step=cancel-requested sentinel on the latest run", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oath-upload-cancel-"));
  try {
    // Pre-write a running entry so the handler can find a runId for sessionId.
    trackEvent({
      workflow: "oath-upload",
      timestamp: new Date().toISOString(),
      id: "session-x",
      runId: "run-x",
      status: "running",
      step: "wait-signatures",
    }, dir);

    const h = buildOathUploadCancelHandler({ trackerDir: dir });
    const r = await h({ sessionId: "session-x" });
    assert.equal(r.status, 200);

    const file = join(dir, `oath-upload-${dateLocal()}.jsonl`);
    const lines = readFileSync(file, "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const sentinel = lines.find((l) => l.step === "cancel-requested");
    assert.ok(sentinel, "expected a cancel-requested entry");
    assert.equal(sentinel.id, "session-x");
    assert.equal(sentinel.runId, "run-x");
    assert.equal(sentinel.status, "running");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("buildOathUploadCancelHandler: returns 400 when no active row for sessionId", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oath-upload-cancel-noid-"));
  try {
    const h = buildOathUploadCancelHandler({ trackerDir: dir });
    const r = await h({ sessionId: "nonexistent" });
    assert.equal(r.status, 400);
    assert.equal(r.body.ok, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("sweepStuckOathUploadRows: marks pending/running rows as failed step=swept", () => {
  const dir = mkdtempSync(join(tmpdir(), "oath-upload-sweep-"));
  try {
    trackEvent({
      workflow: "oath-upload",
      timestamp: new Date().toISOString(),
      id: "s-pend",
      runId: "r-pend",
      status: "pending",
      data: {},
    }, dir);
    trackEvent({
      workflow: "oath-upload",
      timestamp: new Date().toISOString(),
      id: "s-run",
      runId: "r-run",
      status: "running",
      data: {},
    }, dir);
    // A done row should NOT be touched.
    trackEvent({
      workflow: "oath-upload",
      timestamp: new Date().toISOString(),
      id: "s-done",
      runId: "r-done",
      status: "done",
      step: "submit",
      data: {},
    }, dir);

    sweepStuckOathUploadRows(dir);

    const file = join(dir, `oath-upload-${dateLocal()}.jsonl`);
    const lines = readFileSync(file, "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const sweptForPend = lines.find((l) => l.id === "s-pend" && l.step === "swept");
    const sweptForRun = lines.find((l) => l.id === "s-run" && l.step === "swept");
    assert.ok(sweptForPend, "expected sweep entry for pending row");
    assert.ok(sweptForRun, "expected sweep entry for running row");
    assert.equal(sweptForPend.status, "failed");
    assert.match(sweptForPend.error ?? "", /Dashboard restarted/);

    // No new entry for the done row.
    const sweptForDone = lines.find((l) => l.id === "s-done" && l.step === "swept");
    assert.equal(sweptForDone, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("sweepStuckOathUploadRows: no-op when JSONL doesn't exist", () => {
  const dir = mkdtempSync(join(tmpdir(), "oath-upload-sweep-empty-"));
  try {
    // Should not throw.
    sweepStuckOathUploadRows(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
