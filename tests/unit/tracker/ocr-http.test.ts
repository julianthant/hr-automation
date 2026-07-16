import { test, vi } from "vitest";
import assert from "node:assert";
import { mkdirSync, rmSync, readFileSync, existsSync, appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  buildOcrFormsHandler,
  buildOcrPrepareHandler,
  buildOcrApproveHandler,
  buildOcrForceResearchHandler,
  buildOcrReocrWholePdfHandler,
  sweepStuckOcrRows,
  _resetSessionLockForTests,
  type ApproveHandlerOpts,
} from "../../../src/tracker/dashboard/ocr/index.js";
import { buildOcrDiscardHandler } from "../../../src/control/ocr/discard.js";
import { trackEventForDate } from "../../../src/tracker/jsonl.js";
import { rowFilePath, rowsDir } from "../../../src/tracker/paths.js";
import { openControlDb } from "../../../src/core/control-db.js";
import { createTaskStore } from "../../../src/core/task-store/index.js";
import { verifyOcrFormSpec } from "../../../src/services/ocr/forms/verify.js";

function setup(): string {
  const dir = join(tmpdir(), `ocr-http-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(rowsDir(dir), { recursive: true });
  return dir;
}

function todayLocal(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function seedOcrPriorRow(dir: string, sessionId: string, runId: string): void {
  trackEventForDate(
    {
      workflow: "ocr",
      timestamp: new Date().toISOString(),
      id: sessionId,
      runId,
      status: "running",
      step: "awaiting-approval",
      data: { archetype: "operation" },
    },
    todayLocal(),
    dir,
  );
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

test("POST /api/ocr/prepare accepts a roster-OPTIONAL form with no rosterPath (i9 — found live 2026-07-10)", async () => {
  // The route defaults rosterMode to "existing" when the modal has no roster
  // section (separations "Run I-9 Check"). A roster-optional form must proceed
  // rosterless; only roster-required forms 400 here.
  const dir = setup();
  _resetSessionLockForTests();
  const handler = buildOcrPrepareHandler({
    trackerDir: dir,
    runOrchestrator: async () => {/* fire-and-forget stub */},
  });
  const resp = await handler({
    pdfPath: "/tmp/fake-i9.pdf",
    pdfOriginalName: "fake-i9.pdf",
    formType: "i9",
    rosterMode: "existing",
  });
  assert.equal(resp.status, 202);
  assert.equal(resp.body.ok, true);
  rmSync(dir, { recursive: true, force: true });
});

test("POST /api/ocr/prepare still 400s a roster-REQUIRED form with no rosterPath", async () => {
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
  });
  assert.equal(resp.status, 400);
  assert.equal(resp.body.ok, false);
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
  seedOcrPriorRow(dir, "s1", "r1");
  const handler = buildOcrDiscardHandler({ trackerDir: dir });
  const resp = await handler({ sessionId: "s1", runId: "r1", reason: "user clicked" });
  assert.equal(resp.status, 200);
  const file = rowFilePath("ocr", todayLocal(), dir);
  assert.ok(existsSync(file));
  const lines = readFileSync(file, "utf-8").split("\n").filter(Boolean);
  const last = JSON.parse(lines[lines.length - 1]);
  assert.equal(last.status, "failed");
  assert.equal(last.step, "discarded");
  rmSync(dir, { recursive: true, force: true });
});

test("POST /api/ocr/discard-prepare reports missing OCR history without deleting delegated children", async () => {
  const dir = setup();
  const date = todayLocal();
  trackEventForDate(
    {
      workflow: "eid-lookup",
      timestamp: new Date().toISOString(),
      id: "child-that-must-remain",
      runId: "eid-child-stays",
      parentRunId: "missing-ocr-run",
      status: "done",
    },
    date,
    dir,
  );

  const handler = buildOcrDiscardHandler({ trackerDir: dir });
  const resp = await handler({
    sessionId: "missing-ocr-session",
    runId: "missing-ocr-run",
    reason: "operator discarded OCR row",
  });

  assert.equal(resp.status, 400);
  assert.match(resp.body.error ?? "", /cannot discard OCR prep/i);
  assert.match(resp.body.error ?? "", /prior tracker row/i);

  const eidFile = rowFilePath("eid-lookup", date, dir);
  const remaining = readFileSync(eidFile, "utf-8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
  assert.deepEqual(remaining.map((row) => row.id), ["child-that-must-remain"]);
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
      data: { archetype: "operation" },
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
  const eidFile = rowFilePath("eid-lookup", date, dir);
  const eidLines = existsSync(eidFile)
    ? readFileSync(eidFile, "utf-8").split("\n").filter(Boolean)
    : [];
  assert.deepEqual(eidLines, []);
  rmSync(dir, { recursive: true, force: true });
});

test("POST /api/ocr/discard-prepare deletes children for that OCR run only", async () => {
  const dir = setup();
  const date = todayLocal();
  seedOcrPriorRow(dir, "ocr-session-discarded", "ocr-run-discarded");
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
  const eidFile = rowFilePath("eid-lookup", date, dir);
  const remaining = existsSync(eidFile)
    ? readFileSync(eidFile, "utf-8").split("\n").filter(Boolean).map((line) => JSON.parse(line))
    : [];
  assert.deepEqual(
    remaining.map((row) => row.id),
    ["child-for-other-run"],
  );
  rmSync(dir, { recursive: true, force: true });
});

test("POST /api/ocr/discard-prepare mirrors explicit parent row with OCR and parent history", async () => {
  const dir = setup();
  seedOcrPriorRow(dir, "s-parent", "r-ocr");
  trackEventForDate(
    {
      workflow: "oath-signature",
      timestamp: new Date().toISOString(),
      id: "ocr-prep-s-parent",
      runId: "r-parent",
      status: "running",
      step: "delegated-to-ocr",
      data: { archetype: "single" },
    },
    todayLocal(),
    dir,
  );
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

  const parentFile = rowFilePath("oath-signature", todayLocal(), dir);
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

// Bug #6 — when the OCR-parent row itself carries `parentRunId` (i.e. the
// parent workflow was itself spawned as a delegation child of a batch
// orchestrator), the discard row mirrored onto the parent must inherit that
// `parentRunId` via emitInheritedRow. Without it, the discard row orphans
// from the grandparent batch card.
test("POST /api/ocr/discard-prepare inherits parentRunId on parent-workflow row when parent was itself a delegation child", async () => {
  const dir = setup();
  const date = todayLocal();
  seedOcrPriorRow(dir, "s-inh", "r-ocr-inh");
  // Pre-emit a prior parent-workflow row that carries `parentRunId` —
  // models the case where oath-signature is itself a child of a
  // batch-orchestrator workflow (e.g. oath-upload's fan-out).
  trackEventForDate(
    {
      workflow: "oath-signature",
      timestamp: new Date().toISOString(),
      id: "ocr-prep-s-inh",
      runId: "r-parent-inh",
      parentRunId: "grandparent-run-inh",
      status: "running",
      step: "delegated-to-ocr",
      data: { archetype: "single" },
    },
    date,
    dir,
  );

  const handler = buildOcrDiscardHandler({ trackerDir: dir });
  const resp = await handler({
    sessionId: "s-inh",
    runId: "r-ocr-inh",
    reason: "Cancelled from oath-upload batch",
    parentWorkflow: "oath-signature",
    parentRunId: "r-parent-inh",
    parentItemId: "ocr-prep-s-inh",
    formType: "oath",
  });
  assert.equal(resp.status, 200);

  const parentFile = rowFilePath("oath-signature", date, dir);
  const parentLines = readFileSync(parentFile, "utf-8").split("\n").filter(Boolean);
  const lastParent = JSON.parse(parentLines[parentLines.length - 1]);
  assert.equal(lastParent.status, "failed");
  assert.equal(lastParent.step, "discarded");
  assert.equal(
    lastParent.parentRunId,
    "grandparent-run-inh",
    "discard row must inherit grandparent parentRunId from prior parent entry (Bug #6)",
  );
  assert.equal(
    lastParent.data?.archetype,
    "single",
    "discard row must inherit the parent's prior archetype (single)",
  );
  rmSync(dir, { recursive: true, force: true });
});

test("sweepStuckOcrRows marks running rows failed and preserves the reached step", () => {
  const dir = setup();
  const file = rowFilePath("ocr", todayLocal(), dir);
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
  // The reached step rides onto the failed row so the step pipeline marks the
  // failure on `ocr`, not its step-0 (`loading-roster`) fallback.
  assert.equal(last.step, "ocr");
  rmSync(dir, { recursive: true, force: true });
});

test("sweepStuckOcrRows omits step for a step-less stuck row (keeps the step-0 fallback)", () => {
  const dir = setup();
  const file = rowFilePath("ocr", todayLocal(), dir);
  appendFileSync(file,
    JSON.stringify({
      workflow: "ocr", id: "stuck-pending", runId: "rp",
      status: "pending",
      timestamp: new Date().toISOString(),
    }) + "\n",
  );
  sweepStuckOcrRows(dir);
  const lines = readFileSync(file, "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const swept = lines.find((l) => l.id === "stuck-pending" && l.status === "failed");
  assert.ok(swept, "expected a swept failed row for the pending session");
  assert.equal("step" in swept, false, "a step-less row must not gain a step");
  rmSync(dir, { recursive: true, force: true });
});

test("sweepStuckOcrRows preserves a durable awaiting-approval review across restart", () => {
  const dir = setup();
  seedOcrPriorRow(dir, "s-await-restart", "r-await-restart");
  sweepStuckOcrRows(dir);
  const lines = readFileSync(rowFilePath("ocr", todayLocal(), dir), "utf-8")
    .split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const latest = lines[lines.length - 1];
  assert.equal(latest.status, "running");
  assert.equal(latest.step, "awaiting-approval");
});

test("buildOcrRetryPageHandler rejects concurrent retries on the same row", async () => {
  const dir = join(tmpdir(), `ocr-http-mutex-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(rowsDir(dir), { recursive: true });
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
  mkdirSync(rowsDir(dir), { recursive: true });
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
  mkdirSync(rowsDir(dir), { recursive: true });
  try {
    const ocrFile = rowFilePath("ocr", dateLocalForTest(), dir);
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
  mkdirSync(rowsDir(dir), { recursive: true });
  try {
    const ocrFile = rowFilePath("ocr", dateLocalForTest(), dir);
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

test("buildOcrReocrWholePdfHandler parents lookup children under the operation/OCR run", async () => {
  const dir = join(tmpdir(), `ocr-http-reocr-parent-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(rowsDir(dir), { recursive: true });
  try {
    const ocrFile = rowFilePath("ocr", dateLocalForTest(), dir);
    writeFileSync(ocrFile, JSON.stringify({
      workflow: "ocr",
      id: "s-parent",
      runId: "r-parent",
      parentRunId: "operation-parent",
      status: "done",
      step: "awaiting-approval",
      timestamp: "2026-05-01T00:00:00Z",
      data: {
        formType: "oath",
        pdfPath: "/tmp/fake.pdf",
        pdfOriginalName: "fake.pdf",
        sessionId: "s-parent",
        parentRunId: "operation-parent",
        records: JSON.stringify([]),
        failedPages: JSON.stringify([]),
        pageStatusSummary: JSON.stringify({ total: 0, succeeded: 0, failed: 0 }),
      },
    }) + "\n", "utf-8");

    const { buildOcrReocrWholePdfHandler, _resetSessionLockForTests } = await import("../../../src/tracker/dashboard/ocr/index.js");
    _resetSessionLockForTests();

    let childParentRunId = "";
    const handler = buildOcrReocrWholePdfHandler({
      trackerDir: dir,
      _emitOverride: () => {},
      _wholePdfOverride: (async () => ({
        data: [{
          sourcePage: 1, rowIndex: 0, printedName: "Alice One",
          employeeSigned: true, officerSigned: true, dateSigned: "05/01/2026",
          notes: [], documentType: "expected", originallyMissing: [],
        }],
        provider: "whole-pdf-stub",
        attempts: 1,
        cached: false,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      })) as any,
      _loadRosterOverride: async () => [],
      _watchChildRunsOverride: async () => [],
      _enqueueEidLookupOverride: async (_items, context) => {
        childParentRunId = context.parentRunId;
      },
    });

    await handler({ sessionId: "s-parent", runId: "r-parent" });
    assert.equal(childParentRunId, "operation-parent");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("buildOcrReocrWholePdfHandler runs verify enrichRecords before final emit", async () => {
  const dir = join(tmpdir(), `ocr-http-reocr-enrich-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(rowsDir(dir), { recursive: true });
  const enrichSpy = vi.spyOn(verifyOcrFormSpec, "enrichRecords");
  try {
    const ocrFile = rowFilePath("ocr", dateLocalForTest(), dir);
    writeFileSync(ocrFile, JSON.stringify({
      workflow: "ocr",
      id: "s-verify",
      runId: "r-verify",
      status: "done",
      step: "person-lookup",
      timestamp: "2026-05-01T00:00:00Z",
      data: {
        formType: "verify",
        pdfPath: "/tmp/verify.pdf",
        pdfOriginalName: "verify.pdf",
        sessionId: "s-verify",
        __traceId: "vf-123456-rver",
        parallelWorkers: "4",
        parentSubject: "Verify PDF",
        records: JSON.stringify([]),
        failedPages: JSON.stringify([{ page: 1, error: "x" }]),
        pageStatusSummary: JSON.stringify({ total: 1, succeeded: 0, failed: 1 }),
      },
    }) + "\n", "utf-8");

    let observedRootPrefix = "";
    let observedParallelWorkers: unknown;
    enrichSpy.mockImplementation(async (input) => {
      observedRootPrefix = input.rootTracePrefix;
      observedParallelWorkers = input.runOptions?.parallelWorkers;
      input.emitProgress(input.records);
      return input.records.map((record) => ({
        ...(record as Record<string, unknown>),
        employeeId: "10000009",
        verification: { state: "verified" },
      })) as never;
    });

    const { buildOcrReocrWholePdfHandler, _resetSessionLockForTests } = await import("../../../src/tracker/dashboard/ocr/index.js");
    _resetSessionLockForTests();

    const writtenEntries: Array<{ status: string; step?: string; data?: Record<string, string> }> = [];
    const handler = buildOcrReocrWholePdfHandler({
      trackerDir: dir,
      _emitOverride: (e) => writtenEntries.push(e as typeof writtenEntries[number]),
      _wholePdfOverride: (async () => ({
        data: [{
          formKind: "oath",
          sourcePage: 1,
          printedName: "Mira Test",
          employeeId: "",
          paperEmploymentDate: null,
          paperDateSigned: null,
          employeeSigned: true,
          officerSigned: false,
          documentType: "expected",
          originallyMissing: [],
          notes: [],
        }],
        provider: "whole-pdf-stub",
        attempts: 1,
        cached: false,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      })) as any,
      _loadRosterOverride: async () => [],
      _watchChildRunsOverride: async () => [],
    });

    const res = await handler({ sessionId: "s-verify", runId: "r-verify" });
    assert.equal(res.status, 202);
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(enrichSpy.mock.calls.length, 1);
    assert.equal(observedRootPrefix, "vf-123456");
    assert.equal(observedParallelWorkers, 4);
    const progress = writtenEntries.find((entry) => entry.status === "running");
    assert.ok(progress, "emitProgress writes a running snapshot");
    assert.equal(progress!.step, "person-lookup", "enrichment progress mirrors orchestrator person-lookup step");
    const final = writtenEntries.find((entry) => entry.status === "done");
    assert.ok(final);
    assert.equal(final!.step, "awaiting-approval", "final review snapshot stays awaiting-approval");
    const records = JSON.parse(final!.data!.records) as Array<Record<string, unknown>>;
    assert.equal(records[0].employeeId, "10000009");
    assert.equal(final!.data!.verifiedCount, "1");
    assert.equal(final!.data!.failedPages, "[]");
    assert.equal(final!.data!.mode, "prepare");
  } finally {
    enrichSpy.mockRestore();
    rmSync(dir, { recursive: true, force: true });
  }
});

function dateLocalForTest(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function emergencyContactPreviewRecord(
  employeeId: string,
  employeeName: string,
  sourcePage = 1,
): Record<string, unknown> {
  return {
    sourcePage,
    employee: {
      name: employeeName,
      employeeId,
    },
    emergencyContact: {
      name: `${employeeName} Contact`,
      relationship: "Parent",
      primary: true,
      sameAddressAsEmployee: true,
      cellPhone: "(555) 555-0100",
    },
    notes: [],
    documentType: "expected",
    originallyMissing: [],
    selected: true,
    matchState: "matched",
    warnings: [],
  };
}

// ─── buildOcrApproveHandler: parentRunId forwarding + fannedOutItemIds ────────

test("buildOcrApproveHandler fans out oath approvals to oath-signature + oath-upload", async () => {
  // OCR-hub fan-out (2026-06-02): oath approve now enqueues per-record
  // oath-signature signer rows AND one oath-upload ticket row. (Old behavior:
  // approve omitted fan-out and woke the oath-signature PDF handler — retired.)
  const dir = join(tmpdir(), `ocr-approve-oath-fanout-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(rowsDir(dir), { recursive: true });
  try {
    const ocrFile = rowFilePath("ocr", dateLocalForTest(), dir);
    writeFileSync(ocrFile, JSON.stringify({
      workflow: "ocr",
      id: "session-oath-fanout",
      runId: "run-oath-fanout",
      parentRunId: "op-parent-oath-fanout",
      status: "running",
      step: "awaiting-approval",
      timestamp: "2026-05-01T00:00:00Z",
      data: {
        formType: "oath",
        pdfPath: "/tmp/oath.pdf",
        pdfOriginalName: "oath.pdf",
        pdfFileId: "file-oath",
        sessionId: "session-oath-fanout",
        records: JSON.stringify([]),
      },
    }) + "\n", "utf-8");

    const enqueuedWorkflows: string[] = [];
    const handler = buildOcrApproveHandler({
      trackerDir: dir,
      ensureDaemonsAndEnqueueOverride: async (workflow, inputs, deriveItemId) => {
        enqueuedWorkflows.push(workflow);
        const ids = inputs.map((inp, i) => deriveItemId(inp, i));
        return { enqueued: ids.map((id) => ({ id })) };
      },
    });

    const resp = await handler({
      sessionId: "session-oath-fanout",
      runId: "run-oath-fanout",
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
    const body = resp.body as { ok: true; fannedOut: Array<{ workflow: string }> };
    const workflows = body.fannedOut.map((f) => f.workflow);
    assert.ok(workflows.includes("oath-signature"));
    assert.ok(workflows.includes("oath-upload"));
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.ok(enqueuedWorkflows.includes("oath-signature"));
    assert.ok(enqueuedWorkflows.includes("oath-upload"));

    const lines = readFileSync(ocrFile, "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const approvedEntry = lines.find((e: { step?: string }) => e.step === "approved");
    assert.ok(approvedEntry, "post-approve entry should exist");
    assert.equal(approvedEntry.data?.formType, "oath");
    assert.equal(approvedEntry.data?.recordCount, "1");
    // fannedOutItemIds names the per-record (signer) rows.
    assert.equal(approvedEntry.data?.fannedOutCount, "1");
    assert.deepEqual(JSON.parse(approvedEntry.data.fannedOutItemIds as string), [
      "ocr-oath-run-oath-fanout-r0",
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("buildOcrApproveHandler forwards parentRunId to ensureDaemonsAndEnqueueOverride and stamps post-approve entry", async () => {
  const dir = join(tmpdir(), `ocr-approve-parent-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(rowsDir(dir), { recursive: true });
  try {
    // Pre-write an OCR awaiting-approval tracker entry with parentRunId
    const ocrFile = rowFilePath("ocr", dateLocalForTest(), dir);
    writeFileSync(ocrFile, JSON.stringify({
      workflow: "ocr",
      id: "session-approve-1",
      runId: "run-approve-1",
      status: "done",
      step: "awaiting-approval",
      timestamp: "2026-05-01T00:00:00Z",
      parentRunId: "oath-upload-run-1",
      data: {
        formType: "emergency-contact",
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
      emergencyContactPreviewRecord("10000001", "Alice One", 1),
      emergencyContactPreviewRecord("10000002", "Bob Two", 2),
    ];

    const resp = await handler({
      sessionId: "session-approve-1",
      runId: "run-approve-1",
      records,
    });

    assert.equal(resp.status, 200, `Expected 200 but got ${resp.status}: ${JSON.stringify(resp.body)}`);
    assert.ok((resp.body as { ok: boolean }).ok);
    await new Promise((r) => setTimeout(r, 250));

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
    assert.equal(approvedEntry.data?.formType, "emergency-contact");
    assert.equal(approvedEntry.data?.pdfOriginalName, "fake.pdf");
    assert.equal(approvedEntry.data?.recordCount, "2");
    const approvedRecords = JSON.parse(approvedEntry.data.records as string) as Array<{ employee?: { name?: string } }>;
    assert.equal(approvedRecords.length, 2);
    assert.equal(approvedRecords[0].employee?.name, "Alice One");
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
  mkdirSync(rowsDir(dir), { recursive: true });
  try {
    const today = dateLocalForTest();
    const ocrFile = rowFilePath("ocr", today, dir);
    const ecFile = rowFilePath("emergency-contact", today, dir);
    writeFileSync(ocrFile, JSON.stringify({
      workflow: "ocr",
      id: "session-preemit-approve",
      runId: "run-preemit-approve",
      status: "done",
      step: "awaiting-approval",
      timestamp: "2026-05-01T00:00:00Z",
      parentRunId: "parent-preemit-approve",
      data: {
        formType: "emergency-contact",
        sessionId: "session-preemit-approve",
        parentSubject: "Emergency Contact · #1234",
        records: JSON.stringify([]),
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
      records: [emergencyContactPreviewRecord("10874100", "Alice One")],
    });

    assert.equal(resp.status, 200);
    await new Promise((resolve) => setTimeout(resolve, 100));

    const ecRows = readFileSync(ecFile, "utf-8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
    const childPending = ecRows.find((row: any) => row.runId === "child-run-preauth" && row.status === "pending");
    assert.ok(childPending, "downstream emergency-contact child pending row should be emitted before daemon auth");
    assert.equal(childPending.workflow, "emergency-contact");
    assert.equal(childPending.parentRunId, "parent-preemit-approve");
    assert.match(childPending.data.employee, /10874100/);
    assert.equal(childPending.data.parentSubject, "Emergency Contact · #1234");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("buildOcrApproveHandler propagates dryRun from OCR row to downstream inputs", async () => {
  const dir = join(tmpdir(), `ocr-approve-dry-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(rowsDir(dir), { recursive: true });
  try {
    const ocrFile = rowFilePath("ocr", dateLocalForTest(), dir);
    writeFileSync(ocrFile, JSON.stringify({
      workflow: "ocr",
      id: "session-approve-dry",
      runId: "run-approve-dry",
      parentRunId: "op-parent-dry",
      status: "done",
      step: "awaiting-approval",
      timestamp: "2026-05-01T00:00:00Z",
      data: {
        formType: "emergency-contact",
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
      records: [emergencyContactPreviewRecord("10000001", "Alice One")],
    });

    assert.equal(resp.status, 200);
    await new Promise((r) => setTimeout(r, 250));
    assert.equal((capturedInputs[0] as { dryRun?: boolean }).dryRun, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("buildOcrApproveHandler creates SQLite dependency rows from approval fan-out task ids", async () => {
  const dir = join(tmpdir(), `ocr-approve-deps-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(rowsDir(dir), { recursive: true });
  try {
    const taskStore = createTaskStore(openControlDb({ trackerDir: dir }));
    const [parent] = taskStore.enqueueTasks({
      workflow: "oath-upload",
      inputs: [{ sessionId: "oath-parent" }],
      deriveItemId: () => "ocr-prep-session-approve-deps",
      runIds: ["oath-upload-run-deps"],
    });
    const ocrFile = rowFilePath("ocr", dateLocalForTest(), dir);
    writeFileSync(ocrFile, JSON.stringify({
      workflow: "ocr",
      id: "session-approve-deps",
      runId: "run-approve-deps",
      status: "done",
      step: "awaiting-approval",
      timestamp: "2026-05-01T00:00:00Z",
      parentRunId: "oath-upload-run-deps",
      data: {
        formType: "emergency-contact",
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
      records: [emergencyContactPreviewRecord("10000001", "Alice One")],
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

test("buildOcrApproveHandler: standalone OCR run (no parentRunId) is REJECTED with 400 (approval \u2261 delegation; legacy fan-out removed 2026-06-11)", async () => {
  const dir = join(tmpdir(), `ocr-approve-noparent-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(rowsDir(dir), { recursive: true });
  try {
    // Pre-write an OCR awaiting-approval entry WITHOUT parentRunId
    const ocrFile = rowFilePath("ocr", dateLocalForTest(), dir);
    writeFileSync(ocrFile, JSON.stringify({
      workflow: "ocr",
      id: "session-approve-2",
      runId: "run-approve-2",
      status: "done",
      step: "awaiting-approval",
      timestamp: "2026-05-01T00:00:00Z",
      data: {
        formType: "emergency-contact",
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

    const records = [emergencyContactPreviewRecord("10000003", "Carol Three")];

    const resp = await handler({
      sessionId: "session-approve-2",
      runId: "run-approve-2",
      records,
    });

    // Standalone approve is rejected loud: the UI never offers Approve for a
    // standalone run (it completes as a read-only review), and the legacy
    // both-targets fan-out was removed.
    assert.equal(resp.status, 400, `Expected 400 but got ${resp.status}: ${JSON.stringify(resp.body)}`);
    assert.match((resp.body as { error: string }).error, /[Ss]tandalone OCR runs have no approve flow/);
    assert.equal(capturedSpyArgs, undefined, "no fan-out is dispatched for a rejected standalone approve");

    // No post-approve entry is written either.
    const lines = readFileSync(ocrFile, "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const approvedEntry = lines.find((e: { step?: string }) => e.step === "approved");
    assert.equal(approvedEntry, undefined, "no post-approve entry for a rejected standalone approve");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("buildOcrApproveHandler approves without preview readiness props", async () => {
  const dir = join(tmpdir(), `ocr-approve-skip-preview-props-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(rowsDir(dir), { recursive: true });
  try {
    writeFileSync(rowFilePath("ocr", dateLocalForTest(), dir), JSON.stringify({
      workflow: "ocr",
      id: "session-preview-props-removed",
      runId: "run-preview-props-removed",
      parentRunId: "op-parent-preview-props",
      status: "done",
      step: "awaiting-approval",
      timestamp: "2026-05-01T00:00:00Z",
      data: {
        formType: "emergency-contact",
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
      records: [emergencyContactPreviewRecord("10000001", "Alice One")],
    });

    assert.equal(resp.status, 200);
    await new Promise((r) => setTimeout(r, 250));
    assert.ok(enqueueCalled);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("discard cascade-cancels still-queued delegated child tasks AND the dependency anchor (E2E-010)", async () => {
  const dir = setup();
  seedOcrPriorRow(dir, "s-cascade", "r-cascade");

  // Seed SQLite: two queued person-lookup children parented to the OCR run,
  // plus the task_kind=ocr dependency anchor (workflow=ocr, item=session).
  const control = openControlDb({ trackerDir: dir });
  const taskStore = createTaskStore(control);
  const children = taskStore.enqueueTasks({
    workflow: "person-lookup",
    inputs: [{ name: "Doe, Jane" }, { name: "Roe, Sam" }],
    deriveItemId: (_inp, idx) => `ocr-oath-r-cascade-r${idx}`,
    parentRunId: "r-cascade",
  });
  const [anchor] = taskStore.enqueueTasks({
    workflow: "ocr",
    inputs: [{ sessionId: "s-cascade" }],
    deriveItemId: () => "s-cascade",
    runIds: ["r-cascade"],
  });
  taskStore.db.prepare(`UPDATE tasks SET task_kind = 'ocr' WHERE id = ?`).run(anchor.taskId);

  const handler = buildOcrDiscardHandler({ trackerDir: dir });
  const resp = await handler({ sessionId: "s-cascade", runId: "r-cascade", reason: "operator discarded" });
  assert.equal(resp.status, 200);

  // Children: cancelled, never claimable for a discarded prep.
  for (const child of children) {
    assert.equal(taskStore.getTask(child.taskId)?.state, "cancelled", `child ${child.id} cancelled`);
  }
  // Anchor: terminal (cancelled), not a lingering queued/waiting zombie.
  assert.equal(taskStore.getTask(anchor.taskId)?.state, "cancelled", "anchor terminalized");
});
