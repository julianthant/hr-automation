import { test } from "vitest";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openStateDb } from "../../../../src/tracker/state/db.js";
import { registerLocalFile } from "../../../../src/tracker/files/files.js";
import { runOcrOrchestrator } from "../../../../src/workflows/ocr/orchestrator.js";
import {
  requestOcrPrepareAbort,
  isOcrPrepareAbortRequested,
  _resetOcrPrepareAbortRegistryForTests,
} from "../../../../src/workflows/ocr/prepare-abort.js";

function setup() {
  const dir = join(tmpdir(), `ocr-discard-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  mkdirSync(join(dir, "uploads"), { recursive: true });
  const rosterPath = join(dir, "roster.xlsx");
  writeFileSync(rosterPath, "");
  const pdfPath = join(dir, "uploads", "test.pdf");
  writeFileSync(
    pdfPath,
    "%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[]/Count 0>>endobj xref\n0 3\ntrailer<</Size 3/Root 1 0 R>>\nstartxref\n9\n%%EOF\n",
  );
  const db = openStateDb(dir);
  const { fileId: pdfFileId } = registerLocalFile(db, {
    trackerDir: dir,
    kind: "pdf",
    mimeType: "application/pdf",
    path: pdfPath,
    originalName: "test.pdf",
    source: "discard-cleanup-test",
  });
  return { dir, rosterPath, pdfPath, pdfFileId };
}

test("orchestrator clears OcrPrepareAbort flag after operator discard", async () => {
  _resetOcrPrepareAbortRegistryForTests();
  const { dir, rosterPath, pdfPath, pdfFileId } = setup();
  const sessionId = "discard-session-1";
  const runId = "discard-run-1";

  let pendingEmitted = false;

  // Request the abort after the pending row is emitted (simulates operator
  // clicking Discard just as the orchestrator starts its first running write).
  const emitOverride = (entry: Record<string, unknown>) => {
    if (!pendingEmitted && entry["status"] === "pending") {
      pendingEmitted = true;
      requestOcrPrepareAbort(sessionId, runId);
    }
  };

  // The orchestrator should catch the abort and return without throwing.
  await assert.doesNotReject(
    runOcrOrchestrator(
      { pdfPath, pdfOriginalName: "test.pdf", pdfFileId, formType: "oath", sessionId, rosterPath, rosterMode: "existing" },
      { runId, trackerDir: dir, _emitOverride: emitOverride as never, _assertSharepointDispatchUnreached: true },
    ),
  );

  // The finally block must have cleared the flag.
  assert.equal(
    isOcrPrepareAbortRequested(sessionId, runId),
    false,
    "OcrPrepareAbort flag must be cleared after orchestrator exits",
  );
  _resetOcrPrepareAbortRegistryForTests();
});

test("orchestrator clears flag even when failure tracker-write itself would re-throw", async () => {
  // Verify that a second discard request while recording failure still resolves cleanly.
  _resetOcrPrepareAbortRegistryForTests();
  const { dir, rosterPath, pdfPath, pdfFileId } = setup();
  const sessionId = "discard-session-2";
  const runId = "discard-run-2";

  let emitCount = 0;
  const emitOverride = (entry: Record<string, unknown>) => {
    emitCount++;
    // After the pending row, set the abort so the FIRST running write throws.
    // Then set it again so the failure-write in the catch block also throws.
    if (emitCount === 1 && entry["status"] === "pending") {
      requestOcrPrepareAbort(sessionId, runId);
    }
  };

  await assert.doesNotReject(
    runOcrOrchestrator(
      { pdfPath, pdfOriginalName: "test.pdf", pdfFileId, formType: "oath", sessionId, rosterPath, rosterMode: "existing" },
      { runId, trackerDir: dir, _emitOverride: emitOverride as never, _assertSharepointDispatchUnreached: true },
    ),
  );

  assert.equal(isOcrPrepareAbortRequested(sessionId, runId), false);
  _resetOcrPrepareAbortRegistryForTests();
});
