import { defineWorkflow } from "../../core/index.js";
import type { Ctx } from "../../core/kernel/types.js";
import { buildOperatorSubject } from "../../domain/operator-subject.js";
import { DEFAULT_WORKFLOW_RUNTIME_POLICY } from "../../domain/workflow-runtime/default-policy.js";
import type { WorkflowRuntimePolicy } from "../../domain/workflow-runtime/types.js";
import { runOcrOrchestrator } from "./orchestrator.js";
import { ocrStatusExtensions } from "../../tracker/dashboard/ocr-status.js";
import { OcrInputSchema, type OcrInput } from "./schema.js";
import {
  subscribeToApproval,
  OcrDiscardedError,
  OcrApprovalCancelledError,
  type ApprovedPayload,
} from "../../services/ocr/approval-signal.js";
import { CancelledError } from "../../core/kernel/types.js";

/**
 * OCR runtime policy.
 *
 * Captures the dashboard rules that previously lived as inline special
 * cases (`isOcrDaemonPrepFanoutChild`, the log panel's `· Preview`
 * suffix, etc.):
 *  - Single PDF → preview surface card.
 *  - Multiple PDFs → batch cards over single-file prep rows.
 *  - OCR utility EID/active-check fan-out children use normal delegated
 *    grouping: one child stays a single row, multiple children render as a
 *    batch surface.
 *  - File-scope cancel routes through OCR discard so the prep run AND
 *    its delegated children are cleaned up together.
 */
export const OCR_WORKFLOW_RUNTIME_POLICY: WorkflowRuntimePolicy = {
  ...DEFAULT_WORKFLOW_RUNTIME_POLICY,
  preview: {
    rowTypeLabelSuffix: "Preview",
    alwaysAvailable: true,
  },
  prepRow: {
    titleSource: "pdf-original-name",
  },
};

const ocrSteps = [
  "loading-roster",
  "ocr",
  "matching",
  "disambiguating",
  "person-lookup",
  "verification",
  "awaiting-approval",
] as const;

export const ocrWorkflow = defineWorkflow({
  name: "ocr",
  label: "OCR",
  archetype: "preview",
  inputSubject: "pdf",
  statusExtensions: ocrStatusExtensions,
  code: "oc",
  category: "Utils",
  iconName: "FileScan",
  systems: [],
  authSteps: false,
  steps: ocrSteps,
  schema: OcrInputSchema,
  runtimePolicy: OCR_WORKFLOW_RUNTIME_POLICY,
  queueTitle: {
    kind: "batch",
    labelFromInput: (input) => input.formType === "emergency-contact" ? "Emergency Contact" : "Oath",
  },
  detailFields: [{ key: "recordCount", label: "Records" }],
  getName: (d) => d.pdfOriginalName ?? "",
  getId:   (d) => d.sessionId ?? "",
  operatorSubject: (input) =>
    buildOperatorSubject({
      kind: "pdf",
      value: input.pdfOriginalName ?? input.pdfPath ?? input.sessionId,
      prefix: "OCR",
    }),
  handler: ocrKernelHandler,
});

async function ocrKernelHandler(ctx: Ctx<typeof ocrSteps, OcrInput>, input: OcrInput): Promise<void> {
  // Thin wrapper. Orchestrator owns its own tracker emissions because the
  // kernel's per-step machinery doesn't model "wait for user, mid-handler."
  //
  // New approval contract (2026-05-25): the orchestrator now returns at
  // `running step=awaiting-approval` instead of emitting terminal `done`.
  // The handler suspends here until the operator approves or discards;
  // the kernel emits the terminal `done` row only after this handler
  // returns. Discards reject via `OcrDiscardedError` → kernel `failed`;
  // operator cancel via `ctx.signal` → kernel `cancelled`.
  // Capture the orchestrator's latest rich preview payload. The orchestrator
  // emits its own (rich) queue rows directly, but on FAILURE the kernel
  // auto-emits a terminal `failed` row from accumulated `ctx` data — which is
  // sparse (no `mode: "prepare"`, no records) and, under the dashboard's
  // latest-wins dedupe, clobbers the orchestrator's rich `failed` row,
  // stripping the Preview tab off the failed prep row. Seeding the captured
  // payload into `ctx` before rethrow keeps that terminal row a recognizable
  // preview row (mirrors the approve-path `ctx.updateData` below).
  let lastReviewData: Record<string, unknown> | undefined;
  let result: Awaited<ReturnType<typeof runOcrOrchestrator>>;
  try {
    // `parentRunId` is delegated scope. The kernel stamps it on the rows IT
    // emits (pending/terminal), but the orchestrator emits its own rich
    // running/awaiting-approval snapshots and reads `input.parentRunId` to
    // re-stamp them. Delegation never injects parentRunId into the child
    // *input* (it's a kernel option, not an input field), so fall back to
    // `ctx.parentRunId` — otherwise the orchestrator's latest-wins snapshot
    // rows drop the scope, the dashboard treats a delegated OCR row as
    // standalone, and the OcrReviewPane hides the Approve button (isDelegation
    // = parentRunId present). Verified 2026-06-02.
    const orchestratorInput = {
      ...input,
      ...(input.parentRunId ?? ctx.parentRunId
        ? { parentRunId: input.parentRunId ?? ctx.parentRunId }
        : {}),
    };
    result = await runOcrOrchestrator(orchestratorInput, {
      runId: ctx.runId,
      trackerDir: ctx.trackerDir,
      signal: ctx.signal,
      // OCR owns its own queue-row emission and bypasses ctx.step, so drive the
      // session-drawer timeline explicitly: each orchestrator phase mirrors into
      // ctx.reportPhase → session step_change, so the OCR WorkflowBox advances
      // through loading-roster → … → awaiting-approval like every other workflow.
      onPhase: (step) => ctx.reportPhase(step),
      onReviewData: (data) => { lastReviewData = data; },
    });
  } catch (err) {
    // `parentRunId` is kernel-owned (top-level); keep it out of `data`.
    const { parentRunId: _parentRunId, ...reviewData } = lastReviewData ?? {};
    ctx.updateData({ ...reviewData, mode: "prepare" } as Partial<OcrInput & Record<string, unknown>>);
    throw err;
  }
  if (result.status !== "awaiting-approval") {
    // "discarded" — orchestrator already stopped emitting; the
    // discard route owns the terminal row. Don't await — return.
    return;
  }
  let payload: ApprovedPayload;
  try {
    payload = await subscribeToApproval(
      { workflow: "ocr", sessionId: input.sessionId },
      { signal: ctx.signal, trackerDir: ctx.trackerDir },
    );
  } catch (err) {
    if (err instanceof OcrDiscardedError) {
      // Throw so kernel emits `failed`. The discard route also wrote the
      // terminal `failed step=discarded` row directly (dashboard path
      // compatibility) — both rows have status=failed and converge on
      // the same dashboard surface.
      throw err;
    }
    if (err instanceof OcrApprovalCancelledError) {
      // ctx.signal aborted. Surface as kernel CancelledError so terminal
      // row is `failed step=cancelled` and the daemon's post-cancel reset
      // semantics run.
      throw new CancelledError("awaiting-approval");
    }
    throw err;
  }
  // Mirror approve route's payload into accumulated tracker data so the
  // kernel's auto-emitted terminal `done` carries records / fannedOutItemIds.
  // The approve route's `done step=approved` row was written BEFORE this
  // signal fired, so consumers that key on `step === "approved"` already
  // have what they need; this update is belt-and-suspenders for the
  // kernel's later bare-`done` row.
  const update: Record<string, unknown> = {
    records: JSON.stringify(payload.records),
    recordCount: String(payload.records.length),
  };
  if (payload.fannedOutItemIds) {
    update.fannedOutItemIds = JSON.stringify(payload.fannedOutItemIds);
    update.fannedOutCount = String(payload.fannedOutItemIds.length);
  }
  ctx.updateData(update as Partial<OcrInput & Record<string, unknown>>);
}
