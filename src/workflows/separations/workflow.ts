import type { Page, BrowserContext, Browser } from "playwright";
import { log, withLogContext } from "../../utils/log.js";
import { errorMessage } from "../../utils/errors.js";
import { launchBrowser } from "../../browser/launch.js";
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
} from "../../ucpath/index.js";
import type { JobSummaryData } from "../../ucpath/index.js";

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
  const { dryRun = false, keepOpen = false, existingWindows } = options;
  const extraWindows: BrowserWindow[] = []; // UCPath windows we launch and close

  // ─── Step 1: Launch + auth (or reuse existing) ───
  let kualiWin: BrowserWindow;
  let oldKronosWin: BrowserWindow;
  let newKronosWin: BrowserWindow;

  let ucpathWin: BrowserWindow;

  if (existingWindows) {
    log.step("=== Reusing existing browser windows ===");
    kualiWin = existingWindows.kuali;
    oldKronosWin = existingWindows.oldKronos;
    newKronosWin = existingWindows.newKronos;
    ucpathWin = existingWindows.ucpath;

    // Auto-dismiss PeopleSoft dialogs that may appear when navigating
    // away from a previous transaction (batch mode state cleanup)
    ucpathWin.page.on("dialog", (d) => d.accept().catch(() => {}));

    await openActionList(kualiWin.page);
    await clickDocument(kualiWin.page, docId);
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

    // ─── Auth Kuali (Duo #1) ───
    log.step("=== Auth Kuali (Duo #1) ===");
    const kualiAuth = await loginToKuali(kualiWin.page, KUALI_SPACE_URL);
    if (!kualiAuth) throw new Error("Kuali authentication failed");
    log.success("[Kuali] Authenticated");

    // ─── Extract Kuali ‖ Auth Old Kronos (Duo #2) ───
    log.step("=== Extract Kuali ‖ Auth Old Kronos (Duo #2) ===");
    {
      const [, kronosResult] = await Promise.allSettled([
        (async () => {
          await openActionList(kualiWin.page);
          await clickDocument(kualiWin.page, docId);
        })(),
        (async () => {
          log.waiting("[Old Kronos] Auth (Duo #2)...");
          await loginToUKG(oldKronosWin.page);
          log.success("[Old Kronos] Authenticated");
        })(),
      ]);
      if (kronosResult.status === "rejected") {
        log.error(`[Old Kronos] Auth failed: ${errorMessage(kronosResult.reason)}`);
      }
    }

    // ─── Auth New Kronos (Duo #3) ───
    log.step("=== Auth New Kronos (Duo #3) ===");
    await newKronosWin.page.goto(NEW_KRONOS_URL, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await loginToNewKronos(newKronosWin.page);
    log.success("[New Kronos] Authenticated");

    // ─── Auth UCPath (Duo #4) ───
    log.step("=== Auth UCPath (Duo #4) ===");
    await loginToUCPath(ucpathWin.page);
    log.success("[UCPath] Authenticated");
  }

  const makeSessionWindows = (): SessionWindows => ({
    kuali: kualiWin, oldKronos: oldKronosWin, newKronos: newKronosWin, ucpath: ucpathWin,
  });

  // ─── Extract Kuali data ───
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
  log.step(`Employee: ${kualiData.employeeName} | EID: ${kualiData.eid}`);
  log.step(`Type: ${kualiData.terminationType} (${isVol ? "VOL" : "INVOL"}) | Eff: ${termEffDate}`);

  if (dryRun) {
    return {
      data: { docId, ...kualiData, isVoluntary: isVol, terminationEffDate: termEffDate },
      windows: makeSessionWindows(),
    };
  }

  // ═══════════════════════════════════════════
  // PHASE 1: Kronos timecards (both in parallel)
  // ═══════════════════════════════════════════
  log.step("=== PHASE 1: Kronos timecards ===");

  // Reset Kronos browsers when reusing windows (batch mode) —
  // previous doc leaves them on the old employee's timecard page
  if (existingWindows) {
    log.step("[Batch] Resetting Kronos browsers for new employee...");
    await Promise.allSettled([
      goBackToOldKronosMain(oldKronosWin.page),
      newKronosWin.page.goto(NEW_KRONOS_URL, { waitUntil: "domcontentloaded", timeout: 30_000 }),
    ]);
  }

  const { startDate: kronosStart, endDate: kronosEnd } = computeKronosDateRange(
    kualiData.lastDayWorked, kualiData.separationDate,
  );
  log.step(`[Kronos] Date range: ${kronosStart} – ${kronosEnd}`);

  let oldKronosDate: string | null = null;
  let newKronosDate: string | null = null;
  let oldKronosFound = false;
  let newKronosFound = false;

  const [oldResult, newResult] = await Promise.allSettled([
    (async () => {
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
    })(),
    (async () => {
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
    })(),
  ]);

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

  log.step(`Kronos results — Old: ${oldKronosFound} (${oldKronosDate ?? "no time"}), New: ${newKronosFound} (${newKronosDate ?? "no time"})`);

  // ─── Resolve dates ───
  const resolved = resolveKronosDates(
    kualiData.lastDayWorked, kualiData.separationDate,
    oldKronosDate, newKronosDate,
  );

  const chosenDateSource = resolved.changed
    ? (oldKronosDate && newKronosDate
        ? (oldKronosDate >= newKronosDate ? "Old Kronos" : "New Kronos")
        : (oldKronosDate ? "Old Kronos" : "New Kronos"))
    : "Kuali (no change)";
  log.step(`Kronos dates: Old="${oldKronosDate || "none"}", New="${newKronosDate || "none"}" — using ${chosenDateSource}`);

  if (resolved.changed) {
    log.step("[Dates] Kronos dates differ — updating Kuali:");
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

  // ═══════════════════════════════════════════
  // PHASE 2: UCPath (Job Summary → Transaction)
  // ═══════════════════════════════════════════
  log.step("=== PHASE 2: UCPath Job Summary ===");

  let jobSummary: JobSummaryData | undefined;
  {
    const results = await Promise.allSettled([
      getJobSummaryData(ucpathWin.page, kualiData.eid),
      (async () => {
        log.step("[Kuali] Filling timekeeper + term date...");
        await fillTimekeeperTasks(kualiWin.page, timekeeperName);
        await kualiWin.page.getByRole("textbox", { name: "Termination Effective Date*" }).fill(finalTermEffDate, { timeout: 5_000 });
        log.success("[Kuali] Partial fill done");
      })(),
    ]);
    if (results[0].status === "fulfilled") {
      jobSummary = results[0].value;
    } else {
      log.error(`[UCPath Job Summary] Failed: ${errorMessage(results[0].reason)}`);
    }
  }

  if (jobSummary && (jobSummary.departmentDescription || jobSummary.jobCode)) {
    await fillFinalTransactions(kualiWin.page, {
      department: jobSummary.departmentDescription,
      payrollTitleCode: jobSummary.jobCode,
      payrollTitle: jobSummary.jobDescription,
    });
    log.success("[Kuali] Department + payroll filled");
  }

  // ─── UCPath Smart HR Transaction ───
  log.step("=== UCPath Smart HR Transaction ===");

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
  // Critical for batch mode: leaving the browser on a transaction info page causes
  // session conflicts when creating the next doc's transaction.
  try {
    await navigateToSmartHR(ucpathWin.page);
  } catch {
    // Non-fatal — next doc's navigateToSmartHR will retry
  }

  // ═══════════════════════════════════════════
  // PHASE 3: Kuali finalization + save
  // ═══════════════════════════════════════════
  log.step("=== PHASE 3: Kuali finalization ===");

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
  }); // end withLogContext
}
