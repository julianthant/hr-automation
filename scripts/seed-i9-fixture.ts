/**
 * Seed a synthetic STANDALONE i9 OCR review row (terminal `done`, the
 * read-only UCPath person-check report) into an isolated tracker dir, for
 * headless dashboard verification of the i9 form type with `playwright-cli`.
 *
 * Mirrors the real shape `runOcrOrchestrator`'s `writeTracker` stamps for a
 * standalone completed prep row (see `src/workflows/ocr/orchestrator.ts`),
 * trimmed to the fields the dashboard's OcrReviewPane / VerifyRecordView
 * read. Records + checks are built with the REAL i9 form-spec helpers
 * (`buildI9Checks` / `applyPersonMatchToI9Record`) so the fixture cannot
 * drift from the production record shape.
 *
 * Usage:
 *   tsx scripts/seed-i9-fixture.ts [trackerDir]
 *   (default: generated/.dashboard-preview/tracker — gitignored)
 *
 * Then:
 *   npm run build:dashboard
 *   HRAUTO_TRACKER_DIR=generated/.dashboard-preview/tracker npm run dashboard:prod -- --port 3944
 *   playwright-cli -s=i9 open "http://localhost:3944/?wf=ocr&id=i9-fixture"
 *   (open the Preview tab — available whenever `data.mode === "prepare"`.)
 */
import { mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { buildTraceId } from "../src/domain/queue-trace-id.js";
import { emitTrackerRow, type StampedData } from "../src/tracker/jsonl-io.js";
import { rowsDir } from "../src/tracker/paths.js";
import {
  applyPersonMatchToI9Record,
  buildI9Checks,
  type I9PreviewRecord,
} from "../src/services/ocr/forms/i9.js";

const dir = process.argv[2] ?? "generated/.dashboard-preview/tracker";
mkdirSync(rowsDir(dir), { recursive: true });

const baseAt = new Date();

function makeRecord(overrides: Partial<I9PreviewRecord>): I9PreviewRecord {
  const rec: I9PreviewRecord = {
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
    name: "Doe, Jane A",
    matchState: "resolved",
    selected: true,
    warnings: [],
    checks: [],
    ...overrides,
  };
  rec.checks = buildI9Checks(rec);
  return rec;
}

const found = makeRecord({ sourcePage: 1, personMatchStatus: "completed" });
applyPersonMatchToI9Record(found, {
  found: "true",
  matchedEmplId: "10874100",
  matchedName: "Jane Doe",
});
found.checks = buildI9Checks(found);

const notFound = makeRecord({
  sourcePage: 2,
  lastName: "Roe",
  firstName: "Sam",
  middleInitial: null,
  name: "Roe, Sam",
  dateOfBirth: "09/12/2001",
  ssn: "987-65-4321",
  personMatchStatus: "completed",
});
applyPersonMatchToI9Record(notFound, { found: "false" });
notFound.checks = buildI9Checks(notFound);

const failed = makeRecord({
  sourcePage: 3,
  lastName: "Nguyen",
  firstName: "Kim",
  middleInitial: null,
  name: "Nguyen, Kim",
  ssn: null,
  personMatchStatus: "failed",
  matchState: "unresolved",
  warnings: ["UCPath person match timed out without a result"],
});

const runId = randomUUID();
const id = "i9-fixture";
const traceId = buildTraceId({ code: "ic", runId, at: baseAt });
const data: StampedData = {
  archetype: "preview",
  mode: "prepare",
  formType: "i9",
  sessionId: id,
  pdfPath: "",
  pdfOriginalName: "I9_Packet_Fixture.pdf",
  rosterPath: "",
  records: JSON.stringify([found, notFound, failed]),
  ocrSessionId: id,
  ocrRunId: runId,
  queueRowKind: "file",
  __id: id,
  __name: "OCR",
  __traceId: traceId,
};

emitTrackerRow(
  {
    workflow: "ocr",
    timestamp: baseAt.toISOString(),
    id,
    runId,
    status: "done",
    step: "person-lookup",
    data,
  },
  dir,
);

// eslint-disable-next-line no-console
console.log(`[seed-i9-fixture] i9 row → id=${id} runId=${runId.slice(0, 8)}… trace=${traceId}`);
