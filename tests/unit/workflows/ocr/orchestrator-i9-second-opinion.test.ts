/**
 * Spec-driven second opinion for the roster-less i9 form.
 *
 * Live failure mode (2026-07 batch-quality investigation): the orchestrator's
 * tier-1 re-read of suspect pages was gated on `roster.length > 0`, and the
 * generic suspect/name helpers only understand oath/EC record shapes — so an
 * i9 run (rosterMode "optional", launched from separations with NO roster) had
 * ZERO protection against weak-tier model misreads. A tier-2 model garbling
 * Section 1 (partial SSN, 2-digit-year DOB, mangled name) sailed straight into
 * the UCPath person-match search — or made the record unsearchable entirely.
 *
 * These tests pin `spec.secondOpinion` (i9): suspect = an i9-classified page
 * whose Section 1 read is unsearchable; the re-read is adopted only when
 * searchability strictly improves, guarded by the orchestrator's name-token
 * identity gate whenever the first read had a non-empty name.
 */
import { test, vi } from "vitest";
import assert from "node:assert";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openStateDb } from "../../../../src/tracker/state/db.js";
import { registerLocalFile } from "../../../../src/tracker/files/files.js";
import { writeOnePagePdf } from "../../../_utils/one-page-pdf.js";

// Since 2026-07-16, i9 enrichment fans out NO person-match children — the
// UCPath search runs post-completion as separations i9-check member tasks. If
// enrichment ever regresses into dispatching children again, this mock makes
// the dispatch visible (and prevents a real daemon spawn under vitest).
vi.mock("../../../../src/core/delegate.js", () => ({
  delegateToAllImpl: vi.fn(async () => {
    throw new Error(
      "i9 enrichment must not dispatch children — the UCPath search moved to separations i9-check member tasks",
    );
  }),
}));

async function setup(): Promise<{ dir: string; pdfPath: string; pdfFileId: string }> {
  const dir = join(tmpdir(), `ocr-i9-so-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  const uploadsDir = join(dir, "uploads");
  mkdirSync(uploadsDir, { recursive: true });
  const pdfPath = join(uploadsDir, "i9-packet.pdf");
  await writeOnePagePdf(pdfPath);
  const db = openStateDb(dir);
  const { fileId: pdfFileId } = registerLocalFile(db, {
    trackerDir: dir,
    kind: "pdf",
    mimeType: "application/pdf",
    path: pdfPath,
    originalName: "i9-packet.pdf",
    source: "ocr-i9-second-opinion-test",
  });
  return { dir, pdfPath, pdfFileId };
}

function lastRecords(entries: Array<{ data?: Record<string, unknown> }>): Array<Record<string, unknown>> {
  const last = [...entries].reverse().find((e) => typeof (e.data as { records?: unknown })?.records === "string");
  assert.ok(last, "a snapshot with records was emitted");
  return JSON.parse((last!.data as { records: string }).records) as Array<Record<string, unknown>>;
}

const i9Record = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  formKind: "i9 section 1",
  sourcePage: 1,
  lastName: "Doe",
  firstName: "Jane",
  middleInitial: "A",
  dateOfBirth: "04/01/1998",
  ssn: "123-45-6789",
  documentType: "expected",
  originallyMissing: [],
  notes: [],
  ...over,
});

async function importOrchestrator(): Promise<typeof import("../../../../src/workflows/ocr/orchestrator.js")> {
  vi.resetModules();
  return import("../../../../src/workflows/ocr/orchestrator.js");
}

test("i9 second opinion: an unsearchable Section-1 read triggers a roster-LESS tier-1 re-read; the corrected record is adopted and searched", async (t) => {
  const { dir, pdfPath, pdfFileId } = await setup();
  t.onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  const { runOcrOrchestrator } = await importOrchestrator();
  const writtenEntries: Array<{ data?: Record<string, unknown> }> = [];
  const reReads: Array<{ pageNum: number; excludeModels: string[] }> = [];

  await runOcrOrchestrator(
    {
      pdfPath,
      pdfOriginalName: "i9-packet.pdf",
      pdfFileId,
      formType: "i9",
      sessionId: "session-i9-so",
      rosterMode: "existing", // no rosterPath — i9 is rosterMode:"optional"
    },
    {
      runId: "run-i9-so",
      trackerDir: dir,
      _emitOverride: (entry: unknown) => writtenEntries.push(entry as never),
      _ocrPipelineOverride: async () => ({
        // A tier-2 misread: partial SSN + 2-digit-year DOB → unsearchable.
        data: [i9Record({ ssn: "123-45-67", dateOfBirth: "04/01/98" })],
        provider: "stub",
        attempts: 1,
        cached: false,
        pages: [{ page: 1, success: true, attemptedKeys: ["gemini-2:gemini-2.5-flash-lite"], poolKeyId: "gemini-2:gemini-2.5-flash-lite", attempts: 1 }],
      }),
      _secondOpinionOverride: async (args: { pageNum: number; excludeModels: string[] }) => {
        reReads.push(args);
        return {
          records: [i9Record()], // the tier-1 re-read: full SSN + 4-digit DOB
          poolKeyId: "gemini-1:gemini-2.5-flash",
        };
      },
    } as never,
  );

  assert.equal(reReads.length, 1, "the unsearchable i9 page is re-read despite NO roster being loaded");
  assert.equal(reReads[0].pageNum, 1);
  assert.deepEqual(reReads[0].excludeModels, ["gemini-2.5-flash-lite"], "the first-read model is excluded");

  const records = lastRecords(writtenEntries);
  assert.equal(records[0].ssn, "123-45-6789", "the corrected (searchable) SSN was adopted");
  assert.equal(records[0].dateOfBirth, "04/01/1998");
  assert.ok(
    (records[0].warnings as string[] | undefined)?.some((w) => w.includes("Second-opinion re-read adopted")),
    `adoption is never silent — review warning expected (warnings: ${JSON.stringify(records[0].warnings)})`,
  );
  assert.equal(
    records[0].matchState,
    "resolved",
    "the adopted record became searchable — ready for its separations i9-check member task",
  );
  assert.equal(records[0].ucpathFound, undefined, "no UCPath verdict is stamped during OCR anymore");
});

test("i9 second opinion: a re-read naming a DIFFERENT person is NOT adopted (identity gate) — kept + flagged", async (t) => {
  const { dir, pdfPath, pdfFileId } = await setup();
  t.onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  const { runOcrOrchestrator } = await importOrchestrator();
  const writtenEntries: Array<{ data?: Record<string, unknown> }> = [];

  await runOcrOrchestrator(
    {
      pdfPath,
      pdfOriginalName: "i9-packet.pdf",
      pdfFileId,
      formType: "i9",
      sessionId: "session-i9-so-gate",
      rosterMode: "existing",
    },
    {
      runId: "run-i9-so-gate",
      trackerDir: dir,
      _emitOverride: (entry: unknown) => writtenEntries.push(entry as never),
      _ocrPipelineOverride: async () => ({
        // Legible name, but no usable identifier → suspect (rank 1).
        data: [i9Record({ ssn: null, dateOfBirth: null })],
        provider: "stub",
        attempts: 1,
        cached: false,
        pages: [{ page: 1, success: true, attemptedKeys: ["mistral-1:ministral-8b-latest"], poolKeyId: "mistral-1:ministral-8b-latest", attempts: 1 }],
      }),
      _secondOpinionOverride: async () => ({
        // Ranks better (searchable) but shares NO name token — different person.
        records: [i9Record({ lastName: "Smith", firstName: "John", middleInitial: null })],
        poolKeyId: "gemini-1:gemini-2.5-flash",
      }),
    } as never,
  );

  const records = lastRecords(writtenEntries);
  assert.equal(records[0].lastName, "Doe", "the original reading is kept");
  assert.ok(
    (records[0].warnings as string[] | undefined)?.some((w) => w.includes("different person")),
    `the conflict is surfaced as a review warning (warnings: ${JSON.stringify(records[0].warnings)})`,
  );
});

test("i9 second opinion: a searchable Section-1 read is NOT a suspect — no re-read burned", async (t) => {
  const { dir, pdfPath, pdfFileId } = await setup();
  t.onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  const { runOcrOrchestrator } = await importOrchestrator();
  const writtenEntries: Array<{ data?: Record<string, unknown> }> = [];
  const reReads: unknown[] = [];

  await runOcrOrchestrator(
    {
      pdfPath,
      pdfOriginalName: "i9-packet.pdf",
      pdfFileId,
      formType: "i9",
      sessionId: "session-i9-so-clean",
      rosterMode: "existing",
    },
    {
      runId: "run-i9-so-clean",
      trackerDir: dir,
      _emitOverride: (entry: unknown) => writtenEntries.push(entry as never),
      _ocrPipelineOverride: async () => ({
        data: [i9Record()],
        provider: "stub",
        attempts: 1,
        cached: false,
        pages: [{ page: 1, success: true, attemptedKeys: ["gemini-1:gemini-2.5-flash"], poolKeyId: "gemini-1:gemini-2.5-flash", attempts: 1 }],
      }),
      _secondOpinionOverride: async (args: unknown) => {
        reReads.push(args);
        return null;
      },
    } as never,
  );

  assert.equal(reReads.length, 0, "a clean read never triggers the re-read");
  const records = lastRecords(writtenEntries);
  assert.equal(
    records[0].matchState,
    "resolved",
    "the clean record is searchable as-is (searched later by its member task)",
  );
});
