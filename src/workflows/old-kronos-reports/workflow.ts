import type { Page, Frame } from "playwright";
import type { Mutex } from "async-mutex";
import { existsSync } from "fs";
import { stat } from "fs/promises";
import { join } from "path";
import { log } from "../../utils/log.js";
import { errorMessage } from "../../utils/errors.js";
import {
  getGeniesIframe,
  searchEmployee,
  clickEmployeeRow,
  clickGoToReports,
  goBackToMain,
  setDateRange,
  dismissModal,
} from "../../old-kronos/index.js";
import { handleReportsPage } from "../../old-kronos/reports.js";
import { validateAndClean, verifyPdfMatch } from "./validate.js";
import {
  updateKronosTracker as defaultUpdateTracker,
  buildTrackerRow,
  TRACKER_PATH,
} from "./tracker.js";
import type { KronosTrackerRow } from "./tracker.js";
import { REPORTS_DIR } from "./config.js";

export interface KronosOptions {
  dryRun?: boolean;
  startDate?: string;
  endDate?: string;
  /** Pre-launched page (for parallel worker reuse). */
  page?: Page;
  /** Whether date range has already been set on this page. */
  dateRangeSet?: boolean;
  /** Mutex-wrapped tracker write function. */
  updateTrackerFn?: (filePath: string, data: KronosTrackerRow) => Promise<void>;
  /** Mutex for serializing report navigation (Go To → Reports → download → back). */
  reportLock?: Mutex;
  /** Log prefix for worker identification. */
  logPrefix?: string;
  /** Dashboard step callback from withTrackedWorkflow. */
  onStep?: (step: string) => void;
  /** Dashboard data callback from withTrackedWorkflow. */
  onData?: (data: Record<string, string>) => void;
}

function prefixed(prefix: string | undefined, msg: string): string {
  return prefix ? `${prefix} ${msg}` : msg;
}

/**
 * Run the kronos report download workflow for a single employee.
 *
 * Steps:
 * 1. Get the Genies iframe
 * 2. Search for employee by ID
 * 3. Click employee row, extract name
 * 4. Navigate to Reports via Go To
 * 5. Run Time Detail report and download PDF
 * 6. Validate PDF and update tracker
 * 7. Navigate back to dashboard
 */
export async function runKronosForEmployee(
  employeeId: string,
  options: KronosOptions = {},
): Promise<void> {
  const p = options.logPrefix;
  const writeTracker = options.updateTrackerFn ?? defaultUpdateTracker;
  const page = options.page!;
  const reportsDir = REPORTS_DIR;

  try {
    // Step 1: Get iframe
    const iframe = await getGeniesIframe(page);

    // Step 2: Search employee
    await searchEmployee(page, iframe, employeeId);

    // Step 3: Check if employee was found
    const firstRow = iframe.locator("#row0genieGrid");
    const rowExists = await firstRow.count() > 0;
    const rowText = rowExists ? (await firstRow.innerText()).trim() : "";
    if (!rowExists || !rowText || !rowText.includes(employeeId)) {
      log.step(prefixed(p, `${employeeId} -> No matches were found on Kronos`));
      await writeTracker(TRACKER_PATH, buildTrackerRow(
        employeeId, "", "Done", "No matches were found on Kronos",
      ));
      return;
    }

    // Step 4: Click employee row
    options.onStep?.("extracting");
    const empName = await clickEmployeeRow(page, iframe, employeeId);
    if (empName === false) {
      log.step(prefixed(p, `${employeeId} -> Could not find row`));
      await writeTracker(TRACKER_PATH, buildTrackerRow(
        employeeId, "", "Done", "Could not find row",
      ));
      return;
    }
    const employeeName = empName ?? "";
    options.onData?.({ name: employeeName });
    log.step(prefixed(p, `Employee name: ${employeeName}`));

    // Step 5-7: Navigate to Reports → run → download → back
    // Serialized with reportLock to avoid UKG server-side session conflicts
    options.onStep?.("downloading");
    const reportLock = options.reportLock;
    let success = false;

    const doReportFlow = async () => {
      // Try up to 2 times — if report frames don't load, go back and retry
      for (let attempt = 1; attempt <= 2; attempt++) {
        if (!await clickGoToReports(page, iframe)) {
          log.step(prefixed(p, `${employeeId} -> Could not navigate to Reports`));
          await writeTracker(TRACKER_PATH, buildTrackerRow(
            employeeId, employeeName, "Failed", "Could not navigate to Reports",
          ));
          await goBackToMain(page);
          return;
        }

        await page.waitForTimeout(5_000);
        success = await handleReportsPage(page, employeeId, employeeName || null, reportsDir);

        if (success) {
          await goBackToMain(page);
          return;
        }

        // Failed — go back and retry if we have attempts left
        await goBackToMain(page);
        if (attempt < 2) {
          log.step(prefixed(p, `${employeeId} -> Retrying Reports navigation (attempt ${attempt + 1})...`));
          await page.waitForTimeout(3_000);
        }
      }
    };

    if (reportLock) {
      const release = await reportLock.acquire();
      try {
        await doReportFlow();
      } finally {
        release();
      }
    } else {
      await doReportFlow();
    }

    // Step 8: Validate and update tracker
    if (success) {
      const filename = employeeName
        ? `Time Detail_${employeeName} (${employeeId}).pdf`
        : `Time Detail_${employeeId}.pdf`;
      const dest = join(reportsDir, filename);

      if (existsSync(dest)) {
        const { valid } = await validateAndClean(dest, employeeId);
        if (valid) {
          const fileStat = await stat(dest);
          const sizeKb = Math.floor(fileStat.size / 1024);
          const verified = await verifyPdfMatch(dest, employeeName, employeeId);
          if (verified === "x") {
            log.success(prefixed(p, `${employeeId} -> OK (${sizeKb} KB) name='${employeeName}' [verified]`));
            await writeTracker(TRACKER_PATH, buildTrackerRow(
              employeeId, employeeName, "Done", "", true, verified,
            ));
          } else {
            // Mismatch — wrong PDF downloaded. Delete it and mark as failed.
            log.error(prefixed(p, `${employeeId} -> MISMATCH: ${verified} — deleting wrong PDF`));
            try { await (await import("fs/promises")).unlink(dest); } catch { /* ignore */ }
            await writeTracker(TRACKER_PATH, buildTrackerRow(
              employeeId, employeeName, "Failed", `Mismatch: ${verified}`,
            ));
          }
        } else {
          log.step(prefixed(p, `${employeeId} -> No Data Returned (deleted)`));
          await writeTracker(TRACKER_PATH, buildTrackerRow(
            employeeId, employeeName, "Done", "No Data Returned",
          ));
        }
      } else {
        log.step(prefixed(p, `${employeeId} -> Done (file not found at expected path)`));
        await writeTracker(TRACKER_PATH, buildTrackerRow(
          employeeId, employeeName, "Done", "",
        ));
      }
    } else {
      log.error(prefixed(p, `${employeeId} -> Report failed`));
      await writeTracker(TRACKER_PATH, buildTrackerRow(
        employeeId, employeeName, "Failed", "Report failed",
      ));
    }
  } catch (error) {
    const errMsg = errorMessage(error).slice(0, 100);
    log.error(prefixed(p, `${employeeId} -> ERROR: ${errMsg}`));
    try {
      await writeTracker(TRACKER_PATH, buildTrackerRow(
        employeeId, "", "Failed", errMsg,
      ));
    } catch {
      // Non-fatal
    }

    // Try to recover to dashboard
    try {
      await goBackToMain(page);
    } catch {
      try {
        const { UKG_URL } = await import("../../config.js");
        await page.goto(UKG_URL, { waitUntil: "domcontentloaded", timeout: 30_000 });
        await page.waitForTimeout(5_000);
      } catch {
        // Give up recovery
      }
    }
  }
}
