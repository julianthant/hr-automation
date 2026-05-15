import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Ctx } from "../../core/kernel/types.js";
import { runWorkflow } from "../../core/index.js";
import { ocrWorkflow } from "../ocr/index.js";
import { watchChildRuns } from "../../tracker/delegation/watch-child-runs.js";
import { errorMessage } from "../../utils/errors.js";
import { log } from "../../utils/log.js";
import { dateLocal, type TrackerEntry } from "../../tracker/jsonl.js";
import {
  fillHrInquiryForm,
  submitAndCaptureTicketNumber,
} from "./fill-form.js";
import {
  gotoHrInquiryForm,
  verifyOnInquiryForm,
} from "../../systems/servicenow/navigate.js";
import { waitForOcrApproval } from "./wait-ocr-approval.js";
import type { OathUploadInput } from "./schema.js";

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60_000;

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
    mode: input.mode,
    status: "running",
    taskRole: input.mode === "upload-only" ? "root" : "delegator",
    taskGroupId: ctx.runId,
    ...(input.dryRun ? { dryRun: true } : {}),
  });

  const ocrSessionId = `oath-upload-${ctx.runId}-ocr`;
  if (input.mode !== "upload-only") {
    ctx.updateData({ ocrSessionId });
  }

  let fannedOutItemIds: string[] = [];
  const priorApproval = input.mode === "upload-only" ? null : readPriorOcrApproval(ocrSessionId, trackerDir);
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
      // Fire-and-forget — OCR runs as a child workflow in the same process,
      // but we don't await it here. The next step (wait-ocr-approval) blocks
      // until the operator approves on the dashboard.
      void runWorkflow(ocrWorkflow, {
        pdfPath: input.pdfPath,
        pdfOriginalName: input.pdfOriginalName,
        pdfFileId: input.pdfFileId,
        formType: "oath",
        sessionId: ocrSessionId,
        rosterMode: input.rosterMode,
        rosterPath: input.rosterPath,
        dryRun: input.dryRun,
        parentRunId: ctx.runId,
      } as never, { trackerDir: ctx.trackerDir ?? trackerDir }).catch((err) =>
        log.warn(`[oath-upload] OCR child crashed: ${errorMessage(err)}`),
      );
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
        },
      });
    });
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

function readPriorOcrApproval(
  ocrSessionId: string,
  trackerDir: string | undefined,
): { fannedOutItemIds: string[] } | null {
  const dir = trackerDir ?? ".tracker";
  const today = new Date();
  for (let i = 0; i < LOOKBACK_DAYS; i++) {
    const d = new Date(today);
    d.setDate(today.getDate() - i);
    const file = join(dir, `ocr-${dateLocal(d)}.jsonl`);
    if (!existsSync(file)) continue;
    const lines = readFileSync(file, "utf-8").split("\n").filter(Boolean);
    for (let j = lines.length - 1; j >= 0; j--) {
      try {
        const e = JSON.parse(lines[j]) as TrackerEntry;
        if (
          e.id === ocrSessionId &&
          e.step === "approved" &&
          typeof e.data?.fannedOutItemIds === "string"
        ) {
          try {
            const ids = JSON.parse(e.data.fannedOutItemIds);
            if (Array.isArray(ids) && ids.every((s) => typeof s === "string")) {
              return { fannedOutItemIds: ids as string[] };
            }
          } catch {
            /* tolerate malformed payload */
          }
        }
      } catch {
        /* tolerate malformed line */
      }
    }
  }
  return null;
}
