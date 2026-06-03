import { test } from "vitest";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { defineWorkflow } from "../../../src/core/index.js";
import { runOneItem } from "../../../src/core/kernel/workflow.js";
import { Session } from "../../../src/core/kernel/session.js";
import { dateLocal, rowFilePath } from "../../../src/tracker/jsonl.js";
import { openStateDb } from "../../../src/tracker/state/db.js";
import { registerLocalFile } from "../../../src/tracker/files/files.js";
import { writeOnePagePdf } from "../../_utils/one-page-pdf.js";
import { ocrWorkflow } from "../../../src/workflows/ocr/index.js";
import { runOcrOrchestrator } from "../../../src/workflows/ocr/orchestrator.js";
import { OcrInputSchema, type OcrInput } from "../../../src/workflows/ocr/schema.js";
import {
  subscribeToApproval,
  emitApproved,
  _resetApprovalSignalRegistryForTests,
  type ApprovedPayload,
} from "../../../src/services/ocr/approval-signal.js";

interface TrackerRow {
  workflow: string;
  id: string;
  runId?: string;
  parentRunId?: string;
  status: string;
  step?: string;
  data?: Record<string, string>;
  error?: string;
}

function readOcrRows(trackerDir: string): TrackerRow[] {
  const path = rowFilePath("ocr", dateLocal(), trackerDir);
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as TrackerRow);
}

// ─── Registration shape (kept from the prior placeholder) ─────────────────

test("ocrWorkflow registered with empty systems", () => {
  assert.deepEqual(ocrWorkflow.config.systems, []);
  assert.equal(ocrWorkflow.config.authSteps, false);
  assert.equal(ocrWorkflow.config.name, "ocr");
});

test("ocrWorkflow declares expected steps", () => {
  assert.deepEqual(Array.from(ocrWorkflow.config.steps), [
    "loading-roster",
    "ocr",
    "matching",
    "disambiguating",
    "person-lookup",
    "verification",
    "awaiting-approval",
  ]);
});

// ─── Real end-to-end run through the kernel ───────────────────────────────

/**
 * Drives the OCR workflow through the REAL kernel (`runOneItem` +
 * `Session.forTesting`), exercising the actual `runOcrOrchestrator` body — every
 * prep phase, the rich queue-row emissions, the trace-id branding, and the
 * delegated-scope re-stamping — with NO browser, NO LLM, and NO live roster:
 *
 *   - PDF rendering: a real one-page pdf-lib PDF (so the inline
 *     `ensurePdfPageCache` renders without a browser) registered via
 *     `registerLocalFile` so `pdfFileId` resolves.
 *   - LLM extraction: `_ocrPipelineOverride` returns a fixed record.
 *   - Roster loading: `_loadRosterOverride` returns a one-row roster.
 *   - eid-lookup fan-out: `_enqueueEidLookupOverride` + `_watchChildRunsOverride`
 *     stub the person-lookup delegation (no daemon).
 *   - Approval: the handler subscribes to the approval signal; the test fires
 *     `emitApproved` once the orchestrator reports `awaiting-approval` (via
 *     `onPhase`), so the kernel emits the terminal `done` row.
 *
 * The workflow-level `ocrWorkflow.config.handler` doesn't expose the
 * orchestrator escape hatches, so — exactly like `tests/integration/
 * oath-upload-smoke.test.ts` — we wrap the orchestrator in a thin test-only
 * workflow that mirrors the real `ocrKernelHandler` (orchestrate → wait for
 * approval → stamp records) but with overrides injected.
 */
test("ocr end-to-end through runOneItem — orchestrate, await approval, emit terminal done", async (t) => {
  _resetApprovalSignalRegistryForTests();
  t.onTestFinished(() => _resetApprovalSignalRegistryForTests());

  const dir = mkdtempSync(join(tmpdir(), "ocr-e2e-"));
  t.onTestFinished(() => rmSync(dir, { recursive: true, force: true }));

  // Real one-page PDF registered in the file store so pdfFileId resolves and
  // the orchestrator's inline ensurePdfPageCache renders a page (no browser).
  const uploadsDir = join(dir, "uploads");
  mkdirSync(uploadsDir, { recursive: true });
  const rosterPath = join(dir, "roster.xlsx");
  writeFileSync(rosterPath, ""); // _loadRosterOverride bypasses real parsing
  const pdfPath = join(uploadsDir, "oaths.pdf");
  await writeOnePagePdf(pdfPath);
  const { fileId: pdfFileId } = registerLocalFile(openStateDb(dir), {
    kind: "pdf",
    mimeType: "application/pdf",
    path: pdfPath,
    originalName: "oaths.pdf",
    source: "ocr-e2e-test",
  });

  const sessionId = "ocr-e2e-session-1";
  const runId = "ocr-e2e-run-1";
  const parentRunId = "oath-upload-parent-run-1";
  const approvedRecords = [{ printedName: "Liam Kustenbauder", employeeId: "10000001", selected: true }];

  // Thin test-only OCR workflow: mirrors ocrKernelHandler (orchestrate → await
  // approval → stamp approved records) but injects the orchestrator overrides.
  const testWorkflow = defineWorkflow({
    name: "ocr",
    label: "OCR",
    archetype: "preview",
    inputSubject: "pdf",
    systems: [],
    authSteps: false,
    steps: ocrWorkflow.config.steps,
    schema: OcrInputSchema,
    getName: (d) => d.pdfOriginalName ?? "",
    getId: (d) => d.sessionId ?? "",
    handler: async (ctx, input: OcrInput) => {
      const orchestratorInput = {
        ...input,
        ...(input.parentRunId ?? ctx.parentRunId
          ? { parentRunId: input.parentRunId ?? ctx.parentRunId }
          : {}),
      };
      const result = await runOcrOrchestrator(orchestratorInput, {
        runId: ctx.runId,
        trackerDir: ctx.trackerDir,
        signal: ctx.signal,
        onPhase: (step) => {
          ctx.reportPhase(step);
          // The orchestrator parks at running/awaiting-approval and returns;
          // fire the approval signal so the handler's subscribeToApproval wakes
          // and the kernel emits the terminal done row. Defer a tick so the
          // subscription is registered before we emit.
          if (step === "awaiting-approval") {
            setTimeout(() => {
              emitApproved(
                { workflow: "ocr", sessionId: input.sessionId },
                { records: approvedRecords },
              );
            }, 0);
          }
        },
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
        _enqueueEidLookupOverride: async () => { /* no-op: no daemon */ },
        _disableSqliteDependencies: true,
        _watchChildRunsOverride: async () => [{
          workflow: "person-lookup",
          itemId: `ocr-oath-${ctx.runId}-r0`,
          runId: "verify-1",
          status: "done" as const,
          data: { emplId: "10000001", hrStatus: "Active", department: "HDH", personOrgScreenshot: "x.png" },
        }],
      });
      if (result.status !== "awaiting-approval") return; // discarded path

      const payload: ApprovedPayload = await subscribeToApproval(
        { workflow: "ocr", sessionId: input.sessionId },
        { signal: ctx.signal, trackerDir: ctx.trackerDir },
      );
      ctx.updateData({
        records: JSON.stringify(payload.records),
        recordCount: String(payload.records.length),
      } as Partial<OcrInput & Record<string, unknown>>);
    },
  });

  const session = Session.forTesting({
    systems: testWorkflow.config.systems,
    browsers: new Map(),
    readyPromises: new Map(),
  });
  (session as unknown as { captureAll: () => Promise<unknown[]> }).captureAll = async () => [];

  const input: OcrInput = {
    pdfPath,
    pdfOriginalName: "oaths.pdf",
    pdfFileId,
    formType: "oath",
    sessionId,
    rosterPath,
    rosterMode: "existing",
    parentRunId,
  };

  const res = await runOneItem({
    wf: testWorkflow,
    session,
    item: input,
    itemId: sessionId,
    runId,
    trackerDir: dir,
    callerPreEmits: false,
    parentRunId,
  });
  assert.ok(res.ok, `runOneItem should succeed; got: ${JSON.stringify(res)}`);

  const rows = readOcrRows(dir);
  assert.ok(rows.length > 0, "OCR JSONL rows were emitted");

  // Every orchestrator-self-emitted prep row carries mode "prepare", the
  // delegated parentRunId, the preview archetype, and the oath-branded trace id.
  const prepRows = rows.filter((r) => r.data?.mode === "prepare");
  assert.ok(prepRows.length > 0, "orchestrator emitted at least one prep row");
  for (const row of prepRows) {
    assert.equal(row.data?.mode, "prepare", "prep rows carry mode=prepare");
    assert.equal(row.parentRunId, parentRunId, "delegated prep rows re-stamp parentRunId");
    assert.equal(row.data?.archetype, "preview", "prep rows carry the preview archetype");
    assert.equal(row.data?.queueRowKind, "file", "OCR rows are file-kind (pdf input)");
    // Oath form spec brands the operation `ou-…` (not the default `oc-…`).
    assert.match(
      row.data?.__traceId ?? "",
      /^ou-\d{6}-[a-z0-9]{4}$/,
      `oath-form OCR prep rows stamp an ou-… trace id (got "${row.data?.__traceId}")`,
    );
  }
  // The trace id is frozen-identical across every prep emission.
  const prepTraceIds = new Set(prepRows.map((r) => r.data?.__traceId));
  assert.equal(prepTraceIds.size, 1, "trace id is frozen across all prep rows");

  // The orchestrator parked at running/awaiting-approval before approval.
  const awaiting = rows.find((r) => r.status === "running" && r.step === "awaiting-approval");
  assert.ok(awaiting, "an awaiting-approval running row was emitted");
  assert.equal(awaiting.parentRunId, parentRunId);

  // After approval, the kernel emitted a terminal done row carrying the
  // approved records (the handler stamped them via ctx.updateData).
  const done = rows.findLast((r) => r.status === "done");
  assert.ok(done, "a terminal done row was emitted after approval");
  assert.equal(done.parentRunId, parentRunId, "terminal done row keeps delegated scope");
  const doneRecords = JSON.parse(done.data?.records ?? "[]") as unknown[];
  assert.equal(doneRecords.length, approvedRecords.length, "terminal row carries the approved records");
  assert.equal(done.data?.recordCount, String(approvedRecords.length));
});
