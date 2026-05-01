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
      _emitOverride: (entry) => writtenEntries.push(entry),
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
