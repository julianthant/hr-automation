import type { Page, BrowserContext, Browser } from "playwright";
import { log, withLogContext } from "../../utils/log.js";
import { errorMessage } from "../../utils/errors.js";
import { withTrackedWorkflow } from "../../tracker/jsonl.js";
import { launchBrowser } from "../../browser/launch.js";
import { loginToKuali, loginToUKG, loginToUCPath, loginToNewKronos } from "../../auth/login.js";
import { ensurePageHealthy } from "../../core/page-health.js";

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
} from "../../kuali/index.js";
import type { KualiSeparationData } from "../../kuali/index.js";

// Old Kronos module
import {
  getGeniesIframe,
  searchEmployee as searchOldKronos,
  clickEmployeeRow,
  dismissModal,
  setDateRange as setOldKronosDateRange,
  clickGoToTimecard as clickOldKronosGoToTimecard,
  getTimecardLastDate as getOldKronosTimecardLastDate,
  goBackToMain as goBackToOldKronosMain,
} from "../../old-kronos/index.js";

// New Kronos module
import {
  searchEmployee as searchNewKronos,
  selectEmployeeResult as selectNewKronosResult,
  clickGoToTimecard as clickNewKronosGoToTimecard,
  setDateRange as setNewKronosDateRange,
  getTimecardLastDate as getNewKronosTimecardLastDate,
  NEW_KRONOS_URL,
} from "../../new-kronos/index.js";

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
import type { SeparationData } from "./schema.js";
import {
  KUALI_SPACE_URL,
  UC_VOL_TERM_TEMPLATE,
  UC_INVOL_TERM_TEMPLATE,
} from "./config.js";
import { PATHS } from "../../config.js";
import { computeTileLayout } from "../../browser/tiling.js";

export interface SeparationOptions {
  dryRun?: boolean;
  keepOpen?: boolean;
  existingWindows?: SessionWindows;
  /** Pre-assigned runId from batch mode — skips pending emit in withTrackedWorkflow. */
  runId?: string;
}

export interface SessionWindows {
  kuali: BrowserWindow;
  oldKronos: BrowserWindow;
  newKronos: BrowserWindow;
  ucpath: BrowserWindow;
}

interface BrowserWindow {
  browser: Browser | null;
  context: BrowserContext;
  page: Page;
}

// ─── Helpers ───

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

async function closeBrowserWindow(win: BrowserWindow): Promise<void> {
  try {
    if (win.browser) await win.browser.close();
    else await win.context.close();
  } catch { /* ignore */ }
}

export interface SeparationResult {
  data: SeparationData;
  windows: SessionWindows;
}

/**
 * Run the full separation workflow for a single document.
 *
 * Only 1 UCPath browser at a time — avoids SSO session conflicts.
 * When existingWindows is provided, skips launch/auth for Kuali, Old Kronos, New Kronos.
 */
export async function runSeparation(
  docId: string,
  options: SeparationOptions = {},
): Promise<SeparationResult> {
  return withLogContext("separations", docId, async () => {
  return withTrackedWorkflow("separations", docId, {}, async (setStep, updateData, onCleanup, session) => {
  const { dryRun = false, keepOpen = false, existingWindows } = options;
  const extraWindows: BrowserWindow[] = []; // UCPath windows we launch and close
  const allWindows: BrowserWindow[] = []; // tracked for batch reuse

  // ─── Step 1: Launch + auth (or reuse existing) ───
  let kualiWin: BrowserWindow;
  let oldKronosWin: BrowserWindow;
  let newKronosWin: BrowserWindow;
  let ucpathWin: BrowserWindow;

  // Auth-ready promises — each resolves when its browser is ready for work.
  // Batch mode: all resolve immediately (browsers already authed).
  // Fresh mode: each resolves after its Duo MFA completes, allowing work tasks
  // to start as soon as their individual auth clears (not waiting for all 4).
  let oldKronosReady: Promise<void> = Promise.resolve();
  let newKronosReady: Promise<void> = Promise.resolve();
  let ucpathReady: Promise<void> = Promise.resolve();

  setStep("launching");
  if (existingWindows) {
    log.step("=== Reusing existing browser windows ===");
    kualiWin = existingWindows.kuali;
    oldKronosWin = existingWindows.oldKronos;
    newKronosWin = existingWindows.newKronos;
    ucpathWin = existingWindows.ucpath;
    allWindows.push(kualiWin, oldKronosWin, newKronosWin, ucpathWin);

    // Auto-dismiss PeopleSoft dialogs that may appear when navigating
    // away from a previous transaction (batch mode state cleanup)
    ucpathWin.page.on("dialog", (d) => d.accept().catch(() => {}));

    await openActionList(kualiWin.page);
    await clickDocument(kualiWin.page, docId);
    // Ready promises stay as Promise.resolve() — browsers already authed
  } else {
    log.step("=== Step 1: Launch 4 browsers ===");

    const wins = await Promise.all([
      launchBrowser(computeTileLayout(0, 4)),
      launchBrowser({ ...computeTileLayout(1, 4), sessionDir: PATHS.ukgSessionSep }),
      launchBrowser(computeTileLayout(2, 4)),
      launchBrowser(computeTileLayout(3, 4)),
    ]);

    kualiWin = wins[0];
    oldKronosWin = wins[1];
    newKronosWin = wins[2];
    ucpathWin = wins[3];
    allWindows.push(...wins);

    // ─── Auth Kuali (Duo #1) — must complete before anything else ───
    setStep("authenticating");
    log.step("=== Auth Kuali (Duo #1) ===");
    const kualiAuth = await loginToKuali(kualiWin.page, KUALI_SPACE_URL);
    if (!kualiAuth) throw new Error("Kuali authentication failed");
    log.success("[Kuali] Authenticated");

    // ─── Kuali nav ‖ Auth Old Kronos (Duo #2) ───
    // Both run in parallel. Old Kronos auth becomes a ready promise.
    log.step("=== Kuali nav ‖ Auth Old Kronos (Duo #2) ===");
    oldKronosReady = (async () => {
      log.waiting("[Old Kronos] Auth (Duo #2)...");
      await loginToUKG(oldKronosWin.page);
      log.success("[Old Kronos] Authenticated");
    })();

    await Promise.allSettled([
      (async () => {
        await openActionList(kualiWin.page);
        await clickDocument(kualiWin.page, docId);
      })(),
      oldKronosReady,
    ]);

    // ─── Auth chain continues in background ───
    // Each browser starts its work immediately after its own Duo clears.
    // Don't await — extraction proceeds while user approves remaining Duos.
    // .catch() on each step prevents one auth failure from blocking the chain.
    newKronosReady = oldKronosReady
      .catch(() => {})
      .then(async () => {
        log.step("=== Auth New Kronos (Duo #3) ===");
        await newKronosWin.page.goto(NEW_KRONOS_URL, { waitUntil: "domcontentloaded", timeout: 30_000 });
        await loginToNewKronos(newKronosWin.page);
        log.success("[New Kronos] Authenticated");
      });

    ucpathReady = newKronosReady
      .catch(() => {})
      .then(async () => {
        log.step("=== Auth UCPath (Duo #4) ===");
        await loginToUCPath(ucpathWin.page);
        log.success("[UCPath] Authenticated");
      });

    // Prevent unhandled rejection if workflow exits before Phase 1 consumes these
    ucpathReady.catch(() => {});
  }

  const makeSessionWindows = (): SessionWindows => ({
    kuali: kualiWin, oldKronos: oldKronosWin, newKronos: newKronosWin, ucpath: ucpathWin,
  });

  // ─── Extract Kuali data ───
  setStep("kuali-extraction");
  await ensurePageHealthy(kualiWin.page, undefined, "[Kuali]");
  const kualiData = await extractSeparationData(kualiWin.page);

  const isVol = isVoluntaryTermination(kualiData.terminationType);
  const termEffDate = computeTerminationEffDate(kualiData.separationDate);
  const ucpathReason = mapReasonCode(kualiData.terminationType);
  const template = isVol ? UC_VOL_TERM_TEMPLATE : UC_INVOL_TERM_TEMPLATE;
  const timekeeperName = process.env.NAME ?? "";

  log.step(`Kuali extraction: Employee="${kualiData.employeeName}", EID="${kualiData.eid}", SepDate="${kualiData.separationDate}", Type="${kualiData.terminationType}"`);
  log.step(`Template: "${template}" — ${isVol ? "voluntary termination" : "involuntary termination"}`);
  log.step(`Reason code: Kuali type "${kualiData.terminationType}" → UCPath reason "${ucpathReason}"`);
  log.step(`Termination effective date: ${termEffDate} (separation date ${kualiData.separationDate} + 1 day)`);
  updateData({ name: kualiData.employeeName, eid: kualiData.eid });
  log.step(`Employee: ${kualiData.employeeName} | EID: ${kualiData.eid}`);
  log.step(`Type: ${kualiData.terminationType} (${isVol ? "VOL" : "INVOL"}) | Eff: ${termEffDate}`);

  if (dryRun) {
    return {
      data: { docId, ...kualiData, isVoluntary: isVol, terminationEffDate: termEffDate },
      windows: makeSessionWindows(),
    };
  }

  // ═══════════════════════════════════════════
  // PHASE 1: Kronos + Job Summary + Kuali fill (parallel)
  // All 4 tasks use separate browser windows — no conflicts.
  // Job Summary only needs EID (from Kuali extraction).
  // Kuali timekeeper fill touches different form fields than date updates.
  // ═══════════════════════════════════════════
  setStep("kronos-search");
  log.step("=== PHASE 1: Kronos + Job Summary + Kuali fill (parallel) ===");

  // Batch mode: health check + reset (browsers already authed, may have stale state).
  // Fresh mode: skip — browsers are being authed in background via ready promises.
  if (existingWindows) {
    await Promise.allSettled([
      ensurePageHealthy(oldKronosWin.page, undefined, "[Old Kronos]"),
      ensurePageHealthy(newKronosWin.page, NEW_KRONOS_URL, "[New Kronos]"),
      ensurePageHealthy(ucpathWin.page, undefined, "[UCPath]"),
    ]);
    log.step("[Batch] Resetting Old Kronos + New Kronos browsers for new employee...");
    await Promise.allSettled([
      goBackToOldKronosMain(oldKronosWin.page),
      newKronosWin.page.goto(NEW_KRONOS_URL, { waitUntil: "domcontentloaded", timeout: 30_000 }),
    ]);
  }

  const { startDate: kronosStart, endDate: kronosEnd } = computeKronosDateRange(
    kualiData.lastDayWorked, kualiData.separationDate,
  );
  log.step(`[Old Kronos / New Kronos] Date range: ${kronosStart} – ${kronosEnd}`);

  let oldKronosDate: string | null = null;
  let newKronosDate: string | null = null;
  let oldKronosFound = false;
  let newKronosFound = false;
  let jobSummary: JobSummaryData | undefined;

  // Each work task awaits its own auth-ready promise before starting.
  // Batch mode: promises already resolved → work starts immediately.
  // Fresh mode: each task starts as soon as its Duo MFA clears — Old Kronos
  // work begins while user is still approving New Kronos/UCPath on their phone.
  const [oldResult, newResult, jobSummaryResult] = await Promise.allSettled([
    oldKronosReady.then(async () => {
      // Old Kronos: set date range FIRST, then search by ID
      const iframe = await getGeniesIframe(oldKronosWin.page);
      await dismissModal(oldKronosWin.page, iframe);
      await setOldKronosDateRange(oldKronosWin.page, iframe, kronosStart, kronosEnd);
      await searchOldKronos(oldKronosWin.page, iframe, kualiData.eid);
      await oldKronosWin.page.waitForTimeout(3_000);
      const found = await checkOldKronosResult(oldKronosWin.page);
      log.step(`[Old Kronos] EID ${kualiData.eid}: ${found ? "FOUND" : "NOT FOUND"}`);
      if (!found) return { found: false, date: null };
      await clickEmployeeRow(oldKronosWin.page, iframe, kualiData.eid);
      // Go to timecard — date range already set, no pay period switching needed
      const okTimecard = await clickOldKronosGoToTimecard(oldKronosWin.page, iframe);
      if (!okTimecard) return { found: true, date: null };
      await oldKronosWin.page.waitForTimeout(3_000);
      await dismissModal(oldKronosWin.page, iframe);
      const date = await getOldKronosTimecardLastDate(oldKronosWin.page, iframe);
      return { found: true, date };
    }),
    newKronosReady.then(async () => {
      // New Kronos: search by ID first, then go to timecard, then set date range
      const found = await searchNewKronos(newKronosWin.page, kualiData.eid);
      log.step(`[New Kronos] EID ${kualiData.eid}: ${found ? "FOUND" : "NOT FOUND"}`);
      if (!found) return { found: false, date: null };
      await selectNewKronosResult(newKronosWin.page);
      const okTimecard = await clickNewKronosGoToTimecard(newKronosWin.page);
      if (!okTimecard) return { found: true, date: null };
      await newKronosWin.page.waitForTimeout(3_000);
      await setNewKronosDateRange(newKronosWin.page, kronosStart, kronosEnd);
      const date = await getNewKronosTimecardLastDate(newKronosWin.page);
      return { found: true, date };
    }),
    ucpathReady.then(async () => {
      // UCPath Job Summary — only needs EID, no dependency on Kronos results
      log.step("[UCPath] Starting Job Summary lookup...");
      return getJobSummaryData(ucpathWin.page, kualiData.eid);
    }),
    (async () => {
      // Kuali timekeeper name fill — already authed, starts immediately
      log.step("[Kuali] Filling timekeeper name...");
      await fillTimekeeperTasks(kualiWin.page, timekeeperName);
      log.success("[Kuali] Timekeeper name filled");
    })(),
  ]);

  // ─── Process Kronos results ───
  if (oldResult.status === "fulfilled") {
    oldKronosFound = oldResult.value.found;
    oldKronosDate = oldResult.value.date;
  } else {
    log.error(`[Old Kronos] Error: ${errorMessage(oldResult.reason)}`);
  }
  if (newResult.status === "fulfilled") {
    newKronosFound = newResult.value.found;
    newKronosDate = newResult.value.date;
  } else {
    log.error(`[New Kronos] Error: ${errorMessage(newResult.reason)}`);
  }

  log.step(`[Old Kronos] ${oldKronosFound ? "Found" : "Not found"} (${oldKronosDate ?? "no time"})`);
  log.step(`[New Kronos] ${newKronosFound ? "Found" : "Not found"} (${newKronosDate ?? "no time"})`);

  // ─── Process Job Summary result ───
  if (jobSummaryResult.status === "fulfilled") {
    jobSummary = jobSummaryResult.value;
  } else {
    log.error(`[UCPath Job Summary] Failed: ${errorMessage(jobSummaryResult.reason)}`);
  }

  // ─── Resolve Kronos dates ───
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

  if (resolved.changed) {
    log.step("[Old Kronos / New Kronos] Dates differ from Kuali — updating:");
    if (resolved.lastDayWorked !== kualiData.lastDayWorked) {
      log.step(`  Last Day Worked: ${kualiData.lastDayWorked} → ${resolved.lastDayWorked}`);
      await updateLastDayWorked(kualiWin.page, resolved.lastDayWorked);
    }
    if (resolved.separationDate !== kualiData.separationDate) {
      log.step(`  Separation Date: ${kualiData.separationDate} → ${resolved.separationDate}`);
      await updateSeparationDate(kualiWin.page, resolved.separationDate);
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

  // ─── Fill remaining Kuali fields (term date + department/payroll) ───
  // Term date depends on Kronos date resolution; department depends on Job Summary.
  // Both are now available after the parallel block above.
  setStep("ucpath-job-summary");
  log.step("[Kuali] Filling termination effective date + department/payroll...");
  await kualiWin.page.getByRole("textbox", { name: "Termination Effective Date*" }).fill(finalTermEffDate, { timeout: 5_000 });

  if (jobSummary && (jobSummary.departmentDescription || jobSummary.jobCode)) {
    await fillFinalTransactions(kualiWin.page, {
      department: jobSummary.departmentDescription,
      payrollTitleCode: jobSummary.jobCode,
      payrollTitle: jobSummary.jobDescription,
    });
    log.success("[Kuali] Department + payroll filled");
  }

  // ���── UCPath Smart HR Transaction ───
  setStep("ucpath-transaction");
  log.step("=== UCPath Smart HR Transaction ===");
  await ensurePageHealthy(ucpathWin.page, undefined, "[UCPath]");

  // Navigate UCPath to Smart HR (reuse same browser)
  let transactionNumber = "";
  try {
    await navigateToSmartHR(ucpathWin.page);
    await clickSmartHRTransactions(ucpathWin.page);

    const frame = getContentFrame(ucpathWin.page);
    await selectTemplate(frame, template);
    await enterEffectiveDate(frame, finalTermEffDate);

    const createResult = await clickCreateTransaction(ucpathWin.page, frame);
    if (!createResult.success) {
      log.error(`[UCPath Txn] Create failed: ${createResult.error}`);
    } else {
      log.step("[UCPath Txn] Filling Empl ID...");
      await frame.getByRole("textbox", { name: "Empl ID" }).fill(kualiData.eid, { timeout: 10_000 });
      await selectReasonCode(ucpathWin.page, frame, ucpathReason);
      await fillComments(frame, finalComments);

      // Convert "Last, First" to "First Last" for UCPath name matching
      const nameParts = kualiData.employeeName.split(",").map(s => s.trim());
      const ucpathName = nameParts.length >= 2 ? `${nameParts[1]} ${nameParts[0]}` : kualiData.employeeName;
      const submitResult = await clickSaveAndSubmit(ucpathWin.page, frame, ucpathName);
      if (!submitResult.success) {
        log.error(`[UCPath Txn] Submit failed: ${submitResult.error}`);
      } else {
        transactionNumber = submitResult.transactionNumber ?? "";
        log.success(`[UCPath Txn] Transaction submitted${transactionNumber ? ` (#${transactionNumber})` : ""}`);
      }
    }
  } catch (e) {
    log.error(`[UCPath Txn] Failed: ${errorMessage(e)}`);
  }

  // Navigate UCPath back to Smart HR base URL to reset PeopleSoft session state.
  // Only needed in batch mode: leaving the browser on a transaction info page causes
  // session conflicts when creating the next doc's transaction.
  if (existingWindows) {
    try {
      await navigateToSmartHR(ucpathWin.page);
    } catch {
      // Non-fatal — next doc's navigateToSmartHR will retry
    }
  }

  // ═══════════════════════════════════════════
  // PHASE 3: Kuali finalization + save
  // ═══════════════════════════════════════════
  setStep("kuali-finalization");
  log.step("=== PHASE 3: Kuali finalization ===");
  await ensurePageHealthy(kualiWin.page, undefined, "[Kuali]");

  // Always fill checkbox + radio; fill txn number if we have it
  await fillTransactionResults(kualiWin.page, transactionNumber);
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
    await fillTimekeeperComments(kualiWin.page, dateChangeComments);
  }

  await clickSave(kualiWin.page);

  const separationData: SeparationData = {
    docId,
    ...kualiData,
    isVoluntary: isVol,
    terminationEffDate: finalTermEffDate,
    deptId: jobSummary?.deptId,
    departmentDescription: jobSummary?.departmentDescription,
    jobCode: jobSummary?.jobCode,
    jobDescription: jobSummary?.jobDescription,
    foundInOldKronos: oldKronosFound,
    foundInNewKronos: newKronosFound,
    transactionNumber: transactionNumber || undefined,
  };

  log.success(`=== Separation complete for doc #${docId} ===`);
  return { data: separationData, windows: makeSessionWindows() };
  }, options.runId); // end withTrackedWorkflow
  }); // end withLogContext
}
