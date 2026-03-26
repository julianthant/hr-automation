import type { Page, BrowserContext, Browser } from "playwright";
import { log } from "../../utils/log.js";
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
} from "../../kuali/index.js";
import type { KualiSeparationData } from "../../kuali/index.js";

// Old Kronos module
import {
  getGeniesIframe,
  searchEmployee as searchOldKronos,
  dismissModal,
} from "../../old-kronos/index.js";

// New Kronos module
import {
  searchEmployee as searchNewKronos,
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
  buildTerminationComments,
  mapReasonCode,
  getInitials,
} from "./schema.js";
import type { SeparationData } from "./schema.js";
import {
  KUALI_SPACE_URL,
  UC_VOL_TERM_TEMPLATE,
  UC_INVOL_TERM_TEMPLATE,
  SCREEN_WIDTH,
  SCREEN_HEIGHT,
} from "./config.js";

// ─── Direct URLs (prefer URL nav over clicking) ───

/** Workforce Job Summary — skip sidebar, go direct. */
const JOB_SUMMARY_URL =
  "https://ucphrprdpub.universityofcalifornia.edu/psc/ucphrprd/EMPLOYEE/HRMS/c/ADMINISTER_WORKFORCE_(GBL).WF_JOB_SUMMARY.GBL";

export interface SeparationOptions {
  dryRun?: boolean;
  keepOpen?: boolean;
  existingWindows?: AuthenticatedWindows;
}

export interface AuthenticatedWindows {
  kuali: Page;
  oldKronos: Page;
  newKronos: Page;
  ucpathJobSummary: Page;
  ucpathTransaction: Page;
  browsers: BrowserWindow[];
}

interface BrowserWindow {
  browser: Browser | null;
  context: BrowserContext;
  page: Page;
}

// ─── Window tiling ───

function getTileArgs(index: number) {
  const W = SCREEN_WIDTH;
  const H = SCREEN_HEIGHT;
  const topW = Math.floor(W / 3);
  const topH = Math.floor(H / 2);
  const botW = Math.floor(W / 2);
  const botH = Math.floor(H / 2);

  const positions = [
    { x: 0, y: 0, w: topW, h: topH },           // 0: Kuali
    { x: topW, y: 0, w: topW, h: topH },         // 1: Old Kronos
    { x: topW * 2, y: 0, w: topW, h: topH },     // 2: New Kronos
    { x: 0, y: topH, w: botW, h: botH },         // 3: UCPath Txn (prioritized)
    { x: botW, y: topH, w: botW, h: botH },      // 4: UCPath Job Summary
  ];

  const p = positions[index];
  return {
    viewport: { width: p.w - 20, height: p.h - 80 },
    args: [`--window-position=${p.x},${p.y}`, `--window-size=${p.w},${p.h}`],
  };
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

export async function closeAllWindows(windows: AuthenticatedWindows): Promise<void> {
  log.step("Closing browser windows...");
  for (const win of windows.browsers) {
    try {
      if (win.browser) await win.browser.close();
      else await win.context.close();
    } catch { /* ignore */ }
  }
}

/**
 * Run the full separation workflow for a single document.
 *
 * Optimized pipeline — 1 Duo at a time, max parallelism:
 *
 * Step 1: Launch 5 browsers (tiled)
 * Step 2: Auth Kuali (Duo #1)
 * Step 3: Extract Kuali ‖ Auth Old Kronos (Duo #2)
 * Step 4: Search Old Kronos ‖ Auth New Kronos (Duo #3)
 * Step 5: Search New Kronos ‖ Auth UCPath Txn (Duo #4) — PRIORITIZED
 * Step 6: UCPath Smart HR Txn + Kuali partial fill ‖ Auth UCPath Job (Duo #5)
 * Step 7: UCPath Job Summary → fill remaining Kuali fields (dept, payroll)
 */
export async function runSeparation(
  docId: string,
  options: SeparationOptions = {},
): Promise<SeparationData> {
  const { dryRun = false, keepOpen = false } = options;
  let windows = options.existingWindows;
  const ownedWindows = !windows;

  try {
    if (!windows) {
      // ─── Step 1: Launch all 5 browsers tiled ───
      log.step("=== Step 1: Launch 5 browsers ===");

      const [kualiWin, oldKronosWin, newKronosWin, ucpathTxnWin, ucpathJobWin] =
        await Promise.all([
          launchBrowser(getTileArgs(0)),
          launchBrowser({ ...getTileArgs(1), sessionDir: "C:\\Users\\juzaw\\ukg_session_sep" }),
          launchBrowser(getTileArgs(2)),
          launchBrowser(getTileArgs(3)),
          launchBrowser(getTileArgs(4)),
        ]);

      windows = {
        kuali: kualiWin.page,
        oldKronos: oldKronosWin.page,
        newKronos: newKronosWin.page,
        ucpathTransaction: ucpathTxnWin.page,
        ucpathJobSummary: ucpathJobWin.page,
        browsers: [kualiWin, oldKronosWin, newKronosWin, ucpathTxnWin, ucpathJobWin],
      };

      // ─── Step 2: Auth Kuali (Duo #1) ───
      log.step("=== Step 2: Auth Kuali (Duo #1) ===");
      await loginToKuali(windows.kuali, KUALI_SPACE_URL);
      log.success("[Kuali] Authenticated");
    }

    // ─── Step 3: Extract Kuali ‖ Auth Old Kronos (Duo #2) ───
    log.step("=== Step 3: Extract Kuali ‖ Auth Old Kronos ===");

    let kualiData!: KualiSeparationData;
    {
      const [extractResult] = await Promise.allSettled([
        (async () => {
          await openActionList(windows!.kuali);
          await clickDocument(windows!.kuali, docId);
          return extractSeparationData(windows!.kuali);
        })(),
        (async () => {
          log.waiting("[Old Kronos] Auth (Duo #2)...");
          await loginToUKG(windows!.oldKronos);
          log.success("[Old Kronos] Authenticated");
        })(),
      ]);
      if (extractResult.status === "rejected") {
        throw new Error(`Kuali extraction failed: ${errorMessage(extractResult.reason)}`);
      }
      kualiData = extractResult.value;
    }

    const isVol = isVoluntaryTermination(kualiData.terminationType);
    const termEffDate = computeTerminationEffDate(kualiData.separationDate);
    const comments = buildTerminationComments(termEffDate, kualiData.lastDayWorked, docId);
    const ucpathReason = mapReasonCode(kualiData.terminationType);
    const template = isVol ? UC_VOL_TERM_TEMPLATE : UC_INVOL_TERM_TEMPLATE;
    const timekeeperName = process.env.NAME ?? "";

    log.step(`Employee: ${kualiData.employeeName} | EID: ${kualiData.eid}`);
    log.step(`Type: ${kualiData.terminationType} (${isVol ? "VOL" : "INVOL"}) | Eff: ${termEffDate}`);

    if (dryRun) {
      log.step("=== DRY RUN ===");
      log.step(`  Doc: ${docId} | Name: ${kualiData.employeeName} | EID: ${kualiData.eid}`);
      log.step(`  Last Day: ${kualiData.lastDayWorked} | Sep Date: ${kualiData.separationDate}`);
      log.step(`  Type: ${kualiData.terminationType} | Vol: ${isVol} | Eff: ${termEffDate}`);
      return { docId, ...kualiData, isVoluntary: isVol, terminationEffDate: termEffDate };
    }

    // ─── Step 4: Search Old Kronos ‖ Auth New Kronos (Duo #3) ───
    log.step("=== Step 4: Search Old Kronos ‖ Auth New Kronos ===");

    let oldKronosFound = false;
    {
      const [searchResult] = await Promise.allSettled([
        (async () => {
          const iframe = await getGeniesIframe(windows!.oldKronos);
          await dismissModal(windows!.oldKronos, iframe);
          await searchOldKronos(windows!.oldKronos, iframe, kualiData.eid);
          await windows!.oldKronos.waitForTimeout(3_000);
          const found = await checkOldKronosResult(windows!.oldKronos);
          log.step(`[Old Kronos] EID ${kualiData.eid}: ${found ? "FOUND" : "NOT FOUND"}`);
          return found;
        })(),
        (async () => {
          log.waiting("[New Kronos] Auth (Duo #3)...");
          await windows!.newKronos.goto(NEW_KRONOS_URL, { waitUntil: "domcontentloaded", timeout: 30_000 });
          await loginToNewKronos(windows!.newKronos);
          log.success("[New Kronos] Authenticated");
        })(),
      ]);
      oldKronosFound = searchResult.status === "fulfilled" ? searchResult.value : false;
    }

    // ─── Step 5: Search New Kronos ‖ Auth UCPath Txn (Duo #4) — PRIORITIZED ───
    log.step("=== Step 5: Search New Kronos ‖ Auth UCPath Txn ===");

    let newKronosFound = false;
    {
      const [searchResult] = await Promise.allSettled([
        (async () => {
          const found = await searchNewKronos(windows!.newKronos, kualiData.eid);
          log.step(`[New Kronos] EID ${kualiData.eid}: ${found ? "FOUND" : "NOT FOUND"}`);
          return found;
        })(),
        (async () => {
          log.waiting("[UCPath Txn] Auth (Duo #4)...");
          await loginToUCPath(windows!.ucpathTransaction);
          log.success("[UCPath Txn] Authenticated");
        })(),
      ]);
      newKronosFound = searchResult.status === "fulfilled" ? searchResult.value : false;
    }

    log.step(`Kronos results — Old: ${oldKronosFound}, New: ${newKronosFound}`);

    // ─── Step 6: UCPath Txn + Kuali partial fill ‖ Auth UCPath Job (Duo #5) ───
    log.step("=== Step 6: UCPath Txn + Kuali fill ‖ Auth UCPath Job ===");

    let transactionNumber = "";
    {
      const results = await Promise.allSettled([
        // UCPath Smart HR Transaction — fill + submit
        (async () => {
          log.step("[UCPath Txn] Starting Smart HR Transaction...");
          await navigateToSmartHR(windows!.ucpathTransaction);
          await clickSmartHRTransactions(windows!.ucpathTransaction);

          const frame = getContentFrame(windows!.ucpathTransaction);
          await selectTemplate(frame, template);
          await enterEffectiveDate(frame, termEffDate);

          const createResult = await clickCreateTransaction(windows!.ucpathTransaction, frame);
          if (!createResult.success) {
            log.error(`[UCPath Txn] Create failed: ${createResult.error}`);
            return "";
          }

          log.step("[UCPath Txn] Filling Empl ID...");
          await frame.getByRole("textbox", { name: "Empl ID" }).fill(kualiData.eid, { timeout: 10_000 });

          await selectReasonCode(windows!.ucpathTransaction, frame, ucpathReason);
          await fillComments(frame, comments);

          // Save and Submit
          const submitResult = await clickSaveAndSubmit(windows!.ucpathTransaction, frame);
          if (!submitResult.success) {
            log.error(`[UCPath Txn] Submit failed: ${submitResult.error}`);
            return "";
          }

          log.success(`[UCPath Txn] Transaction submitted${submitResult.transactionNumber ? ` (#${submitResult.transactionNumber})` : ""}`);
          return submitResult.transactionNumber ?? "";
        })(),

        // Kuali partial fill (timekeeper, term eff date, acknowledged)
        (async () => {
          log.step("[Kuali] Filling timekeeper + term date...");
          await fillTimekeeperTasks(windows!.kuali, timekeeperName);
          const termDateInput = windows!.kuali.getByRole("textbox", { name: "Termination Effective Date*" });
          await termDateInput.fill(termEffDate, { timeout: 5_000 });
          log.success("[Kuali] Partial fill done (timekeeper + term date)");
        })(),

        // Auth UCPath Job Summary (Duo #5)
        (async () => {
          log.waiting("[UCPath Job] Auth (Duo #5)...");
          await loginToUCPath(windows!.ucpathJobSummary);
          log.success("[UCPath Job] Authenticated");
        })(),
      ]);

      // Extract transaction number from the UCPath result
      if (results[0].status === "fulfilled") {
        transactionNumber = results[0].value as string;
      }
    }

    // ─── Step 7: UCPath Job Summary → fill remaining Kuali fields ───
    log.step("=== Step 7: Job Summary → fill Kuali dept/payroll ===");

    let jobSummary: JobSummaryData | undefined;
    try {
      jobSummary = await getJobSummaryData(windows.ucpathJobSummary, kualiData.eid);
    } catch (e) {
      log.error(`[UCPath Job] Failed: ${errorMessage(e)}`);
    }

    // Fill remaining Kuali fields (dept, payroll, transaction results)
    if (jobSummary && (jobSummary.departmentDescription || jobSummary.jobCode)) {
      log.step("[Kuali] Filling department + payroll from Job Summary...");
      await fillFinalTransactions(windows.kuali, {
        department: jobSummary.departmentDescription,
        payrollTitleCode: jobSummary.jobCode,
        payrollTitle: jobSummary.jobDescription,
      });
      log.success("[Kuali] Department + payroll filled");
    } else {
      log.error("[Kuali] No Job Summary data — dept/payroll left empty");
    }

    // ─── Step 8: Fill Kuali transaction results ───
    log.step("=== Step 8: Fill Kuali transaction results ===");

    if (transactionNumber) {
      await fillTransactionResults(windows.kuali, transactionNumber);
    } else {
      log.error("[Kuali] No transaction number — skipping transaction results");
    }

    // Fill date change comments if applicable
    const initials = getInitials(timekeeperName);
    // For now, no date changes detected — this will be used when Kronos dates differ
    // Example: buildDateChangeComments(original, new, original, new, initials)

    const separationData: SeparationData = {
      docId,
      ...kualiData,
      isVoluntary: isVol,
      terminationEffDate: termEffDate,
      deptId: jobSummary?.deptId,
      departmentDescription: jobSummary?.departmentDescription,
      jobCode: jobSummary?.jobCode,
      jobDescription: jobSummary?.jobDescription,
      foundInOldKronos: oldKronosFound,
      foundInNewKronos: newKronosFound,
      transactionNumber: transactionNumber || undefined,
    };

    log.success(`=== Separation complete for doc #${docId} ===`);
    return separationData;
  } finally {
    if (ownedWindows && !keepOpen && windows) {
      await closeAllWindows(windows);
    }
  }
}

/**
 * Pre-authenticate all windows for batch mode.
 */
export async function launchAllWindows(): Promise<AuthenticatedWindows> {
  log.step("=== Pre-authenticating all windows for batch ===");

  const [kualiWin, oldKronosWin, newKronosWin, ucpathTxnWin, ucpathJobWin] =
    await Promise.all([
      launchBrowser(getTileArgs(0)),
      launchBrowser({ ...getTileArgs(1), sessionDir: "C:\\Users\\juzaw\\ukg_session_sep" }),
      launchBrowser(getTileArgs(2)),
      launchBrowser(getTileArgs(3)),
      launchBrowser(getTileArgs(4)),
    ]);

  const browsers: BrowserWindow[] = [kualiWin, oldKronosWin, newKronosWin, ucpathTxnWin, ucpathJobWin];

  // Sequential auth — one Duo at a time
  await loginToKuali(kualiWin.page, KUALI_SPACE_URL);
  log.success("[Kuali] Authenticated");

  await loginToUKG(oldKronosWin.page);
  log.success("[Old Kronos] Authenticated");

  await newKronosWin.page.goto(NEW_KRONOS_URL, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await loginToNewKronos(newKronosWin.page);
  log.success("[New Kronos] Authenticated");

  await loginToUCPath(ucpathTxnWin.page);
  log.success("[UCPath Txn] Authenticated");

  await loginToUCPath(ucpathJobWin.page);
  log.success("[UCPath Job] Authenticated");

  return {
    kuali: kualiWin.page,
    oldKronos: oldKronosWin.page,
    newKronos: newKronosWin.page,
    ucpathTransaction: ucpathTxnWin.page,
    ucpathJobSummary: ucpathJobWin.page,
    browsers,
  };
}
