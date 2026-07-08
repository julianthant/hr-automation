/**
 * Seed two synthetic DELEGATED OCR prep rows (one oath, one emergency-contact)
 * carrying a LOW-CONFIDENCE LLM-disambiguated record into an isolated tracker
 * dir, for headless dashboard verification of the OCR warnings/matchConfidence
 * badge fix with `playwright-cli`.
 *
 * Mirrors the real shape `runOcrOrchestrator`'s `writeTracker` stamps for a
 * delegated (parentRunId-carrying) OCR prep row awaiting approval — see
 * `src/workflows/ocr/orchestrator.ts` — trimmed to only the fields the
 * dashboard's OcrReviewPane / OathRecordView / EcRecordView actually read.
 *
 * Usage:
 *   tsx scripts/seed-ocr-warnings-fixture.ts [trackerDir]
 *   (default: generated/.dashboard-preview/tracker — gitignored)
 *
 * Then:
 *   npm run build:dashboard
 *   HRAUTO_TRACKER_DIR=generated/.dashboard-preview/tracker npm run dashboard:prod -- --port 3943
 *   playwright-cli -s=ocrw open "http://localhost:3943/?wf=ocr&id=oath-warn-fixture"
 *   playwright-cli -s=ocrw open "http://localhost:3943/?wf=ocr&id=ec-warn-fixture"
 *   (click the "Preview" tab — the OCR row's Preview tab is available
 *   whenever `data.mode === "prepare"`, independent of `?id=`.)
 */
import { mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { buildTraceId } from "../src/domain/queue-trace-id.js";
import { emitTrackerRow, type StampedData } from "../src/tracker/jsonl-io.js";
import { rowsDir } from "../src/tracker/paths.js";

const dir = process.argv[2] ?? "generated/.dashboard-preview/tracker";
mkdirSync(rowsDir(dir), { recursive: true });

const baseAt = new Date();

// A fake parent (operation coordinator) run id — never resolved to a real
// row. Only its presence matters: `OcrReviewPane`'s `isDelegation` gate reads
// `entry.parentRunId` directly, so this alone routes the row through the
// EDITABLE `OathRecordView`/`EcRecordView` cards (not the read-only
// `VerifyRecordView` projection a standalone run would use).
const fakeParentRunId = randomUUID();

function oathRow(): void {
  const runId = randomUUID();
  const id = "oath-warn-fixture";
  const traceId = buildTraceId({ code: "oc", runId, at: baseAt });
  const record = {
    formKind: "oath",
    sourcePage: 1,
    rowIndex: 0,
    printedName: "Doe, Jane",
    firstName: "Jane",
    lastName: "Doe",
    employeeSigned: true,
    officerSigned: true,
    dateSigned: "07/01/2026",
    notes: [],
    employeeId: "10000001",
    matchState: "lookup-pending",
    matchSource: "llm",
    matchConfidence: 0.4,
    selected: true,
    warnings: ["LLM picked EID 10000001 but low confidence (0.40) — review"],
  };
  const data: StampedData = {
    archetype: "preview",
    mode: "prepare",
    formType: "oath",
    sessionId: id,
    pdfPath: "",
    pdfOriginalName: "Oath_Packet_Fixture.pdf",
    rosterPath: "",
    records: JSON.stringify([record]),
    ocrSessionId: id,
    ocrRunId: runId,
    operationWorkflow: "oath-signature",
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
      parentRunId: fakeParentRunId,
      status: "running",
      step: "awaiting-approval",
      data,
    },
    dir,
  );
  // eslint-disable-next-line no-console
  console.log(`[seed-ocr-warnings-fixture] oath row → id=${id} runId=${runId.slice(0, 8)}… trace=${traceId}`);
}

function ecRow(): void {
  const runId = randomUUID();
  const id = "ec-warn-fixture";
  const traceId = buildTraceId({ code: "oc", runId, at: baseAt });
  const record = {
    formKind: "emergency-contact",
    sourcePage: 1,
    employee: { name: "Lee, Jordan", employeeId: "10000002" },
    emergencyContact: {
      name: "Lee, Robin",
      relationship: "Parent",
      primary: true,
      sameAddressAsEmployee: true,
    },
    notes: [],
    matchState: "lookup-pending",
    matchSource: "llm",
    matchConfidence: 0.35,
    selected: true,
    warnings: ["LLM picked EID 10000002 but low confidence (0.35) — review"],
  };
  const data: StampedData = {
    archetype: "preview",
    mode: "prepare",
    formType: "emergency-contact",
    sessionId: id,
    pdfPath: "",
    pdfOriginalName: "EC_Packet_Fixture.pdf",
    rosterPath: "",
    records: JSON.stringify([record]),
    ocrSessionId: id,
    ocrRunId: runId,
    operationWorkflow: "emergency-contact",
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
      parentRunId: fakeParentRunId,
      status: "running",
      step: "awaiting-approval",
      data,
    },
    dir,
  );
  // eslint-disable-next-line no-console
  console.log(`[seed-ocr-warnings-fixture] EC row → id=${id} runId=${runId.slice(0, 8)}… trace=${traceId}`);
}

/**
 * Standalone oath row (NO parentRunId, terminal `done`): renders the
 * READ-ONLY `VerifyRecordView` projection via `toReadonlyVerifyRecord` — the
 * post-hoc audit path where `matchConfidence` must also surface.
 */
function standaloneOathRow(): void {
  const runId = randomUUID();
  const id = "oath-standalone-fixture";
  const traceId = buildTraceId({ code: "oc", runId, at: baseAt });
  const record = {
    formKind: "oath",
    sourcePage: 1,
    rowIndex: 0,
    printedName: "Roe, Alex",
    employeeSigned: true,
    officerSigned: true,
    dateSigned: "07/01/2026",
    notes: [],
    employeeId: "10000003",
    matchState: "lookup-pending",
    matchSource: "llm",
    matchConfidence: 0.45,
    selected: true,
    warnings: ["LLM picked EID 10000003 but low confidence (0.45) — review"],
  };
  const data: StampedData = {
    archetype: "preview",
    mode: "prepare",
    formType: "oath",
    sessionId: id,
    pdfPath: "",
    pdfOriginalName: "Oath_Standalone_Fixture.pdf",
    rosterPath: "",
    records: JSON.stringify([record]),
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
  console.log(`[seed-ocr-warnings-fixture] standalone oath row → id=${id} runId=${runId.slice(0, 8)}…`);
}

oathRow();
ecRow();
standaloneOathRow();

// eslint-disable-next-line no-console
console.log(`[seed-ocr-warnings-fixture] seeded → ${dir}`);
