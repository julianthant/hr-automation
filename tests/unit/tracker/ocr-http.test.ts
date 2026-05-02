import { test } from "node:test";
import assert from "node:assert";
import { mkdirSync, rmSync, readFileSync, existsSync, appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  buildOcrFormsHandler,
  buildOcrPrepareHandler,
  buildOcrApproveHandler,
  buildOcrDiscardHandler,
  buildOcrForceResearchHandler,
  buildOcrReocrWholePdfHandler,
  sweepStuckOcrRows,
  _resetSessionLockForTests,
} from "../../../src/tracker/ocr-http.js";

function setup(): string {
  const dir = join(tmpdir(), `ocr-http-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function todayLocal(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

test("GET /api/ocr/forms returns registry listing", () => {
  const handler = buildOcrFormsHandler();
  const result = handler();
  assert.ok(result.length >= 2);
  const oath = result.find((f) => f.formType === "oath");
  assert.ok(oath);
  assert.equal(oath.label, "Oath signature");
});

test("POST /api/ocr/prepare returns 202 with sessionId+runId on happy path", async () => {
  const dir = setup();
  _resetSessionLockForTests();
  const handler = buildOcrPrepareHandler({
    trackerDir: dir,
    runOrchestrator: async () => {/* fire-and-forget stub */},
  });
  const resp = await handler({
    pdfPath: "/tmp/fake.pdf",
    pdfOriginalName: "fake.pdf",
    formType: "oath",
    rosterMode: "existing",
    rosterPath: "/tmp/roster.xlsx",
  });
  assert.equal(resp.status, 202);
  assert.equal(resp.body.ok, true);
  assert.ok((resp.body as any).sessionId);
  assert.ok((resp.body as any).runId);
  rmSync(dir, { recursive: true, force: true });
});

test("POST /api/ocr/prepare returns 409 when sessionId is locked", async () => {
  const dir = setup();
  _resetSessionLockForTests();
  let resolveStub: (() => void) | null = null;
  const handler = buildOcrPrepareHandler({
    trackerDir: dir,
    runOrchestrator: () => new Promise<void>((resolve) => { resolveStub = resolve; }),
  });
  const sessionId = "session-locked";
  const first = await handler({
    pdfPath: "/tmp/a.pdf", pdfOriginalName: "a.pdf",
    formType: "oath", rosterMode: "existing", rosterPath: "/tmp/r.xlsx",
    sessionId,
  });
  assert.equal(first.status, 202);

  const second = await handler({
    pdfPath: "/tmp/b.pdf", pdfOriginalName: "b.pdf",
    formType: "oath", rosterMode: "existing", rosterPath: "/tmp/r.xlsx",
    sessionId,
  });
  assert.equal(second.status, 409);

  if (resolveStub) (resolveStub as () => void)();
  rmSync(dir, { recursive: true, force: true });
});

test("POST /api/ocr/reupload requires sessionId + previousRunId", async () => {
  const dir = setup();
  _resetSessionLockForTests();
  const handler = buildOcrPrepareHandler({
    trackerDir: dir,
    runOrchestrator: async () => {},
  });
  const resp = await handler({
    pdfPath: "/tmp/fake.pdf", pdfOriginalName: "fake.pdf",
    formType: "oath", rosterMode: "existing", rosterPath: "/tmp/r.xlsx",
    isReupload: true,
    // sessionId + previousRunId omitted
  });
  assert.equal(resp.status, 400);
  rmSync(dir, { recursive: true, force: true });
});

test("POST /api/ocr/discard-prepare emits failed step=discarded", async () => {
  const dir = setup();
  const handler = buildOcrDiscardHandler({ trackerDir: dir });
  const resp = await handler({ sessionId: "s1", runId: "r1", reason: "user clicked" });
  assert.equal(resp.status, 200);
  const file = join(dir, `ocr-${todayLocal()}.jsonl`);
  assert.ok(existsSync(file));
  const lines = readFileSync(file, "utf-8").split("\n").filter(Boolean);
  const last = JSON.parse(lines[lines.length - 1]);
  assert.equal(last.status, "failed");
  assert.equal(last.step, "discarded");
  rmSync(dir, { recursive: true, force: true });
});

test("sweepStuckOcrRows marks running rows failed", () => {
  const dir = setup();
  const file = join(dir, `ocr-${todayLocal()}.jsonl`);
  appendFileSync(file,
    JSON.stringify({
      workflow: "ocr", id: "stuck-session", runId: "r1",
      status: "running", step: "ocr",
      timestamp: new Date().toISOString(),
    }) + "\n",
  );
  sweepStuckOcrRows(dir);
  const lines = readFileSync(file, "utf-8").split("\n").filter(Boolean);
  const last = JSON.parse(lines[lines.length - 1]);
  assert.equal(last.status, "failed");
  assert.match(last.error, /Dashboard restarted/);
  rmSync(dir, { recursive: true, force: true });
});

test("buildOcrRetryPageHandler rejects concurrent retries on the same row", async () => {
  const dir = join(tmpdir(), `ocr-http-mutex-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  try {
    const { buildOcrRetryPageHandler, _resetSessionLockForTests } = await import("../../../src/tracker/ocr-http.js");
    _resetSessionLockForTests();

    let inFlightResolve: () => void;
    const inFlight = new Promise<void>((r) => { inFlightResolve = r; });
    const handler = buildOcrRetryPageHandler({
      trackerDir: dir,
      runRetryPageOverride: async () => {
        await inFlight;
        return { ok: true, page: 1, recordsAdded: 0, stillFailed: false };
      },
    });

    const first = handler({ sessionId: "s1", runId: "r1", pageNum: 1 });
    const second = await handler({ sessionId: "s1", runId: "r1", pageNum: 1 });
    assert.equal(second.status, 409);
    assert.match(JSON.stringify(second.body), /already in progress/i);

    inFlightResolve!();
    const firstResolved = await first;
    assert.equal(firstResolved.status, 200);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("buildOcrRetryPageHandler maps RetryPageError codes to HTTP statuses", async () => {
  const dir = join(tmpdir(), `ocr-http-err-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  try {
    const { buildOcrRetryPageHandler, _resetSessionLockForTests } = await import("../../../src/tracker/ocr-http.js");
    const { RetryPageError } = await import("../../../src/workflows/ocr/retry-page.js");
    _resetSessionLockForTests();

    const handler = buildOcrRetryPageHandler({
      trackerDir: dir,
      runRetryPageOverride: async () => {
        throw new RetryPageError("image-missing", "page image expired");
      },
    });
    const r = await handler({ sessionId: "s2", runId: "r2", pageNum: 1 });
    assert.equal(r.status, 410);
    assert.match(JSON.stringify(r.body), /expired/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("buildOcrReocrWholePdfHandler replaces records and clears failedPages", async () => {
  const dir = join(tmpdir(), `ocr-http-whole-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  try {
    const ocrFile = join(dir, `ocr-${dateLocalForTest()}.jsonl`);
    writeFileSync(ocrFile, JSON.stringify({
      workflow: "ocr",
      id: "s3",
      runId: "r3",
      status: "done",
      step: "awaiting-approval",
      timestamp: "2026-05-01T00:00:00Z",
      data: {
        formType: "oath",
        pdfPath: "/tmp/fake.pdf",
        pdfOriginalName: "fake.pdf",
        sessionId: "s3",
        records: JSON.stringify([]),
        failedPages: JSON.stringify([{ page: 1, error: "x", attemptedKeys: [], pageImagePath: "/tmp/p1.png", attempts: 1 }]),
        pageStatusSummary: JSON.stringify({ total: 1, succeeded: 0, failed: 1 }),
      },
    }) + "\n", "utf-8");

    const { buildOcrReocrWholePdfHandler, _resetSessionLockForTests } = await import("../../../src/tracker/ocr-http.js");
    _resetSessionLockForTests();

    const writtenEntries: object[] = [];
    const handler = buildOcrReocrWholePdfHandler({
      trackerDir: dir,
      _emitOverride: (e) => writtenEntries.push(e),
      _wholePdfOverride: (async () => ({
        data: [{
          sourcePage: 1, rowIndex: 0,
          printedName: "Carla", employeeSigned: true, officerSigned: true, dateSigned: "05/01/2026",
          notes: [], documentType: "expected", originallyMissing: [],
        }],
        provider: "whole-pdf-stub",
        attempts: 1,
        cached: false,
        pageCount: 1,
        keyIndex: 1,
        durationMs: 0,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      })) as any,
      _loadRosterOverride: async () => [{ eid: "10000003", name: "Carla" }],
      _watchChildRunsOverride: async () => [],
      _enqueueEidLookupOverride: async () => {},
    });
    const r = await handler({ sessionId: "s3", runId: "r3" });
    assert.equal(r.status, 200);
    const approval = (writtenEntries as Array<{ status: string; step?: string; data?: Record<string, string> }>)
      .find((e) => (e.status === "running" || e.status === "done") && e.step === "awaiting-approval");
    assert.ok(approval);
    const failedPages = JSON.parse(approval!.data!.failedPages ?? "[]") as unknown[];
    assert.equal(failedPages.length, 0, "failedPages cleared");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("buildOcrReocrWholePdfHandler assigns distinct itemIds to eid-lookup fan-out", async () => {
  const dir = join(tmpdir(), `ocr-http-reocr-fanout-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  try {
    const ocrFile = join(dir, `ocr-${dateLocalForTest()}.jsonl`);
    writeFileSync(ocrFile, JSON.stringify({
      workflow: "ocr",
      id: "s-fanout",
      runId: "r-fanout",
      status: "done",
      step: "awaiting-approval",
      timestamp: "2026-05-01T00:00:00Z",
      data: {
        formType: "oath",
        pdfPath: "/tmp/fake.pdf",
        pdfOriginalName: "fake.pdf",
        sessionId: "s-fanout",
        records: JSON.stringify([]),
        failedPages: JSON.stringify([]),
        pageStatusSummary: JSON.stringify({ total: 0, succeeded: 0, failed: 0 }),
      },
    }) + "\n", "utf-8");

    const { buildOcrReocrWholePdfHandler, _resetSessionLockForTests } = await import("../../../src/tracker/ocr-http.js");
    _resetSessionLockForTests();

    const captured: Array<{ name?: string; emplId?: string; itemId: string }> = [];
    const handler = buildOcrReocrWholePdfHandler({
      trackerDir: dir,
      _emitOverride: () => {},
      _wholePdfOverride: (async () => ({
        data: [
          { sourcePage: 1, rowIndex: 0, printedName: "Alice One",
            employeeSigned: true, officerSigned: true, dateSigned: "05/01/2026",
            notes: [], documentType: "expected", originallyMissing: [] },
          { sourcePage: 2, rowIndex: 0, printedName: "Bob Two",
            employeeSigned: true, officerSigned: true, dateSigned: "05/01/2026",
            notes: [], documentType: "expected", originallyMissing: [] },
        ],
        provider: "whole-pdf-stub",
        attempts: 1,
        cached: false,
        pageCount: 2,
        keyIndex: 1,
        durationMs: 0,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      })) as any,
      _loadRosterOverride: async () => [],
      _watchChildRunsOverride: async () => [],
      _enqueueEidLookupOverride: async (items) => {
        for (const it of items) captured.push(it);
      },
    });

    await handler({ sessionId: "s-fanout", runId: "r-fanout" });
    assert.equal(captured.length, 2, "two records each enqueued");
    const ids = captured.map((c) => c.itemId);
    assert.equal(new Set(ids).size, 2, "itemIds must be distinct");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function dateLocalForTest(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// ─── buildOcrApproveHandler: parentRunId forwarding + fannedOutItemIds ────────

test("buildOcrApproveHandler forwards parentRunId to ensureDaemonsAndEnqueueOverride and stamps post-approve entry", async () => {
  const dir = join(tmpdir(), `ocr-approve-parent-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  try {
    // Pre-write an OCR awaiting-approval tracker entry with parentRunId
    const ocrFile = join(dir, `ocr-${dateLocalForTest()}.jsonl`);
    writeFileSync(ocrFile, JSON.stringify({
      workflow: "ocr",
      id: "session-approve-1",
      runId: "run-approve-1",
      status: "done",
      step: "awaiting-approval",
      timestamp: "2026-05-01T00:00:00Z",
      parentRunId: "oath-upload-run-1",
      data: {
        formType: "oath",
        pdfPath: "/tmp/fake.pdf",
        pdfOriginalName: "fake.pdf",
        sessionId: "session-approve-1",
        records: JSON.stringify([]),
      },
    }) + "\n", "utf-8");

    // Spy that captures args
    let capturedSpyArgs: unknown[] | undefined;
    const spy = async (...args: unknown[]) => {
      capturedSpyArgs = args;
    };

    const handler = buildOcrApproveHandler({
      trackerDir: dir,
      ensureDaemonsAndEnqueueOverride: spy as Parameters<typeof buildOcrApproveHandler>[0]["ensureDaemonsAndEnqueueOverride"],
    });

    const records = [
      {
        employeeId: "10000001",
        printedName: "Alice One",
        selected: true,
        matchState: "matched",
        employeeSigned: true,
        officerSigned: true,
        dateSigned: "05/01/2026",
        sourcePage: 1,
        rowIndex: 0,
      },
      {
        employeeId: "10000002",
        printedName: "Bob Two",
        selected: true,
        matchState: "matched",
        employeeSigned: true,
        officerSigned: true,
        dateSigned: "05/01/2026",
        sourcePage: 2,
        rowIndex: 0,
      },
    ];

    const resp = await handler({
      sessionId: "session-approve-1",
      runId: "run-approve-1",
      records,
    });

    assert.equal(resp.status, 200, `Expected 200 but got ${resp.status}: ${JSON.stringify(resp.body)}`);
    assert.ok((resp.body as { ok: boolean }).ok);

    // Assert spy was called with 4th arg = { parentRunId: 'oath-upload-run-1' }
    assert.ok(capturedSpyArgs, "spy should have been called");
    assert.deepEqual(capturedSpyArgs![3], { parentRunId: "oath-upload-run-1" });

    // Read back the post-approve JSONL entry
    const lines = readFileSync(ocrFile, "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const approvedEntry = lines.find((e: { step?: string }) => e.step === "approved");
    assert.ok(approvedEntry, "post-approve entry should exist");
    assert.equal(approvedEntry.parentRunId, "oath-upload-run-1", "post-approve entry should carry parentRunId");
    assert.ok(approvedEntry.data?.fannedOutItemIds, "post-approve entry should have fannedOutItemIds");
    const parsedIds = JSON.parse(approvedEntry.data.fannedOutItemIds as string) as string[];
    assert.equal(parsedIds.length, 2, "fannedOutItemIds should have 2 elements");
    assert.equal(typeof parsedIds[0], "string");
    assert.equal(typeof parsedIds[1], "string");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("buildOcrApproveHandler back-compat: no parentRunId on OCR row → spy called with undefined 4th arg, entry has no parentRunId but still has fannedOutItemIds", async () => {
  const dir = join(tmpdir(), `ocr-approve-noparent-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  try {
    // Pre-write an OCR awaiting-approval entry WITHOUT parentRunId
    const ocrFile = join(dir, `ocr-${dateLocalForTest()}.jsonl`);
    writeFileSync(ocrFile, JSON.stringify({
      workflow: "ocr",
      id: "session-approve-2",
      runId: "run-approve-2",
      status: "done",
      step: "awaiting-approval",
      timestamp: "2026-05-01T00:00:00Z",
      data: {
        formType: "oath",
        pdfPath: "/tmp/fake2.pdf",
        pdfOriginalName: "fake2.pdf",
        sessionId: "session-approve-2",
        records: JSON.stringify([]),
      },
    }) + "\n", "utf-8");

    let capturedSpyArgs: unknown[] | undefined;
    const spy = async (...args: unknown[]) => {
      capturedSpyArgs = args;
    };

    const handler = buildOcrApproveHandler({
      trackerDir: dir,
      ensureDaemonsAndEnqueueOverride: spy as Parameters<typeof buildOcrApproveHandler>[0]["ensureDaemonsAndEnqueueOverride"],
    });

    const records = [
      {
        employeeId: "10000003",
        printedName: "Carol Three",
        selected: true,
        matchState: "matched",
        employeeSigned: true,
        officerSigned: true,
        dateSigned: "05/01/2026",
        sourcePage: 1,
        rowIndex: 0,
      },
    ];

    const resp = await handler({
      sessionId: "session-approve-2",
      runId: "run-approve-2",
      records,
    });

    assert.equal(resp.status, 200, `Expected 200 but got ${resp.status}: ${JSON.stringify(resp.body)}`);

    // 4th arg should be undefined when no parentRunId
    assert.ok(capturedSpyArgs, "spy should have been called");
    assert.equal(capturedSpyArgs![3], undefined, "4th arg should be undefined when no parentRunId");

    // Read back the post-approve JSONL entry
    const lines = readFileSync(ocrFile, "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const approvedEntry = lines.find((e: { step?: string }) => e.step === "approved");
    assert.ok(approvedEntry, "post-approve entry should exist");
    assert.equal(approvedEntry.parentRunId, undefined, "post-approve entry should NOT have parentRunId");
    assert.ok(approvedEntry.data?.fannedOutItemIds, "post-approve entry should still have fannedOutItemIds");
    const parsedIds = JSON.parse(approvedEntry.data.fannedOutItemIds as string) as string[];
    assert.equal(parsedIds.length, 1, "fannedOutItemIds should have 1 element");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
