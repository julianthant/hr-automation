import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runOcrRetryPage } from "../../../../src/workflows/ocr/retry-page.js";

function setup(): { dir: string } {
  const dir = join(tmpdir(), `ocr-retry-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return { dir };
}

test("runOcrRetryPage replaces records for the retried page and clears it from failedPages", async () => {
  const { dir } = setup();
  const ocrFile = join(dir, "ocr-2026-05-01.jsonl");
  writeFileSync(ocrFile, JSON.stringify({
    workflow: "ocr",
    id: "session-r1",
    runId: "run-r1",
    status: "done",
    step: "awaiting-approval",
    timestamp: "2026-05-01T00:00:00Z",
    data: {
      formType: "oath",
      pdfPath: "/tmp/fake.pdf",
      pdfOriginalName: "fake.pdf",
      sessionId: "session-r1",
      recordCount: 2,
      verifiedCount: 1,
      records: JSON.stringify([
        { sourcePage: 1, rowIndex: 0, printedName: "Alice",
          employeeSigned: true, officerSigned: true, dateSigned: "05/01/2026",
          notes: [], documentType: "expected", originallyMissing: [],
          employeeId: "10000001", matchState: "resolved", selected: true, warnings: [],
          verification: { state: "verified", hrStatus: "Active", department: "HDH", screenshotFilename: "a.png", checkedAt: "2026-05-01T00:00:00Z" },
        },
      ]),
      failedPages: JSON.stringify([
        { page: 2, error: "rate limit", attemptedKeys: ["gemini-1"], pageImagePath: join(dir, "page-images", "session-r1", "page-02.png"), attempts: 1 },
      ]),
      pageStatusSummary: JSON.stringify({ total: 2, succeeded: 1, failed: 1 }),
    },
  }) + "\n", "utf-8");

  const writtenEntries: object[] = [];
  await runOcrRetryPage(
    { sessionId: "session-r1", runId: "run-r1", pageNum: 2 },
    {
      trackerDir: dir,
      date: "2026-05-01",
      _emitOverride: (e) => writtenEntries.push(e),
      _ocrPageOverride: async ({ pageNum }) => {
        assert.equal(pageNum, 2);
        return {
          records: [{
            sourcePage: 2, rowIndex: 0,
            printedName: "Bob",
            employeeSigned: true, officerSigned: true, dateSigned: "05/01/2026",
            notes: [], documentType: "expected", originallyMissing: [],
          }],
          stillFailed: false,
        };
      },
      _loadRosterOverride: async () => [{ eid: "10000002", name: "Bob" }],
      _enqueueEidLookupOverride: async () => { /* none — Bob matches roster directly */ },
      _watchChildRunsOverride: async () => [],
    },
  );

  const approval = (writtenEntries as Array<{ status: string; step?: string; data?: Record<string, string> }>).find(
    (e) => (e.status === "running" || e.status === "done") && e.step === "awaiting-approval",
  );
  assert.ok(approval, "fresh awaiting-approval entry written");
  const records = JSON.parse(approval!.data!.records!) as Array<{ sourcePage: number; printedName: string }>;
  const sortedRecords = [...records].sort((a, b) => a.sourcePage - b.sourcePage);
  assert.equal(sortedRecords.length, 2, "alice (page 1) + bob (page 2)");
  assert.equal(sortedRecords[0].printedName, "Alice");
  assert.equal(sortedRecords[1].printedName, "Bob");
  const failedPages = JSON.parse(approval!.data!.failedPages ?? "[]") as Array<{ page: number }>;
  assert.equal(failedPages.length, 0, "page 2 cleared from failedPages");

  rmSync(dir, { recursive: true, force: true });
});

test("runOcrRetryPage keeps page in failedPages with bumped attempts when retry still fails", async () => {
  const { dir } = setup();
  const ocrFile = join(dir, "ocr-2026-05-01.jsonl");
  writeFileSync(ocrFile, JSON.stringify({
    workflow: "ocr",
    id: "session-r2",
    runId: "run-r2",
    status: "done",
    step: "awaiting-approval",
    timestamp: "2026-05-01T00:00:00Z",
    data: {
      formType: "oath",
      pdfPath: "/tmp/fake.pdf",
      pdfOriginalName: "fake.pdf",
      sessionId: "session-r2",
      recordCount: 0,
      verifiedCount: 0,
      records: JSON.stringify([]),
      failedPages: JSON.stringify([
        { page: 1, error: "rate limit", attemptedKeys: ["gemini-1"], pageImagePath: join(dir, "page-images", "session-r2", "page-01.png"), attempts: 1 },
      ]),
      pageStatusSummary: JSON.stringify({ total: 1, succeeded: 0, failed: 1 }),
    },
  }) + "\n", "utf-8");

  const writtenEntries: object[] = [];
  await runOcrRetryPage(
    { sessionId: "session-r2", runId: "run-r2", pageNum: 1 },
    {
      trackerDir: dir,
      date: "2026-05-01",
      _emitOverride: (e) => writtenEntries.push(e),
      _ocrPageOverride: async () => ({
        records: [],
        stillFailed: true,
        error: "still throttled",
        attemptedKeys: ["gemini-2", "mistral-1"],
      }),
      _loadRosterOverride: async () => [],
      _enqueueEidLookupOverride: async () => {},
      _watchChildRunsOverride: async () => [],
    },
  );

  const approval = (writtenEntries as Array<{ status: string; step?: string; data?: Record<string, string> }>).find(
    (e) => (e.status === "running" || e.status === "done") && e.step === "awaiting-approval",
  );
  const failedPages = JSON.parse(approval!.data!.failedPages!) as Array<{ page: number; attempts: number; error: string }>;
  assert.equal(failedPages.length, 1);
  assert.equal(failedPages[0].page, 1);
  assert.equal(failedPages[0].attempts, 2, "attempts bumped from 1 to 2");
  assert.equal(failedPages[0].error, "still throttled");

  rmSync(dir, { recursive: true, force: true });
});
