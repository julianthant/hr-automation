/**
 * Finding c (2026-07-09 fail-loud re-audit): a swallowed LLM DISAMBIGUATION
 * failure must be surfaced ON THE RECORD, not just log.warn'd — otherwise the
 * review card shows a cleanly-unresolved record and the operator can't tell
 * "the disambiguator found no confident match" from "the disambiguator never
 * ran because the LLM call failed".
 *
 * Lives in its own file because it vi.mock's the disambiguate module (the
 * orchestrator imports it dynamically with no test seam); the main
 * orchestrator.test.ts must keep the real module.
 */
import { test, vi } from "vitest";
import assert from "node:assert";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openStateDb } from "../../../../src/tracker/state/db.js";
import { registerLocalFile } from "../../../../src/tracker/files/files.js";
import { runOcrOrchestrator } from "../../../../src/workflows/ocr/orchestrator.js";
import { writeOnePagePdf } from "../../../_utils/one-page-pdf.js";

vi.mock("../../../../src/services/ocr/disambiguate.js", () => ({
  disambiguateMatch: vi.fn(async () => {
    throw new Error("LLM pool exhausted (stub)");
  }),
}));

test("disambiguation-LLM failure is surfaced ON THE RECORD as a warning — not swallowed into a clean-looking unresolved record (finding c)", async () => {
  const dir = join(tmpdir(), `ocr-orch-disambig-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  const rosterPath = join(dir, "roster.xlsx");
  writeFileSync(rosterPath, ""); // stubbed via _loadRosterOverride
  const pdfPath = join(dir, "test.pdf");
  await writeOnePagePdf(pdfPath);
  const db = openStateDb(dir);
  const { fileId: pdfFileId } = registerLocalFile(db, {
    trackerDir: dir,
    kind: "pdf",
    mimeType: "application/pdf",
    path: pdfPath,
    originalName: "test.pdf",
    source: "ocr-orchestrator-test",
  });

  const writtenEntries: Array<{ status: string; step?: string; data?: Record<string, string> }> = [];

  await runOcrOrchestrator(
    {
      pdfPath,
      pdfOriginalName: "fake.pdf",
      pdfFileId,
      formType: "oath",
      sessionId: "session-disambig-fail",
      rosterPath,
      rosterMode: "existing",
    },
    {
      runId: "run-disambig-fail",
      trackerDir: dir,
      _emitOverride: (entry: any) => writtenEntries.push(entry),
      _ocrPipelineOverride: async () => ({
        // Two near-identical roster candidates force the ambiguous
        // lookup-pending branch → the orchestrator's disambiguating phase
        // calls the (mocked, throwing) disambiguateMatch.
        data: [{
          sourcePage: 1,
          rowIndex: 0,
          printedName: "Maria Garcia",
          employeeSigned: true,
          officerSigned: true,
          dateSigned: "05/01/2026",
          notes: [],
          documentType: "expected",
          originallyMissing: [],
        }],
        provider: "stub", attempts: 1, cached: false,
      }),
      _loadRosterOverride: async () => [
        // Both score 0.9 for "Maria Garcia" (probed against the real matcher)
        // → the ambiguous multi-candidate branch, not a single-accept.
        { eid: "10000001", name: "Garcia Lopez, Maria" },
        { eid: "10000002", name: "Garcia Torres, Maria" },
      ],
      _secondOpinionOverride: async () => null,
      _lookupSuggestionOverride: async () => [],
      _enqueueEidLookupOverride: async () => {},
      _disableSqliteDependencies: true,
      _watchChildRunsOverride: async () => [{
        workflow: "person-lookup",
        itemId: "ocr-oath-run-disambig-fail-r0",
        runId: "verify-1",
        status: "done" as const,
        data: { hrStatus: "Active", emplId: "10000001" },
      }],
    },
  );

  const terminalRow = writtenEntries.find((e) => e.status === "done" && e.step === "person-lookup");
  assert.ok(terminalRow, "the run still completes — the record falls through to the name lookup");
  const records = JSON.parse(terminalRow!.data?.records ?? "[]") as Array<{ warnings?: string[] }>;
  assert.ok(
    records[0]?.warnings?.some((w) => w.includes("Auto-disambiguation failed") && w.includes("LLM pool exhausted")),
    `the record carries the disambiguation-failure warning (warnings: ${JSON.stringify(records[0]?.warnings)})`,
  );
  rmSync(dir, { recursive: true, force: true });
});
