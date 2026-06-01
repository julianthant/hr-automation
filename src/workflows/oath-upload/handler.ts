import type { Ctx } from "../../core/kernel/types.js";
import { log } from "../../utils/log.js";
import { findLatestEntryForPredicate } from "../../tracker/find-latest-entry.js";
import { openControlDb } from "../../core/control-db.js";
import { loginToServiceNow } from "../../infra/auth/login.js";
import {
  fillHrInquiryForm,
  submitAndCaptureTicketNumber,
} from "./fill-form.js";
import {
  gotoHrInquiryForm,
  verifyOnInquiryForm,
} from "../../systems/servicenow/navigate.js";
import { oathSignatureWorkflow } from "../oath-signature/index.js";
import type { OathUploadInput } from "./schema.js";

/**
 * Step list — `delegate-signatures` runs BEFORE the ServiceNow browser is
 * launched so we don't hold an authenticated session open across the
 * potentially multi-day operator-approval + per-signer wait.
 */
export const oathUploadStepList = [
  "delegate-signatures",
  "servicenow-auth",
  "open-hr-form",
  "fill-form",
  "submit",
] as const;

export const oathUploadSteps = oathUploadStepList;

export type OathUploadSteps = typeof oathUploadSteps;

const HR_FORM_VALUES = {
  subject: "HDH New Hire Oaths",
  description: "Please see attached oaths for employees hired under HDH.",
  specifically: "Signing Ceremony (Oath)",
  category: "Payroll",
} as const;

type DelegateTo = Ctx<OathUploadSteps, OathUploadInput>["delegateTo"];

export interface OathUploadHandlerOpts {
  trackerDir?: string;
  // Test escape hatches.
  _delegateToOverride?: DelegateTo;
  _loginOverride?: typeof loginToServiceNow;
  _gotoOverride?: typeof gotoHrInquiryForm;
  _verifyOverride?: typeof verifyOnInquiryForm;
  _fillFormOverride?: typeof fillHrInquiryForm;
  _submitOverride?: typeof submitAndCaptureTicketNumber;
}

export async function oathUploadHandler(
  ctx: Ctx<OathUploadSteps, OathUploadInput>,
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

  if (input.mode === "upload-only") {
    log.step("[oath-upload] upload-only mode: skipping OCR and signature delegation");
    ctx.skipStep("delegate-signatures");
    ctx.updateData({ signerCount: "skipped" });
  } else {
    await ctx.step("delegate-signatures", async () => {
      ctx.updateData({
        status: "waiting-signatures",
      });
      const delegateTo = opts._delegateToOverride ?? ctx.delegateTo;
      const result = await delegateTo(
        oathSignatureWorkflow,
        {
          pdfPath: input.pdfPath,
          pdfOriginalName: input.pdfOriginalName,
          ...(input.pdfFileId ? { pdfFileId: input.pdfFileId } : {}),
          sessionId: input.sessionId,
          pdfHash: input.pdfHash,
          rosterMode: input.rosterMode,
          ...(input.rosterPath ? { rosterPath: input.rosterPath } : {}),
          ...(input.dryRun ? { dryRun: input.dryRun } : {}),
        },
        { itemId: input.sessionId },
      );
      if (result.status !== "done") {
        throw new Error(
          `oath-upload: delegated oath-signature PDF run ended with status=${result.status}` +
            (result.error?.message ? ` — ${result.error.message}` : ""),
        );
      }
      if (typeof result.data?.fannedOutCount === "string") {
        ctx.updateData({ signerCount: result.data.fannedOutCount });
      }
    });
  }

  // Idempotency: probe by stable business identity (`sessionId` / `pdfHash`)
  // — NOT by `runId`. Contract 2 retry creates a new runId, so a runId-keyed
  // probe would miss a prior successful ticket and submit a duplicate.
  const priorTicket = findPriorTicketForSession(input.sessionId, input.pdfHash, trackerDir);
  if (priorTicket) {
    log.warn(
      `[oath-upload] sessionId=${input.sessionId} already filed ticket ${priorTicket}; skipping HR form on restart/retry`,
    );
    ctx.updateData({ ticketNumber: priorTicket });
    ctx.skipStep("servicenow-auth");
    ctx.skipStep("open-hr-form");
    ctx.skipStep("fill-form");
    ctx.skipStep("submit");
    return;
  }

  const page = await ctx.page("servicenow");
  await ctx.step("servicenow-auth", async () => {
    // ServiceNow auth is deferred from session launch to right before we use
    // the page, so the daemon doesn't hold a SAML session open across the
    // delegated signature wait.
    const ok = await (opts._loginOverride ?? loginToServiceNow)(page, undefined, ctx.signal);
    if (!ok) throw new Error("ServiceNow authentication failed");
  });

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

function isFiledTicketNumber(ticketNumber: string): boolean {
  if (ticketNumber.length === 0) return false;
  if (ticketNumber.toUpperCase().includes("DRY RUN")) return false;
  return /^HRC\d/i.test(ticketNumber);
}

/**
 * Idempotency probe: looks for a prior tracker entry for this `sessionId`
 * that already wrote a filed ticket number. Keyed on stable business
 * identity (sessionId / pdfHash) — not `runId` — because Contract 2 retry
 * assigns a NEW runId for the same logical work, and a runId-keyed lookup
 * would miss the prior ticket and submit a duplicate.
 */
export function findPriorTicketForSession(
  sessionId: string,
  pdfHash: string | undefined,
  trackerDir?: string,
): string | null {
  let controlDb: ReturnType<typeof openControlDb> | undefined;
  try { controlDb = openControlDb({ trackerDir }); } catch { /* fall through to JSONL */ }
  try {
    const match = findLatestEntryForPredicate({
      workflow: "oath-upload",
      trackerDir,
      lookbackDays: LOOKBACK_DAYS,
      ...(controlDb ? { db: controlDb.db, itemId: sessionId } : {}),
      predicate: (e) => {
        if (e.id !== sessionId) return false;
        if (pdfHash && typeof e.data?.pdfHash === "string" && e.data.pdfHash !== pdfHash) return false;
        return (
          typeof e.data?.ticketNumber === "string" &&
          isFiledTicketNumber(e.data.ticketNumber as string)
        );
      },
    });
    if (!match) return null;
    const t = match.data?.ticketNumber;
    return typeof t === "string" ? t : null;
  } finally {
    controlDb?.close();
  }
}
