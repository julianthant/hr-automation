import type { Page } from "playwright";
import { z } from "zod/v4";
import { log } from "../../utils/log.js";
import { errorMessage, classifyPlaywrightError } from "../../utils/errors.js";
import { defineWorkflow, runWorkflow, runWorkflowBatch } from "../../core/index.js";
import { trackEvent } from "../../tracker/jsonl.js";

// Auth wrappers — split into prepare (nav + fill) + submit (click + Duo)
// phases so Session.launch can pre-fill every SSO form in parallel before
// the serial Duo chain begins.
import {
  kualiNavigateAndFill,
  kualiSubmitAndWaitForDuo,
  ukgNavigateAndFill,
  ukgSubmitAndWaitForDuo,
  ucpathNavigateAndFill,
  ucpathSubmitAndWaitForDuo,
  newKronosNavigateAndFill,
  newKronosSubmitAndWaitForDuo,
} from "../../auth/login.js";

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
  verifyTxnNumberFilled,
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
  scrollNewKronosTimecardToDate,
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
  findExistingTerminationTransaction,
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
  validateLastDayWorked,
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
      prepareLogin: async (page) => {
        const prep = await kualiNavigateAndFill(page, KUALI_SPACE_URL);
        if (prep === false) throw new Error("Kuali prepareLogin failed");
      },
      login: async (page, instance) => {
        const ok = await kualiSubmitAndWaitForDuo(page, KUALI_SPACE_URL, instance);
        if (!ok) throw new Error("Kuali authentication failed");
      },
      resetUrl: KUALI_SPACE_URL,
    },
    {
      id: "old-kronos",
      prepareLogin: async (page) => {
        const prep = await ukgNavigateAndFill(page);
        if (prep === false) throw new Error("UKG prepareLogin failed");
      },
      login: async (page, instance) => {
        const ok = await ukgSubmitAndWaitForDuo(page, instance);
        if (!ok) throw new Error("Old Kronos (UKG) authentication failed");
      },
      sessionDir: getProcessIsolatedSessionDir(PATHS.ukgSessionSep),
    },
    {
      id: "new-kronos",
      prepareLogin: async (page) => {
        const prep = await newKronosNavigateAndFill(page);
        if (prep === false) throw new Error("New Kronos prepareLogin failed");
      },
      login: async (page, instance) => {
        const ok = await newKronosSubmitAndWaitForDuo(page, instance);
        if (!ok) throw new Error("New Kronos authentication failed");
      },
      resetUrl: NEW_KRONOS_URL,
    },
    {
      id: "ucpath",
      prepareLogin: async (page) => {
        const prep = await ucpathNavigateAndFill(page);
        if (!prep) throw new Error("UCPath prepareLogin failed");
      },
      login: async (page, instance) => {
        const ok = await ucpathSubmitAndWaitForDuo(page, instance);
        if (!ok) throw new Error("UCPath authentication failed");
      },
      resetUrl: UCPATH_SMART_HR_URL,
    },
  ],
  steps: separationsSteps,
  schema: SeparationInputSchema,
  authChain: "interleaved",
  batch: {
    mode: "sequential",
    betweenItems: ["reset-browsers"],
  },
  detailFields: [
    { key: "name",              label: "Employee",       editable: true  },
    { key: "eid",               label: "EID",            editable: true  },
    { key: "docId",             label: "Doc ID"                          },
    { key: "terminationType",   label: "Term Type"                       }, // computed (Vol/Invol) — display only
    { key: "rawTerminationType",label: "Reason",         editable: true  }, // raw Kuali type — drives reason-code mapping
    { key: "separationDate",    label: "Sep Date",       editable: true  },
    { key: "lastDayWorked",     label: "Last Day Worked", editable: true },
    { key: "transactionNumber", label: "Txn #"                           },
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
    //
    // Edit-and-resume bypass: if every required field is already in
    // ctx.data (the dashboard's "Run with these values" path pre-merges
    // them via the kernel's prefilledData channel), skip the extraction
    // step entirely and synthesize a kualiData object from those values.
    // The downstream code path is unchanged — it reads from kualiData,
    // which now mirrors what extraction would have returned.
    const requiredKualiFields = [
      "name",
      "eid",
      "rawTerminationType",
      "separationDate",
      "lastDayWorked",
    ] as const;
    const allPrefilled = requiredKualiFields.every(
      (k) => typeof ctx.data[k] === "string" && (ctx.data[k] as string).length > 0,
    );

    let kualiData: Awaited<ReturnType<typeof extractSeparationData>>;
    if (allPrefilled) {
      ctx.skipStep("kuali-extraction");
      log.step(
        `[Step: kuali-extraction] SKIPPED — using prefilled data ` +
        `(employeeName='${ctx.data.name}' eid='${ctx.data.eid}' ` +
        `rawTerminationType='${ctx.data.rawTerminationType}')`,
      );
      kualiData = {
        employeeName: ctx.data.name as string,
        eid: ctx.data.eid as string,
        terminationType: ctx.data.rawTerminationType as string,
        separationDate: ctx.data.separationDate as string,
        lastDayWorked: ctx.data.lastDayWorked as string,
        // `location` isn't read downstream — empty string is safe and keeps
        // the synthesized object structurally compatible with KualiSeparationData.
        location: "",
      };
    } else {
      kualiData = await ctx.step("kuali-extraction", async () => {
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
        // Write extracted fields onto the tracker row BEFORE the step returns.
        // Anything that throws downstream (validateLastDayWorked, Kronos, Kuali
        // finalize, etc.) still leaves a populated detail grid instead of a row
        // of em-dashes. `rawTerminationType` is the un-mapped Kuali string —
        // edit-and-resume needs it for `mapReasonCode()` on the bypass path.
        ctx.updateData({
          name: result.employeeName,
          eid: result.eid,
          rawTerminationType: result.terminationType,
          separationDate: result.separationDate,
          lastDayWorked: result.lastDayWorked,
          terminationType: isVoluntaryTermination(result.terminationType) ? "Vol" : "Invol",
        });
        log.step(
          `[Step: kuali-extraction] END took=${Date.now() - t0}ms `
          + `employeeName='${result.employeeName}' eid='${result.eid}' `
          + `lastDayWorked='${result.lastDayWorked}' separationDate='${result.separationDate}'`,
        );
        return result;
      });
    }

    // Preflight: reject future-dated separations so we don't waste Kronos/UCPath
    // work on a record that isn't yet actionable. Both Last Day Worked and
    // Separation Date are checked because either can be post-dated by the
    // requester.
    validateLastDayWorked(kualiData.lastDayWorked, "Last Day Worked");
    validateLastDayWorked(kualiData.separationDate, "Separation Date");

    const isVol = isVoluntaryTermination(kualiData.terminationType);
    const termEffDate = computeTerminationEffDate(kualiData.separationDate);
    const ucpathReason = mapReasonCode(kualiData.terminationType);
    const template = isVol ? UC_VOL_TERM_TEMPLATE : UC_INVOL_TERM_TEMPLATE;
    const timekeeperName = process.env.NAME ?? "";

    log.step(`Kuali extraction: Employee="${kualiData.employeeName}", EID="${kualiData.eid}", SepDate="${kualiData.separationDate}", Type="${kualiData.terminationType}"`);
    log.step(`Template: "${template}" — ${isVol ? "voluntary termination" : "involuntary termination"}`);
    log.step(`Reason code: Kuali type "${kualiData.terminationType}" → UCPath reason "${ucpathReason}"`);
    log.step(`Termination effective date: ${termEffDate} (separation date ${kualiData.separationDate} + 1 day)`);
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
          // Throws with a clear "verify EID in Kuali" message if Workforce
          // Job Summary returns no results. No cross-source fallbacks —
          // wrong EIDs get surfaced, not silently corrected.
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

    // Position the New Kronos timecard view so the chosen Last Day Worked
    // is the topmost visible row. Any error screenshot taken later in the
    // run (handler-throw in ucpath-transaction / kuali-finalization) will
    // then show the operator the chosen date + every row after it, so they
    // can verify "was there actually a later date that should have been
    // picked?" without opening the Kronos browser themselves. Best-effort —
    // a scroll failure here must not disrupt the rest of the run.
    try {
      const newKronosPage = await ctx.page("new-kronos");
      await scrollNewKronosTimecardToDate(newKronosPage, resolved.lastDayWorked);
    } catch { /* best-effort */ }

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

    await ctx.step("ucpath-transaction", async () => {
      const t0 = Date.now();
      log.debug(`[Step: ucpath-transaction] START empl='${kualiData.eid}' template='${template}'`);
      try {
        log.step("=== UCPath Smart HR Transaction ===");
        const ucpathPage = await ctx.page("ucpath");

        // Pre-submit existence check — match by EID (Person ID column) +
        // effective date + "Terminatn" action. Names are unreliable
        // (Kuali-vs-UCPath nickname/spelling/column-order variants cause
        // real dupes — EID 10794813 Aki Uchida, 2026-04-24); EID is
        // deterministic. If a row already exists, reuse its txn# and skip
        // the submit.
        const existingTxn = await findExistingTerminationTransaction(
          ucpathPage,
          kualiData.eid,
          finalTermEffDate,
        );
        if (existingTxn) {
          log.warn(`[UCPath Txn] Existing termination transaction #${existingTxn} found on Smart HR list — skipping submit.`);
          transactionNumber = existingTxn;
          // Persist the txn # immediately. If kuali-finalization throws
          // later, the handler exits before the final updateData at the end
          // of the body — without this inline call the dashboard detail
          // panel shows "—".
          ctx.updateData({ transactionNumber, existingTransactionFound: "true" });
          await ctx.screenshot({ kind: 'form', label: 'ucpath-transaction-existing' });
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

          const submitResult = await clickSaveAndSubmit(ucpathPage, frame, kualiData.eid);
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
          // Diagnostic capture for this soft-failure path. The handler
          // intentionally swallows the throw (kuali-finalization still runs
          // with an empty txn#), so the kernel's step-failure screenshot
          // never fires — explicit ctx.screenshot keeps the debug image
          // reachable from the dashboard Screenshots panel.
          await ctx.screenshot({ kind: "error", label: "ucpath-transaction-failed" });
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

      await verifyTxnNumberFilled(kualiPage, transactionNumber);
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
