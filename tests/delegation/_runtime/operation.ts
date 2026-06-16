import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { buildOcrPrepareHandler } from "../../../src/tracker/dashboard/ocr/prepare.js";
import { runOcrOrchestrator } from "../../../src/workflows/ocr/orchestrator.js";
import type { OcrInput } from "../../../src/workflows/ocr/schema.js";

import { registerOcrPdf, rawRecordEid, deriveRosterFromRawRecords, type StubRosterRow } from "./ocr-stub.js";
import type { ApprovedChild, ApproveOcrOpts, DelegationRuntime } from "./runtime.js";

/**
 * Drive the REAL run-modal handlers (`/api/ocr/prepare` + `/api/ocr/approve-batch`)
 * against the harness's temp tracker + gated daemons, for the OCR-delegated
 * **operation** workflows (oath-signature / emergency-contact).
 *
 * SEAM (real handler, no fallback). `preparyOperation`/`prepareOperation` drives
 * the REAL `buildOcrPrepareHandler` with an operation `targetWorkflow`, so the
 * real operation-coordinator stamping path runs: the `archetype:"operation"`
 * coordinator row in the target panel + the OCR run delegated under it
 * (`parentRunId = operationRunId`) + the denormalized `ocr*` fields + the
 * trace-prefix composition (operation `os-…`/`ec-…` prefix → OCR row). The ONLY
 * substitution is the orchestrator's PDF/LLM/roster/SQLite IO: the handler's
 * `runOrchestrator` opt is given a wrapper around the REAL `runOcrOrchestrator`
 * with the SAME `_ocrPipelineOverride` / `_loadRosterOverride` /
 * `_enqueueEidLookupOverride` / `_watchChildRunsOverride` /
 * `_disableSqliteDependencies` escape hatches the OCR stub daemon uses
 * (`ocr-stub.ts`). No real PDF text, no browser, no LLM, no live person-lookup —
 * but every operation-coordinator code path in `prepare.ts` is the real one.
 *
 * `approveOperation` is a thin wrapper over the runtime's existing `approveOcr`
 * (the documented multi-target approve seam, `ensureDaemonsAndEnqueueOverride`),
 * which routes the per-record fan-out children onto the gated test daemons. For
 * an operation coordinator workflow the real approve route stamps the children
 * `operation-member` (via `isOperationCoordinatorWorkflow`) and parents them to
 * the coordinator run — exactly the production behavior under test.
 */

export interface PrepareOperationOpts {
  /** The dashboard workflow the operator clicked Run on (oath-signature / emergency-contact). */
  targetWorkflow: string;
  /** OCR form type. Defaults to the runtime's `ocr.formType`, else `"oath"`. */
  formType?: string;
  /** Path to a renderable fixture PDF (falls back to a synthetic one-pager). */
  fixturePath: string;
  /** Original filename the operation/OCR file title resolves to. Defaults to basename. */
  originalName?: string;
  /**
   * Raw, form-appropriate OCR records the stub pipeline returns VERBATIM (build
   * via `rawOathRecordFromStub` / `rawEcRecordFromStub`). The REAL `spec.matchRecord`
   * runs on them. PII-FREE — fake names + UCPath-shaped `10######` EIDs.
   */
  seededRecords: ReadonlyArray<Record<string, unknown>>;
  /**
   * Roster rows the stub `_loadRosterOverride` returns. When omitted, one row
   * per seeded record is derived (EID short-circuit → matched).
   */
  roster?: ReadonlyArray<StubRosterRow>;
  /** Pre-assign the OCR session id (the OCR row `id`). Else a fresh id. */
  sessionId?: string;
  /** Dry-run flag threaded to the operation row + OCR run. */
  dryRun?: boolean;
}

export interface PrepareOperationResult {
  /** The operation coordinator row's run id (= the OCR run's `parentRunId`). */
  operationRunId: string;
  /** The delegated OCR run id. */
  ocrRunId: string;
  /** The OCR session id (the OCR row `id`). */
  ocrSessionId: string;
}

/**
 * Drive the REAL `/api/ocr/prepare` handler with operation intent. Returns the
 * operation coordinator run id, the delegated OCR run id, and the OCR session id.
 *
 * After this resolves the operation coordinator row + the delegated OCR review
 * row are in the temp tracker; the OCR orchestrator runs to its
 * `running step=awaiting-approval` park (sync via
 * `rt.waitForEvent("ocr:awaiting-approval", { runId: ocrRunId })`).
 */
export async function prepareOperation(
  rt: DelegationRuntime,
  opts: PrepareOperationOpts,
): Promise<PrepareOperationResult> {
  const trackerDir = rt.trackerDir;
  const formType = opts.formType ?? "oath";
  const originalName = opts.originalName ?? opts.fixturePath.split("/").pop() ?? "operation.pdf";
  const sessionId = opts.sessionId ?? `ocr-sess-${randomUUID().slice(0, 8)}`;

  // Register a renderable PDF in the temp file store (prefers the real fixture;
  // synthetic one-pager fallback). The records come from the override either way.
  const { pdfFileId, pdfPath } = await registerOcrPdf({ trackerDir, fixturePath: opts.fixturePath, originalName });

  // The orchestrator's `_loadRosterOverride` bypasses real parsing, but the path
  // must resolve to a non-empty string so the "no roster path" guard doesn't trip.
  const uploadsDir = join(trackerDir, "uploads");
  if (!existsSync(uploadsDir)) mkdirSync(uploadsDir, { recursive: true });
  const rosterPath = join(uploadsDir, "roster.xlsx");
  writeFileSync(rosterPath, "");

  const seededRecords = opts.seededRecords.map((r) => ({ ...r }));
  const roster: StubRosterRow[] = opts.roster
    ? opts.roster.map((r) => ({ ...r }))
    : deriveRosterFromRawRecords(seededRecords);

  // Drive the REAL prepare handler. Its `runOrchestrator` opt fully replaces the
  // orchestrator function — we hand it a wrapper over the REAL `runOcrOrchestrator`
  // with the OCR stub's escape hatches, so the operation-coordinator stamping +
  // delegation + trace composition all run for real, browserlessly.
  const handler = buildOcrPrepareHandler({
    trackerDir,
    runOrchestrator: async (input: OcrInput, orchOpts) =>
      void (await runOcrOrchestrator(input, {
        ...orchOpts,
        _ocrPipelineOverride: async () => ({
          data: seededRecords.map((r) => ({ ...r })),
          provider: "stub",
          attempts: 1,
          cached: false,
        }),
        _loadRosterOverride: async () => roster.map((r) => ({ eid: r.eid, name: r.name })),
        _enqueueEidLookupOverride: async () => {
          /* no-op: no person-lookup daemon in this runtime */
        },
        _disableSqliteDependencies: true,
        _watchChildRunsOverride: async (watchOpts) =>
          watchOpts.expectedItemIds.map((itemId, i) => ({
            workflow: "person-lookup",
            itemId,
            runId: `stub-op-verify-${i}`,
            status: "done" as const,
            data: {
              emplId: rawRecordEid(seededRecords[i]),
              hrStatus: "Active",
              department: "HDH",
              personOrgScreenshot: "x.png",
            },
          })),
      })),
  });

  const res = await handler({
    pdfPath,
    pdfOriginalName: originalName,
    pdfFileId,
    formType,
    rosterMode: "existing",
    rosterPath,
    sessionId,
    targetWorkflow: opts.targetWorkflow,
    ...(opts.dryRun ? { dryRun: true } : {}),
  });

  if (res.status !== 202 || !res.body.ok) {
    throw new Error(
      `prepareOperation: prepare route returned ${res.status}: ${JSON.stringify(res.body)}`,
    );
  }
  const { runId: ocrRunId, parentRunId: operationRunId } = res.body;
  if (!operationRunId) {
    throw new Error(
      `prepareOperation: prepare did NOT create an operation coordinator row for ` +
        `targetWorkflow="${opts.targetWorkflow}" (no parentRunId in 202 body) — ` +
        `is the target an operation-coordinator workflow?`,
    );
  }
  return { operationRunId, ocrRunId, ocrSessionId: sessionId };
}

/** Alias matching the spec's `preparyOperation` name. */
export const preparyOperation = prepareOperation;

export interface ApproveOperationOpts {
  ocrSessionId: string;
  ocrRunId: string;
  /** The approved records (selected + EID) the operator would submit. */
  records: Array<Record<string, unknown>>;
  /** The gated child daemon the fan-out lands signer/contact rows onto. */
  childWorkflow: string;
}

/**
 * Drive the REAL `/api/ocr/approve-batch` fan-out for an operation, routing the
 * per-record children onto the gated test daemon. Returns the claimed member
 * children. Thin wrapper over the runtime's `approveOcr` (the documented approve
 * seam) — the real route stamps `operation-member` + parents the children to the
 * coordinator run on its own (`isOperationCoordinatorWorkflow`).
 */
export async function approveOperation(
  rt: DelegationRuntime,
  opts: ApproveOperationOpts,
): Promise<ApprovedChild[]> {
  const approveOpts: ApproveOcrOpts = {
    sessionId: opts.ocrSessionId,
    runId: opts.ocrRunId,
    records: opts.records,
    childWorkflow: opts.childWorkflow,
  };
  return rt.approveOcr(approveOpts);
}
