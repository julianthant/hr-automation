import type { Ctx } from "../../core/kernel/types.js";
import { watchChildRuns } from "../../tracker/delegation/watch-child-runs.js";
import { log } from "../../utils/log.js";
import { findLatestEntryForPredicate } from "../../tracker/find-latest-entry.js";
import { openControlDb } from "../../core/control-db.js";
import { createTaskStore } from "../../core/task-store/index.js";
import {
  buildOcrPrepareHandler,
  type PrepareInput,
  type PrepareResponse,
} from "../../tracker/dashboard/ocr/prepare.js";
import { loginToServiceNow } from "../../infra/auth/login.js";
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

/**
 * Step list — `dispatch` and `wait-signatures` run BEFORE the ServiceNow
 * browser is launched so we don't hold an authenticated session open across
 * the (potentially multi-day) operator-approval + per-signer wait.
 */
export const oathUploadStepList = [
  "dispatch",
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

type PrepareHandler = (input: PrepareInput) => Promise<PrepareResponse>;

export interface OathUploadHandlerOpts {
  trackerDir?: string;
  // Test escape hatches.
  _prepareOverride?: PrepareHandler;
  _waitForOcrApprovalOverride?: typeof waitForOcrApproval;
  _watchChildRunsOverride?: typeof watchChildRuns;
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
    log.step("[oath-upload] upload-only mode: skipping OCR and signature delegation");
    ctx.skipStep("dispatch");
    ctx.skipStep("wait-signatures");
    ctx.updateData({ signerCount: "skipped" });
  } else if (priorApproval) {
    log.step(
      `[oath-upload] recovery: prior approved OCR for ${ocrSessionId}; skipping dispatch`,
    );
    ctx.skipStep("dispatch");
    fannedOutItemIds = priorApproval.fannedOutItemIds;
    ctx.updateData({ signerCount: String(fannedOutItemIds.length) });
  } else {
    await ctx.step("dispatch", async () => {
      // Trigger OCR + signature batch the same way the oath-signature TopBar
      // Run modal does. `originWorkflow: "oath-signature"` makes the prepare
      // handler synthesize a batch-parent row in the oath-signature tab; the
      // OCR row + per-signer signature rows nest under that synthesized
      // parent. No children nest under THIS oath-upload row.
      const prepare: PrepareHandler =
        opts._prepareOverride ?? buildOcrPrepareHandler({ trackerDir });
      const prepareInput: PrepareInput = {
        pdfPath: input.pdfPath,
        pdfOriginalName: input.pdfOriginalName,
        ...(input.pdfFileId ? { pdfFileId: input.pdfFileId } : {}),
        formType: "oath",
        rosterMode: input.rosterMode,
        ...(input.rosterPath ? { rosterPath: input.rosterPath } : {}),
        sessionId: ocrSessionId,
        ...(input.dryRun ? { dryRun: input.dryRun } : {}),
        originWorkflow: "oath-signature",
      };
      const result = await prepare(prepareInput);
      if (result.status !== 202 || result.body.ok === false) {
        const detail = result.body.ok === false
          ? result.body.error
          : `OCR prepare returned status ${result.status}`;
        throw new Error(`oath-upload: OCR prepare failed — ${detail}`);
      }
      if (result.body.parentRunId) {
        // Stash the synthesized oath-signature batch parent's runId on
        // oath-upload's row data for cross-tab correlation + debugging.
        ctx.updateData({ signaturesParentRunId: result.body.parentRunId });
      }

      // Wait for the OCR row (workflow="ocr", id=ocrSessionId) to reach
      // step="approved". The OCR approve handler stamps fannedOutItemIds on
      // that row's approved entry.
      const fn = opts._waitForOcrApprovalOverride ?? waitForOcrApproval;
      const r = await fn({
        sessionId: ocrSessionId,
        ...(trackerDir ? { trackerDir } : {}),
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
    await ctx.step("wait-signatures", async () => {
      ctx.updateData({
        status: "waiting-signatures",
        signerItemIds: fannedOutItemIds.join(", "),
      });
      const fn = opts._watchChildRunsOverride ?? watchChildRuns;
      await fn({
        workflow: "oath-signature",
        expectedItemIds: fannedOutItemIds,
        ...(trackerDir ? { trackerDir } : {}),
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
    // dispatch + signature waits.
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

function verifyEnqueuedSignerIds(ids: string[], trackerDir: string | undefined): string[] | null {
  if (ids.length === 0) return ids;
  try {
    const db = openControlDb({ trackerDir });
    const taskStore = createTaskStore(db);
    const allTasks = taskStore.listTasksForWorkflow("oath-signature");
    db.close();
    if (allTasks.length === 0) return ids;
    const taskItemIds = new Set(allTasks.map((t) => t.itemId));
    const missing = ids.filter((id) => !taskItemIds.has(id));
    if (missing.length === 0) return ids;
    log.warn(
      `[oath-upload] recovery: ${missing.length}/${ids.length} fanned-out signer ids missing from task_store — re-running dispatch`,
    );
    return null;
  } catch {
    return ids;
  }
}

function readPriorOcrApproval(
  ocrSessionId: string,
  trackerDir: string | undefined,
): { fannedOutItemIds: string[] } | null {
  let controlDb: ReturnType<typeof openControlDb> | undefined;
  try { controlDb = openControlDb({ trackerDir }); } catch { /* fall through to JSONL */ }
  let entry: ReturnType<typeof findLatestEntryForPredicate>;
  try {
    entry = findLatestEntryForPredicate({
      workflow: "ocr",
      trackerDir,
      lookbackDays: LOOKBACK_DAYS,
      ...(controlDb ? { db: controlDb.db, itemId: ocrSessionId } : {}),
      predicate: (e) =>
        e.id === ocrSessionId &&
        e.step === "approved" &&
        typeof e.data?.fannedOutItemIds === "string",
    });
  } finally {
    controlDb?.close();
  }
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
