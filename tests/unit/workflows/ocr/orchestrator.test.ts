import { test } from "vitest";
import assert from "node:assert";
import { mkdirSync, rmSync, readFileSync, existsSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rowFilePath, rowsDir } from "../../../../src/tracker/jsonl.js";
import type { WatchChildRunsOpts } from "../../../../src/tracker/delegation/watch-child-runs.js";
import { openStateDb } from "../../../../src/tracker/state/db.js";
import { registerLocalFile } from "../../../../src/tracker/files/files.js";
import { runOcrOrchestrator } from "../../../../src/workflows/ocr/orchestrator.js";
import { writeOnePagePdf } from "../../../_utils/one-page-pdf.js";
import { renderPdfPagesToPngs } from "../../../../src/services/ocr/render-pages.js";

async function setup(): Promise<{
  dir: string;
  uploadsDir: string;
  rosterPath: string;
  pdfPath: string;
  pdfFileId: string;
}> {
  const dir = join(tmpdir(), `ocr-orch-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  const uploadsDir = join(dir, "uploads");
  mkdirSync(uploadsDir, { recursive: true });
  const rosterPath = join(dir, "roster.xlsx");
  writeFileSync(rosterPath, ""); // stubbed
  const pdfPath = join(uploadsDir, "test.pdf");
  await writeOnePagePdf(pdfPath);
  const db = openStateDb(dir);
  const { fileId: pdfFileId } = registerLocalFile(db, {
    kind: "pdf",
    mimeType: "application/pdf",
    path: pdfPath,
    originalName: "test.pdf",
    source: "ocr-orchestrator-test",
  });
  const preRendered = await renderPdfPagesToPngs(pdfPath, join(dir, "fixture-render-check"));
  assert.ok(
    preRendered.length >= 1,
    "orchestrator fixture PDF must pre-render at least one preview page",
  );
  return { dir, uploadsDir, rosterPath, pdfPath, pdfFileId };
}

test("orchestrator emits pending → loading-roster → ocr → matching → done(awaiting-approval)", async () => {
  const { dir, rosterPath, pdfPath, pdfFileId } = await setup();
  const writtenEntries: object[] = [];

  await runOcrOrchestrator(
    {
      pdfPath,
      pdfOriginalName: "fake.pdf",
      pdfFileId,
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
          workflow: "person-lookup",
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

test("orchestrator's terminal failed row keeps the rich preview payload (mode/preview + records)", async () => {
  // Regression: a failed OCR prep run must stay a recognizable *preview* row so
  // the dashboard keeps showing its Preview tab. The orchestrator surfaces its
  // last rich snapshot via `onReviewData` (so the kernel handler can re-stamp
  // it onto the kernel's terminal failed row) AND carries that payload onto its
  // own `failed` row. Force a failure after the first preview snapshot emits.
  const { dir, rosterPath, pdfPath, pdfFileId } = await setup();
  const writtenEntries: any[] = [];
  const reviewPayloads: Array<Record<string, unknown>> = [];

  await assert.rejects(
    runOcrOrchestrator(
      {
        pdfPath,
        pdfOriginalName: "fake.pdf",
        pdfFileId,
        formType: "oath",
        sessionId: "session-fail",
        rosterPath,
        rosterMode: "existing",
      },
      {
        runId: "run-fail",
        trackerDir: dir,
        _emitOverride: (entry: any) => writtenEntries.push(entry),
        onReviewData: (data) => reviewPayloads.push(data),
        // Throw after the placeholder "ocr" snapshot has already emitted, so a
        // rich review payload is captured before the orchestrator unwinds.
        _ocrPipelineOverride: async () => { throw new Error("boom ocr"); },
        _loadRosterOverride: async () => [{ eid: "10000001", name: "Liam Kustenbauder" }],
        _enqueueEidLookupOverride: async () => { /* no-op */ },
        _watchChildRunsOverride: async () => [],
      },
    ),
    /boom ocr/,
  );

  // onReviewData fired at least once with the preview records.
  assert.ok(reviewPayloads.length >= 1, "onReviewData should surface the preview payload");
  assert.ok(Array.isArray(reviewPayloads[0]!.records), "review payload carries records");

  const failed = writtenEntries.find((e) => e.status === "failed");
  assert.ok(failed, "a terminal failed row should be emitted");
  assert.equal(failed.data.mode, "prepare", "failed row keeps the prep mode");
  assert.equal(failed.data.archetype, "preview", "failed row keeps the preview archetype");
  const failedRecords = JSON.parse(failed.data.records ?? "[]");
  assert.ok(Array.isArray(failedRecords) && failedRecords.length >= 1, "failed row carries the extracted records");
  assert.match(failed.error, /boom ocr/);

  rmSync(dir, { recursive: true, force: true });
});

test("orchestrator drives the session timeline via onPhase for each running phase", async () => {
  const { dir, rosterPath, pdfPath, pdfFileId } = await setup();
  const phases: string[] = [];

  await runOcrOrchestrator(
    {
      pdfPath,
      pdfOriginalName: "fake.pdf",
      pdfFileId,
      formType: "oath",
      sessionId: "session-phase",
      rosterPath,
      rosterMode: "existing",
    },
    {
      runId: "run-phase",
      trackerDir: dir,
      // onPhase is the kernel bridge (ctx.reportPhase) that mirrors OCR's
      // progress into the session-drawer timeline. It must fire for every
      // non-terminal phase even though OCR owns its own queue-row emission.
      onPhase: (step) => phases.push(step),
      _emitOverride: () => { /* swallow queue rows; we only assert phases */ },
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
          workflow: "person-lookup",
          itemId: "ocr-oath-run-phase-r0",
          runId: "verify-1",
          status: "done" as const,
          data: { hrStatus: "Active", department: "HDH", personOrgScreenshot: "x.png", emplId: "10000001" },
        },
      ],
    },
  );

  assert.ok(phases.includes("loading-roster"), `phases: ${phases.join(", ")}`);
  assert.ok(phases.includes("ocr"), `phases: ${phases.join(", ")}`);
  assert.ok(phases.includes("matching"), `phases: ${phases.join(", ")}`);
  assert.ok(phases.includes("awaiting-approval"), `phases: ${phases.join(", ")}`);
  // Bridge only fires on non-terminal (running) rows, never a bare terminal.
  assert.ok(phases.every((p) => p.length > 0), `phases: ${phases.join(", ")}`);

  rmSync(dir, { recursive: true, force: true });
});

test("orchestrator with previousRunId carries forward v1 EIDs", async () => {
  const { dir, rosterPath, pdfPath, pdfFileId } = await setup();
  // Pre-populate v1 history in JSONL
  mkdirSync(rowsDir(dir), { recursive: true });
  const ocrFile = rowFilePath("ocr", "2026-05-01", dir);
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
      pdfPath,
      pdfOriginalName: "fake-v2.pdf",
      pdfFileId,
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
  const { dir, rosterPath, pdfPath, pdfFileId } = await setup();
  let watcherCalled = false;
  let dependencyBatchCreated = false;

  await runOcrOrchestrator(
    {
      pdfPath,
      pdfOriginalName: "fake.pdf",
      pdfFileId,
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
        assert.equal(children[0].workflow, "person-lookup");
        assert.equal(children[0].recordIndex, 0);
        assert.equal(children[0].lookupKind, "name");
      },
      _scheduleDependencyTickOverride: async () => ({ ok: true }),
    },
  );

  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(dependencyBatchCreated, true);
  assert.equal(watcherCalled, true);
  rmSync(dir, { recursive: true, force: true });
});

test("orchestrator waits for eid-lookup results before completing awaiting-approval", async () => {
  const { dir, rosterPath, pdfPath, pdfFileId } = await setup();
  const writtenEntries: object[] = [];
  let watcherCalled = false;

  await runOcrOrchestrator(
    {
      pdfPath,
      pdfOriginalName: "fake.pdf",
      pdfFileId,
      formType: "oath",
      sessionId: "session-wait-eid",
      rosterPath,
      rosterMode: "existing",
    },
    {
      runId: "run-wait-eid",
      trackerDir: dir,
      _emitOverride: (entry: any) => writtenEntries.push(entry),
      _ocrPipelineOverride: async () => ({
        data: [{
          sourcePage: 1,
          rowIndex: 0,
          printedName: "Carlos D. Barahona Martell",
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
        await new Promise((resolve) => setTimeout(resolve, 10));
        return [{
          workflow: "person-lookup",
          itemId: "ocr-oath-run-wait-eid-r0",
          runId: "eid-run-1",
          status: "done" as const,
          data: {
            emplId: "10873698",
            hrStatus: "Active",
            department: "HDH Dining",
            personOrgScreenshot: "person-org.png",
          },
        }];
      },
      _disableSqliteDependencies: true,
    },
  );

  assert.equal(watcherCalled, true);
  // New approval contract (2026-05-25): awaiting-approval row carries
  // status="running" until the operator approves; it never reaches "done"
  // from the orchestrator.
  const approval = (writtenEntries as Array<{ status: string; step?: string; data?: Record<string, string> }>).find(
    (entry) => entry.status === "running" && entry.step === "awaiting-approval",
  );
  assert.ok(approval, "awaiting-approval row should be emitted as running after child lookup returns");
  const records = JSON.parse(approval.data?.records ?? "[]") as Array<Record<string, unknown>>;
  assert.equal(records[0]?.employeeId, "10873698");
  assert.deepEqual((records[0]?.verification as Record<string, unknown>)?.state, "verified");
  rmSync(dir, { recursive: true, force: true });
});

test("orchestrator patches child outcomes once when progress and final outcomes both include a failure", async () => {
  const { dir, rosterPath, pdfPath, pdfFileId } = await setup();
  const writtenEntries: object[] = [];
  const outcome = {
    workflow: "person-lookup",
    itemId: "ocr-oath-run-single-patch-r0",
    runId: "eid-run-failed",
    status: "failed" as const,
    data: {},
    error: "failed",
  };

  await runOcrOrchestrator(
    {
      pdfPath,
      pdfOriginalName: "fake.pdf",
      pdfFileId,
      formType: "oath",
      sessionId: "session-single-patch",
      rosterPath,
      rosterMode: "existing",
    },
    {
      runId: "run-single-patch",
      trackerDir: dir,
      _emitOverride: (entry: any) => writtenEntries.push(entry),
      _ocrPipelineOverride: async () => ({
        data: [{
          sourcePage: 1,
          rowIndex: 0,
          printedName: "Carlos D. Barahona Martell",
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
      _disableSqliteDependencies: true,
      _watchChildRunsOverride: async (opts: any) => {
        opts.onProgress?.(outcome, 0);
        return [outcome];
      },
    },
  );

  // New approval contract (2026-05-25): awaiting-approval row is status="running".
  const approval = (writtenEntries as Array<{ status: string; step?: string; data?: Record<string, string> }>).find(
    (entry) => entry.status === "running" && entry.step === "awaiting-approval",
  );
  assert.ok(approval, "awaiting-approval row should be emitted as running after child lookup returns");
  const records = JSON.parse(approval.data?.records ?? "[]") as Array<{ warnings?: string[] }>;
  assert.equal(records[0]?.warnings?.filter((warning) => warning === "eid-lookup failed").length, 1);
  rmSync(dir, { recursive: true, force: true });
});

test("orchestrator pre-emits delegated eid-lookup pending rows before daemon auth", async () => {
  const { dir, rosterPath, pdfPath, pdfFileId } = await setup();
  const writtenEntries: object[] = [];

  await runOcrOrchestrator(
    {
      pdfPath,
      pdfOriginalName: "fake.pdf",
      pdfFileId,
      formType: "oath",
      sessionId: "session-preemit-eid",
      rosterPath,
      rosterMode: "existing",
    },
    {
      runId: "run-preemit-eid",
      trackerDir: dir,
      _emitOverride: (entry: any) => writtenEntries.push(entry),
      _ocrPipelineOverride: async () => ({
        data: [{
          sourcePage: 1,
          rowIndex: 0,
          printedName: "Carlos D. Barahona Martell",
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
      _disableSqliteDependencies: true,
      _watchChildRunsOverride: async () => [{
        workflow: "person-lookup",
        itemId: "ocr-oath-run-preemit-eid-r0",
        runId: "eid-run-1",
        status: "done" as const,
        data: { emplId: "10873698", hrStatus: "Active", department: "HDH" },
      }],
    },
  );

  const eidFileName = readdirSync(rowsDir(dir)).find((file) => /^person-lookup-\d{4}-\d{2}-\d{2}\.jsonl$/.test(file));
  assert.ok(eidFileName, "expected a person-lookup tracker file");
  const eidFile = join(rowsDir(dir), eidFileName);
  assert.equal(existsSync(eidFile), true, "delegated person-lookup pending row should be written immediately");
  const entries = readFileSync(eidFile, "utf-8").trim().split("\n").map((line) => JSON.parse(line));
  const pending = entries.find((entry: any) => entry.status === "pending" && entry.id === "ocr-oath-run-preemit-eid-r0");
  assert.ok(pending, "expected pre-emitted pending person-lookup row");
  assert.equal(pending.data.searchName, "Barahona Martell, Carlos D");
  // New approval contract (2026-05-25): awaiting-approval is status="running".
  assert.equal(writtenEntries.some((entry: any) => entry.status === "running" && entry.step === "awaiting-approval"), true);
  rmSync(dir, { recursive: true, force: true });
});

test("orchestrator dispatches eid-lookup by EID when roster supplies a UCPath employee id", async () => {
  const { dir, rosterPath, pdfPath, pdfFileId } = await setup();
  const writtenEntries: object[] = [];
  let eidLookupItems: Array<{ name?: string; emplId?: string; itemId: string }> = [];

  await runOcrOrchestrator(
    {
      pdfPath,
      pdfOriginalName: "fake.pdf",
      pdfFileId,
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
      _disableSqliteDependencies: true,
      _watchChildRunsOverride: async ({ expectedItemIds }: WatchChildRunsOpts) =>
        expectedItemIds.map((itemId) => ({
          workflow: "person-lookup",
          itemId,
          runId: "eid-run-active-mock",
          status: "done" as const,
          data: {
            emplId: "10000001",
            hrStatus: "Active",
            department: "Housing Dining Hospitality",
            activeStatus: "active",
            isActive: "true",
            isHdhAccepted: "true",
          },
        })),
    } as never,
  );

  assert.equal(eidLookupItems.length, 1);
  assert.equal(eidLookupItems[0].emplId, "10000001");
  assert.match(eidLookupItems[0].itemId, /^ocr-oath-run-active-r0$/);
  const steps = writtenEntries.map((e: any) => `${e.status}/${e.step ?? ""}`);
  assert.ok(steps.some((s) => s.includes("eid-lookup")), `steps: ${steps.join(", ")}`);
  rmSync(dir, { recursive: true, force: true });
});

test("orchestrator treats non-UCPath employee ids as missing and falls back to name lookup", async () => {
  const { dir, rosterPath, pdfPath, pdfFileId } = await setup();
  let eidLookupItems: Array<{ name?: string; emplId?: string; itemId: string }> = [];

  await runOcrOrchestrator(
    {
      pdfPath,
      pdfOriginalName: "fake.pdf",
      pdfFileId,
      formType: "oath",
      sessionId: "session-invalid-eid",
      rosterPath,
      rosterMode: "existing",
    },
    {
      runId: "run-invalid-eid",
      trackerDir: dir,
      _ocrPipelineOverride: async () => ({
        data: [{
          sourcePage: 1,
          rowIndex: 0,
          printedName: "Carlos Barahona",
          employeeId: "12345",
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
      _enqueueEidLookupOverride: async (items: Array<{ name?: string; emplId?: string; itemId: string }>) => {
        eidLookupItems = items;
      },
      _lookupSuggestionOverride: async () => [],
      _disableSqliteDependencies: true,
      _watchChildRunsOverride: async () => [],
    } as never,
  );

  assert.equal(eidLookupItems.length, 1);
  assert.equal(eidLookupItems[0].name, "Barahona, Carlos");
  assert.equal(eidLookupItems[0].emplId, undefined);
  rmSync(dir, { recursive: true, force: true });
});

test("orchestrator records SQLite dependencies for eid-lookup fan-out (verify-by-EID)", async () => {
  const { dir, rosterPath, pdfPath, pdfFileId } = await setup();
  const runId = "00000000-0000-4000-8000-0000000000ab";
  let watcherCalled = false;
  let dependencyBatchCreated = false;

  await runOcrOrchestrator(
    {
      pdfPath,
      pdfOriginalName: "fake.pdf",
      pdfFileId,
      formType: "oath",
      sessionId: "session-active-deps",
      rosterPath,
      rosterMode: "existing",
    },
    {
      runId,
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
      _enqueueEidLookupOverride: async () => {},
      _createDependencyBatchOverride: async ({ parent, children }) => {
        dependencyBatchCreated = true;
        assert.equal(parent.workflow, "ocr");
        assert.equal(parent.itemId, "session-active-deps");
        assert.equal(parent.runId, runId);
        assert.equal(children.length, 1);
        assert.equal(children[0].workflow, "person-lookup");
        assert.equal(children[0].itemId, `ocr-oath-${runId}-r0`);
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
  assert.equal(watcherCalled, true);
  rmSync(dir, { recursive: true, force: true });
});

test("orchestrator uses LLM suggestion EIDs but enqueues only OCR name when fuzzy roster matching has no candidates", async () => {
  const { dir, rosterPath, pdfPath, pdfFileId } = await setup();
  let eidLookupItems: Array<{ name?: string; emplId?: string; itemId: string }> = [];

  await runOcrOrchestrator(
    {
      pdfPath,
      pdfOriginalName: "fake.pdf",
      pdfFileId,
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
      _disableSqliteDependencies: true,
      _watchChildRunsOverride: async () => [],
    } as never,
  );

  assert.ok(eidLookupItems.some((item) => item.name === "Batistessa, Jhn"));
  assert.ok(eidLookupItems.some((item) => item.emplId === "10873698"));
  assert.equal(eidLookupItems.filter((item) => item.name !== undefined).length, 1);
  rmSync(dir, { recursive: true, force: true });
});

test("orchestrator collapses lookup name variants to the candidate with the most words", async () => {
  const { dir, rosterPath, pdfPath, pdfFileId } = await setup();
  let eidLookupItems: Array<{ name?: string; emplId?: string; itemId: string }> = [];

  await runOcrOrchestrator(
    {
      pdfPath,
      pdfOriginalName: "fake.pdf",
      pdfFileId,
      formType: "oath",
      sessionId: "session-name-variants",
      rosterPath,
      rosterMode: "existing",
    },
    {
      runId: "run-name-variants",
      trackerDir: dir,
      _ocrPipelineOverride: async () => ({
        data: [{
          sourcePage: 1,
          rowIndex: 0,
          printedName: "Barahona Martell, Carlos",
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
        { name: "Barahona Martell, Carlos D", confidence: 0.85 },
        { name: "Barahona Martell, Carlos", confidence: 0.74 },
        { name: "Barahona, Carlos D", confidence: 0.73 },
      ],
      _enqueueEidLookupOverride: async (items: Array<{ name?: string; emplId?: string; itemId: string }>) => {
        eidLookupItems = items;
      },
      _disableSqliteDependencies: true,
      _watchChildRunsOverride: async () => [],
    } as never,
  );

  const nameItems = eidLookupItems.filter((item) => item.name !== undefined);
  assert.deepEqual(nameItems.map((item) => item.name), ["Barahona Martell, Carlos D"]);
  rmSync(dir, { recursive: true, force: true });
});

test("orchestrator falls back to watchChildRuns when dependency creation fails", async () => {
  const { dir, rosterPath, pdfPath, pdfFileId } = await setup();
  let watcherCalled = false;

  await runOcrOrchestrator(
    {
      pdfPath,
      pdfOriginalName: "fake.pdf",
      pdfFileId,
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
  const { dir, rosterPath, pdfPath, pdfFileId } = await setup();
  const previous = process.env.OCR_SQLITE_DEPENDENCIES;
  process.env.OCR_SQLITE_DEPENDENCIES = "0";
  let watcherCalled = false;
  let dependencyBatchCreated = false;

  try {
    await runOcrOrchestrator(
      {
        pdfPath,
        pdfOriginalName: "fake.pdf",
        pdfFileId,
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
  const { dir, uploadsDir, pdfPath, pdfFileId } = await setup();
  let watchWorkflow = "";

  await runOcrOrchestrator(
    {
      pdfPath,
      pdfOriginalName: "fake.pdf",
      pdfFileId,
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
  const { dir, rosterPath, pdfPath, pdfFileId } = await setup();
  const writtenEntries: object[] = [];

  await runOcrOrchestrator(
    {
      pdfPath,
      pdfOriginalName: "fake.pdf",
      pdfFileId,
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
          workflow: "person-lookup",
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

