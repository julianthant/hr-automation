import type { Page } from "playwright";
import { z } from "zod/v4";
import { log } from "../../utils/log.js";
import { errorMessage } from "../../utils/errors.js";
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
} from "../../systems/ucpath/index.js";
import type { JobSummaryData } from "../../systems/ucpath/index.js";

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
      sessionDir: PATHS.ukgSessionSep,
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
    { key: "name", label: "Employee" },
    { key: "eid", label: "EID" },
    { key: "docId", label: "Doc ID" },
  ],
  getName: (d) => d.name ?? "",
  getId: (d) => d.docId ?? "",
  handler: async (ctx, input) => {
    const { docId } = input;

    // Stamp docId immediately so the dashboard row shows it from step 1.
    ctx.updateData({ docId });

    // ─── Step 1: Extract Kuali data ───
    const kualiData = await ctx.step("kuali-extraction", async () => {
      const kualiPage = await ctx.page("kuali");
      // Auto-dismiss PeopleSoft dialogs on UCPath — important when a previous
      // doc's transaction leaves a confirmation modal up (batch mode state).
      const ucpathPage = await ctx.page("ucpath");
      ucpathPage.on("dialog", (d) => d.accept().catch(() => {}));

      await openActionList(kualiPage);
      await clickDocument(kualiPage, docId);
      return extractSeparationData(kualiPage);
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
      log.step("=== PHASE 1: Kronos + Job Summary + Kuali fill (parallel) ===");
      return ctx.parallel({
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
      log.error(`[Old Kronos] Error: ${errorMessage(phase1.oldK.reason)}`);
    }
    if (phase1.newK.status === "fulfilled") {
      newKronosFound = phase1.newK.value.found;
      newKronosDate = phase1.newK.value.date;
    } else {
      log.error(`[New Kronos] Error: ${errorMessage(phase1.newK.reason)}`);
    }
    if (phase1.jobSummary.status === "fulfilled") {
      jobSummaryData = phase1.jobSummary.value;
    } else {
      log.error(`[UCPath Job Summary] Failed: ${errorMessage(phase1.jobSummary.reason)}`);
    }
    if (phase1.kualiTimekeeper.status === "rejected") {
      log.error(`[Kuali] Timekeeper fill failed: ${errorMessage(phase1.kualiTimekeeper.reason)}`);
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
    });

    // ─── Step 6: UCPath Smart HR Transaction ───
    let transactionNumber = "";
    await ctx.step("ucpath-transaction", async () => {
      log.step("=== UCPath Smart HR Transaction ===");
      const ucpathPage = await ctx.page("ucpath");

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

        // Convert "Last, First" → "First Last" for UCPath name matching
        const nameParts = kualiData.employeeName.split(",").map((s) => s.trim());
        const ucpathName = nameParts.length >= 2 ? `${nameParts[1]} ${nameParts[0]}` : kualiData.employeeName;
        const submitResult = await clickSaveAndSubmit(ucpathPage, frame, ucpathName);
        if (!submitResult.success) {
          log.error(`[UCPath Txn] Submit failed: ${submitResult.error}`);
          return;
        }
        transactionNumber = submitResult.transactionNumber ?? "";
        log.success(`[UCPath Txn] Transaction submitted${transactionNumber ? ` (#${transactionNumber})` : ""}`);
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
    });

    // ─── Step 7: Kuali finalization ───
    await ctx.step("kuali-finalization", async () => {
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
    });

    // Final state snapshot for the dashboard detail panel / JSONL readers.
    ctx.updateData({
      isVoluntary: String(isVol),
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
  await runWorkflow(separationsWorkflow, { docId });
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

  const now = new Date().toISOString();
  const items = docIds.map((id) => ({ docId: id }));
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
}
