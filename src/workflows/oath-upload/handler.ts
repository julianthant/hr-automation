import type { Ctx } from "../../core/kernel/types.js";
import { CancelledError } from "../../core/kernel/types.js";
import { log } from "../../utils/log.js";
import { findLatestEntryForPredicate } from "../../tracker/find-latest-entry.js";
import { watchChildRuns, type ChildOutcome } from "../../tracker/delegation/watch-child-runs.js";
import {
  subscribeToApproval,
  OcrDiscardedError,
  OcrApprovalFailedError,
  type ApprovedPayload,
} from "../../services/ocr/approval-signal.js";
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
  "wait-approval",
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
  _subscribeToApprovalOverride?: (opts: {
    sessionId: string;
    trackerDir?: string;
  }) => Promise<ApprovedPayload>;
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
  /**
   * Replaces `ctx.page("servicenow")` — for runs with no servicenow system at
   * all (e2e stub mode declares `systems: []`, so `ctx.page` would hang).
   * Pair with the other overrides; the returned page is only ever passed to
   * them.
   */
  _pageOverride?: () => Promise<import("playwright").Page>;
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

  // ─── 0. Wait for OCR approval (born-at-upload "full" runs only) ──────────
  // Option A: a full oath upload is created at upload time (before OCR review)
  // and walks OCR prep → awaiting approval → wait signatures → submit as ONE
  // row. When the row arrives WITHOUT `signerItemIds` (mode "full"), it learns
  // its signer set here by waiting cross-process for the operator to approve the
  // OCR prep (the approve route stamps `fannedOutItemIds` on the OCR row). Rows
  // born with `signerItemIds` already set (legacy approve fan-out) or
  // `upload-only` rows skip this step.
  let signerItemIds = input.signerItemIds ?? [];
  const needsApprovalWait = input.mode === "full" && signerItemIds.length === 0;
  if (needsApprovalWait) {
    await ctx.step("wait-approval", async () => {
      ctx.updateData({ status: "awaiting-approval" });
      log.step(
        `[oath-upload] waiting for the operator to approve the OCR prep (session ${input.sessionId}) before filing`,
      );
      const subscribe = opts._subscribeToApprovalOverride
        ? (k: { sessionId: string }) =>
            opts._subscribeToApprovalOverride!({
              sessionId: k.sessionId,
              ...(trackerDir !== undefined ? { trackerDir } : {}),
            })
        : (k: { sessionId: string }) =>
            subscribeToApproval(
              { workflow: "ocr", sessionId: k.sessionId },
              { signal: ctx.signal, ...(trackerDir !== undefined ? { trackerDir } : {}) },
            );
      try {
        const payload = await subscribe({ sessionId: input.sessionId });
        signerItemIds = [...(payload.fannedOutItemIds ?? [])];
        ctx.updateData({ status: "approved", signerCount: String(signerItemIds.length) });
        log.success(
          `[oath-upload] OCR prep approved — ${signerItemIds.length} signer row(s) to wait on before filing`,
        );
      } catch (err) {
        if (err instanceof OcrDiscardedError) {
          // ISS-007: an upstream OCR discard is a CANCELLATION of this ticket,
          // not a failure. Throw a kernel CancelledError carrying the
          // `discarded` sentinel step so the terminal row classifies on the
          // Cancel surface (orange Cancelled), not red Failed. (The controller
          // is NOT aborted on a discard — the discard route leaves the
          // oath-upload task to self-abort via the approval signal — so without
          // this the kernel would freeze the row at `step=wait-approval`.) The
          // `cause` preserves the discard reason for the terminal log line.
          log.warn(
            `[oath-upload] OCR prep was discarded — NOT filing the HR ticket (${err.reason})`,
          );
          throw Object.assign(new CancelledError("discarded"), { cause: err });
        }
        if (err instanceof OcrApprovalFailedError) {
          throw new Error(
            `oath-upload: OCR prep failed — NOT filing the HR ticket (${err.reason})`,
            { cause: err },
          );
        }
        throw err;
      }
    });
  } else {
    ctx.skipStep("wait-approval");
  }

  if (needsApprovalWait && signerItemIds.length === 0) {
    ctx.updateData({ status: "approval-empty", signerCount: "0" });
    throw new Error(
      "oath-upload: OCR prep was approved but produced zero signer row(s) — NOT filing the HR ticket",
    );
  }

  // ─── 1. Wait for the signer rows ────────────────────────────────────────
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
      let outcomes: ChildOutcome[];
      try {
        outcomes = await watch({
          workflow: "oath-signature",
          expectedItemIds: signerItemIds,
          ...(trackerDir !== undefined ? { trackerDir } : {}),
        });
      } catch (err) {
        // A wait-signatures REJECTION (poll/read error, timeout, blocked/failed
        // parent) is NOT "a signer is still pending" — the watch only settles by
        // returning every signer terminal, or by throwing. Re-throw LOUD and
        // DISTINCT so the terminal row unambiguously reports that the signer set
        // could NOT be verified and NO ticket was filed on an unconfirmed set
        // (rather than a raw watcher error indistinguishable from a signer
        // failure). A genuine operator cancel is preserved as-is.
        if (err instanceof CancelledError) throw err;
        throw new Error(
          `oath-upload: could not verify the ${signerItemIds.length} oath-signature signer row(s) (wait-signatures failed: ${errorMessage(err)}) — NOT filing the HR ticket`,
          { cause: err },
        );
      }
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

  // Idempotency-window guard. A PRIOR attempt for this session may have reached
  // the ServiceNow submit step (durably stamping `data.submitAttempted` on its
  // `running step=submit` row) and then crashed AFTER ServiceNow filed the
  // ticket but BEFORE the ticket number persisted (ctx.updateData only merges;
  // the number lands on the terminal `done` row). We only reach here when NO
  // filed ticket was found (the probe above returns early on a hit), so a prior
  // submit-attempt with no recorded ticket is AMBIGUOUS — auto-submitting again
  // would risk a DUPLICATE HR ticket. Fail loud: the operator verifies
  // support.ucsd.edu and either records the ticket (work already done) or
  // re-uploads (new session) to retry cleanly. Dry runs never file, so they
  // don't stamp the marker and never trip this.
  if (!input.dryRun && hasUnverifiedPriorSubmit(input.sessionId, pdfHash, trackerDir)) {
    ctx.updateData({ status: "submit-unverified" });
    throw new Error(
      `oath-upload: a previous attempt for sessionId=${input.sessionId} reached the ServiceNow submit step but recorded no ticket number — a ServiceNow ticket MAY already have been filed. Refusing to auto-submit again to avoid a duplicate HR ticket; manually verify support.ucsd.edu (record the ticket if it exists, otherwise re-upload to retry).`,
    );
  }

  const page = await (opts._pageOverride ? opts._pageOverride() : ctx.page("servicenow"));
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

  // Durable pre-submit marker (fail-loud idempotency). `ctx.updateData` only
  // merges into accumulated data; the very next emit — the `running step=submit`
  // row that `ctx.step` writes at step START, BEFORE the ServiceNow POST —
  // carries this flag to disk. So a crash AFTER the POST files the ticket but
  // BEFORE the ticket number persists leaves a durable `submitAttempted`, and a
  // retry refuses to blindly re-file (see `hasUnverifiedPriorSubmit`). Stamped
  // only for a REAL submit — a dry run never files, so it must not trip the guard.
  if (!input.dryRun) ctx.updateData({ submitAttempted: "true" });
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

function deriveHash(path: string): string {
  try {
    return hashFile(path).sha256;
  } catch (err) {
    throw new Error(`oath-upload: could not hash PDF at ${path}: ${errorMessage(err)}`, { cause: err });
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
  const controlDb = openControlDb({ trackerDir });
  try {
    const match = findLatestEntryForPredicate({
      workflow: "oath-upload",
      trackerDir,
      lookbackDays: LOOKBACK_DAYS,
      db: controlDb.db,
      itemId: sessionId,
      predicate: (e) => {
        if (e.id !== sessionId) return false;
        if (pdfHash && typeof e.data?.pdfHash === "string" && e.data.pdfHash !== pdfHash) return false;
        return (
          typeof e.data?.ticketNumber === "string" &&
          isFiledTicketNumber(e.data.ticketNumber)
        );
      },
    });
    if (!match) return null;
    const t = match.data?.ticketNumber;
    return typeof t === "string" ? t : null;
  } finally {
    controlDb.close();
  }
}

/**
 * Idempotency-window probe: returns true when a PRIOR run for this session
 * reached the ServiceNow `submit` step (durably marked `data.submitAttempted`)
 * — i.e. a ticket MAY have been filed even though no ticket number was recorded
 * (a crash between the ServiceNow POST and the ticket-number persist). Callers
 * MUST first rule out a recorded filed ticket via `findPriorTicketForSession`;
 * a hit here then means the submit outcome is UNKNOWN and auto-retrying would
 * risk a duplicate HR ticket. Keyed on stable business identity (sessionId,
 * defensive pdfHash) like the ticket probe; dry-run rows never set the marker.
 * The `findLatestEntryForPredicate` SQLite fast path short-circuits only on the
 * latest projection row, then falls through to the JSONL history scan — so a
 * retry's own newer (marker-less) rows don't mask a prior crashed attempt.
 */
export function hasUnverifiedPriorSubmit(
  sessionId: string,
  pdfHash: string | undefined,
  trackerDir?: string,
): boolean {
  const controlDb = openControlDb({ trackerDir });
  try {
    const match = findLatestEntryForPredicate({
      workflow: "oath-upload",
      trackerDir,
      lookbackDays: LOOKBACK_DAYS,
      db: controlDb.db,
      itemId: sessionId,
      predicate: (e) => {
        if (e.id !== sessionId) return false;
        if (pdfHash && typeof e.data?.pdfHash === "string" && e.data.pdfHash !== pdfHash) return false;
        return e.data?.submitAttempted === "true";
      },
    });
    return match !== null;
  } finally {
    controlDb.close();
  }
}
