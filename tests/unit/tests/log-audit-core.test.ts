import { test } from "vitest";
import assert from "node:assert/strict";
import {
  assertNoUnexpectedStderr,
  recordConsoleLog,
  resetStderrAudit,
  setActiveTestFileForStderrAudit,
} from "../../log-audit-core.js";

test("stderr audit allowlists intentional ✗ log.error lines", () => {
  resetStderrAudit();
  setActiveTestFileForStderrAudit("/fake/tests/unit/core/batch.test.ts");
  recordConsoleLog("✗ deliberate", "stderr", {
    file: { filepath: "/fake/tests/unit/core/batch.test.ts" },
  });
  assert.doesNotThrow(() => assertNoUnexpectedStderr());
});

test("stderr audit fails on unexpected stderr", () => {
  resetStderrAudit();
  setActiveTestFileForStderrAudit("/fake/tests/unit/foo.test.ts");
  recordConsoleLog("totally unexpected library noise", "stderr", {
    file: { filepath: "/fake/tests/unit/foo.test.ts" },
  });
  assert.throws(
    () => assertNoUnexpectedStderr(),
    (err: unknown) =>
      err instanceof Error && err.message.includes("Unexpected stderr"),
  );
  resetStderrAudit();
});

test("stderr audit ignores benign pdfjs indexing warning", () => {
  resetStderrAudit();
  setActiveTestFileForStderrAudit("/fake/tests/unit/workflows/ocr/orchestrator.test.ts");
  recordConsoleLog("Warning: Indexing all PDF objects", "stderr", {
    file: { filepath: "/fake/tests/unit/workflows/ocr/orchestrator.test.ts" },
  });
  assert.doesNotThrow(() => assertNoUnexpectedStderr());
});
