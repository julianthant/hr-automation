import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { defineWorkflow } from "../../../src/core/index.js";
import { openStateDb } from "../../../src/tracker/state/db.js";
import { registerLocalFile } from "../../../src/tracker/files/files.js";
import { ensurePdfPageCache } from "../../../src/tracker/files/pdf-cache.js";
import { runOcrOrchestrator } from "../../../src/workflows/ocr/orchestrator.js";
import { ocrWorkflow } from "../../../src/workflows/ocr/index.js";
import { findFrozenTraceId } from "../../../src/tracker/find-latest-entry.js";
import { OcrInputSchema, type OcrInput } from "../../../src/workflows/ocr/schema.js";
import {
  subscribeToApproval,
  emitApproved,
  type ApprovedPayload,
} from "../../../src/services/ocr/approval-signal.js";
import { writeOnePagePdf } from "../../_utils/one-page-pdf.js";
import type { RegisteredWorkflow } from "../../../src/core/kernel/types.js";

/**
 * A synthetic OATH OCR record the stub pipeline returns. PII-FREE — tests pass
 * fake printed names + fake 5+-digit (UCPath-shaped 8-digit) EIDs; never extract
 * real EIDs/names from the fixture PDFs. The oath form spec's `matchRecord` runs
 * on these for real, so an EID present here that also appears in the stub roster
 * short-circuits to `matched` (form-eid) and passes the approve fan-out's
 * `canFanOut` (`selected` + `/^\d{5,}$/` EID).
 */
export interface StubOcrRecord {
  sourcePage: number;
  rowIndex: number;
  printedName: string;
  employeeId: string;
  employeeSigned: boolean;
  officerSigned?: boolean | null;
  dateSigned: string;
  notes?: string[];
  documentType?: string;
  originallyMissing?: string[];
}

/**
 * A synthetic EMERGENCY-CONTACT OCR record the stub pipeline returns. Mirrors
 * the EC form spec's `PermissiveRecordSchema` raw shape (`employee.name` /
 * `employee.employeeId` + a nested `emergencyContact`). Same PII-FREE rule.
 * The EC form spec's `matchRecord` runs on these for real; a form-EID present
 * (`employee.employeeId`) short-circuits to `matched` (form source).
 */
export interface StubEcOcrRecord {
  sourcePage: number;
  employee: {
    name: string;
    employeeId: string;
  };
  emergencyContact: {
    name: string;
    relationship: string;
    primary?: boolean;
    sameAddressAsEmployee: boolean;
    address?: { street: string; city?: string; state?: string; zip?: string } | null;
    cellPhone?: string | null;
    homePhone?: string | null;
    workPhone?: string | null;
  };
  notes?: string[];
  documentType?: string;
  originallyMissing?: string[];
}

/**
 * A synthetic VERIFY OCR record the stub pipeline returns. Mirrors the verify
 * form spec's `VerifyOcrRecordSchema` raw shape — a MIXED oath + emergency-
 * contact page record. Same PII-FREE rule (fake printed names; verify enriches
 * via person-lookup/i9-lookup, not a roster, so EIDs are usually blank on
 * paper). The verify `matchRecord` runs on these for real, then `enrichRecords`
 * fans out to person-lookup (every record with a `name`) and i9-lookup (oath
 * records with `officerSigned !== true`).
 */
export interface StubVerifyOcrRecord {
  formKind: "oath" | "emergency-contact" | "unknown";
  sourcePage: number;
  printedName: string;
  /** Usually null/absent on paper for verify (looked up via person-lookup). */
  employeeId?: string | null;
  /** oath: authorized-official signature present. `false` → i9-lookup fires. */
  officerSigned?: boolean | null;
  paperEmploymentDate?: string | null;
  paperDateSigned?: string | null;
  employeeSigned?: boolean | null;
  paperOfficialName?: string | null;
  documentType?: "expected" | "unknown";
  originallyMissing?: string[];
  notes?: string[];
}

/** Roster row the stub `_loadRosterOverride` returns (eid+name only). */
export interface StubRosterRow {
  eid: string;
  name: string;
}

/**
 * Mutable holder the OCR stub handler reads at run time. `rt.stubOcr` sets it.
 * `rawRecords` are FORM-APPROPRIATE raw OCR records (oath-shaped or EC-shaped)
 * passed VERBATIM to the orchestrator's pipeline — the real `spec.matchRecord`
 * runs on them. The stub is form-agnostic: it no longer re-maps an oath struct.
 */
export interface StubOcrState {
  rawRecords: Array<Record<string, unknown>>;
  roster: StubRosterRow[];
}

export interface StubOcrConfig {
  /** OCR form type. Default `"oath"` (the P2.9 oath-signature fan-out). */
  formType?: string;
}

/**
 * Build the thin test-only `"ocr"` workflow used by the Tier-1 delegation
 * harness — exactly the bridge-test pattern (`tests/integration/ocr/
 * end-to-end.test.ts`, now retired), but registered as a real daemon workflow
 * so the harness drives it end-to-end. Its handler calls the REAL
 * `runOcrOrchestrator` with the LLM/roster/eid-lookup escape hatches stubbed
 * (no live browser, no LLM, no SQLite deps) and parks at `awaiting-approval`
 * via `subscribeToApproval`. The approve fan-out is driven separately by the
 * real `buildOcrApproveHandler` (see `runtime.approveOcr`).
 *
 * The `state` holder is shared with `rt.stubOcr(records)` so a test sets the
 * records AFTER construction but BEFORE enqueueing the OCR run.
 */
export function makeStubOcrWorkflow(
  state: StubOcrState,
  config: StubOcrConfig = {},
): RegisteredWorkflow<OcrInput, readonly string[]> {
  const formType = config.formType ?? "oath";
  return defineWorkflow({
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
      const orchestratorInput: OcrInput = {
        ...input,
        formType,
        ...(input.parentRunId ?? ctx.parentRunId
          ? { parentRunId: input.parentRunId ?? ctx.parentRunId }
          : {}),
      };
      // Capture the orchestrator's latest rich preview payload (pdfOriginalName,
      // records, page metadata) so the kernel's auto-emitted terminal `done`
      // row stays a recognizable preview row instead of clobbering the rich
      // approve-route row in latest-wins dedupe — exactly the real handler's
      // pattern (`src/workflows/ocr/workflow.ts`).
      let lastReviewData: Record<string, unknown> | undefined;
      const result = await runOcrOrchestrator(orchestratorInput, {
        runId: ctx.runId,
        ...(ctx.trackerDir ? { trackerDir: ctx.trackerDir } : {}),
        signal: ctx.signal,
        onPhase: (step) => ctx.reportPhase(step),
        onReviewData: (data) => {
          lastReviewData = data;
        },
        // LLM extraction → the FORM-APPROPRIATE raw records the test seeded,
        // passed verbatim. The stub is form-agnostic: `spec.matchRecord` runs on
        // these for real (oath-shaped for oath, EC-shaped for EC).
        _ocrPipelineOverride: async () => ({
          data: state.rawRecords.map((r) => ({ ...r })),
          provider: "stub",
          attempts: 1,
          cached: false,
        }),
        // Roster: the synthetic rows the test seeded (EID short-circuit to matched).
        _loadRosterOverride: async () => state.roster.map((r) => ({ eid: r.eid, name: r.name })),
        // person-lookup eid-lookup fan-out: no daemon — no-op enqueue + a synthetic
        // `done` outcome per child so matched records gain a `verification` and the
        // orchestrator reaches awaiting-approval without a live person-lookup.
        _enqueueEidLookupOverride: async () => {
          /* no-op: no person-lookup daemon in this runtime */
        },
        _disableSqliteDependencies: true,
        _watchChildRunsOverride: async (watchOpts) =>
          watchOpts.expectedItemIds.map((itemId, i) => ({
            workflow: "person-lookup",
            itemId,
            runId: `stub-verify-${i}`,
            status: "done" as const,
            data: {
              emplId: rawRecordEid(state.rawRecords[i]),
              hrStatus: "Active",
              department: "HDH",
              personOrgScreenshot: "x.png",
            },
          })),
      });
      if (result.status === "complete") {
        // STANDALONE review run (verify / standalone oath-EC) — completed `done`
        // after person-lookup, no approval gate. Seed the rich review payload so
        // the kernel's terminal `done` row keeps the preview identity (mirrors
        // the real ocrKernelHandler's `complete` branch).
        const reviewData: Record<string, unknown> = { ...(lastReviewData ?? {}) };
        delete reviewData.parentRunId;
        const frozenTraceId = findFrozenTraceId({
          workflow: "ocr",
          runId: ctx.runId,
          ...(ctx.trackerDir ? { trackerDir: ctx.trackerDir } : {}),
        });
        ctx.updateData({
          ...reviewData,
          ...(frozenTraceId ? { __traceId: frozenTraceId } : {}),
          mode: "prepare",
        } as Partial<OcrInput & Record<string, unknown>>);
        return;
      }
      if (result.status !== "awaiting-approval") return;

      // Park until the approve route (`rt.approveOcr`) fires `emitApproved`.
      const payload: ApprovedPayload = await subscribeToApproval(
        { workflow: "ocr", sessionId: input.sessionId },
        { signal: ctx.signal, ...(ctx.trackerDir ? { trackerDir: ctx.trackerDir } : {}) },
      );
      // Seed the rich review payload (sans kernel-owned parentRunId) + records
      // onto accumulated data so the kernel's terminal `done` row keeps the OCR
      // preview identity (pdfOriginalName/mode/file-kind title) rather than
      // collapsing to a sparse, title-less row.
      // Strip the kernel-owned parentRunId so the re-stamp doesn't fight the
      // kernel's own delegated-scope handling.
      const reviewData: Record<string, unknown> = { ...(lastReviewData ?? {}) };
      delete reviewData.parentRunId;
      // Carry the operation's frozen `__traceId` onto the re-stamp. The
      // orchestrator stamps it (`ou-…` for oath via `spec.traceCode`, `oc-…`
      // otherwise) on every row it emits, but AFTER `onReviewData` captured
      // `lastReviewData` — so without this, the kernel's auto-emitted terminal
      // `done` row would fall back to the workflow's own pre-emit code (`oc-`)
      // and clobber the operation prefix on the latest OCR row. Production's
      // `latestReviewData` carries `__traceId` for the same reason; mirror it.
      const frozenTraceId = findFrozenTraceId({
        workflow: "ocr",
        runId: ctx.runId,
        ...(ctx.trackerDir ? { trackerDir: ctx.trackerDir } : {}),
      });
      ctx.updateData({
        ...reviewData,
        ...(frozenTraceId ? { __traceId: frozenTraceId } : {}),
        mode: "prepare",
        records: JSON.stringify(payload.records),
        recordCount: String(payload.records.length),
      } as Partial<OcrInput & Record<string, unknown>>);
    },
  }) as unknown as RegisteredWorkflow<OcrInput, readonly string[]>;
}

/**
 * Register a renderable PDF in the temp tracker's file store so the
 * orchestrator's inline `ensurePdfPageCache` produces a page cache without a
 * browser. Prefers the real fixture; falls back to a synthetic one-page pdf-lib
 * PDF if the fixture fails to render headlessly (the records come from the
 * override regardless — the PDF only needs to render a page cache). Returns the
 * `pdfFileId` + `pdfPath` to feed the OCR input, and whether the real fixture
 * rendered.
 */
export async function registerOcrPdf(opts: {
  trackerDir: string;
  fixturePath: string;
  originalName: string;
}): Promise<{ pdfFileId: string; pdfPath: string; usedFixture: boolean }> {
  const db = openStateDb(opts.trackerDir);

  const tryRegister = async (path: string, originalName: string): Promise<string> => {
    const { fileId } = registerLocalFile(db, {
      kind: "pdf",
      mimeType: "application/pdf",
      path,
      originalName,
      source: "delegation-ocr-test",
    });
    // Force a page render now so a fallback can be chosen synchronously here
    // (rather than failing later inside the orchestrator).
    const pages = await ensurePdfPageCache(db, {
      trackerDir: opts.trackerDir,
      fileId,
      pdfPath: path,
    });
    if (!pages.some((p) => p.status === "ready" && p.imagePath)) {
      throw new Error(`PDF ${path} rendered zero ready pages`);
    }
    return fileId;
  };

  try {
    const fileId = await tryRegister(opts.fixturePath, opts.originalName);
    return { pdfFileId: fileId, pdfPath: opts.fixturePath, usedFixture: true };
  } catch {
    // Synthetic fallback — a minimal one-page pdf-lib PDF that always renders.
    const uploadsDir = join(opts.trackerDir, "uploads");
    mkdirSync(uploadsDir, { recursive: true });
    const synthPath = join(uploadsDir, "synthetic-oath.pdf");
    await writeOnePagePdf(synthPath);
    const fileId = await tryRegister(synthPath, opts.originalName);
    return { pdfFileId: fileId, pdfPath: synthPath, usedFixture: false };
  }
}

/**
 * Read the employee EID off a form-appropriate raw OCR record (oath:
 * `employeeId`; EC: `employee.employeeId`). Used by the stub's roster
 * derivation + synthetic person-lookup verification outcome so both forms
 * short-circuit `matchRecord` to `matched`.
 */
export function rawRecordEid(record: Record<string, unknown> | undefined): string {
  if (!record) return "";
  if (typeof record.employeeId === "string") return record.employeeId;
  const employee = record.employee as Record<string, unknown> | undefined;
  if (employee && typeof employee.employeeId === "string") return employee.employeeId;
  return "";
}

/** Read the employee NAME off a form-appropriate raw OCR record. */
export function rawRecordName(record: Record<string, unknown> | undefined): string {
  if (!record) return "";
  if (typeof record.printedName === "string") return record.printedName;
  const employee = record.employee as Record<string, unknown> | undefined;
  if (employee && typeof employee.name === "string") return employee.name;
  return "";
}

/**
 * Derive a roster row per raw record (EID short-circuit → `matched`) when the
 * test omits an explicit roster — form-agnostic via `rawRecordEid`/`rawRecordName`.
 */
export function deriveRosterFromRawRecords(
  rawRecords: ReadonlyArray<Record<string, unknown>>,
): StubRosterRow[] {
  return rawRecords.map((r) => ({ eid: rawRecordEid(r), name: rawRecordName(r) }));
}

/**
 * Build a raw OATH OCR record (the orchestrator pipeline shape) from a
 * `StubOcrRecord`. Passed verbatim through `_ocrPipelineOverride`.
 */
export function rawOathRecordFromStub(r: StubOcrRecord): Record<string, unknown> {
  return {
    sourcePage: r.sourcePage,
    rowIndex: r.rowIndex,
    printedName: r.printedName,
    employeeId: r.employeeId,
    employeeSigned: r.employeeSigned,
    officerSigned: r.officerSigned ?? true,
    dateSigned: r.dateSigned,
    notes: r.notes ?? [],
    documentType: r.documentType ?? "expected",
    originallyMissing: r.originallyMissing ?? [],
  };
}

/**
 * Build a raw EMERGENCY-CONTACT OCR record (the orchestrator pipeline shape,
 * `PermissiveRecordSchema`) from a `StubEcOcrRecord`. Passed verbatim through
 * `_ocrPipelineOverride`; the EC `matchRecord` short-circuits on the form-EID.
 */
export function rawEcRecordFromStub(r: StubEcOcrRecord): Record<string, unknown> {
  return {
    formKind: "emergency-contact",
    sourcePage: r.sourcePage,
    employee: { ...r.employee },
    emergencyContact: { primary: true, ...r.emergencyContact },
    notes: r.notes ?? [],
    documentType: r.documentType ?? "expected",
    originallyMissing: r.originallyMissing ?? [],
  };
}

/**
 * Build a raw VERIFY OCR record (the orchestrator pipeline shape,
 * `VerifyOcrRecordSchema`) from a `StubVerifyOcrRecord`. Passed verbatim
 * through `_ocrPipelineOverride`; the verify `matchRecord` runs on it and
 * `enrichRecords` fans out to person-lookup + i9-lookup. verify has NO approve
 * fan-out — it is a read-only completeness report.
 */
export function rawVerifyRecordFromStub(r: StubVerifyOcrRecord): Record<string, unknown> {
  return {
    formKind: r.formKind,
    sourcePage: r.sourcePage,
    printedName: r.printedName,
    employeeId: r.employeeId ?? null,
    ...(r.officerSigned !== undefined ? { officerSigned: r.officerSigned } : {}),
    ...(r.paperEmploymentDate !== undefined ? { paperEmploymentDate: r.paperEmploymentDate } : {}),
    ...(r.paperDateSigned !== undefined ? { paperDateSigned: r.paperDateSigned } : {}),
    ...(r.employeeSigned !== undefined ? { employeeSigned: r.employeeSigned } : {}),
    ...(r.paperOfficialName !== undefined ? { paperOfficialName: r.paperOfficialName } : {}),
    documentType: r.documentType ?? "expected",
    originallyMissing: r.originallyMissing ?? [],
    notes: r.notes ?? [],
  };
}

/**
 * Build the approved OATH-records payload the operator would submit: every stub
 * record, marked `selected` so the oath form spec's `canFanOut` (selected +
 * 5+-digit EID) lets it fan out to one oath-signature signer row.
 */
export function approvedOathRecordsFromStub(records: StubOcrRecord[]): Array<Record<string, unknown>> {
  return records.map((r) => ({
    formKind: "oath",
    sourcePage: r.sourcePage,
    rowIndex: r.rowIndex,
    printedName: r.printedName,
    employeeId: r.employeeId,
    employeeSigned: r.employeeSigned,
    dateSigned: r.dateSigned,
    documentType: r.documentType ?? "expected",
    originallyMissing: r.originallyMissing ?? [],
    notes: r.notes ?? [],
    matchState: "matched",
    matchSource: "form-eid",
    selected: true,
    warnings: [],
  }));
}

/**
 * Build the approved EMERGENCY-CONTACT-records payload the operator would
 * submit. Each record is `selected:true` so the approve route's
 * `isSelectedRecord` passes; EC's `approveTo` has NO `canFanOut`, so every
 * selected record fans out. The shape satisfies EC's
 * `approveTo.deriveInput` (`employee.employeeId` + `emergencyContact`) and the
 * `matched`/`form` provenance mirrors how `matchRecord` short-circuits on a
 * form-EID present in the roster.
 */
export function approvedEcRecordsFromStub(records: StubEcOcrRecord[]): Array<Record<string, unknown>> {
  return records.map((r) => ({
    formKind: "emergency-contact",
    sourcePage: r.sourcePage,
    employee: { ...r.employee },
    emergencyContact: { primary: true, ...r.emergencyContact },
    notes: r.notes ?? [],
    documentType: r.documentType ?? "expected",
    originallyMissing: r.originallyMissing ?? [],
    matchState: "matched",
    matchSource: "form",
    matchConfidence: 1.0,
    selected: true,
    warnings: [],
  }));
}

export { emitApproved };
