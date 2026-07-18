/**
 * Seed a synthetic "Run I-9 Check" operation into an isolated tracker dir so
 * the separations queue AND the per-person OCR review can be rendered
 * headlessly (see the "Verifying dashboard changes" recipe in the root
 * CLAUDE.md).
 *
 * Emits what production emits (rev. 2026-07-16, real-member-task model): the
 * `separations` operation coordinator row `/api/ocr/prepare` writes for an i9
 * upload, the completed delegated OCR run carrying the enriched records
 * (Section 1↔2 pairing + roster NAME-match seeds, NO UCPath verdicts), then
 * the REAL member fan-out (`enqueueI9CheckMemberTasks`, enqueue stubbed so no
 * daemon spawns — the pre-emit pending rows + provenance logs are the
 * production code path), and finally simulated daemon verdict rows for two
 * members (what `runI9CheckMember` stamps).
 *
 *   npx tsx scripts/seed-i9-check-fixture.ts generated/.dashboard-preview/tracker
 */
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { emitTrackerRow } from "../src/tracker/jsonl.js";
import { rowsDir } from "../src/tracker/paths.js";
import { buildTraceId } from "../src/domain/queue-trace-id.js";
import { openStateDb } from "../src/tracker/state/db.js";
import { registerLocalFile } from "../src/tracker/files/files.js";
import { enqueueI9CheckMemberTasks } from "../src/tracker/dashboard/ocr/i9-check-results.js";
import type { I9PreviewRecord } from "../src/services/ocr/forms/i9.js";

const trackerDir = process.argv[2] ?? "generated/.dashboard-preview/tracker";
mkdirSync(rowsDir(trackerDir), { recursive: true });
process.env.TIMEKEEPER_NAME ||= "Julian";

const sessionId = randomUUID();
const ocrRunId = randomUUID();
const operationRunId = randomUUID();
const operationTraceId = buildTraceId({ code: "se", runId: operationRunId, at: new Date() });

// Back the preview with a REAL scanned packet when available so the
// per-person sections render genuine page images (Sanchez: S2 page 1 + S1
// page 9 in this scan). Falls back to no file id (image slots error, layout
// still renders) when the operator data dir is absent.
const REAL_SCAN = join(process.cwd(), "data", "i9", "Xerox Scan_07102026090215.pdf");
let pdfFileId: string | undefined;
if (existsSync(REAL_SCAN)) {
  const db = openStateDb(trackerDir);
  pdfFileId = registerLocalFile(db, {
    trackerDir,
    kind: "pdf",
    mimeType: "application/pdf",
    path: REAL_SCAN,
    originalName: "i9-packet-july.pdf",
    source: "seed-i9-check-fixture",
  }).fileId;
}

function rec(over: Partial<I9PreviewRecord>): I9PreviewRecord {
  return {
    formKind: "i9 section 1",
    sourcePage: 1,
    lastName: "Doe",
    firstName: "Jane",
    middleInitial: null,
    dateOfBirth: "04/01/1998",
    ssn: "123-45-6789",
    documentType: "expected",
    originallyMissing: [],
    illegible: [],
    corroboration: "unavailable",
    disputedFields: [],
    orphanSection2: false,
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
  // The real packet shape: Sanchez's Section 2 is page 1, his Section 1 page 9
  // — the preview must render BOTH (non-adjacent) pages in one section.
  rec({
    name: "Sanchez, Gabriel",
    lastName: "Sanchez",
    firstName: "Gabriel",
    dateOfBirth: "10/08/1986",
    sourcePage: 9,
    section2Page: 1,
    corroboration: "confirmed",
    ppsEid: "42529",
    ppsEidPadded: "000042529",
    rosterEmplId: "10366615",
    hireDate: "04/25/2016",
    i9SeparationDate: "2/20/2020",
  }),
  // Adjacent pairing (S2 page 3, S1 page 4), no roster name match.
  rec({
    name: "Mihalik, Joshua A",
    lastName: "Mihalik",
    firstName: "Joshua",
    middleInitial: "A",
    dateOfBirth: "09/23/1996",
    sourcePage: 4,
    section2Page: 3,
    corroboration: "confirmed",
    hireDate: "2/24/2016",
  }),
  // Name-only searchable (no usable identifiers), roster name-match hit.
  rec({
    name: "Michels, Veronika A",
    lastName: "Michels",
    firstName: "Veronika",
    middleInitial: "A",
    ssn: null,
    dateOfBirth: null,
    sourcePage: 6,
    section2Page: 5,
    corroboration: "confirmed",
    ppsEid: "843182",
    ppsEidPadded: "000843182",
    hireDate: "02/10/2016",
    warnings: ["No usable SSN or mm/dd/yyyy date of birth — UCPath will be searched by name only"],
  }),
  // An orphan Section 2 — employer verified this person, Section 1 missing
  // (fixture repurposes the page-7 sheet as an orphan).
  rec({
    formKind: "i9 section 2",
    name: "Menon, Elizabeth C",
    lastName: "Menon",
    firstName: "Elizabeth",
    middleInitial: "C",
    ssn: null,
    dateOfBirth: null,
    sourcePage: 7,
    hireDate: "02/18/2016",
    orphanSection2: true,
    warnings: [
      'Section 2 for "Menon, Elizabeth C" is in the packet but its Section 1 page is NOT — this person could not be checked against UCPath. Locate the missing Section 1 page.',
    ],
  }),
  // An unreadable Section 1 — becomes a display-only failed row.
  rec({
    formKind: "i9 section 1",
    name: "",
    lastName: null,
    firstName: null,
    ssn: null,
    dateOfBirth: null,
    sourcePage: 8,
    illegible: ["lastName", "firstName", "ssn", "dateOfBirth"],
    matchState: "unresolved",
    warnings: ["Cannot check against UCPath: no legible name on this I-9 — verify the scan"],
  }),
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
    step: "ocr",
    data: {
      archetype: "preview",
      mode: "prepare",
      formType: "i9",
      queueRowKind: "file",
      pdfOriginalName: "i9-packet-july.pdf",
      operationWorkflow: "separations",
      ocrSessionId: sessionId,
      ocrRunId,
      ...(pdfFileId ? { pdfFileId } : {}),
      __id: sessionId,
      __traceId: buildTraceId({ code: "ic", runId: ocrRunId, at: new Date() }),
      records: JSON.stringify(records),
    },
  },
  trackerDir,
);

// 3. The REAL member fan-out — pre-emit pending rows + provenance logs are the
// production code; only the daemon enqueue itself is stubbed (no daemon in a
// preview fixture).
const memberRunIdByItemId = new Map<string, string>();
const summary = await enqueueI9CheckMemberTasks({
  sessionId,
  ocrRunId,
  operation: { workflow: "separations", runId: operationRunId, traceId: operationTraceId },
  trackerDir,
  ensureDaemonsAndEnqueueOverride: async (_wf, inputs, _flags, opts) => {
    const runIds = opts.runIds as string[];
    const deriveItemId = opts.deriveItemId as (input: unknown) => string;
    const onPreEmitPending = opts.onPreEmitPending as (
      item: unknown,
      runId: string,
      parentRunId: string | undefined,
      itemId: string,
    ) => void;
    inputs.forEach((input, i) => {
      const { __runtimeOptions: _r, ...cleaned } = input as Record<string, unknown>;
      const itemId = deriveItemId(cleaned);
      memberRunIdByItemId.set(itemId, runIds[i]);
      onPreEmitPending(input, runIds[i], opts.parentRunId as string, itemId);
    });
    return { enqueued: inputs.length };
  },
});

// 4. Simulated daemon verdicts for two members — the data shape
// `runI9CheckMember` stamps (found + Keep; not-found + Shred).
function emitVerdict(
  recordIndex: number,
  data: Record<string, string>,
): void {
  const itemId = `i9-check-${sessionId}-r${recordIndex}`;
  const runId = memberRunIdByItemId.get(itemId);
  if (!runId) return;
  emitTrackerRow(
    {
      workflow: "separations",
      timestamp: new Date().toISOString(),
      id: itemId,
      runId,
      parentRunId: operationRunId,
      status: "done",
      step: "i9-check",
      data: {
        archetype: "operation-member",
        queueRowKind: "person",
        i9Check: "true",
        ocrSessionId: sessionId,
        ocrRunId,
        __id: itemId,
        ...data,
      },
    },
    trackerDir,
  );
}

emitVerdict(0, {
  name: "Sanchez, Gabriel",
  __subject: "Sanchez, Gabriel",
  __subjectKind: "person",
  ucpathFound: "true",
  ucpathFoundLabel: "Yes",
  eid: "10366615",
  matchedName: "Gabriel Sanchez",
  ppsEid: "42529",
  separationDate: "2/20/2020",
  i9HireDate: "04/25/2016",
  section1Present: "Yes — page 9",
  section2Present: "Yes — page 1",
  i9RetentionAction: "Shred",
});
emitVerdict(1, {
  name: "Mihalik, Joshua A",
  __subject: "Mihalik, Joshua A",
  __subjectKind: "person",
  ucpathFound: "false",
  ucpathFoundLabel: "Not found in UCPath",
  i9HireDate: "2/24/2016",
  section1Present: "Yes — page 4",
  section2Present: "Yes — page 3",
  i9RetentionAction: "Shred",
});

// 5. The coordinator as the fan-out leaves it — RUNNING; the members-terminal
// rollup completes it once every member finishes.
emitTrackerRow(
  {
    workflow: "separations",
    timestamp: new Date().toISOString(),
    id: `ocr-prep-${sessionId}`,
    runId: operationRunId,
    status: "running",
    step: "i9-check",
    data: { ...coordinatorData, ocrStatus: "members-queued", ocrStep: "i9-check" },
  },
  trackerDir,
);

console.log(`seeded I-9 check operation into ${trackerDir}:`, summary);
console.log(`OCR review row: session ${sessionId}`);
