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
  type ApproveHandlerOpts,
} from "../../../src/tracker/dashboard/ocr/index.js";
import { trackEventForDate } from "../../../src/tracker/jsonl.js";
import { openControlDb } from "../../../src/core/control-db.js";
import { createTaskStore } from "../../../src/core/task-store/index.js";

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

test("POST /api/ocr/prepare passes dryRun to the orchestrator input", async () => {
  const dir = setup();
  _resetSessionLockForTests();
  let seenDryRun: boolean | undefined;
  const handler = buildOcrPrepareHandler({
    trackerDir: dir,
    runOrchestrator: async (input) => {
      seenDryRun = input.dryRun;
    },
  });
  const resp = await handler({
    pdfPath: "/tmp/fake.pdf",
    pdfOriginalName: "fake.pdf",
    formType: "oath",
    rosterMode: "existing",
    rosterPath: "/tmp/roster.xlsx",
    dryRun: true,
  });
  assert.equal(resp.status, 202);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(seenDryRun, true);
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

test("POST /api/ocr/discard-prepare deletes delegated EID lookup child rows", async () => {
  const dir = setup();
  const date = todayLocal();
  trackEventForDate(
    {
      workflow: "ocr",
      timestamp: new Date().toISOString(),
      id: "ocr-session-children",
      runId: "ocr-run-children",
      status: "running",
      step: "awaiting-approval",
    },
    date,
    dir,
  );
  trackEventForDate(
    {
      workflow: "eid-lookup",
      timestamp: new Date().toISOString(),
      id: "ocr-oath-ocr-run-children-r0",
      runId: "eid-child-run",
      parentRunId: "ocr-run-children",
      status: "done",
    },
    date,
    dir,
  );

  const handler = buildOcrDiscardHandler({ trackerDir: dir });
  const resp = await handler({
    sessionId: "ocr-session-children",
    runId: "ocr-run-children",
    reason: "operator discarded OCR row",
  });

  assert.equal(resp.status, 200);
  const eidFile = join(dir, `eid-lookup-${date}.jsonl`);
  const eidLines = existsSync(eidFile)
    ? readFileSync(eidFile, "utf-8").split("\n").filter(Boolean)
    : [];
  assert.deepEqual(eidLines, []);
  rmSync(dir, { recursive: true, force: true });
});

test("POST /api/ocr/discard-prepare deletes children for that OCR run only", async () => {
  const dir = setup();
  const date = todayLocal();
  trackEventForDate(
    {
      workflow: "eid-lookup",
      timestamp: new Date().toISOString(),
      id: "child-for-discarded-run",
      runId: "eid-child-run-1",
      parentRunId: "ocr-run-discarded",
      status: "done",
    },
    date,
    dir,
  );
  trackEventForDate(
    {
      workflow: "eid-lookup",
      timestamp: new Date().toISOString(),
      id: "child-for-other-run",
      runId: "eid-child-run-2",
      parentRunId: "ocr-run-kept",
      status: "done",
    },
    date,
    dir,
  );

  const handler = buildOcrDiscardHandler({ trackerDir: dir });
  const resp = await handler({
    sessionId: "ocr-session-discarded",
    runId: "ocr-run-discarded",
    reason: "operator discarded OCR row",
  });

  assert.equal(resp.status, 200);
  const eidFile = join(dir, `eid-lookup-${date}.jsonl`);
  const remaining = existsSync(eidFile)
    ? readFileSync(eidFile, "utf-8").split("\n").filter(Boolean).map((line) => JSON.parse(line))
    : [];
  assert.deepEqual(
    remaining.map((row) => row.id),
    ["child-for-other-run"],
  );
  rmSync(dir, { recursive: true, force: true });
});

test("POST /api/ocr/discard-prepare mirrors explicit parent row without OCR history", async () => {
  const dir = setup();
  const handler = buildOcrDiscardHandler({ trackerDir: dir });
  const resp = await handler({
    sessionId: "s-parent",
    runId: "r-ocr",
    reason: "Cancelled from oath-signature queue",
    parentWorkflow: "oath-signature",
    parentRunId: "r-parent",
    parentItemId: "ocr-prep-s-parent",
    formType: "oath",
  });
  assert.equal(resp.status, 200);

  const parentFile = join(dir, `oath-signature-${todayLocal()}.jsonl`);
  assert.ok(existsSync(parentFile));
  const parentLines = readFileSync(parentFile, "utf-8").split("\n").filter(Boolean);
  const lastParent = JSON.parse(parentLines[parentLines.length - 1]);
  assert.equal(lastParent.workflow, "oath-signature");
  assert.equal(lastParent.id, "ocr-prep-s-parent");
  assert.equal(lastParent.runId, "r-parent");
  assert.equal(lastParent.status, "failed");
  assert.equal(lastParent.step, "discarded");
  assert.equal(lastParent.error, "Cancelled from oath-signature queue");
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
    const { buildOcrRetryPageHandler, _resetSessionLockForTests } = await import("../../../src/tracker/dashboard/ocr/index.js");
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
    const { buildOcrRetryPageHandler, _resetSessionLockForTests } = await import("../../../src/tracker/dashboard/ocr/index.js");
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

    const { buildOcrReocrWholePdfHandler, _resetSessionLockForTests } = await import("../../../src/tracker/dashboard/ocr/index.js");
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
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      })) as any,
      _loadRosterOverride: async () => [{ eid: "10000003", name: "Carla" }],
      _watchChildRunsOverride: async () => [],
      _enqueueEidLookupOverride: async () => {},
    });
    const r = await handler({ sessionId: "s3", runId: "r3" });
    assert.equal(r.status, 202);
    assert.equal((r.body as { ok: boolean }).ok, true);
    // Handler returns 202 immediately; tracker emits happen in the background
    // async block. Flush the microtask/macrotask queue so the void promise
    // settles before we inspect writtenEntries.
    await new Promise((resolve) => setTimeout(resolve, 0));
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

    const { buildOcrReocrWholePdfHandler, _resetSessionLockForTests } = await import("../../../src/tracker/dashboard/ocr/index.js");
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
      ensureDaemonsAndEnqueueOverride: spy as ApproveHandlerOpts["ensureDaemonsAndEnqueueOverride"],
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

    // Assert spy was called with parentRunId plus the pre-auth child row emitter.
    assert.ok(capturedSpyArgs, "spy should have been called");
    assert.equal((capturedSpyArgs![3] as any).parentRunId, "oath-upload-run-1");
    assert.equal(typeof (capturedSpyArgs![3] as any).onPreEmitPending, "function");

    // Read back the post-approve JSONL entry
    const lines = readFileSync(ocrFile, "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const approvedEntry = lines.find((e: { step?: string }) => e.step === "approved");
    assert.ok(approvedEntry, "post-approve entry should exist");
    assert.equal(approvedEntry.parentRunId, "oath-upload-run-1", "post-approve entry should carry parentRunId");
    assert.equal(approvedEntry.data?.mode, "prepare", "approved OCR row should remain a prep/review row");
    assert.equal(approvedEntry.data?.formType, "oath");
    assert.equal(approvedEntry.data?.pdfOriginalName, "fake.pdf");
    assert.equal(approvedEntry.data?.recordCount, "2");
    const approvedRecords = JSON.parse(approvedEntry.data.records as string) as Array<{ printedName?: string }>;
    assert.equal(approvedRecords.length, 2);
    assert.equal(approvedRecords[0].printedName, "Alice One");
    assert.ok(approvedEntry.data?.fannedOutItemIds, "post-approve entry should have fannedOutItemIds");
    const parsedIds = JSON.parse(approvedEntry.data.fannedOutItemIds as string) as string[];
    assert.equal(parsedIds.length, 2, "fannedOutItemIds should have 2 elements");
    assert.equal(typeof parsedIds[0], "string");
    assert.equal(typeof parsedIds[1], "string");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("buildOcrApproveHandler provides downstream pre-emit hook before daemon auth", async () => {
  const dir = join(tmpdir(), `ocr-approve-preemit-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  try {
    const today = dateLocalForTest();
    const ocrFile = join(dir, `ocr-${today}.jsonl`);
    const oathFile = join(dir, `oath-signature-${today}.jsonl`);
    writeFileSync(ocrFile, JSON.stringify({
      workflow: "ocr",
      id: "session-preemit-approve",
      runId: "run-preemit-approve",
      status: "done",
      step: "awaiting-approval",
      timestamp: "2026-05-01T00:00:00Z",
      parentRunId: "parent-preemit-approve",
      data: {
        formType: "oath",
        sessionId: "session-preemit-approve",
        records: JSON.stringify([]),
      },
    }) + "\n", "utf-8");
    writeFileSync(oathFile, JSON.stringify({
      workflow: "oath-signature",
      id: "ocr-prep-session-preemit-approve",
      runId: "parent-preemit-approve",
      status: "running",
      step: "ocr",
      timestamp: "2026-05-01T00:00:00Z",
      data: {
        __name: "Oath Signature · #1234",
        __id: "ocr-prep-session-preemit-approve",
        mode: "prepare",
      },
    }) + "\n", "utf-8");

    const handler = buildOcrApproveHandler({
      trackerDir: dir,
      ensureDaemonsAndEnqueueOverride: async (_workflow, inputs, deriveItemId, opts) => {
        assert.equal(typeof (opts as any)?.onPreEmitPending, "function");
        (opts as any).onPreEmitPending(inputs[0], "child-run-preauth", opts?.parentRunId, deriveItemId(inputs[0], 0));
        return { enqueued: [{ id: deriveItemId(inputs[0], 0), runId: "child-run-preauth" }] };
      },
    });

    const resp = await handler({
      sessionId: "session-preemit-approve",
      runId: "run-preemit-approve",
      records: [{
        employeeId: "10874100",
        printedName: "Alice One",
        selected: true,
        matchState: "matched",
        employeeSigned: true,
        officerSigned: true,
        dateSigned: "05/01/2026",
        sourcePage: 1,
        rowIndex: 0,
      }],
    });

    assert.equal(resp.status, 200);
    await new Promise((resolve) => setTimeout(resolve, 100));

    const oathRows = readFileSync(oathFile, "utf-8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
    const childPending = oathRows.find((row: any) => row.runId === "child-run-preauth" && row.status === "pending");
    assert.ok(childPending, "downstream oath-signature child pending row should be emitted before daemon auth");
    assert.equal(childPending.workflow, "oath-signature");
    assert.equal(childPending.parentRunId, "parent-preemit-approve");
    assert.equal(childPending.data.emplId, "10874100");
    assert.equal(childPending.data.parentSubject, "Oath Signature · #1234");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("buildOcrApproveHandler preserves origin parent prep metadata when marking approved", async () => {
  const dir = join(tmpdir(), `ocr-approve-origin-parent-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  try {
    const parentRunId = "origin-parent-run";
    const sessionId = "session-origin-parent";
    const runId = "run-origin-parent";
    const parentItemId = `ocr-prep-${sessionId}`;
    const parentFile = join(dir, `oath-signature-${dateLocalForTest()}.jsonl`);
    writeFileSync(parentFile, JSON.stringify({
      workflow: "oath-signature",
      id: parentItemId,
      runId: parentRunId,
      status: "running",
      step: "ocr",
      timestamp: "2026-05-01T00:00:00Z",
      data: {
        __name: "Oath Signature · #-run",
        __id: parentItemId,
        mode: "prepare",
        pdfOriginalName: "fake.pdf",
        ocrSessionId: sessionId,
        ocrRunId: runId,
      },
    }) + "\n", "utf-8");

    const ocrFile = join(dir, `ocr-${dateLocalForTest()}.jsonl`);
    writeFileSync(ocrFile, JSON.stringify({
      workflow: "ocr",
      id: sessionId,
      runId,
      status: "done",
      step: "awaiting-approval",
      timestamp: "2026-05-01T00:00:00Z",
      parentRunId,
      data: {
        formType: "oath",
        pdfPath: "/tmp/fake.pdf",
        pdfOriginalName: "fake.pdf",
        sessionId,
        records: JSON.stringify([]),
      },
    }) + "\n", "utf-8");

    const handler = buildOcrApproveHandler({
      trackerDir: dir,
      ensureDaemonsAndEnqueueOverride: async () => {},
    });

    const resp = await handler({
      sessionId,
      runId,
      records: [
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
      ],
    });

    assert.equal(resp.status, 200);
    const parentLines = readFileSync(parentFile, "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const approvedParent = parentLines[parentLines.length - 1] as { status: string; step?: string; data?: Record<string, string> };
    assert.equal(approvedParent.status, "done");
    assert.equal(approvedParent.step, "approved");
    assert.equal(approvedParent.data?.mode, "prepare");
    assert.equal(approvedParent.data?.ocrSessionId, sessionId);
    assert.equal(approvedParent.data?.ocrRunId, runId);
    assert.equal(approvedParent.data?.fannedOutCount, "1");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("buildOcrApproveHandler propagates dryRun from OCR row to downstream inputs", async () => {
  const dir = join(tmpdir(), `ocr-approve-dry-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  try {
    const ocrFile = join(dir, `ocr-${dateLocalForTest()}.jsonl`);
    writeFileSync(ocrFile, JSON.stringify({
      workflow: "ocr",
      id: "session-approve-dry",
      runId: "run-approve-dry",
      status: "done",
      step: "awaiting-approval",
      timestamp: "2026-05-01T00:00:00Z",
      data: {
        formType: "oath",
        dryRun: "true",
        pdfPath: "/tmp/fake.pdf",
        pdfOriginalName: "fake.pdf",
        sessionId: "session-approve-dry",
        records: JSON.stringify([]),
      },
    }) + "\n", "utf-8");

    let capturedInputs: unknown[] = [];
    const handler = buildOcrApproveHandler({
      trackerDir: dir,
      ensureDaemonsAndEnqueueOverride: async (_workflow, inputs) => {
        capturedInputs = inputs;
      },
    });

    const resp = await handler({
      sessionId: "session-approve-dry",
      runId: "run-approve-dry",
      records: [
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
      ],
    });

    assert.equal(resp.status, 200);
    assert.equal((capturedInputs[0] as { dryRun?: boolean }).dryRun, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("buildOcrApproveHandler creates SQLite dependency rows from approval fan-out task ids", async () => {
  const dir = join(tmpdir(), `ocr-approve-deps-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  try {
    const taskStore = createTaskStore(openControlDb({ trackerDir: dir }));
    const [parent] = taskStore.enqueueTasks({
      workflow: "oath-upload",
      inputs: [{ sessionId: "oath-parent" }],
      deriveItemId: () => "ocr-prep-session-approve-deps",
      runIds: ["oath-upload-run-deps"],
    });
    const ocrFile = join(dir, `ocr-${dateLocalForTest()}.jsonl`);
    writeFileSync(ocrFile, JSON.stringify({
      workflow: "ocr",
      id: "session-approve-deps",
      runId: "run-approve-deps",
      status: "done",
      step: "awaiting-approval",
      timestamp: "2026-05-01T00:00:00Z",
      parentRunId: "oath-upload-run-deps",
      data: {
        formType: "oath",
        pdfPath: "/tmp/fake.pdf",
        pdfOriginalName: "fake.pdf",
        sessionId: "session-approve-deps",
        records: JSON.stringify([]),
      },
    }) + "\n", "utf-8");

    const handler = buildOcrApproveHandler({
      trackerDir: dir,
      ensureDaemonsAndEnqueueOverride: async (workflow, inputs, deriveItemId) => {
        const enqueued = taskStore.enqueueTasks({
          workflow,
          inputs,
          deriveItemId: (input, index) => deriveItemId(input, index),
          parentRunId: "oath-upload-run-deps",
        });
        return { enqueued: enqueued.map((item) => ({ id: item.id, taskId: item.taskId, runId: item.runId })) };
      },
    });

    const resp = await handler({
      sessionId: "session-approve-deps",
      runId: "run-approve-deps",
      records: [
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
      ],
    });

    assert.equal(resp.status, 200);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const deps = taskStore.db.prepare("SELECT * FROM task_dependencies WHERE parent_task_id = ?").all(parent.taskId) as Array<{
      on_child_failed: string;
      cascade_cancel: number;
      resume_parent_after_child_retry: number;
    }>;
    assert.equal(deps.length, 1);
    assert.equal(deps[0].on_child_failed, "block_parent");
    assert.equal(deps[0].cascade_cancel, 1);
    assert.equal(deps[0].resume_parent_after_child_retry, 1);
    taskStore.close();
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
      ensureDaemonsAndEnqueueOverride: spy as ApproveHandlerOpts["ensureDaemonsAndEnqueueOverride"],
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

    // 4th arg still carries the pre-auth child row emitter when no parentRunId exists.
    assert.ok(capturedSpyArgs, "spy should have been called");
    assert.equal((capturedSpyArgs![3] as any).parentRunId, undefined);
    assert.equal(typeof (capturedSpyArgs![3] as any).onPreEmitPending, "function");

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

test("buildOcrApproveHandler approves without preview readiness props", async () => {
  const dir = join(tmpdir(), `ocr-approve-skip-preview-props-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  try {
    writeFileSync(join(dir, `ocr-${dateLocalForTest()}.jsonl`), JSON.stringify({
      workflow: "ocr",
      id: "session-preview-props-removed",
      runId: "run-preview-props-removed",
      status: "done",
      step: "awaiting-approval",
      timestamp: "2026-05-01T00:00:00Z",
      data: {
        formType: "oath",
        pdfPath: "/tmp/fake.pdf",
        pdfOriginalName: "fake.pdf",
        sessionId: "session-preview-props-removed",
        records: JSON.stringify([]),
      },
    }) + "\n", "utf-8");

    let enqueueCalled = false;
    const handler = buildOcrApproveHandler({
      trackerDir: dir,
      ensureDaemonsAndEnqueueOverride: async () => {
        enqueueCalled = true;
      },
    });

    const resp = await handler({
      sessionId: "session-preview-props-removed",
      runId: "run-preview-props-removed",
      records: [
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
      ],
    });

    assert.equal(resp.status, 200);
    assert.ok(enqueueCalled);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
