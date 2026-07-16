import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "vitest";

import { openControlDb } from "../../../src/core/control-db.js";
import { reEnqueueOcrEntry } from "../../../src/control/ops/retry.js";
import {
  persistOcrPrepareInput,
} from "../../../src/tracker/state/ocr-prepare-input-store.js";
import type { PrepareInput } from "../../../src/tracker/dashboard/ocr/prepare-contract.js";

const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ocr-prepare-retry-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test("OCR retry replays the exact persisted operation-aware prepare input", async () => {
  const dir = tempDir();
  const input: PrepareInput = {
    pdfPath: "/tmp/exact.pdf",
    pdfOriginalName: "exact.pdf",
    pdfFileId: "attachment-uuid",
    formType: "oath",
    rosterMode: "wait",
    rosterPath: "/tmp/original-roster.xlsx",
    sessionId: "session-exact",
    previousRunId: "older-run",
    isReupload: true,
    dryRun: true,
    targetWorkflow: "oath-signature",
    runOptions: { parallelWorkers: 3 },
  };
  persistOcrPrepareInput(openControlDb({ trackerDir: dir }), {
    sessionId: "session-exact",
    runId: "run-exact",
    input,
  });
  let captured: PrepareInput | undefined;
  const result = await reEnqueueOcrEntry(
    "session-exact",
    "run-exact",
    dir,
    undefined,
    async (value) => {
      captured = value;
      return { body: { ok: true } };
    },
  );
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(captured, input);
});

test("legacy OCR retry refuses tracker reconstruction and requires re-upload", async () => {
  const dir = tempDir();
  const result = await reEnqueueOcrEntry("legacy-session", "legacy-run", dir);
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /legacy run.*re-upload/i);
});

test("corrupt persisted OCR retry input fails loud and requires re-upload", async () => {
  const dir = tempDir();
  const control = openControlDb({ trackerDir: dir });
  persistOcrPrepareInput(control, {
    sessionId: "session-corrupt",
    runId: "run-corrupt",
    input: {
      pdfPath: "/tmp/a.pdf",
      pdfOriginalName: "a.pdf",
      formType: "oath",
      rosterMode: "download",
      sessionId: "session-corrupt",
    },
  });
  control.db.prepare(`
    UPDATE ocr_prepare_inputs SET input_hash = 'wrong'
    WHERE session_id = 'session-corrupt' AND run_id = 'run-corrupt'
  `).run();
  const result = await reEnqueueOcrEntry("session-corrupt", "run-corrupt", dir);
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /corrupt.*re-upload/i);
});
