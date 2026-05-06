import { test } from "node:test";
import assert from "node:assert";
import { mkdirSync, rmSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runOcrOrchestrator } from "../../../../src/workflows/ocr/orchestrator.js";

function setup(): { dir: string; uploadsDir: string; rosterPath: string } {
  const dir = join(tmpdir(), `ocr-orch-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  const uploadsDir = join(dir, "uploads");
  mkdirSync(uploadsDir, { recursive: true });
  const rosterPath = join(dir, "roster.xlsx");
  writeFileSync(rosterPath, ""); // stubbed
  return { dir, uploadsDir, rosterPath };
}

test("orchestrator emits pending → loading-roster → ocr → matching → done(awaiting-approval)", async () => {
  const { dir, rosterPath } = setup();
  const writtenEntries: object[] = [];

  await runOcrOrchestrator(
    {
      pdfPath: "/tmp/fake.pdf",
      pdfOriginalName: "fake.pdf",
      formType: "oath",
      sessionId: "session-1",
      rosterPath,
      rosterMode: "existing",
    },
    {
      runId: "run-1",
      trackerDir: dir,
      _emitOverride: (entry: any) => writtenEntries.push(entry),
      _ocrPipelineOverride: async () => ({
        data: [{
          sourcePage: 1, rowIndex: 0,
          printedName: "Liam Kustenbauder",
          employeeSigned: true, officerSigned: true, dateSigned: "05/01/2026",
          notes: [], documentType: "expected", originallyMissing: [],
        }],
        provider: "stub",
        attempts: 1,
        cached: false,
      }),
      _loadRosterOverride: async () => [
        { eid: "10000001", name: "Liam Kustenbauder" },
      ],
      _enqueueEidLookupOverride: async () => { /* no-op */ },
      _watchChildRunsOverride: async () => [
        {
          workflow: "eid-lookup",
          itemId: "ocr-oath-run-1-r0",
          runId: "verify-1",
          status: "done" as const,
          data: { hrStatus: "Active", department: "HDH", personOrgScreenshot: "x.png", emplId: "10000001" },
        },
      ],
    },
  );

  const steps = writtenEntries.map((e: any) => `${e.status}/${e.step ?? ""}`);
  assert.ok(steps.includes("pending/"), `steps: ${steps.join(", ")}`);
  assert.ok(steps.some((s) => s.includes("loading-roster")), `steps: ${steps.join(", ")}`);
  assert.ok(steps.some((s) => s.includes("ocr")), `steps: ${steps.join(", ")}`);
  assert.ok(steps.some((s) => s.includes("matching")), `steps: ${steps.join(", ")}`);
  assert.ok(steps.some((s) => s === "running/awaiting-approval" || s === "done/awaiting-approval"), `steps: ${steps.join(", ")}`);

  const approval = (writtenEntries as Array<{ status: string; step?: string; data?: Record<string, string> }>).find(
    (e) => (e.status === "running" || e.status === "done") && e.step === "awaiting-approval",
  );
  assert.ok(approval);
  const summary = JSON.parse(approval!.data!.pageStatusSummary ?? "{}");
  assert.deepEqual(summary, { total: 0, succeeded: 0, failed: 0 });
  const failedPages = JSON.parse(approval!.data!.failedPages ?? "[]");
  assert.deepEqual(failedPages, []);

  rmSync(dir, { recursive: true, force: true });
});

test("orchestrator with previousRunId carries forward v1 EIDs", async () => {
  const { dir, rosterPath } = setup();
  // Pre-populate v1 history in JSONL
  const ocrFile = join(dir, "ocr-2026-05-01.jsonl");
  writeFileSync(ocrFile, JSON.stringify({
    workflow: "ocr", id: "session-1", runId: "run-prev",
    status: "done", step: "approved",
    data: {
      records: JSON.stringify([{
        sourcePage: 1, rowIndex: 0,
        printedName: "Liam Kustenbauder",
        employeeSigned: true, officerSigned: true, dateSigned: "05/01/2026",
        notes: [], documentType: "expected", originallyMissing: [],
        employeeId: "10000001",
        matchState: "resolved", matchSource: "eid-lookup",
        selected: true, warnings: [],
        verification: { state: "verified", hrStatus: "Active", department: "HDH", screenshotFilename: "x.png", checkedAt: "2026-05-01T00:00:00Z" },
      }]),
    },
    timestamp: "2026-05-01T00:00:00Z",
  }) + "\n");

  let watchCalled = false;
  await runOcrOrchestrator(
    {
      pdfPath: "/tmp/fake.pdf",
      pdfOriginalName: "fake-v2.pdf",
      formType: "oath",
      sessionId: "session-1",
      rosterPath,
      rosterMode: "existing",
      previousRunId: "run-prev",
    },
    {
      runId: "run-2",
      trackerDir: dir,
      date: "2026-05-01",
      _ocrPipelineOverride: async () => ({
        data: [{
          sourcePage: 1, rowIndex: 0,
          printedName: "Liam Kustenbauder",
          employeeSigned: true, officerSigned: true, dateSigned: "05/01/2026",
          notes: [], documentType: "expected", originallyMissing: [],
        }],
        provider: "stub", attempts: 1, cached: false,
      }),
      _loadRosterOverride: async () => [{ eid: "10000001", name: "Liam Kustenbauder" }],
      _watchChildRunsOverride: async () => {
        watchCalled = true;
        return [];
      },
    },
  );

  assert.equal(watchCalled, false, "watchChildRuns should not be called when carry-forward fully resolves");
  rmSync(dir, { recursive: true, force: true });
});

test("orchestrator uses SQLite dependencies for initial eid-lookup fan-out", async () => {
  const { dir, rosterPath } = setup();
  let watcherCalled = false;
  let dependencyBatchCreated = false;

  await runOcrOrchestrator(
    {
      pdfPath: "/tmp/fake.pdf",
      pdfOriginalName: "fake.pdf",
      formType: "oath",
      sessionId: "session-deps",
      rosterPath,
      rosterMode: "existing",
    },
    {
      runId: "run-deps",
      trackerDir: dir,
      _ocrPipelineOverride: async () => ({
        data: [{
          sourcePage: 1,
          rowIndex: 0,
          printedName: "Liam Kustenbauder",
          employeeSigned: true,
          officerSigned: true,
          dateSigned: "05/01/2026",
          notes: [],
          documentType: "expected",
          originallyMissing: [],
        }],
        provider: "stub",
        attempts: 1,
        cached: false,
      }),
      _loadRosterOverride: async () => [{ eid: "10000001", name: "Different Person" }],
      _enqueueEidLookupOverride: async () => {},
      _watchChildRunsOverride: async () => {
        watcherCalled = true;
        return [];
      },
      _createDependencyBatchOverride: async ({ parent, children }) => {
        dependencyBatchCreated = true;
        assert.equal(parent.workflow, "ocr");
        assert.equal(parent.itemId, "session-deps");
        assert.equal(parent.runId, "run-deps");
        assert.equal(children.length, 1);
        assert.equal(children[0].workflow, "eid-lookup");
        assert.equal(children[0].recordIndex, 0);
        assert.equal(children[0].lookupKind, "name");
      },
      _scheduleDependencyTickOverride: async () => ({ ok: true }),
    },
  );

  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(dependencyBatchCreated, true);
  assert.equal(watcherCalled, false);
  rmSync(dir, { recursive: true, force: true });
});

test("orchestrator dispatches active-check for records that already have an EID", async () => {
  const { dir, rosterPath } = setup();
  const writtenEntries: object[] = [];
  let eidLookupItems: Array<{ name?: string; emplId?: string; itemId: string }> = [];
  let activeCheckItems: Array<{ name?: string; emplId?: string; itemId: string }> = [];

  await runOcrOrchestrator(
    {
      pdfPath: "/tmp/fake.pdf",
      pdfOriginalName: "fake.pdf",
      formType: "oath",
      sessionId: "session-active",
      rosterPath,
      rosterMode: "existing",
    },
    {
      runId: "run-active",
      trackerDir: dir,
      _emitOverride: (entry: any) => writtenEntries.push(entry),
      _ocrPipelineOverride: async () => ({
        data: [{
          sourcePage: 1,
          rowIndex: 0,
          printedName: "Liam Kustenbauder",
          employeeSigned: true,
          officerSigned: true,
          dateSigned: "05/01/2026",
          notes: [],
          documentType: "expected",
          originallyMissing: [],
        }],
        provider: "stub",
        attempts: 1,
        cached: false,
      }),
      _loadRosterOverride: async () => [{ eid: "10000001", name: "Liam Kustenbauder" }],
      _enqueueEidLookupOverride: async (items: Array<{ name?: string; emplId?: string; itemId: string }>) => {
        eidLookupItems = items;
      },
      _enqueueActiveCheckOverride: async (items: Array<{ name?: string; emplId?: string; itemId: string }>) => {
        activeCheckItems = items;
      },
      _disableSqliteDependencies: true,
    } as never,
  );

  assert.equal(eidLookupItems.length, 0, "records that already have an EID should not run eid-lookup");
  assert.equal(activeCheckItems.length, 1);
  assert.equal(activeCheckItems[0].emplId, "10000001");
  assert.match(activeCheckItems[0].itemId, /^ocr-active-run-active-r0$/);
  const steps = writtenEntries.map((e: any) => `${e.status}/${e.step ?? ""}`);
  assert.ok(steps.some((s) => s.includes("active-check")), `steps: ${steps.join(", ")}`);
  rmSync(dir, { recursive: true, force: true });
});

test("orchestrator records SQLite dependencies for active-check fan-out", async () => {
  const { dir, rosterPath } = setup();
  let watcherCalled = false;
  let dependencyBatchCreated = false;

  await runOcrOrchestrator(
    {
      pdfPath: "/tmp/fake.pdf",
      pdfOriginalName: "fake.pdf",
      formType: "oath",
      sessionId: "session-active-deps",
      rosterPath,
      rosterMode: "existing",
    },
    {
      runId: "run-active-deps",
      trackerDir: dir,
      _ocrPipelineOverride: async () => ({
        data: [{
          sourcePage: 1,
          rowIndex: 0,
          printedName: "Liam Kustenbauder",
          employeeSigned: true,
          officerSigned: true,
          dateSigned: "05/01/2026",
          notes: [],
          documentType: "expected",
          originallyMissing: [],
        }],
        provider: "stub",
        attempts: 1,
        cached: false,
      }),
      _loadRosterOverride: async () => [{ eid: "10000001", name: "Liam Kustenbauder" }],
      _enqueueActiveCheckOverride: async () => {},
      _createActiveCheckDependencyBatchOverride: async ({ parent, children }) => {
        dependencyBatchCreated = true;
        assert.equal(parent.workflow, "ocr");
        assert.equal(parent.itemId, "session-active-deps");
        assert.equal(parent.runId, "run-active-deps");
        assert.equal(children.length, 1);
        assert.equal(children[0].workflow, "active-check");
        assert.equal(children[0].itemId, "ocr-active-run-active-deps-r0");
        assert.equal(children[0].recordIndex, 0);
        assert.equal(children[0].lookupKind, "verify");
      },
      _scheduleDependencyTickOverride: async () => ({ ok: true }),
      _watchChildRunsOverride: async () => {
        watcherCalled = true;
        return [];
      },
    },
  );

  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(dependencyBatchCreated, true);
  assert.equal(watcherCalled, false);
  rmSync(dir, { recursive: true, force: true });
});

test("orchestrator uses LLM lookup suggestions when fuzzy roster matching has no candidates", async () => {
  const { dir, rosterPath } = setup();
  let eidLookupItems: Array<{ name?: string; emplId?: string; itemId: string }> = [];
  let activeCheckItems: Array<{ name?: string; emplId?: string; itemId: string }> = [];

  await runOcrOrchestrator(
    {
      pdfPath: "/tmp/fake.pdf",
      pdfOriginalName: "fake.pdf",
      formType: "oath",
      sessionId: "session-suggestions",
      rosterPath,
      rosterMode: "existing",
    },
    {
      runId: "run-suggestions",
      trackerDir: dir,
      _ocrPipelineOverride: async () => ({
        data: [{
          sourcePage: 1,
          rowIndex: 0,
          printedName: "Jhn Batistessa",
          employeeSigned: true,
          officerSigned: true,
          dateSigned: "05/01/2026",
          notes: [],
          documentType: "expected",
          originallyMissing: [],
        }],
        provider: "stub",
        attempts: 1,
        cached: false,
      }),
      _loadRosterOverride: async () => [{ eid: "10000001", name: "Unrelated Person" }],
      _lookupSuggestionOverride: async () => [
        { name: "Johnnie Battistessa", confidence: 0.72 },
        { emplId: "10873698", confidence: 0.81 },
      ],
      _enqueueEidLookupOverride: async (items: Array<{ name?: string; emplId?: string; itemId: string }>) => {
        eidLookupItems = items;
      },
      _enqueueActiveCheckOverride: async (items: Array<{ name?: string; emplId?: string; itemId: string }>) => {
        activeCheckItems = items;
      },
      _disableSqliteDependencies: true,
      _watchChildRunsOverride: async () => [],
    } as never,
  );

  assert.ok(eidLookupItems.some((item) => item.name === "Johnnie Battistessa"));
  assert.ok(eidLookupItems.some((item) => item.name === "jhn batistessa"));
  assert.ok(activeCheckItems.some((item) => item.emplId === "10873698"));
  rmSync(dir, { recursive: true, force: true });
});

test("orchestrator falls back to watchChildRuns when dependency creation fails", async () => {
  const { dir, rosterPath } = setup();
  let watcherCalled = false;

  await runOcrOrchestrator(
    {
      pdfPath: "/tmp/fake.pdf",
      pdfOriginalName: "fake.pdf",
      formType: "oath",
      sessionId: "session-fallback",
      rosterPath,
      rosterMode: "existing",
    },
    {
      runId: "run-fallback",
      trackerDir: dir,
      _ocrPipelineOverride: async () => ({
        data: [{
          sourcePage: 1,
          rowIndex: 0,
          printedName: "Liam Kustenbauder",
          employeeSigned: true,
          officerSigned: true,
          dateSigned: "05/01/2026",
          notes: [],
          documentType: "expected",
          originallyMissing: [],
        }],
        provider: "stub",
        attempts: 1,
        cached: false,
      }),
      _loadRosterOverride: async () => [{ eid: "10000001", name: "Different Person" }],
      _enqueueEidLookupOverride: async () => {},
      _createDependencyBatchOverride: async () => {
        throw new Error("db unavailable");
      },
      _watchChildRunsOverride: async () => {
        watcherCalled = true;
        return [];
      },
    },
  );

  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(watcherCalled, true);
  rmSync(dir, { recursive: true, force: true });
});

test("orchestrator uses watcher fallback when OCR_SQLITE_DEPENDENCIES is disabled", async () => {
  const { dir, rosterPath } = setup();
  const previous = process.env.OCR_SQLITE_DEPENDENCIES;
  process.env.OCR_SQLITE_DEPENDENCIES = "0";
  let watcherCalled = false;
  let dependencyBatchCreated = false;

  try {
    await runOcrOrchestrator(
      {
        pdfPath: "/tmp/fake.pdf",
        pdfOriginalName: "fake.pdf",
        formType: "oath",
        sessionId: "session-env-fallback",
        rosterPath,
        rosterMode: "existing",
      },
      {
        runId: "run-env-fallback",
        trackerDir: dir,
        _ocrPipelineOverride: async () => ({
          data: [{
            sourcePage: 1,
            rowIndex: 0,
            printedName: "Liam Kustenbauder",
            employeeSigned: true,
            officerSigned: true,
            dateSigned: "05/01/2026",
            notes: [],
            documentType: "expected",
            originallyMissing: [],
          }],
          provider: "stub",
          attempts: 1,
          cached: false,
        }),
        _loadRosterOverride: async () => [{ eid: "10000001", name: "Different Person" }],
        _enqueueEidLookupOverride: async () => {},
        _createDependencyBatchOverride: async () => {
          dependencyBatchCreated = true;
        },
        _watchChildRunsOverride: async () => {
          watcherCalled = true;
          return [];
        },
      },
    );

    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(dependencyBatchCreated, false);
    assert.equal(watcherCalled, true);
  } finally {
    if (previous === undefined) {
      delete process.env.OCR_SQLITE_DEPENDENCIES;
    } else {
      process.env.OCR_SQLITE_DEPENDENCIES = previous;
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

test("rosterMode=download delegates to sharepoint-download via watchChildRuns", async () => {
  const { dir, uploadsDir } = setup();
  let watchWorkflow = "";

  await runOcrOrchestrator(
    {
      pdfPath: "/tmp/fake.pdf",
      pdfOriginalName: "fake.pdf",
      formType: "oath",
      sessionId: "session-sp",
      rosterMode: "download",
      // no rosterPath — should be resolved from SharePoint
    },
    {
      runId: "run-sp",
      trackerDir: dir,
      _emitOverride: () => {},
      _ocrPipelineOverride: async () => ({
        data: [],
        provider: "stub", attempts: 1, cached: false,
      }),
      _loadRosterOverride: async () => [],
      _skipSharepointDispatch: true,
      _watchChildRunsOverride: async (opts) => {
        watchWorkflow = opts.workflow;
        if (opts.workflow === "sharepoint-download") {
          return [{
            workflow: "sharepoint-download",
            itemId: opts.expectedItemIds[0] ?? "onboarding",
            runId: "sp-run",
            status: "done" as const,
            data: { path: "/tmp/roster.xlsx" },
          }];
        }
        return [];
      },
      _enqueueEidLookupOverride: async () => {},
    },
  );

  assert.equal(watchWorkflow, "sharepoint-download", "should have watched sharepoint-download");
  rmSync(dir, { recursive: true, force: true });
});

test("orchestrator surfaces failedPages and pageStatusSummary on awaiting-approval", async () => {
  const { dir, rosterPath } = setup();
  const writtenEntries: object[] = [];

  await runOcrOrchestrator(
    {
      pdfPath: "/tmp/fake.pdf",
      pdfOriginalName: "fake.pdf",
      formType: "oath",
      sessionId: "session-fp-1",
      rosterPath,
      rosterMode: "existing",
    },
    {
      runId: "run-fp-1",
      trackerDir: dir,
      _emitOverride: (entry) => writtenEntries.push(entry),
      _ocrPipelineOverride: async () => ({
        data: [{
          sourcePage: 1, rowIndex: 0,
          printedName: "Liam Kustenbauder",
          employeeSigned: true, officerSigned: true, dateSigned: "05/01/2026",
          notes: [], documentType: "expected", originallyMissing: [],
        }],
        provider: "stub",
        attempts: 3,
        cached: false,
        pages: [
          { page: 1, success: true, attemptedKeys: ["gemini-1"], poolKeyId: "gemini-1" },
          { page: 2, success: false, error: "rate limit", attemptedKeys: ["mistral-1"] },
          { page: 3, success: true, attemptedKeys: ["groq-1"], poolKeyId: "groq-1" },
        ],
      }),
      _loadRosterOverride: async () => [
        { eid: "10000001", name: "Liam Kustenbauder" },
      ],
      _enqueueEidLookupOverride: async () => { /* no-op */ },
      _watchChildRunsOverride: async () => [
        {
          workflow: "eid-lookup",
          itemId: "ocr-oath-run-fp-1-r0",
          runId: "verify-1",
          status: "done" as const,
          data: { hrStatus: "Active", department: "HDH", personOrgScreenshot: "x.png", emplId: "10000001" },
        },
      ],
    },
  );

  const approval = (writtenEntries as Array<{ status: string; step?: string; data?: Record<string, string> }>).find(
    (e) => (e.status === "running" || e.status === "done") && e.step === "awaiting-approval",
  );
  assert.ok(approval, "awaiting-approval entry written");
  const failedPages = JSON.parse(approval!.data!.failedPages ?? "[]") as Array<{ page: number; attempts: number }>;
  assert.equal(failedPages.length, 1, "one failed page");
  assert.equal(failedPages[0].page, 2);
  assert.equal(failedPages[0].attempts, 1);
  const summary = JSON.parse(approval!.data!.pageStatusSummary ?? "{}") as {
    total: number; succeeded: number; failed: number;
  };
  assert.deepEqual(summary, { total: 3, succeeded: 2, failed: 1 });

  rmSync(dir, { recursive: true, force: true });
});
