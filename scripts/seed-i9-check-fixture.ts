/**
 * Seed a synthetic "Run I-9 Check" operation into an isolated tracker dir so the
 * separations queue can be rendered headlessly (see the "Verifying dashboard
 * changes" recipe in the root CLAUDE.md).
 *
 * Emits exactly what production emits: the `separations` operation coordinator
 * row that `/api/ocr/prepare` writes for an i9 upload, the completed delegated
 * OCR run carrying the enriched records, and then the REAL fan-back
 * (`emitI9CheckResultRows`) — so the fixture cannot drift from the row shape the
 * dashboard actually receives.
 *
 *   npx tsx scripts/seed-i9-check-fixture.ts generated/.dashboard-preview/tracker
 */
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { emitTrackerRow } from "../src/tracker/jsonl.js";
import { rowsDir } from "../src/tracker/paths.js";
import { buildTraceId } from "../src/domain/queue-trace-id.js";
import { emitI9CheckResultRows } from "../src/tracker/dashboard/ocr/i9-check-results.js";
import type { I9PreviewRecord } from "../src/services/ocr/forms/i9.js";

const trackerDir = process.argv[2] ?? "generated/.dashboard-preview/tracker";
mkdirSync(rowsDir(trackerDir), { recursive: true });

const sessionId = randomUUID();
const ocrRunId = randomUUID();
const operationRunId = randomUUID();
const operationTraceId = buildTraceId({ code: "se", runId: operationRunId, at: new Date() });

function rec(over: Partial<I9PreviewRecord>): I9PreviewRecord {
  return {
    formKind: "i9",
    sourcePage: 1,
    lastName: "Doe",
    firstName: "Jane",
    middleInitial: null,
    dateOfBirth: "04/01/1998",
    ssn: "123-45-6789",
    documentType: "expected",
    originallyMissing: [],
    notes: [],
    name: "Doe, Jane",
    matchState: "resolved",
    selected: true,
    warnings: [],
    checks: [],
    ...over,
  } as I9PreviewRecord;
}

const records: I9PreviewRecord[] = [
  rec({
    name: "Molinero, Jose A",
    lastName: "Molinero",
    firstName: "Jose",
    ucpathFound: true,
    matchedEmplId: "10366615",
    matchedName: "Jose Rizo",
    personMatchStatus: "completed",
  }),
  rec({
    name: "Zhang, Yukai",
    lastName: "Zhang",
    firstName: "Yukai",
    ucpathFound: false,
    personMatchStatus: "completed",
  }),
  rec({
    name: "Wong, Wing Chun",
    lastName: "Wong",
    firstName: "Wing Chun",
    ucpathFound: false,
    personMatchStatus: "completed",
  }),
  rec({
    name: "Mitchell, Stephanie J",
    lastName: "Mitchell",
    firstName: "Stephanie",
    sourcePage: 4,
    personMatchStatus: "failed",
    warnings: ["UCPath person match failed — found/not-found unknown"],
  }),
  // A filler page (Lists of Acceptable Documents) — must NOT produce a row.
  rec({ formKind: "unknown", name: "", lastName: null, firstName: null, ssn: null, dateOfBirth: null, sourcePage: 5 }),
];

const coordinatorData: Record<string, string> = {
  archetype: "operation",
  mode: "prepare",
  formType: "i9",
  queueRowKind: "file",
  pdfOriginalName: "i9-packet-july.pdf",
  ocrRunId,
  ocrSessionId: sessionId,
  operationWorkflow: "separations",
  operationKind: "i9",
  operationRunId,
  __id: `ocr-prep-${sessionId}`,
  __traceId: operationTraceId,
};

// 1. The coordinator row, as prepare emits it (running → OCR preparing).
emitTrackerRow(
  {
    workflow: "separations",
    timestamp: new Date().toISOString(),
    id: `ocr-prep-${sessionId}`,
    runId: operationRunId,
    status: "running",
    step: "ocr-prep",
    data: { ...coordinatorData, ocrStatus: "running", ocrStep: "preparing" },
  },
  trackerDir,
);

// 2. The completed delegated OCR run carrying the enriched records.
emitTrackerRow(
  {
    workflow: "ocr",
    timestamp: new Date().toISOString(),
    id: sessionId,
    runId: ocrRunId,
    parentRunId: operationRunId,
    status: "done",
    step: "person-lookup",
    data: {
      archetype: "preview",
      mode: "prepare",
      formType: "i9",
      queueRowKind: "file",
      pdfOriginalName: "i9-packet-july.pdf",
      operationWorkflow: "separations",
      ocrSessionId: sessionId,
      ocrRunId,
      __id: sessionId,
      __traceId: buildTraceId({ code: "ic", runId: ocrRunId, at: new Date() }),
      records: JSON.stringify(records),
    },
  },
  trackerDir,
);

// 3. The REAL fan-back — the code under test.
const summary = emitI9CheckResultRows({
  sessionId,
  ocrRunId,
  operation: { workflow: "separations", runId: operationRunId, traceId: operationTraceId },
  trackerDir,
});

// 4. The coordinator settles.
emitTrackerRow(
  {
    workflow: "separations",
    timestamp: new Date().toISOString(),
    id: `ocr-prep-${sessionId}`,
    runId: operationRunId,
    status: "done",
    step: "i9-check",
    data: { ...coordinatorData, ocrStatus: "complete", ocrStep: "results" },
  },
  trackerDir,
);

console.log(`seeded I-9 check operation into ${trackerDir}:`, summary);
