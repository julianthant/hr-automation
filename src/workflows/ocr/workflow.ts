import { defineWorkflow } from "../../core/index.js";
import type { Ctx } from "../../core/kernel/types.js";
import { buildOperatorSubject } from "../../domain/operator-subject.js";
import { DEFAULT_WORKFLOW_RUNTIME_POLICY } from "../../domain/workflow-runtime/default-policy.js";
import type { WorkflowRuntimePolicy } from "../../domain/workflow-runtime/types.js";
import { runOcrOrchestrator } from "./orchestrator.js";
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
 *  - Single PDF → approval-delegation surface with `Single delegation`,
 *    suffixed by `· Preview` when the preview tab is rendered.
 *  - Multiple PDFs → batch delegation over single-file prep rows.
 *  - OCR utility EID/active-check fan-out children stay as delegation
 *    members instead of being promoted to a batch-delegation group.
 *  - File-scope cancel routes through OCR discard so the prep run AND
 *    its delegated children are cleaned up together.
 */
export const OCR_WORKFLOW_RUNTIME_POLICY: WorkflowRuntimePolicy = {
  ...DEFAULT_WORKFLOW_RUNTIME_POLICY,
  delegation: {
    utilityChildSurface: "delegation-member",
    utilityChildWorkflows: ["eid-lookup", "active-check"],
  },
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
  "eid-lookup",
  "verification",
  "awaiting-approval",
] as const;

export const ocrWorkflow = defineWorkflow({
  name: "ocr",
  label: "OCR",
  archetype: "delegating-batch",
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
  const result = await runOcrOrchestrator(input, {
    runId: ctx.runId,
    trackerDir: ctx.trackerDir,
    signal: ctx.signal,
  });
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
