import { test } from "vitest";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { rowFilePath } from "../../../src/tracker/paths.js";
import { tmpdir } from "node:os";
import { trackEvent, dateLocal } from "../../../src/tracker/jsonl.js";
import {
  buildOathUploadDuplicateCheckHandler,
  buildOathUploadStartHandler,
  buildOathUploadCancelHandler,
  sweepStuckOathUploadRows,
} from "../../../src/tracker/dashboard/oath-upload/http.js";

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

    const file = rowFilePath("oath-upload", dateLocal(), dir);
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

test("buildOathUploadStartHandler: defaults to upload-only and passes dryRun", async () => {
  let dryRun: boolean | undefined;
  let mode: string | undefined;
  const h = buildOathUploadStartHandler({
    runOathUploadCli: async (inputs) => {
      dryRun = inputs[0]?.dryRun;
      mode = inputs[0]?.mode;
    },
  });
  const r = await h({
    pdfPath: "/tmp/oath.pdf",
    pdfOriginalName: "oath.pdf",
    pdfHash: "a".repeat(64),
    sessionId: "session-dry",
    rosterMode: "download",
    dryRun: true,
  });
  assert.equal(r.status, 202);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(dryRun, true);
  assert.equal(mode, "upload-only");
});

test("buildOathUploadStartHandler: passes upload-only mode to runOathUploadCli input", async () => {
  let mode: string | undefined;
  const h = buildOathUploadStartHandler({
    runOathUploadCli: async (inputs) => {
      mode = inputs[0]?.mode;
    },
  });
  const r = await h({
    pdfPath: "/tmp/oath.pdf",
    pdfOriginalName: "oath.pdf",
    pdfHash: "a".repeat(64),
    sessionId: "session-upload-only",
    mode: "upload-only",
  });
  assert.equal(r.status, 202);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(mode, "upload-only");
});

test("buildOathUploadStartHandler: rejects full mode because OCR prepare owns it", async () => {
  let called = false;
  const h = buildOathUploadStartHandler({
    runOathUploadCli: async () => {
      called = true;
    },
  });
  const r = await h({
    pdfPath: "/tmp/oath.pdf",
    pdfOriginalName: "oath.pdf",
    pdfHash: "a".repeat(64),
    sessionId: "session-full",
    mode: "full",
  });
  assert.equal(r.status, 400);
  assert.equal(r.body.ok, false);
  assert.match("error" in r.body ? r.body.error : "", /ocr\/prepare/);
  assert.equal(called, false);
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

test("sweepStuckOathUploadRows: marks pending/running rows failed and preserves the reached step", () => {
  const dir = mkdtempSync(join(tmpdir(), "oath-upload-sweep-"));
  try {
    // Step-less pending row → swept row must stay step-less (step-0 fallback).
    trackEvent({
      workflow: "oath-upload",
      timestamp: new Date().toISOString(),
      id: "s-pend",
      runId: "r-pend",
      status: "pending",
      data: {},
    }, dir);
    // Running row parked on a real step → swept row must preserve it.
    trackEvent({
      workflow: "oath-upload",
      timestamp: new Date().toISOString(),
      id: "s-run",
      runId: "r-run",
      status: "running",
      step: "wait-signatures",
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

    const file = rowFilePath("oath-upload", dateLocal(), dir);
    const lines = readFileSync(file, "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const sweptForPend = lines.find((l) => l.id === "s-pend" && l.status === "failed");
    const sweptForRun = lines.find((l) => l.id === "s-run" && l.status === "failed");
    assert.ok(sweptForPend, "expected sweep entry for pending row");
    assert.ok(sweptForRun, "expected sweep entry for running row");
    assert.match(sweptForPend.error ?? "", /Dashboard restarted/);
    // Step preservation: the running row's reached step rides onto the failed
    // row; the step-less pending row gains none (keeps the step-0 fallback).
    assert.equal("step" in sweptForPend, false);
    assert.equal(sweptForRun.step, "wait-signatures");

    // No new failed entry for the done row.
    const sweptForDone = lines.find((l) => l.id === "s-done" && l.status === "failed");
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
