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

test("OCR trace-id branding: oath spec brands 'ou', EC brands 'ec' (F5), verify 'vf'", async () => {
  // Root trace-id propagation brands a STANDALONE OCR run by its form spec's
  // `traceCode` (`spec.traceCode ?? "oc"`): oath → `ou-…`, emergency-contact →
  // `ec-…` (F5 — previously fell back to the OCR default `oc-…`), verify →
  // `vf-…`. An OCR run started as an operation derives the code from the
  // operation intent FIRST (`operationTraceCode`), tested separately below.
  const { getFormSpec } = await import("../../../../src/services/ocr/forms/registry.js");
  const { buildTraceId } = await import("../../../../src/domain/queue-trace-id.js");
  const at = new Date("2026-06-02T09:05:53.000Z");
  const runId = "1a57-aaaa-bbbb";

  const oathSpec = getFormSpec("oath");
  assert.ok(oathSpec, "oath form spec must resolve");
  assert.strictEqual(oathSpec!.traceCode, "ou", "oath spec brands the operation 'ou'");
  assert.match(buildTraceId({ code: oathSpec!.traceCode ?? "oc", runId, at }), /^ou-\d{6}-1a57$/);

  const ecSpec = getFormSpec("emergency-contact");
  assert.ok(ecSpec, "emergency-contact form spec must resolve");
  assert.strictEqual(ecSpec!.traceCode, "ec", "EC spec brands standalone runs 'ec' (F5)");
  assert.match(buildTraceId({ code: ecSpec!.traceCode ?? "oc", runId, at }), /^ec-\d{6}-1a57$/);
});

test("OCR trace-id branding: operation intent disambiguates oath-signature (os) from oath-upload (ou)", async () => {
  // The shared oath form spec brands `ou`, which made an oath-SIGNATURE operation
  // AND an oath-UPLOAD operation both read `ou-…` — the operator-confusing
  // collision. The orchestrator now derives the trace code from the operation
  // intent FIRST, so the prefix tells them apart. Each value matches that
  // operation workflow's own `defineWorkflow` code (kept collision-free by the
  // `workflow codes are unique` guard in queue-row-kind-coverage.test.ts).
  const { operationTraceCode } = await import("../../../../src/workflows/ocr/orchestrator.js");
  assert.strictEqual(operationTraceCode("oath-signature"), "os");
  assert.strictEqual(operationTraceCode("oath-upload"), "ou");
  assert.strictEqual(operationTraceCode("emergency-contact"), "ec");
  // Standalone OCR-hub run (no operation) → caller falls back to spec.traceCode/oc.
  assert.strictEqual(operationTraceCode(undefined), undefined);
  assert.strictEqual(operationTraceCode("ocr"), undefined);
});

test("standalone oath orchestrator emits pending → loading-roster → ocr → person-lookup → done (completes; ALL standalone runs complete after lookup)", async () => {
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
  // `matching` + `disambiguating` are merged into the single `ocr` step; the
  // next distinct step is `person-lookup`.
  assert.ok(steps.some((s) => s.includes("person-lookup")), `steps: ${steps.join(", ")}`);
  assert.ok(!steps.some((s) => s.includes("matching")), `matching folds into ocr; steps: ${steps.join(", ")}`);
  // ALL standalone runs (oath / EC / verify) now complete `done` at person-lookup
  // — none park at awaiting-approval. Only DELEGATED runs (parentRunId set) park.
  // The synthetic `verification` step is retired for all forms.
  assert.ok(steps.some((s) => s === "done/person-lookup"), `standalone oath must complete done/person-lookup; steps: ${steps.join(", ")}`);
  assert.ok(!steps.some((s) => s.includes("awaiting-approval")), `standalone oath must NOT emit awaiting-approval; steps: ${steps.join(", ")}`);
  assert.ok(!steps.some((s) => s.includes("verification")), `verification step is retired; steps: ${steps.join(", ")}`);

  const terminalRow = (writtenEntries as Array<{ status: string; step?: string; data?: Record<string, string> }>).find(
    (e) => e.status === "done" && e.step === "person-lookup",
  );
  assert.ok(terminalRow, "terminal done/person-lookup row must be emitted");
  // Regression (2026-06-02): OCR prep rows must carry the trace id + queue-row
  // kind the kernel would otherwise stamp, so the footer subtitle resolves to
  // the trace id (kind "file") instead of falling back to the literal "OCR".
  // Trace-id branding (root trace-id propagation): the OATH form spec sets
  // `traceCode: "ou"`, so an oath-form OCR root brands the whole operation
  // `ou-…` (not the default `oc-…`). Standalone/EC forms keep `oc-…` — see the
  // emergency-contact branding test below.
  for (const entry of writtenEntries as Array<{ data?: Record<string, string> }>) {
    assert.equal(entry.data?.queueRowKind, "file", "every OCR row stamps queueRowKind=file");
    assert.match(
      entry.data?.__traceId ?? "",
      /^ou-\d{6}-[a-z0-9]{4}$/,
      `every oath-form OCR row stamps a frozen ou-… trace id (got "${entry.data?.__traceId}")`,
    );
  }
  const traceIds = new Set((writtenEntries as Array<{ data?: Record<string, string> }>).map((e) => e.data?.__traceId));
  assert.equal(traceIds.size, 1, "the trace id is frozen-identical across every emitted row");
  const summary = JSON.parse(terminalRow!.data!.pageStatusSummary ?? "{}");
  assert.deepEqual(summary, { total: 0, succeeded: 0, failed: 0 });
  const failedPages = JSON.parse(terminalRow!.data!.failedPages ?? "[]");
  assert.deepEqual(failedPages, []);

  rmSync(dir, { recursive: true, force: true });
});

test("delegated orchestrator re-stamps parentRunId on EVERY self-emitted row", async () => {
  // Regression (verified 2026-06-02): the OCR orchestrator emits its own rich
  // running/awaiting-approval snapshot rows, and the dashboard collapses a run
  // to its LATEST row. If those snapshots drop `parentRunId`, the dashboard
  // treats a delegated OCR run as standalone and `OcrReviewPane` hides the
  // Approve button (`isDelegation = prepActive && entry.parentRunId`). The
  // kernel only stamps parentRunId on the rows IT emits; delegation never puts
  // it in the child input, so `ocrKernelHandler` forwards `ctx.parentRunId`
  // into `input.parentRunId`. This pins that the orchestrator carries it onto
  // every emission — pending through awaiting-approval.
  const { dir, rosterPath, pdfPath, pdfFileId } = await setup();
  const writtenEntries: Array<{ status: string; step?: string; parentRunId?: string }> = [];

  await runOcrOrchestrator(
    {
      pdfPath,
      pdfOriginalName: "fake.pdf",
      pdfFileId,
      formType: "oath",
      sessionId: "session-parent",
      rosterPath,
      rosterMode: "existing",
      parentRunId: "oath-sig-run-99",
    },
    {
      runId: "run-parent",
      trackerDir: dir,
      _emitOverride: (entry: any) => writtenEntries.push(entry),
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
      _enqueueEidLookupOverride: async () => { /* no-op */ },
      _watchChildRunsOverride: async () => [{
        workflow: "person-lookup",
        itemId: "ocr-oath-run-parent-r0",
        runId: "verify-1",
        status: "done" as const,
        data: { hrStatus: "Active", department: "HDH", personOrgScreenshot: "x.png", emplId: "10000001" },
      }],
    },
  );

  assert.ok(writtenEntries.length >= 3, "expected multiple emitted rows");
  for (const entry of writtenEntries) {
    assert.equal(
      entry.parentRunId,
      "oath-sig-run-99",
      `every emitted row must carry parentRunId (offender: ${entry.status}/${entry.step ?? ""})`,
    );
  }
  const approval = writtenEntries.find(
    (e) => (e.status === "running" || e.status === "done") && e.step === "awaiting-approval",
  );
  assert.ok(approval, "awaiting-approval row should be emitted");
  assert.equal(approval!.parentRunId, "oath-sig-run-99");

  rmSync(dir, { recursive: true, force: true });
});

test("orchestrator stamps data.parallelWorkers on EVERY OCR row when run options carry a worker count", async () => {
  // The OCR row is the durable bridge across the upload → approve boundary: the
  // approve route reads the operator's worker count back off it (shared.ts) to
  // size its signer/contact fan-out. So parallelWorkers must ride EVERY
  // self-emitted row (the re-stamp set) — the dashboard collapses a run to its
  // latest row, so a stamp on only the pending row would vanish.
  const { dir, rosterPath, pdfPath, pdfFileId } = await setup();
  const writtenEntries: Array<{ status: string; step?: string; data?: Record<string, string> }> = [];

  await runOcrOrchestrator(
    {
      pdfPath,
      pdfOriginalName: "fake.pdf",
      pdfFileId,
      formType: "oath",
      sessionId: "session-workers",
      rosterPath,
      rosterMode: "existing",
      runOptions: { parallelWorkers: 4 },
    },
    {
      runId: "run-workers",
      trackerDir: dir,
      _emitOverride: (entry: any) => writtenEntries.push(entry),
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
      _enqueueEidLookupOverride: async () => { /* no-op */ },
      _watchChildRunsOverride: async () => [{
        workflow: "person-lookup",
        itemId: "ocr-oath-run-workers-r0",
        runId: "verify-1",
        status: "done" as const,
        data: { hrStatus: "Active", department: "HDH", personOrgScreenshot: "x.png", emplId: "10000001" },
      }],
    },
  );

  assert.ok(writtenEntries.length >= 3, "expected multiple emitted rows");
  for (const entry of writtenEntries) {
    assert.equal(
      entry.data?.parallelWorkers,
      "4",
      `every emitted row must carry data.parallelWorkers (offender: ${entry.status}/${entry.step ?? ""})`,
    );
  }

  rmSync(dir, { recursive: true, force: true });
});

test("orchestrator omits data.parallelWorkers when run options are absent (Auto)", async () => {
  const { dir, rosterPath, pdfPath, pdfFileId } = await setup();
  const writtenEntries: Array<{ data?: Record<string, string> }> = [];

  await runOcrOrchestrator(
    {
      pdfPath,
      pdfOriginalName: "fake.pdf",
      pdfFileId,
      formType: "oath",
      sessionId: "session-auto",
      rosterPath,
      rosterMode: "existing",
    },
    {
      runId: "run-auto",
      trackerDir: dir,
      _emitOverride: (entry: any) => writtenEntries.push(entry),
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
      _enqueueEidLookupOverride: async () => { /* no-op */ },
      _watchChildRunsOverride: async () => [{
        workflow: "person-lookup",
        itemId: "ocr-oath-run-auto-r0",
        runId: "verify-1",
        status: "done" as const,
        data: { hrStatus: "Active", department: "HDH", personOrgScreenshot: "x.png", emplId: "10000001" },
      }],
    },
  );

  assert.ok(writtenEntries.length >= 3, "expected multiple emitted rows");
  for (const entry of writtenEntries) {
    assert.equal(entry.data?.parallelWorkers, undefined, "Auto stamps no parallelWorkers");
  }

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
  // `matching` + `disambiguating` are merged into `ocr` — they no longer emit
  // their own phase; `person-lookup` is the next distinct phase.
  assert.ok(phases.includes("person-lookup"), `phases: ${phases.join(", ")}`);
  assert.ok(!phases.includes("matching"), `matching folds into ocr; phases: ${phases.join(", ")}`);
  assert.ok(!phases.includes("disambiguating"), `disambiguating folds into ocr; phases: ${phases.join(", ")}`);
  // ALL standalone runs (oath / EC / verify) complete `done` at person-lookup —
  // none park at awaiting-approval. Only DELEGATED runs (parentRunId set) fire
  // the awaiting-approval phase. The synthetic `verification` step is retired.
  assert.ok(!phases.includes("awaiting-approval"), `standalone oath must NOT fire awaiting-approval phase; phases: ${phases.join(", ")}`);
  assert.ok(!phases.includes("verification"), `phases: ${phases.join(", ")}`);
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

test("orchestrator waits for eid-lookup results before completing (standalone oath completes done/person-lookup with enriched records)", async () => {
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
  // ALL standalone runs (oath / EC / verify) complete `done` at person-lookup —
  // none park at awaiting-approval. The terminal row carries the enriched records.
  const terminalRow = (writtenEntries as Array<{ status: string; step?: string; data?: Record<string, string> }>).find(
    (entry) => entry.status === "done" && entry.step === "person-lookup",
  );
  assert.ok(terminalRow, "standalone oath must complete done/person-lookup after child lookups return");
  const records = JSON.parse(terminalRow.data?.records ?? "[]") as Array<Record<string, unknown>>;
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

  // ALL standalone runs (oath / EC / verify) complete `done` at person-lookup.
  // The terminal row carries the enriched (patched) records.
  const terminalRow = (writtenEntries as Array<{ status: string; step?: string; data?: Record<string, string> }>).find(
    (entry) => entry.status === "done" && entry.step === "person-lookup",
  );
  assert.ok(terminalRow, "standalone oath must complete done/person-lookup after child lookup returns");
  const records = JSON.parse(terminalRow.data?.records ?? "[]") as Array<{ warnings?: string[] }>;
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
  // ALL standalone runs (oath / EC / verify) complete `done` at person-lookup —
  // none park at awaiting-approval.
  assert.equal(writtenEntries.some((entry: any) => entry.status === "done" && entry.step === "person-lookup"), true);
  rmSync(dir, { recursive: true, force: true });
});

test("orchestrator dispatches eid-lookup by EID when roster supplies a UCPath employee id", async () => {
  const { dir, rosterPath, pdfPath, pdfFileId } = await setup();
  const writtenEntries: object[] = [];
  let eidLookupItems: Array<{ name?: string; emplId?: string; itemId: string }> = [];
  let watchedWorkflow: string | undefined;

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
      _watchChildRunsOverride: async (opts: WatchChildRunsOpts) => {
        watchedWorkflow = opts.workflow;
        return opts.expectedItemIds.map((itemId) => ({
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
        }));
      },
    } as never,
  );

  assert.equal(eidLookupItems.length, 1);
  assert.equal(eidLookupItems[0].emplId, "10000001");
  assert.match(eidLookupItems[0].itemId, /^ocr-oath-run-active-r0$/);
  // Regression guard for the 2026-05-28 eid-lookup→person-lookup rename that
  // stranded watchChildRuns on a dead `eid-lookup` key (1h timeout). The
  // orchestrator must watch the ACTUAL child workflow (`person-lookup`), not
  // the phase label, or the lookup wait never resolves.
  assert.equal(watchedWorkflow, "person-lookup");
  const steps = writtenEntries.map((e: any) => `${e.status}/${e.step ?? ""}`);
  assert.ok(steps.some((s) => s.includes("person-lookup")), `steps: ${steps.join(", ")}`);
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

test("rosterMode=download queues a fresh SharePoint child with OCR trace lineage", async () => {
  const { dir, pdfPath, pdfFileId } = await setup();
  const requests: Array<{
    id: string;
    mode: string;
    parentRunId?: string;
    rootTracePrefix?: string;
    trackerDir?: string;
    itemId?: string;
  }> = [];

  await runOcrOrchestrator(
    {
      pdfPath,
      pdfOriginalName: "fake.pdf",
      pdfFileId,
      formType: "oath",
      sessionId: "session-sp",
      rosterMode: "download",
      operationWorkflow: "oath-signature",
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
      _requestSharePointDownloadOverride: async (request) => {
        requests.push(request);
        return { id: request.id, label: "Onboarding Roster", path: "/tmp/roster.xlsx" };
      },
      _enqueueEidLookupOverride: async () => {},
    },
  );

  assert.equal(requests.length, 1);
  assert.equal(requests[0]!.id, "onboarding");
  assert.equal(requests[0]!.mode, "fresh");
  assert.equal(requests[0]!.parentRunId, "run-sp");
  assert.equal(requests[0]!.trackerDir, dir);
  assert.equal(requests[0]!.itemId, "ocr-sp-run-sp");
  assert.match(requests[0]!.rootTracePrefix ?? "", /^os-\d{6}$/);
  rmSync(dir, { recursive: true, force: true });
});

test("rosterMode=wait waits for the current SharePoint queue result without requesting a fresh download", async () => {
  const { dir, pdfPath, pdfFileId } = await setup();
  const requests: Array<{ id: string; mode: string }> = [];

  await runOcrOrchestrator(
    {
      pdfPath,
      pdfOriginalName: "fake.pdf",
      pdfFileId,
      formType: "oath",
      sessionId: "session-sp-wait",
      rosterMode: "wait",
    },
    {
      runId: "run-sp-wait",
      trackerDir: dir,
      _emitOverride: () => {},
      _ocrPipelineOverride: async () => ({
        data: [],
        provider: "stub", attempts: 1, cached: false,
      }),
      _loadRosterOverride: async () => [],
      _requestSharePointDownloadOverride: async (request) => {
        requests.push(request);
        return { id: request.id, label: "Onboarding Roster", path: "/tmp/queued-roster.xlsx" };
      },
      _enqueueEidLookupOverride: async () => {},
    },
  );

  assert.deepEqual(requests.map((request) => request.mode), ["wait"]);
  rmSync(dir, { recursive: true, force: true });
});

test("orchestrator surfaces failedPages and pageStatusSummary on terminal done/person-lookup row (standalone oath)", async () => {
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

  // ALL standalone runs (oath / EC / verify) complete `done` at person-lookup.
  // failedPages and pageStatusSummary are carried on this terminal row.
  const terminalRow = (writtenEntries as Array<{ status: string; step?: string; data?: Record<string, string> }>).find(
    (e) => e.status === "done" && e.step === "person-lookup",
  );
  assert.ok(terminalRow, "standalone oath must complete done/person-lookup");
  const failedPages = JSON.parse(terminalRow!.data!.failedPages ?? "[]") as Array<{ page: number; attempts: number }>;
  assert.equal(failedPages.length, 1, "one failed page");
  assert.equal(failedPages[0].page, 2);
  assert.equal(failedPages[0].attempts, 1);
  const summary = JSON.parse(terminalRow!.data!.pageStatusSummary ?? "{}") as {
    total: number; succeeded: number; failed: number;
  };
  assert.deepEqual(summary, { total: 3, succeeded: 2, failed: 1 });

  rmSync(dir, { recursive: true, force: true });
});

test("opts.signal abort mid-phase unwinds the prep — no person-lookup/done row emitted after cancel (Task A1)", async () => {
  // Live-proven bug: `/api/ocr/prepare` ran the orchestrator with NO abort signal
  // and NO runRegistry registration, so a queue-row Cancel × fell into cancel.ts's
  // stale-tracker branch (write a cosmetic cancelled row, abort NOTHING) and the
  // live orchestrator's next emit overwrote Cancelled with running/person-lookup.
  // The fix threads `signal` into the orchestrator; its entry bridge trips the
  // prepare-abort flag, which `raceOcrPrepWithDiscard` (around every phase) polls.
  // This pins that a signal aborted DURING the OCR pipeline step unwinds the run
  // before person-lookup — proving no later running/done row is emitted.
  const { _resetOcrPrepareAbortRegistryForTests, isOperatorDiscardAbortError } = await import(
    "../../../../src/workflows/ocr/prepare-abort.js"
  );
  _resetOcrPrepareAbortRegistryForTests();
  const { dir, rosterPath, pdfPath, pdfFileId } = await setup();
  const writtenEntries: Array<{ status: string; step?: string }> = [];
  const controller = new AbortController();

  let threw: unknown;
  try {
    await runOcrOrchestrator(
      {
        pdfPath,
        pdfOriginalName: "fake.pdf",
        pdfFileId,
        formType: "oath",
        sessionId: "session-cancel-1",
        rosterPath,
        rosterMode: "existing",
      },
      {
        runId: "run-cancel-1",
        trackerDir: dir,
        signal: controller.signal,
        _emitOverride: (entry) => writtenEntries.push(entry as { status: string; step?: string }),
        // Abort while the OCR pipeline step is in flight — mirrors an operator
        // hitting Cancel × mid-OCR. `raceOcrPrepWithDiscard` wraps this promise
        // and rejects with the discard-abort error within one poll (≤500ms).
        _ocrPipelineOverride: async () => {
          controller.abort(new Error("cancel requested (dashboard_in_process)"));
          await new Promise((r) => setTimeout(r, 700));
          return { data: [], provider: "stub", attempts: 1, cached: false };
        },
        _loadRosterOverride: async () => [{ eid: "10000001", name: "Liam Kustenbauder" }],
        _enqueueEidLookupOverride: async () => { /* must never be reached */ },
        _watchChildRunsOverride: async () => {
          throw new Error("person-lookup fan-out must not run after a mid-phase cancel");
        },
      },
    );
  } catch (err) {
    threw = err;
  }

  // The orchestrator rethrows the discard-abort error on a signal-cancel so the
  // caller (kernel handler / prepare.ts) maps it to a terminal cancelled row.
  assert.ok(threw, "a signal-cancel mid-phase must throw, not return");
  assert.ok(
    isOperatorDiscardAbortError(threw),
    `expected the operator-discard abort error, got: ${threw instanceof Error ? threw.message : String(threw)}`,
  );

  const steps = writtenEntries.map((e) => `${e.status}/${e.step ?? ""}`);
  // No person-lookup running row, no terminal done row — the run unwound before
  // the fan-out. (cancel.ts / prepare.ts own the terminal cancelled row.)
  assert.ok(
    !steps.some((s) => s === "running/person-lookup"),
    `no person-lookup row after cancel; steps: ${steps.join(", ")}`,
  );
  assert.ok(
    !steps.some((s) => s === "done/person-lookup"),
    `no terminal done row after cancel; steps: ${steps.join(", ")}`,
  );
  assert.ok(
    !steps.some((s) => s.includes("awaiting-approval")),
    `no awaiting-approval row after cancel; steps: ${steps.join(", ")}`,
  );

  _resetOcrPrepareAbortRegistryForTests();
  rmSync(dir, { recursive: true, force: true });
});


test("second opinion: a 0-candidate, no-EID name is re-read on tier-1 and ADOPTED when it roster-matches", async () => {
  // Live repro 2026-06-11: ministral-8b read "Barahona Martell, Carlos D" as
  // "Merrell, Carlos D" — 0 roster candidates + invalid EID, yet the pipeline
  // proceeded with the misread name. The second-opinion phase re-reads the
  // page on a tier-1 model (excluding the model that produced the first
  // read) and adopts the reading that anchors to the roster.
  const { dir, rosterPath, pdfPath, pdfFileId } = await setup();
  const writtenEntries: Array<{ data?: Record<string, unknown> }> = [];
  const calls: Array<{ pageNum: number; excludeModels: string[] }> = [];

  await runOcrOrchestrator(
    {
      pdfPath,
      pdfOriginalName: "fake.pdf",
      pdfFileId,
      formType: "oath",
      sessionId: "session-so-adopt",
      rosterPath,
      rosterMode: "existing",
    },
    {
      runId: "run-so-adopt",
      trackerDir: dir,
      _emitOverride: (entry: unknown) => writtenEntries.push(entry as never),
      _ocrPipelineOverride: async () => ({
        data: [{
          sourcePage: 1, rowIndex: 0,
          printedName: "Merrell, Carlos D",
          employeeId: "000412",
          employeeSigned: true, officerSigned: true, dateSigned: "05/01/2026",
          notes: [], documentType: "expected", originallyMissing: [],
        }],
        provider: "stub", attempts: 1, cached: false,
        pages: [{ page: 1, success: true, attemptedKeys: ["mistral-0:ministral-8b-latest"], poolKeyId: "mistral-0:ministral-8b-latest", attempts: 1 }],
      }),
      _secondOpinionOverride: async (args: { pageNum: number; excludeModels: string[] }) => {
        calls.push(args);
        return {
          records: [{
            sourcePage: 1, rowIndex: 0,
            printedName: "Barahona Martell, Carlos D",
            employeeSigned: true, officerSigned: true, dateSigned: "05/01/2026",
            notes: [], documentType: "expected", originallyMissing: [],
          }],
          poolKeyId: "gemini-0:gemini-3.5-flash",
        };
      },
      _loadRosterOverride: async () => [{ eid: "10000001", name: "Barahona Martell, Carlos D" }],
      _lookupSuggestionOverride: async () => [],
      _enqueueEidLookupOverride: async () => { /* no-op */ },
      _disableSqliteDependencies: true,
      _watchChildRunsOverride: async () => [{
        workflow: "person-lookup",
        itemId: "ocr-oath-run-so-adopt-r0",
        runId: "verify-1",
        status: "done" as const,
        data: { hrStatus: "Active", emplId: "10000001" },
      }],
    } as never,
  );

  assert.equal(calls.length, 1, "exactly one suspect page re-read");
  assert.equal(calls[0].pageNum, 1);
  assert.deepEqual(calls[0].excludeModels, ["ministral-8b-latest"], "the first-read model is excluded from the re-read");
  const last = [...writtenEntries].reverse().find((e) => typeof (e.data as { records?: unknown })?.records === "string");
  assert.ok(last, "a snapshot with records was emitted");
  const parsed = JSON.parse((last!.data as { records: string }).records) as Array<{ printedName?: string }>;
  const name = String(parsed[0]?.printedName ?? "");
  assert.ok(name.includes("Barahona"), `adopted name should be the tier-1 reading, got "${name}"`);
  rmSync(dir, { recursive: true, force: true });
});

test("second opinion: a re-read that ranks no better KEEPS the original reading (and parses ':'-bearing model ids)", async () => {
  const { dir, rosterPath, pdfPath, pdfFileId } = await setup();
  const writtenEntries: Array<{ data?: Record<string, unknown> }> = [];
  const calls: Array<{ pageNum: number; excludeModels: string[] }> = [];

  await runOcrOrchestrator(
    {
      pdfPath,
      pdfOriginalName: "fake.pdf",
      pdfFileId,
      formType: "oath",
      sessionId: "session-so-keep",
      rosterPath,
      rosterMode: "existing",
    },
    {
      runId: "run-so-keep",
      trackerDir: dir,
      _emitOverride: (entry: unknown) => writtenEntries.push(entry as never),
      _ocrPipelineOverride: async () => ({
        data: [{
          sourcePage: 1, rowIndex: 0,
          printedName: "Merrell, Carlos D",
          employeeSigned: true, officerSigned: true, dateSigned: "05/01/2026",
          notes: [], documentType: "expected", originallyMissing: [],
        }],
        provider: "stub", attempts: 1, cached: false,
        pages: [{ page: 1, success: true, attemptedKeys: ["openrouter-2:nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free"], poolKeyId: "openrouter-2:nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free", attempts: 1 }],
      }),
      _secondOpinionOverride: async (args: { pageNum: number; excludeModels: string[] }) => {
        calls.push(args);
        // Another non-roster name, still no EID — ranks no better.
        return {
          records: [{
            sourcePage: 1, rowIndex: 0,
            printedName: "Morrell, Charles",
            employeeSigned: true, officerSigned: true, dateSigned: "05/01/2026",
            notes: [], documentType: "expected", originallyMissing: [],
          }],
          poolKeyId: "gemini-0:gemini-3.5-flash",
        };
      },
      _loadRosterOverride: async () => [{ eid: "10000001", name: "Unrelated Person" }],
      _lookupSuggestionOverride: async () => [],
      _enqueueEidLookupOverride: async () => { /* no-op */ },
      _disableSqliteDependencies: true,
      _watchChildRunsOverride: async () => [],
    } as never,
  );

  assert.equal(calls.length, 1);
  assert.deepEqual(
    calls[0].excludeModels,
    ["nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free"],
    "model id is everything after the FIRST ':' in the poolKeyId combo",
  );
  const last = [...writtenEntries].reverse().find((e) => typeof (e.data as { records?: unknown })?.records === "string");
  assert.ok(last, "a snapshot with records was emitted");
  const parsed = JSON.parse((last!.data as { records: string }).records) as Array<{ printedName?: string }>;
  const name = String(parsed[0]?.printedName ?? "");
  assert.ok(name.includes("Merrell"), `original reading must be kept, got "${name}"`);
  rmSync(dir, { recursive: true, force: true });
});
