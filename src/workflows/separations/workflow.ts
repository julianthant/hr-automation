import type { Page } from "playwright";
import { z } from "zod/v4";
import { log } from "../../utils/log.js";
import { errorMessage, classifyPlaywrightError } from "../../utils/errors.js";
import { defineWorkflow, runWorkflow, runWorkflowBatch } from "../../core/index.js";
import { trackEvent } from "../../tracker/jsonl.js";

// Auth wrappers
import { loginToKuali, loginToUKG, loginToUCPath, loginToNewKronos } from "../../auth/login.js";

// Kuali module
import {
  openActionList,
  clickDocument,
  extractSeparationData,
  isVoluntaryTermination,
  fillTimekeeperTasks,
  fillFinalTransactions,
  fillTransactionResults,
  fillTimekeeperComments,
  updateLastDayWorked,
  updateSeparationDate,
  clickSave,
} from "../../systems/kuali/index.js";
import type { KualiSeparationData } from "../../systems/kuali/index.js";

// Old Kronos module
import {
  getGeniesIframe,
  searchEmployee as searchOldKronos,
  clickEmployeeRow,
  dismissModal,
  setDateRange as setOldKronosDateRange,
  clickGoToTimecard as clickOldKronosGoToTimecard,
  getTimecardLastDate as getOldKronosTimecardLastDate,
} from "../../systems/old-kronos/index.js";

// New Kronos module
import {
  searchEmployee as searchNewKronos,
  selectEmployeeResult as selectNewKronosResult,
  clickGoToTimecard as clickNewKronosGoToTimecard,
  setDateRange as setNewKronosDateRange,
  getTimecardLastDate as getNewKronosTimecardLastDate,
  NEW_KRONOS_URL,
} from "../../systems/new-kronos/index.js";

// UCPath modules
import {
  navigateToSmartHR,
  getContentFrame,
  clickSmartHRTransactions,
  selectTemplate,
  enterEffectiveDate,
  clickCreateTransaction,
  selectReasonCode,
  fillComments,
  clickSaveAndSubmit,
  getJobSummaryData,
  readLatestTransactionNumber,
} from "../../systems/ucpath/index.js";
import type { JobSummaryData } from "../../systems/ucpath/index.js";
import {
  hashKey,
  hasRecentlySucceeded,
  findRecentTransactionId,
  recordSuccess,
} from "../../core/idempotency.js";

import {
  computeTerminationEffDate,
  computeKronosDateRange,
  buildTerminationComments,
  buildDateChangeComments,
  resolveKronosDates,
  mapReasonCode,
  getInitials,
} from "./schema.js";
import {
  KUALI_SPACE_URL,
  UC_VOL_TERM_TEMPLATE,
  UC_INVOL_TERM_TEMPLATE,
} from "./config.js";
import { PATHS, UCPATH_SMART_HR_URL } from "../../config.js";
import { getProcessIsolatedSessionDir } from "../../core/session.js";
import { rmSync } from "node:fs";

/** Input schema for the separations kernel workflow — only docId from the CLI. */
const SeparationInputSchema = z.object({
  docId: z.string().min(1),
});
type SeparationInput = z.infer<typeof SeparationInputSchema>;

const separationsSteps = [
  "kuali-extraction",
  "kronos-search",
  "ucpath-job-summary",
  "ucpath-transaction",
  "kuali-finalization",
] as const;

/**
 * Helper: detect "No matches were found" modal on Old Kronos after an EID search
 * and dismiss it. Returns false when the modal appeared (i.e. EID not found).
 */
async function checkOldKronosResult(page: Page): Promise<boolean> {
  let found = true;
  for (const f of page.frames()) {
    const noMatch = await f.locator("text=No matches were found").count().catch(() => 0);
    if (noMatch > 0) {
      found = false;
      try { await f.locator("button:has-text('OK')").click({ timeout: 3_000 }); } catch { /* ok */ }
      break;
    }
  }
  return found;
}

/**
 * Kernel definition for the separations workflow.
 *
 * 4 systems, interleaved auth: Kuali blocking (Duo #1), then Old Kronos (Duo #2),
 * New Kronos (Duo #3), UCPath (Duo #4) chained in background via the kernel's
 * `authChain: "interleaved"` mode. `ctx.page(id)` awaits each system's ready
 * promise, so work tasks inside `ctx.parallel` start as soon as their individual
 * Duo clears — no waiting for all 4 auths to complete before any work begins.
 *
 * Phase 1 (`kronos-search`) runs 4 tasks in parallel via `ctx.parallel`:
 *   - Old Kronos timecard search
 *   - New Kronos timecard search
 *   - UCPath Job Summary lookup
 *   - Kuali timekeeper name fill
 * Each task `await ctx.page(id)` first to block on its system's auth.
 *
 * Phase 2 (`ucpath-job-summary`): Kronos date resolution + Kuali term date / dept fill.
 * Phase 3 (`ucpath-transaction`): Smart HR UC_VOL_TERM or UC_INVOL_TERM.
 * Phase 4 (`kuali-finalization`): write txn number back, fill date-change comments, save.
 *
 * Batch mode (`runWorkflowBatch` sequential): the kernel calls `session.reset(id)`
 * between docs, which navigates each system's `resetUrl` so the next doc starts
 * from a clean page state.
 */

export function resolveJobSummaryResult(
  result: PromiseSettledResult<JobSummaryData | undefined>,
): JobSummaryData | undefined {
  if (result.status === "fulfilled") return result.value;
  throw new Error(`UCPath Job Summary extraction failed: ${errorMessage(result.reason)}`);
}

export const separationsWorkflow = defineWorkflow({
  name: "separations",
  label: "Separations",
  systems: [
    {
      id: "kuali",
      login: async (page, instance) => {
        const ok = await loginToKuali(page, KUALI_SPACE_URL, instance);
        if (!ok) throw new Error("Kuali authentication failed");
      },
      resetUrl: KUALI_SPACE_URL,
    },
    {
      id: "old-kronos",
      login: async (page, instance) => {
        const ok = await loginToUKG(page, instance);
        if (!ok) throw new Error("Old Kronos (UKG) authentication failed");
      },
      sessionDir: getProcessIsolatedSessionDir(PATHS.ukgSessionSep),
    },
    {
      id: "new-kronos",
      login: async (page, instance) => {
        await page.goto(NEW_KRONOS_URL, { waitUntil: "domcontentloaded", timeout: 30_000 });
        const ok = await loginToNewKronos(page, instance);
        if (!ok) throw new Error("New Kronos authentication failed");
      },
      resetUrl: NEW_KRONOS_URL,
    },
    {
      id: "ucpath",
      login: async (page, instance) => {
        const ok = await loginToUCPath(page, instance);
        if (!ok) throw new Error("UCPath authentication failed");
      },
      resetUrl: UCPATH_SMART_HR_URL,
    },
  ],
  steps: separationsSteps,
  schema: SeparationInputSchema,
  authChain: "interleaved",
  tiling: "auto",
  batch: {
    mode: "sequential",
    betweenItems: ["reset-browsers"],
  },
  detailFields: [
    { key: "name",              label: "Employee" },
    { key: "eid",               label: "EID" },
    { key: "docId",             label: "Doc ID" },
    { key: "terminationType",   label: "Term Type" },
    { key: "separationDate",    label: "Sep Date" },
    { key: "transactionNumber", label: "Txn #" },
  ],
  getName: (d) => d.name ?? "",
  getId: (d) => d.docId ?? "",
  handler: async (ctx, input) => {
    const { docId } = input;

    // Stamp docId immediately so the dashboard row shows it from step 1.
    ctx.updateData({ docId });

    // ─── Step 1: Extract Kuali data ───
    // Kuali docs are user-editable between runs (e.g. correcting a wrong EID
    // after a failed first pass). Caching the extraction would serve stale
    // values on retry, so always re-read. See
    // docs/superpowers/specs/2026-04-23-daemon-isolation-and-separations-stability-design.md
    // Part 1.2 for the general caching rule (write-once / non-user-editable only).
    const kualiData = await ctx.step("kuali-extraction", async () => {
      const t0 = Date.now();
      log.debug(`[Step: kuali-extraction] START docId='${docId}'`);
      const kualiPage = await ctx.page("kuali");
      // Auto-dismiss PeopleSoft dialogs on UCPath — important when a previous
      // doc's transaction leaves a confirmation modal up (batch mode state).
      const ucpathPage = await ctx.page("ucpath");
      ucpathPage.on("dialog", (d) => d.accept().catch(() => {}));

      await openActionList(kualiPage);
      await clickDocument(kualiPage, docId);
      const result = await extractSeparationData(kualiPage);
      log.step(
        `[Step: kuali-extraction] END took=${Date.now() - t0}ms `
        + `employeeName='${result.employeeName}' eid='${result.eid}' `
        + `lastDayWorked='${result.lastDayWorked}' separationDate='${result.separationDate}'`,
      );
      return result;
    });

    const isVol = isVoluntaryTermination(kualiData.terminationType);
    const termEffDate = computeTerminationEffDate(kualiData.separationDate);
    const ucpathReason = mapReasonCode(kualiData.terminationType);
    const template = isVol ? UC_VOL_TERM_TEMPLATE : UC_INVOL_TERM_TEMPLATE;
    const timekeeperName = process.env.NAME ?? "";

    log.step(`Kuali extraction: Employee="${kualiData.employeeName}", EID="${kualiData.eid}", SepDate="${kualiData.separationDate}", Type="${kualiData.terminationType}"`);
    log.step(`Template: "${template}" — ${isVol ? "voluntary termination" : "involuntary termination"}`);
    log.step(`Reason code: Kuali type "${kualiData.terminationType}" → UCPath reason "${ucpathReason}"`);
    log.step(`Termination effective date: ${termEffDate} (separation date ${kualiData.separationDate} + 1 day)`);
    ctx.updateData({ name: kualiData.employeeName, eid: kualiData.eid });
    log.step(`Employee: ${kualiData.employeeName} | EID: ${kualiData.eid}`);
    log.step(`Type: ${kualiData.terminationType} (${isVol ? "VOL" : "INVOL"}) | Eff: ${termEffDate}`);

    // ─── Step 4: kronos-search (4-way parallel) ───
    const { startDate: kronosStart, endDate: kronosEnd } = computeKronosDateRange(
      kualiData.lastDayWorked, kualiData.separationDate,
    );
    log.step(`[Old Kronos / New Kronos] Date range: ${kronosStart} – ${kronosEnd}`);

    const phase1 = await ctx.step("kronos-search", async () => {
      const t0 = Date.now();
      log.debug(`[Step: kronos-search] START eid='${kualiData.eid}'`);
      log.step("=== PHASE 1: Kronos + Job Summary + Kuali fill (parallel) ===");
      const result = await ctx.parallel({
        oldK: async () => {
          const page = await ctx.page("old-kronos");
          // Old Kronos: set date range FIRST, then search by ID
          const iframe = await getGeniesIframe(page);
          await dismissModal(page, iframe);
          await setOldKronosDateRange(page, iframe, kronosStart, kronosEnd);
          await searchOldKronos(page, iframe, kualiData.eid);
          await page.waitForTimeout(3_000);
          const found = await checkOldKronosResult(page);
          log.step(`[Old Kronos] EID ${kualiData.eid}: ${found ? "FOUND" : "NOT FOUND"}`);
          if (!found) return { found: false, date: null as string | null };
          await clickEmployeeRow(page, iframe, kualiData.eid);
          const okTimecard = await clickOldKronosGoToTimecard(page, iframe);
          if (!okTimecard) return { found: true, date: null as string | null };
          await page.waitForTimeout(3_000);
          await dismissModal(page, iframe);
          const date = await getOldKronosTimecardLastDate(page, iframe);
          return { found: true, date };
        },
        newK: async () => {
          const page = await ctx.page("new-kronos");
          // New Kronos: search by ID first, then go to timecard, then set date range
          const found = await searchNewKronos(page, kualiData.eid);
          log.step(`[New Kronos] EID ${kualiData.eid}: ${found ? "FOUND" : "NOT FOUND"}`);
          if (!found) return { found: false, date: null as string | null };
          await selectNewKronosResult(page);
          const okTimecard = await clickNewKronosGoToTimecard(page);
          if (!okTimecard) return { found: true, date: null as string | null };
          await page.waitForTimeout(3_000);
          await setNewKronosDateRange(page, kronosStart, kronosEnd);
          const date = await getNewKronosTimecardLastDate(page);
          return { found: true, date };
        },
        jobSummary: async (): Promise<JobSummaryData | undefined> => {
          const page = await ctx.page("ucpath");
          log.step("[UCPath] Starting Job Summary lookup...");
          return getJobSummaryData(page, kualiData.eid);
        },
        kualiTimekeeper: async () => {
          const page = await ctx.page("kuali");
          log.step("[Kuali] Filling timekeeper name...");
          await fillTimekeeperTasks(page, timekeeperName);
          log.success("[Kuali] Timekeeper name filled");
        },
      });
      log.step(
        `[Step: kronos-search] END took=${Date.now() - t0}ms `
        + `oldK found=${result.oldK.status === "fulfilled"} `
        + `newK found=${result.newK.status === "fulfilled"} `
        + `jobSummary ok=${result.jobSummary.status === "fulfilled"} `
        + `kualiTimekeeper ok=${result.kualiTimekeeper.status === "fulfilled"}`,
      );
      return result;
    });

    // ─── Process Phase 1 results (preserve PromiseSettledResult fallback semantics) ───
    let oldKronosDate: string | null = null;
    let newKronosDate: string | null = null;
    let oldKronosFound = false;
    let newKronosFound = false;
    let jobSummaryData: JobSummaryData | undefined;

    if (phase1.oldK.status === "fulfilled") {
      oldKronosFound = phase1.oldK.value.found;
      oldKronosDate = phase1.oldK.value.date;
    } else {
      const classified = classifyPlaywrightError(phase1.oldK.reason);
      log.error(`[Old Kronos] ${classified.kind}: ${classified.summary}`);
      log.debug(`[Old Kronos] full error: ${errorMessage(phase1.oldK.reason)}`);
    }
    if (phase1.newK.status === "fulfilled") {
      newKronosFound = phase1.newK.value.found;
      newKronosDate = phase1.newK.value.date;
    } else {
      const classified = classifyPlaywrightError(phase1.newK.reason);
      log.error(`[New Kronos] ${classified.kind}: ${classified.summary}`);
      log.debug(`[New Kronos] full error: ${errorMessage(phase1.newK.reason)}`);
    }
    if (phase1.jobSummary.status === "rejected") {
      const classified = classifyPlaywrightError(phase1.jobSummary.reason);
      log.error(`[UCPath Job Summary] ${classified.kind}: ${classified.summary}`);
      log.debug(`[UCPath Job Summary] full error: ${errorMessage(phase1.jobSummary.reason)}`);
    }
    // resolveJobSummaryResult throws on rejection (classified log emitted above);
    // no duplicate log.error here — the rejection is fatal and the throw propagates.
    jobSummaryData = resolveJobSummaryResult(phase1.jobSummary);
    if (phase1.kualiTimekeeper.status === "rejected") {
      const classified = classifyPlaywrightError(phase1.kualiTimekeeper.reason);
      log.error(`[Kuali Timekeeper] ${classified.kind}: ${classified.summary}`);
      log.debug(`[Kuali Timekeeper] full error: ${errorMessage(phase1.kualiTimekeeper.reason)}`);
    }

    log.step(`[Old Kronos] ${oldKronosFound ? "Found" : "Not found"} (${oldKronosDate ?? "no time"})`);
    log.step(`[New Kronos] ${newKronosFound ? "Found" : "Not found"} (${newKronosDate ?? "no time"})`);

    // ─── Resolve Kronos dates (Kronos overrides Kuali — ground truth) ───
    const resolved = resolveKronosDates(
      kualiData.lastDayWorked, kualiData.separationDate,
      oldKronosDate, newKronosDate,
    );

    const chosenDateSource = resolved.changed
      ? (oldKronosDate && newKronosDate
          ? (oldKronosDate >= newKronosDate ? "Old Kronos" : "New Kronos")
          : (oldKronosDate ? "Old Kronos" : "New Kronos"))
      : "Kuali (no change)";
    log.step(`[Old Kronos / New Kronos] Resolved dates — using ${chosenDateSource}`);

    // Early-populate separationDate so the dashboard shows it as soon as
    // Kronos reconciliation completes (not only after the transaction submits).
    ctx.updateData({ separationDate: resolved.separationDate, terminationType: isVol ? "Vol" : "Invol" });

    const kualiPage = await ctx.page("kuali");
    if (resolved.changed) {
      log.step("[Old Kronos / New Kronos] Dates differ from Kuali — updating:");
      if (resolved.lastDayWorked !== kualiData.lastDayWorked) {
        log.step(`  Last Day Worked: ${kualiData.lastDayWorked} → ${resolved.lastDayWorked}`);
        await updateLastDayWorked(kualiPage, resolved.lastDayWorked);
      }
      if (resolved.separationDate !== kualiData.separationDate) {
        log.step(`  Separation Date: ${kualiData.separationDate} → ${resolved.separationDate}`);
        await updateSeparationDate(kualiPage, resolved.separationDate);
      }
    } else {
      log.step("[Dates] No date changes needed");
    }

    const finalTermEffDate = resolved.separationDate !== kualiData.separationDate
      ? computeTerminationEffDate(resolved.separationDate)
      : termEffDate;
    if (resolved.separationDate !== kualiData.separationDate) {
      log.step(`Termination effective date: ${finalTermEffDate} (updated separation date ${resolved.separationDate} + 1 day)`);
    }
    const finalComments = buildTerminationComments(finalTermEffDate, resolved.lastDayWorked, docId);

    // ─── Step 5: ucpath-job-summary (Kuali term date + dept/payroll fill) ───
    await ctx.step("ucpath-job-summary", async () => {
      const t0 = Date.now();
      log.debug(`[Step: ucpath-job-summary] START eid='${kualiData.eid}'`);
      log.step("[Kuali] Filling termination effective date + department/payroll...");
      await kualiPage
        .getByRole("textbox", { name: "Termination Effective Date*" })
        .fill(finalTermEffDate, { timeout: 5_000 });

      if (jobSummaryData && (jobSummaryData.departmentDescription || jobSummaryData.jobCode)) {
        await fillFinalTransactions(kualiPage, {
          department: jobSummaryData.departmentDescription,
          payrollTitleCode: jobSummaryData.jobCode,
          payrollTitle: jobSummaryData.jobDescription,
        });
        log.success("[Kuali] Department + payroll filled");
      }
      log.step(
        `[Step: ucpath-job-summary] END took=${Date.now() - t0}ms `
        + `dept='${jobSummaryData?.departmentDescription ?? ""}' `
        + `jobCode='${jobSummaryData?.jobCode ?? ""}' `
        + `payrollTitle='${jobSummaryData?.jobDescription ?? ""}'`,
      );
    });

    // ─── Step 6: UCPath Smart HR Transaction ───
    let transactionNumber = "";
    // Tracks the specific "submit succeeded but no txn # extracted" case.
    // We must abort before kuali-finalization so we don't write a blank
    // transaction number back to the Kuali form. Raised outside the step's
    // try/catch because we want it to propagate, unlike ordinary submit
    // failures which are logged and allowed to fall through to finalization
    // (so the Kuali form gets its "left blank for manual entry" treatment).
    let submittedWithoutTxnNumber = false;
    // Idempotency key — identifies this specific termination transaction.
    // Two scenarios this protects against:
    //   1. Prior run submitted AND captured txn# → skip UCPath entirely,
    //      resume at Kuali finalization with the recorded txn#.
    //   2. Prior run submitted but readback failed (empty txn# recorded) →
    //      skip the submit (would be a duplicate), run readback-only to
    //      recover the txn#, then continue to Kuali finalization.
    // Key fields: workflow + docId + emplId. docId alone is unique per
    // Kuali doc; emplId is a cross-check that the Kuali extraction resolved
    // to the same employee as last time.
    const idempKey = hashKey({
      workflow: "separations",
      docId,
      emplId: kualiData.eid,
    });

    await ctx.step("ucpath-transaction", async () => {
      const t0 = Date.now();
      log.debug(`[Step: ucpath-transaction] START empl='${kualiData.eid}' template='${template}'`);
      try {
        log.step("=== UCPath Smart HR Transaction ===");
        const ucpathPage = await ctx.page("ucpath");

        // Convert "Last, First" → "First Last" for UCPath name matching
        const nameParts = kualiData.employeeName.split(",").map((s) => s.trim());
        const ucpathName = nameParts.length >= 2 ? `${nameParts[1]} ${nameParts[0]}` : kualiData.employeeName;

        // Idempotency check — before attempting the submit.
        if (hasRecentlySucceeded(idempKey)) {
          const recordedTxn = findRecentTransactionId(idempKey) ?? "";
          if (recordedTxn) {
            log.warn(`[UCPath Txn] Prior submit recorded (txn #${recordedTxn}) — skipping UCPath submit (idempotency)`);
            transactionNumber = recordedTxn;
            // Persist the recovered txn # immediately. If a later step
            // (kuali-finalization) throws, the handler exits before the
            // final updateData at the end of the handler — without this
            // inline call the dashboard detail panel shows "—".
            ctx.updateData({ transactionNumber, idempotencySkip: "submit" });
            return;
          }
          // Submit happened but txn# wasn't captured — run readback only.
          log.warn("[UCPath Txn] Prior submit recorded without txn # — running readback only (idempotency)");
          ctx.updateData({ idempotencySkip: "submit-readback" });
          try {
            const recoveredTxn = await readLatestTransactionNumber(ucpathPage, ucpathName);
            if (recoveredTxn) {
              transactionNumber = recoveredTxn;
              recordSuccess(idempKey, recoveredTxn, "separations");
              // Persist immediately — see comment at the idempotency-hit path above.
              ctx.updateData({ transactionNumber });
              log.success(`[UCPath Txn] Recovered txn #${recoveredTxn} via readback`);
              await ctx.screenshot({ kind: 'form', label: 'ucpath-transaction-recovered' });
            } else {
              submittedWithoutTxnNumber = true;
            }
          } catch (e) {
            log.error(`[UCPath Txn] Readback-only path failed: ${errorMessage(e)}`);
            submittedWithoutTxnNumber = true;
          }
          return;
        }

        try {
          await navigateToSmartHR(ucpathPage);
          await clickSmartHRTransactions(ucpathPage);

          const frame = getContentFrame(ucpathPage);
          await selectTemplate(frame, template);
          await enterEffectiveDate(frame, finalTermEffDate);

          const createResult = await clickCreateTransaction(ucpathPage, frame);
          if (!createResult.success) {
            log.error(`[UCPath Txn] Create failed: ${createResult.error}`);
            return;
          }
          log.step("[UCPath Txn] Filling Empl ID...");
          await frame.getByRole("textbox", { name: "Empl ID" }).fill(kualiData.eid, { timeout: 10_000 });
          await selectReasonCode(ucpathPage, frame, ucpathReason);
          await fillComments(frame, finalComments);

          const submitResult = await clickSaveAndSubmit(ucpathPage, frame, ucpathName);
          transactionNumber = submitResult.transactionNumber ?? "";
          log.step(
            `[UCPath Txn] submit result: success=${submitResult.success} `
            + `txnNumber='${transactionNumber || "<empty>"}' `
            + `reasonMessage='${submitResult.error ?? "<none>"}'`,
          );
          if (!submitResult.success) {
            log.error(`[UCPath Txn] Submit failed: ${submitResult.error}`);
            return;
          }
          // Record idempotency IMMEDIATELY after a successful submit — even
          // if txn# is empty. A retry that comes here with an empty record
          // will skip the submit and try readback only, avoiding a duplicate
          // UCPath termination transaction.
          recordSuccess(idempKey, transactionNumber, "separations");
          if (!transactionNumber) {
            submittedWithoutTxnNumber = true;
            return;
          }
          // Persist txn # immediately so kuali-finalization failures don't
          // drop it from the tracker entry's data.
          ctx.updateData({ transactionNumber });
          log.success(`[UCPath Txn] Transaction submitted (#${transactionNumber})`);
          await ctx.screenshot({ kind: 'form', label: 'ucpath-transaction-submitted' });
        } catch (e) {
          log.error(`[UCPath Txn] Failed: ${errorMessage(e)}`);
        }

        // In batch mode, navigate UCPath back to Smart HR base URL so the next
        // doc's transaction starts from a clean page. Kernel's between-items
        // reset-browsers also does this via the resetUrl SystemConfig field, but
        // we do it immediately here so the current phase3 step doesn't collide
        // with a confirmation modal left over on the page.
        if (ctx.isBatch) {
          try {
            await navigateToSmartHR(ucpathPage);
          } catch {
            // Non-fatal — the between-items reset will retry
          }
        }
      } finally {
        log.step(
          `[Step: ucpath-transaction] END took=${Date.now() - t0}ms `
          + `txnNumber='${transactionNumber || "<empty>"}'`,
        );
      }
    });

    if (submittedWithoutTxnNumber) {
      throw new Error(
        "Transaction submitted but transaction number could not be extracted — aborting before Kuali finalization writes empty value",
      );
    }

    // ─── Step 7: Kuali finalization ───
    await ctx.step("kuali-finalization", async () => {
      const t0 = Date.now();
      log.debug(`[Step: kuali-finalization] START txnNumber='${transactionNumber || "<empty>"}'`);
      log.step("=== PHASE 3: Kuali finalization ===");

      // Always fill checkbox + radio; fill txn number if we have it
      await fillTransactionResults(kualiPage, transactionNumber);
      if (!transactionNumber) {
        log.error("[Kuali] No transaction number — left blank for manual entry");
      }

      const initials = getInitials(timekeeperName);
      const dateChangeComments = buildDateChangeComments(
        kualiData.lastDayWorked, resolved.lastDayWorked,
        kualiData.separationDate, resolved.separationDate,
        initials,
      );
      if (dateChangeComments) {
        log.step(`[Kuali] Date change comments: ${dateChangeComments}`);
        await fillTimekeeperComments(kualiPage, dateChangeComments);
      }

      await clickSave(kualiPage);
      await ctx.screenshot({ kind: 'form', label: 'kuali-finalization-saved' });
      log.step(`[Step: kuali-finalization] END took=${Date.now() - t0}ms success`);
    });

    // Final state snapshot for the dashboard detail panel / JSONL readers.
    ctx.updateData({
      terminationType: isVol ? "Vol" : "Invol",
      separationDate: resolved.separationDate,
      terminationEffDate: finalTermEffDate,
      deptId: jobSummaryData?.deptId ?? "",
      departmentDescription: jobSummaryData?.departmentDescription ?? "",
      jobCode: jobSummaryData?.jobCode ?? "",
      jobDescription: jobSummaryData?.jobDescription ?? "",
      foundInOldKronos: String(oldKronosFound),
      foundInNewKronos: String(newKronosFound),
      transactionNumber,
    });

    log.success(`=== Separation complete for doc #${docId} ===`);
  },
});

export interface SeparationOptions {
  dryRun?: boolean;
}

/**
 * Print a pipeline preview for dry-run mode. No browser launch; no Kuali
 * extraction. Matches the other kernel workflows' dry-run semantics.
 */
function previewSeparationPipeline(docId: string): void {
  log.step("=== DRY RUN MODE ===");
  log.step(`Would process separation for doc #${docId}`);
  log.step("Planned step pipeline:");
  log.step("  1. launching (4 browsers: Kuali, Old Kronos, New Kronos, UCPath)");
  log.step("  2. authenticating (interleaved — Duo #1..#4)");
  log.step("  3. kuali-extraction");
  log.step("  4. kronos-search (parallel: Old Kronos + New Kronos + UCPath Job Summary + Kuali timekeeper)");
  log.step("  5. ucpath-job-summary (Kuali term date + dept/payroll fill)");
  log.step("  6. ucpath-transaction (Smart HR UC_VOL_TERM or UC_INVOL_TERM)");
  log.step("  7. kuali-finalization (transaction number write-back + save)");
  log.success("Dry run complete — no browsers launched");
}

/**
 * CLI adapter for single-doc separation runs.
 *
 * Dry-run bypasses the kernel entirely (no browser). Real runs delegate to
 * `runWorkflow(separationsWorkflow, { docId })` which owns browser launch, the
 * interleaved auth chain, step emission, screenshot-on-failure, and SIGINT
 * cleanup.
 */
export async function runSeparation(
  docId: string,
  options: SeparationOptions = {},
): Promise<void> {
  if (options.dryRun) {
    previewSeparationPipeline(docId);
    return;
  }
  const sessionDir = getProcessIsolatedSessionDir(PATHS.ukgSessionSep);
  try {
    await runWorkflow(separationsWorkflow, { docId });
  } finally {
    try { rmSync(sessionDir, { recursive: true, force: true }); } catch { /* non-fatal */ }
  }
}

/**
 * CLI adapter for multi-doc batch runs.
 *
 * Dry-run bypasses the kernel and previews each docId's pipeline.
 * Real runs delegate to `runWorkflowBatch` sequential mode — the kernel launches
 * browsers once, runs the auth chain once, and reuses the same 4 browsers for
 * every doc, calling `session.reset(id)` between docs.
 *
 * `onPreEmitPending` emits a `pending` tracker row per docId before the first
 * step runs so the dashboard populates the queue immediately. `deriveItemId`
 * produces the docId-shaped item ID that `withTrackedWorkflow` will use.
 */
export async function runSeparationBatch(
  docIds: string[],
  options: SeparationOptions = {},
): Promise<{ total: number; succeeded: number; failed: number }> {
  if (options.dryRun) {
    for (const docId of docIds) previewSeparationPipeline(docId);
    return { total: docIds.length, succeeded: docIds.length, failed: 0 };
  }

  const sessionDir = getProcessIsolatedSessionDir(PATHS.ukgSessionSep);
  const now = new Date().toISOString();
  const items = docIds.map((id) => ({ docId: id }));
  try {
    const result = await runWorkflowBatch(separationsWorkflow, items, {
      deriveItemId: (item) => (item as SeparationInput).docId,
      onPreEmitPending: (item, runId) => {
        const { docId } = item as SeparationInput;
        trackEvent({
          workflow: "separations",
          timestamp: now,
          id: docId,
          runId,
          status: "pending",
          data: { docId },
        });
      },
    });
    return { total: result.total, succeeded: result.succeeded, failed: result.failed };
  } finally {
    try { rmSync(sessionDir, { recursive: true, force: true }); } catch { /* non-fatal */ }
  }
}

/**
 * Daemon-mode CLI adapter. Dispatches docIds through the shared daemon queue
 * instead of launching an in-process batch: first call spawns a detached
 * daemon + pays Duo once, subsequent calls enqueue + wake alive daemons.
 *
 * See `src/core/daemon-client.ts::ensureDaemonsAndEnqueue` for flag semantics
 * and `src/workflows/separations/CLAUDE.md` ("Daemon mode") for user-facing
 * docs. `runSeparation` / `runSeparationBatch` above remain untouched so
 * tests and scripting can still run the separations workflow directly
 * without the daemon.
 */
/**
 * Look up the most recent `eid` recorded in any separations tracker file
 * for the given docId. Used by `runSeparationRecover` to compute the
 * idempotency key without touching UCPath.
 *
 * Scans tracker JSONL files across all dates (newest first), returns the
 * first entry matching `id === docId` with a non-empty `data.eid`.
 */
async function findEmplIdForDoc(docId: string): Promise<string | null> {
  const { readEntriesForDate, listDatesForWorkflow } = await import("../../tracker/jsonl.js");
  const dates = listDatesForWorkflow("separations");
  for (const date of dates) {
    const entries = readEntriesForDate("separations", date);
    for (const e of entries) {
      if (e.id !== docId) continue;
      const eid = e.data?.eid;
      if (typeof eid === "string" && eid.length > 0) return eid;
    }
  }
  return null;
}

/**
 * Recovery CLI for separations docs stuck in the "submitted without txn#"
 * state. Seeds an empty idempotency record for each docId so the next
 * `runSeparationCli` run takes the readback-only resume path (skipping the
 * UCPath termination submit that would otherwise double-submit), then
 * invokes `runSeparationCli` to process the docs through the normal daemon
 * queue.
 *
 * Guard: if an idempotency record already exists for a docId (e.g. the
 * workflow already recorded success after Task B's wiring landed), we skip
 * the seed — the workflow will use whatever record already exists.
 *
 * Precondition: each docId must have at least one prior tracker entry with
 * a populated `data.eid`. Without that we can't compute the idempotency
 * key.
 */
export async function runSeparationRecover(
  docIds: string[],
  options: { dryRun?: boolean; new?: boolean; parallel?: number } = {},
): Promise<void> {
  if (docIds.length === 0) {
    log.error("runSeparationRecover: no doc IDs provided");
    process.exitCode = 1;
    return;
  }
  log.step(`[Recover] Seeding idempotency for ${docIds.length} doc(s)...`);
  const recoverable: string[] = [];
  for (const docId of docIds) {
    const emplId = await findEmplIdForDoc(docId);
    if (!emplId) {
      log.error(`[Recover] No prior tracker entry with eid found for doc ${docId} — cannot seed idempotency. Run the normal separation flow instead.`);
      continue;
    }
    const key = hashKey({ workflow: "separations", docId, emplId });
    if (hasRecentlySucceeded(key)) {
      log.warn(`[Recover] Idempotency record already exists for doc ${docId} (emplId=${emplId}); skipping seed`);
      recoverable.push(docId);
      continue;
    }
    recordSuccess(key, "", "separations");
    log.success(`[Recover] Seeded empty idempotency for doc ${docId} (emplId=${emplId})`);
    recoverable.push(docId);
  }
  if (recoverable.length === 0) {
    log.error("[Recover] No recoverable docs — aborting.");
    process.exitCode = 1;
    return;
  }
  log.step(`[Recover] Enqueueing ${recoverable.length} doc(s) through normal separation flow — the idempotency check will trigger the readback-only path.`);
  await runSeparationCli(recoverable, options);
}

export async function runSeparationCli(
  docIds: string[],
  options: { dryRun?: boolean; new?: boolean; parallel?: number } = {},
): Promise<void> {
  if (docIds.length === 0) {
    log.error("runSeparationCli: no doc IDs provided");
    process.exitCode = 1;
    return;
  }
  if (options.dryRun) {
    for (const docId of docIds) previewSeparationPipeline(docId);
    return;
  }
  const { ensureDaemonsAndEnqueue } = await import("../../core/daemon-client.js");
  const inputs = docIds.map((docId) => ({ docId }));
  const now = new Date().toISOString();
  await ensureDaemonsAndEnqueue(
    separationsWorkflow,
    inputs,
    {
      new: options.new,
      parallel: options.parallel,
    },
    {
      // Emit a `pending` tracker row per docId at enqueue time so the
      // dashboard queue panel populates BEFORE the daemon finishes Duo.
      // Matches the `runSeparationBatch` pre-emit payload (shape is
      // read back by SessionPanel + QueuePanel); runId is pre-assigned
      // by enqueueItems so the eventual running/done rows pair 1:1.
      onPreEmitPending: (item, runId) => {
        const { docId } = item;
        trackEvent({
          workflow: "separations",
          timestamp: now,
          id: docId,
          runId,
          status: "pending",
          data: { docId },
        });
      },
    },
  );
}
