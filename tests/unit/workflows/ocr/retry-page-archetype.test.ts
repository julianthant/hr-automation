import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runOcrRetryPage, RetryPageError } from "../../../../src/workflows/ocr/retry-page.js";

function setup(): { dir: string } {
  const dir = join(tmpdir(), `ocr-retry-gate-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return { dir };
}

function writeRow(
  dir: string,
  overrides: { status: string; step: string; sessionId?: string; runId?: string },
): void {
  const sessionId = overrides.sessionId ?? "session-gate-1";
  const runId = overrides.runId ?? "run-gate-1";
  const file = join(dir, "ocr-2026-05-16.jsonl");
  writeFileSync(
    file,
    JSON.stringify({
      workflow: "ocr",
      id: sessionId,
      runId,
      status: overrides.status,
      step: overrides.step,
      timestamp: "2026-05-16T00:00:00Z",
      data: {
        formType: "oath",
        pdfPath: "/tmp/x.pdf",
        pdfOriginalName: "x.pdf",
        pdfFileId: "pf-gate-1",
        sessionId,
        records: JSON.stringify([]),
        failedPages: JSON.stringify([
          { page: 1, error: "timeout", attemptedKeys: [], pageImagePath: "/tmp/p.png", attempts: 1 },
        ]),
        pageStatusSummary: JSON.stringify({ total: 1, succeeded: 0, failed: 1 }),
      },
    }) + "\n",
    "utf-8",
  );
  // Create pdf-cache page image so image-missing guard doesn't fire.
  const pageDir = join(dir, "pdf-cache", "pf-gate-1");
  mkdirSync(pageDir, { recursive: true });
  writeFileSync(join(pageDir, "page-001.png"), "");
}

describe("retry-page mutability gate", () => {
  it("permits retry on a row whose latest status is 'failed' with step 'prep-page-extract'", async () => {
    const { dir } = setup();
    writeRow(dir, { status: "failed", step: "prep-page-extract" });
    const emitted: object[] = [];
    // Should not throw row-not-mutable — the retry should proceed past the gate.
    // We stub the OCR page call to return a success so the test completes cleanly.
    await assert.doesNotReject(
      runOcrRetryPage(
        { sessionId: "session-gate-1", runId: "run-gate-1", pageNum: 1 },
        {
          trackerDir: dir,
          date: "2026-05-16",
          _emitOverride: (e) => emitted.push(e),
          _ocrPageOverride: async () => ({
            records: [],
            stillFailed: false,
            attemptedKeys: [],
          }),
          _watchChildRunsOverride: async () => [],
        },
      ),
    );
  });

  it("rejects retry when step is 'discarded' (status='failed')", async () => {
    const { dir } = setup();
    writeRow(dir, { status: "failed", step: "discarded" });
    await assert.rejects(
      runOcrRetryPage(
        { sessionId: "session-gate-1", runId: "run-gate-1", pageNum: 1 },
        { trackerDir: dir, date: "2026-05-16" },
      ),
      (err: unknown) => {
        assert.ok(err instanceof RetryPageError, "should be RetryPageError");
        assert.equal((err as RetryPageError).code, "row-not-mutable");
        return true;
      },
    );
  });

  it("rejects retry when step is 'approved' (status='done')", async () => {
    const { dir } = setup();
    writeRow(dir, { status: "done", step: "approved" });
    await assert.rejects(
      runOcrRetryPage(
        { sessionId: "session-gate-1", runId: "run-gate-1", pageNum: 1 },
        { trackerDir: dir, date: "2026-05-16" },
      ),
      (err: unknown) => {
        assert.ok(err instanceof RetryPageError, "should be RetryPageError");
        assert.equal((err as RetryPageError).code, "row-not-mutable");
        return true;
      },
    );
  });
});
