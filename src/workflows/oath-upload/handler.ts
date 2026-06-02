import type { Ctx } from "../../core/kernel/types.js";
import { log } from "../../utils/log.js";
import { findLatestEntryForPredicate } from "../../tracker/find-latest-entry.js";
import { watchChildRuns, type ChildOutcome } from "../../tracker/delegation/watch-child-runs.js";
import { openControlDb } from "../../core/control-db.js";
import { getRegisteredFile, hashFile } from "../../tracker/files/files.js";
import { errorMessage } from "../../utils/errors.js";
import { loginToServiceNow } from "../../infra/auth/login.js";
import {
  fillHrInquiryForm,
  submitAndCaptureTicketNumber,
} from "./fill-form.js";
import {
  gotoHrInquiryForm,
  verifyOnInquiryForm,
} from "../../systems/servicenow/navigate.js";
import type { OathUploadInput } from "./schema.js";

/**
 * Step list. `wait-signatures` runs BEFORE the ServiceNow browser is launched
 * so we don't hold an authenticated session open across the (potentially
 * multi-day) per-signer wait. It waits — cross-daemon — for every
 * `oath-signature` signer row produced by the OCR approve fan-out to finish AND
 * succeed before any ticket is filed ("verify everything is good before we
 * upload").
 *
 * This replaces the old `delegate-signatures` step, which delegated the PDF to
 * oath-signature and fanned out signers onto the SAME single-worker daemon —
 * deadlocking the sequential claim loop. Oath-upload now only WAITS on the
 * signer rows (which the OCR hub fanned out independently); the wait is on a
 * different daemon, so no deadlock.
 */
export const oathUploadStepList = [
  "wait-signatures",
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

export interface OathUploadHandlerOpts {
  trackerDir?: string;
  // Test escape hatches.
  _watchChildRunsOverride?: (opts: {
    workflow: string;
    expectedItemIds: string[];
    trackerDir?: string;
  }) => Promise<ChildOutcome[]>;
  _resolvePdfOverride?: (
    input: OathUploadInput,
    trackerDir: string | undefined,
  ) => { pdfPath: string; pdfHash?: string };
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
  const trackerDir = opts.trackerDir ?? ctx.trackerDir;

  // Resolve the on-disk PDF path + hash. OCR-hub fan-out rows arrive with only
  // `pdfFileId`; standalone/`upload-only` rows still carry `pdfPath`/`pdfHash`.
  const resolved = (opts._resolvePdfOverride ?? resolvePdf)(input, trackerDir);
  const pdfPath = resolved.pdfPath;
  const pdfHash = resolved.pdfHash;

  ctx.updateData({
    pdfOriginalName: input.pdfOriginalName,
    ...(input.pdfFileId ? { pdfFileId: input.pdfFileId } : {}),
    sessionId: input.sessionId,
    ...(pdfHash ? { pdfHash } : {}),
    uploadMode: input.mode,
    status: "running",
    taskGroupId: ctx.runId,
    ...(input.dryRun ? { dryRun: true } : {}),
  });

  // ─── 1. Wait for the signer rows ────────────────────────────────────────
  const signerItemIds = input.signerItemIds ?? [];
  if (input.mode === "upload-only" || signerItemIds.length === 0) {
    if (input.mode !== "upload-only" && signerItemIds.length === 0) {
      log.step("[oath-upload] no signer itemIds to wait for — filing ticket directly");
    } else {
      log.step("[oath-upload] upload-only mode: skipping signature wait");
    }
    ctx.skipStep("wait-signatures");
    ctx.updateData({ signerCount: "skipped" });
  } else {
    await ctx.step("wait-signatures", async () => {
      ctx.updateData({ status: "waiting-signatures", signerCount: String(signerItemIds.length) });
      log.step(
        `[oath-upload] waiting for ${signerItemIds.length} oath-signature signer row${
          signerItemIds.length === 1 ? "" : "s"
        } to finish before filing the ticket`,
      );
      const watch = opts._watchChildRunsOverride ?? watchChildRuns;
      const outcomes = await watch({
        workflow: "oath-signature",
        expectedItemIds: signerItemIds,
        ...(trackerDir !== undefined ? { trackerDir } : {}),
      });
      // Verify EVERYTHING is good before filing: every expected signer must
      // have terminated `done`. Missing / failed / cancelled → throw, no ticket.
      const byItem = new Map(outcomes.map((o) => [o.itemId, o]));
      const problems: string[] = [];
      for (const itemId of signerItemIds) {
        const outcome = byItem.get(itemId);
        if (!outcome) {
          problems.push(`${itemId}=missing`);
        } else if (outcome.status !== "done") {
          problems.push(`${itemId}=${outcome.status}${outcome.error ? `(${outcome.error})` : ""}`);
        }
      }
      if (problems.length > 0) {
        throw new Error(
          `oath-upload: ${problems.length} of ${signerItemIds.length} oath-signature signer row(s) did not succeed — NOT filing the HR ticket: ${problems.join(", ")}`,
        );
      }
      log.success(
        `[oath-upload] all ${signerItemIds.length} signer row(s) succeeded — proceeding to file the ticket`,
      );
      ctx.updateData({ status: "signatures-complete" });
    });
  }

  // Idempotency: probe by stable business identity (`sessionId` / `pdfHash`)
  // — NOT by `runId`. Contract 2 retry creates a new runId, so a runId-keyed
  // probe would miss a prior successful ticket and submit a duplicate.
  const priorTicket = findPriorTicketForSession(input.sessionId, pdfHash, trackerDir);
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
    // signature wait.
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
      attachmentPath: pdfPath,
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

/**
 * Resolve the on-disk PDF path (and hash) for the ServiceNow attachment. When
 * the row carries an explicit `pdfPath` (legacy / `upload-only`) use it; else
 * resolve from the registered file store via `pdfFileId` (OCR-hub fan-out rows).
 * Throws if neither yields a usable path — the ServiceNow attachment needs a
 * real file on disk.
 */
function resolvePdf(
  input: OathUploadInput,
  trackerDir: string | undefined,
): { pdfPath: string; pdfHash?: string } {
  if (input.pdfPath) {
    return { pdfPath: input.pdfPath, ...(input.pdfHash ? { pdfHash: input.pdfHash } : {}) };
  }
  if (!input.pdfFileId) {
    throw new Error(
      `oath-upload: input has neither pdfPath nor pdfFileId for sessionId=${input.sessionId} — cannot resolve the PDF to attach`,
    );
  }
  let db: ReturnType<typeof openControlDb> | undefined;
  try {
    db = openControlDb({ trackerDir });
    const registered = getRegisteredFile(db.db, input.pdfFileId);
    if (!registered) {
      throw new Error(
        `oath-upload: no registered file for pdfFileId=${input.pdfFileId} (sessionId=${input.sessionId})`,
      );
    }
    const pdfHash = input.pdfHash ?? registered.sha256 ?? deriveHash(registered.storagePath);
    return { pdfPath: registered.storagePath, ...(pdfHash ? { pdfHash } : {}) };
  } finally {
    db?.close();
  }
}

function deriveHash(path: string): string | undefined {
  try {
    return hashFile(path).sha256;
  } catch (err) {
    log.warn(`[oath-upload] could not hash PDF at ${path}: ${errorMessage(err)}`);
    return undefined;
  }
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
