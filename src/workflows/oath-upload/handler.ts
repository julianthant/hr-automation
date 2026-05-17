import type { Ctx } from "../../core/kernel/types.js";
import { runWorkflow } from "../../core/index.js";
import { ocrWorkflow } from "../ocr/index.js";
import { watchChildRuns } from "../../tracker/delegation/watch-child-runs.js";
import { errorMessage } from "../../utils/errors.js";
import { log } from "../../utils/log.js";
import { findLatestEntryForPredicate } from "../../tracker/find-latest-entry.js";
import { openControlDb } from "../../core/control-db.js";
import { createTaskStore } from "../../core/task-store/index.js";
import {
  fillHrInquiryForm,
  submitAndCaptureTicketNumber,
} from "./fill-form.js";
import {
  gotoHrInquiryForm,
  verifyOnInquiryForm,
} from "../../systems/servicenow/navigate.js";
import { waitForOcrApproval, SEVEN_DAYS_MS } from "./wait-ocr-approval.js";
import type { OathUploadInput } from "./schema.js";
import { OcrInputSchema } from "../ocr/schema.js";

export const oathUploadStepList = [
  "delegate-ocr",
  "wait-ocr-approval",
  "delegate-signatures",
  "wait-signatures",
  "open-hr-form",
  "fill-form",
  "submit",
] as const;

const HR_FORM_VALUES = {
  subject: "HDH New Hire Oaths",
  description: "Please see attached oaths for employees hired under HDH.",
  specifically: "Signing Ceremony (Oath)",
  category: "Payroll",
} as const;

export interface OathUploadHandlerOpts {
  trackerDir?: string;
  // Test escape hatches.
  _runOcrOverride?: (input: OathUploadInput, ocrSessionId: string, parentRunId: string) => Promise<void>;
  _waitForOcrApprovalOverride?: typeof waitForOcrApproval;
  _watchChildRunsOverride?: typeof watchChildRuns;
  _gotoOverride?: typeof gotoHrInquiryForm;
  _verifyOverride?: typeof verifyOnInquiryForm;
  _fillFormOverride?: typeof fillHrInquiryForm;
  _submitOverride?: typeof submitAndCaptureTicketNumber;
}

export async function oathUploadHandler(
  ctx: Ctx<readonly string[], OathUploadInput>,
  input: OathUploadInput,
  opts: OathUploadHandlerOpts = {},
): Promise<void> {
  const trackerDir = opts.trackerDir;

  ctx.updateData({
    pdfOriginalName: input.pdfOriginalName,
    ...(input.pdfFileId ? { pdfFileId: input.pdfFileId } : {}),
    sessionId: input.sessionId,
    pdfHash: input.pdfHash,
    uploadMode: input.mode,
    status: "running",
    taskGroupId: ctx.runId,
    ...(input.dryRun ? { dryRun: true } : {}),
  });

  const ocrSessionId = `oath-upload-${ctx.runId}-ocr`;
  if (input.mode !== "upload-only") {
    ctx.updateData({ ocrSessionId });
  }

  let fannedOutItemIds: string[] = [];
  const rawPriorApproval = input.mode === "upload-only" ? null : readPriorOcrApproval(ocrSessionId, trackerDir);
  // Verify prior approval's fanned-out ids are actually in task_store. If any are
  // missing (enqueue failed before the approved row was written), treat as no recovery.
  const priorApproval = rawPriorApproval
    ? (verifyEnqueuedSignerIds(rawPriorApproval.fannedOutItemIds, trackerDir) !== null ? rawPriorApproval : null)
    : null;
  if (input.mode === "upload-only") {
    log.step("[oath-upload] upload-only mode: skipping OCR and oath-signature delegation");
    ctx.skipStep("delegate-ocr");
    ctx.skipStep("wait-ocr-approval");
    ctx.skipStep("delegate-signatures");
    ctx.skipStep("wait-signatures");
    ctx.updateData({ signerCount: "skipped" });
  } else if (priorApproval) {
    log.step(
      `[oath-upload] recovery: prior approved OCR found for ${ocrSessionId}; skipping delegate-ocr + wait-ocr-approval`,
    );
    ctx.skipStep("delegate-ocr");
    ctx.skipStep("wait-ocr-approval");
    fannedOutItemIds = priorApproval.fannedOutItemIds;
    ctx.updateData({ signerCount: String(fannedOutItemIds.length) });
  } else {
    await ctx.step("delegate-ocr", async () => {
      if (opts._runOcrOverride) {
        await opts._runOcrOverride(input, ocrSessionId, ctx.runId);
        return;
      }
      // Validate the OCR child input synchronously so schema failures
      // surface immediately as a delegate-ocr step failure rather than
      // being swallowed by the fire-and-forget catch.
      const ocrInputRaw = {
        pdfPath: input.pdfPath,
        pdfOriginalName: input.pdfOriginalName,
        pdfFileId: input.pdfFileId,
        formType: "oath",
        sessionId: ocrSessionId,
        rosterMode: input.rosterMode,
        rosterPath: input.rosterPath,
        dryRun: input.dryRun,
        parentRunId: ctx.runId,
        originWorkflow: "oath-upload",
      };
      const ocrParsed = OcrInputSchema.safeParse(ocrInputRaw);
      if (!ocrParsed.success) {
        throw new Error(`oath-upload: OCR child input invalid — ${ocrParsed.error.message}`);
      }
      // Fire-and-forget — OCR runs as a child workflow in the same process,
      // but we don't await it here. The next step (wait-ocr-approval) blocks
      // until the operator approves on the dashboard.
      void runWorkflow(ocrWorkflow, ocrParsed.data as never, { trackerDir: ctx.trackerDir ?? trackerDir }).catch((err) => {
        log.error(`[oath-upload] OCR child crashed before emitting a tracker row: ${errorMessage(err)}`);
        throw err;
      });
    });

    await ctx.step("wait-ocr-approval", async () => {
      const fn = opts._waitForOcrApprovalOverride ?? waitForOcrApproval;
      const r = await fn({
        sessionId: ocrSessionId,
        trackerDir,
        timeoutMs: SEVEN_DAYS_MS,
        abortIfRowState: {
          workflow: "oath-upload",
          id: input.sessionId,
          step: "cancel-requested",
          status: "cancelled",
        },
      });
      fannedOutItemIds = r.fannedOutItemIds;
      ctx.updateData({ signerCount: String(fannedOutItemIds.length) });
    });
  }

  if (input.mode !== "upload-only") {
    ctx.markStep("delegate-signatures");

    await ctx.step("wait-signatures", async () => {
      ctx.updateData({ status: "waiting-signatures", signerItemIds: fannedOutItemIds.join(", ") });
      const fn = opts._watchChildRunsOverride ?? watchChildRuns;
      await fn({
        workflow: "oath-signature",
        expectedItemIds: fannedOutItemIds,
        trackerDir,
        timeoutMs: SEVEN_DAYS_MS,
        isTerminal: (e) => e.status === "done",
        abortIfRowState: {
          workflow: "oath-upload",
          id: input.sessionId,
          step: "cancel-requested",
          status: "cancelled",
        },
      });
    });
  }

  const priorTicket = findPriorTicketForRunId(ctx.runId, trackerDir);
  if (priorTicket) {
    log.warn(`[oath-upload] runId=${ctx.runId} already filed ticket ${priorTicket}; skipping HR form on restart`);
    ctx.updateData({ ticketNumber: priorTicket });
    ctx.skipStep("open-hr-form");
    ctx.skipStep("fill-form");
    ctx.skipStep("submit");
    return;
  }

  const page = await ctx.page("servicenow");

  await ctx.step("open-hr-form", async () => {
    await (opts._gotoOverride ?? gotoHrInquiryForm)(page);
    await (opts._verifyOverride ?? verifyOnInquiryForm)(page);
  });

  await ctx.step("fill-form", async () => {
    await (opts._fillFormOverride ?? fillHrInquiryForm)(page, {
      ...HR_FORM_VALUES,
      attachmentPath: input.pdfPath,
    });
    await ctx.screenshot({ kind: "form", label: "hr-inquiry-pre-submit" });
  });

  await ctx.step("submit", async () => {
    if (input.dryRun) {
      await ctx.screenshot({ kind: "form", label: "hr-inquiry-dry-run-pre-submit" });
      ctx.updateData({
        ticketNumber: "DRY RUN - not submitted",
        status: "dry-run-complete",
      });
      log.success("Dry run complete — ServiceNow submit was skipped.");
      return;
    }
    const ticketNumber = await (opts._submitOverride ?? submitAndCaptureTicketNumber)(page);
    await ctx.screenshot({ kind: "form", label: "hr-inquiry-submitted" });
    ctx.updateData({
      ticketNumber,
      submittedAt: new Date().toISOString(),
      status: "filed",
    });
  });
}

const LOOKBACK_DAYS = 7;

export function findPriorTicketForRunId(runId: string, trackerDir?: string): string | null {
  const match = findLatestEntryForPredicate({
    workflow: "oath-upload",
    trackerDir,
    lookbackDays: LOOKBACK_DAYS,
    predicate: (e) => e.runId === runId && typeof e.data?.ticketNumber === "string" && (e.data.ticketNumber as string).length > 0,
  });
  if (!match) return null;
  const t = match.data?.ticketNumber;
  return typeof t === "string" ? t : null;
}

function verifyEnqueuedSignerIds(ids: string[], trackerDir: string | undefined): string[] | null {
  if (ids.length === 0) return ids;
  try {
    const db = openControlDb({ trackerDir });
    const taskStore = createTaskStore(db);
    const allTasks = taskStore.listTasksForWorkflow("oath-signature");
    db.close();
    // If no oath-signature tasks exist at all, this is a pre-SQLite run — trust the JSONL.
    if (allTasks.length === 0) return ids;
    const taskItemIds = new Set(allTasks.map((t) => t.itemId));
    const missing = ids.filter((id) => !taskItemIds.has(id));
    if (missing.length === 0) return ids;
    log.warn(
      `[oath-upload] recovery: ${missing.length}/${ids.length} fanned-out signer ids missing from task_store — re-running dispatch`,
    );
    return null;
  } catch {
    // task_store unavailable — trust the prior approval (backward compat)
    return ids;
  }
}

function readPriorOcrApproval(
  ocrSessionId: string,
  trackerDir: string | undefined,
): { fannedOutItemIds: string[] } | null {
  const entry = findLatestEntryForPredicate({
    workflow: "ocr",
    trackerDir,
    lookbackDays: LOOKBACK_DAYS,
    predicate: (e) =>
      e.id === ocrSessionId &&
      e.step === "approved" &&
      typeof e.data?.fannedOutItemIds === "string",
  });
  if (!entry || typeof entry.data?.fannedOutItemIds !== "string") return null;
  let ids: unknown;
  try {
    ids = JSON.parse(entry.data.fannedOutItemIds);
  } catch (e) {
    throw new Error(
      `oath-upload: malformed fannedOutItemIds JSON in prior OCR approval (ocrSessionId=${ocrSessionId}): ${e instanceof Error ? e.message : String(e)}`,
      { cause: e },
    );
  }
  if (!Array.isArray(ids) || !ids.every((s) => typeof s === "string")) {
    throw new Error(
      `oath-upload: prior OCR approval has non-array fannedOutItemIds for ocrSessionId=${ocrSessionId} (got ${Array.isArray(ids) ? "non-string-array" : typeof ids})`,
    );
  }
  return { fannedOutItemIds: ids as string[] };
}
