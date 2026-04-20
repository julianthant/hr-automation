import type { Page, Frame } from "playwright";
import type { Mutex } from "async-mutex";
import { existsSync } from "fs";
import { stat } from "fs/promises";
import { join } from "path";
import { z } from "zod";
import { defineWorkflow } from "../../core/index.js";
import { log } from "../../utils/log.js";
import { errorMessage } from "../../utils/errors.js";
import { loginToUKG } from "../../auth/login.js";
import {
  getGeniesIframe,
  searchEmployee,
  clickEmployeeRow,
  clickGoToReports,
  goBackToMain,
  setDateRange,
} from "../../systems/old-kronos/index.js";
import { handleReportsPage } from "../../systems/old-kronos/reports.js";
import { validateAndClean, verifyPdfMatch } from "./validate.js";
import {
  updateKronosTracker as defaultUpdateTracker,
  buildTrackerRow,
  TRACKER_PATH,
} from "./tracker.js";
import type { KronosTrackerRow } from "./tracker.js";
import { EmployeeIdSchema } from "./schema.js";
import { REPORTS_DIR, DEFAULT_START_DATE, DEFAULT_END_DATE } from "./config.js";

/**
 * Module-scoped runtime state, initialized by `runParallelKronos` in `parallel.ts`
 * before `runWorkflowBatch` launches any workers. The kernel's per-item handler
 * reads from this state (tracker mutex, report-navigation mutex, date range,
 * reports dir) without needing each of them on the TData or in the Ctx.
 *
 * Why module-scoped? Zod can't validate `Mutex` instances (and `schema.parse`
 * strips unknown keys), so the mutexes can't live on `KronosItemSchema`. Pool
 * mode launches N workers sharing this process; all workers read the same
 * module state safely because each mutex is an independent async primitive.
 */
interface KronosRuntime {
  trackerMutex: Mutex;
  reportMutex: Mutex;
  startDate: string;
  endDate: string;
  reportsDir: string;
  writeTracker: (row: KronosTrackerRow) => Promise<void>;
}

let runtime: KronosRuntime | null = null;

/** Called by `runParallelKronos` before launching the kernel batch. */
export function setKronosRuntime(r: KronosRuntime): void {
  runtime = r;
}

/** Called after the batch finishes — clears state so later imports can't read stale data. */
export function clearKronosRuntime(): void {
  runtime = null;
}

function requireRuntime(): KronosRuntime {
  if (!runtime) {
    throw new Error(
      "Kronos runtime not initialized — runParallelKronos must call setKronosRuntime before the kernel launches",
    );
  }
  return runtime;
}

/**
 * Per-worker set of pages that have already had the date range set. The kernel
 * pool launches one Session per worker and each Session keeps a stable `Page`
 * object across items, so a WeakSet keyed on Page correctly identifies "has
 * this worker's page been initialized yet".
 */
const dateRangeSet = new WeakSet<Page>();

async function ensureDateRangeSet(page: Page, iframe: Frame): Promise<void> {
  if (dateRangeSet.has(page)) return;
  const { startDate, endDate } = requireRuntime();
  await setDateRange(page, iframe, startDate, endDate);
  dateRangeSet.add(page);
}

/** Kernel item shape — one entry per employee ID from batch.yaml. */
export const KronosItemSchema = z.object({ employeeId: EmployeeIdSchema });
export type KronosItem = z.infer<typeof KronosItemSchema>;

const kronosSteps = ["searching", "extracting", "downloading"] as const;

/**
 * Run the kronos report download workflow for a single employee.
 *
 * Preserved as an exported helper (was the entire workflow body pre-migration).
 * The kernel handler below inlines the same control flow split across
 * `searching` / `extracting` / `downloading` ctx.step blocks, with `ctx.retry`
 * for the flaky Reports-iframe loads.
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
  options: {
    page: Page;
    dateRangeSet?: boolean;
    updateTrackerFn?: (filePath: string, data: KronosTrackerRow) => Promise<void>;
    reportLock?: Mutex;
    logPrefix?: string;
    onStep?: (step: string) => void;
    onData?: (data: Record<string, string>) => void;
  },
): Promise<void> {
  const p = options.logPrefix;
  const prefixed = (msg: string): string => (p ? `${p} ${msg}` : msg);
  const writeTracker = options.updateTrackerFn ?? defaultUpdateTracker;
  const page = options.page;
  const reportsDir = REPORTS_DIR;

  try {
    const iframe = await getGeniesIframe(page);
    await searchEmployee(page, iframe, employeeId);

    const firstRow = iframe.locator("#row0genieGrid");
    const rowExists = await firstRow.count() > 0;
    const rowText = rowExists ? (await firstRow.innerText()).trim() : "";
    if (!rowExists || !rowText || !rowText.includes(employeeId)) {
      log.step(prefixed(`${employeeId} -> No matches were found on Kronos`));
      await writeTracker(TRACKER_PATH, buildTrackerRow(
        employeeId, "", "Done", "No matches were found on Kronos",
      ));
      return;
    }

    options.onStep?.("extracting");
    const empName = await clickEmployeeRow(page, iframe, employeeId);
    if (empName === false) {
      log.step(prefixed(`${employeeId} -> Could not find row`));
      await writeTracker(TRACKER_PATH, buildTrackerRow(
        employeeId, "", "Done", "Could not find row",
      ));
      return;
    }
    const employeeName = empName ?? "";
    options.onData?.({ name: employeeName });
    log.step(prefixed(`Employee name: ${employeeName}`));

    options.onStep?.("downloading");
    const reportLock = options.reportLock;
    let success = false;

    const doReportFlow = async () => {
      for (let attempt = 1; attempt <= 2; attempt++) {
        if (!await clickGoToReports(page, iframe)) {
          log.step(prefixed(`${employeeId} -> Could not navigate to Reports`));
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

        await goBackToMain(page);
        if (attempt < 2) {
          log.step(prefixed(`${employeeId} -> Retrying Reports navigation (attempt ${attempt + 1})...`));
          await page.waitForTimeout(3_000);
        }
      }
    };

    if (reportLock) {
      const release = await reportLock.acquire();
      try { await doReportFlow(); } finally { release(); }
    } else {
      await doReportFlow();
    }

    if (success) {
      await validateAndRecordTracker(employeeId, employeeName, reportsDir, p, writeTracker);
    } else {
      log.error(prefixed(`${employeeId} -> Report failed`));
      await writeTracker(TRACKER_PATH, buildTrackerRow(
        employeeId, employeeName, "Failed", "Report failed",
      ));
    }
  } catch (error) {
    const errMsg = errorMessage(error).slice(0, 100);
    log.error(prefixed(`${employeeId} -> ERROR: ${errMsg}`));
    try {
      await writeTracker(TRACKER_PATH, buildTrackerRow(
        employeeId, "", "Failed", errMsg,
      ));
    } catch { /* non-fatal */ }

    try {
      await goBackToMain(page);
    } catch {
      try {
        const { UKG_URL } = await import("../../config.js");
        await page.goto(UKG_URL, { waitUntil: "domcontentloaded", timeout: 30_000 });
        await page.waitForTimeout(5_000);
      } catch { /* give up recovery */ }
    }
  }
}

/**
 * Post-download validation + tracker row write. Extracted so both the legacy
 * `runKronosForEmployee` helper and the kernel handler share the same
 * "validate → write final tracker row" logic.
 */
async function validateAndRecordTracker(
  employeeId: string,
  employeeName: string,
  reportsDir: string,
  logPrefix: string | undefined,
  writeTracker: (filePath: string, data: KronosTrackerRow) => Promise<void>,
): Promise<void> {
  const prefixed = (msg: string): string => (logPrefix ? `${logPrefix} ${msg}` : msg);
  const filename = employeeName
    ? `Time Detail_${employeeName} (${employeeId}).pdf`
    : `Time Detail_${employeeId}.pdf`;
  const dest = join(reportsDir, filename);

  if (!existsSync(dest)) {
    log.step(prefixed(`${employeeId} -> Done (file not found at expected path)`));
    await writeTracker(TRACKER_PATH, buildTrackerRow(
      employeeId, employeeName, "Done", "",
    ));
    return;
  }

  const { valid } = await validateAndClean(dest, employeeId);
  if (!valid) {
    log.step(prefixed(`${employeeId} -> No Data Returned (deleted)`));
    await writeTracker(TRACKER_PATH, buildTrackerRow(
      employeeId, employeeName, "Done", "No Data Returned",
    ));
    return;
  }

  const fileStat = await stat(dest);
  const sizeKb = Math.floor(fileStat.size / 1024);
  const verified = await verifyPdfMatch(dest, employeeName, employeeId);
  if (verified === "x") {
    log.success(prefixed(`${employeeId} -> OK (${sizeKb} KB) name='${employeeName}' [verified]`));
    await writeTracker(TRACKER_PATH, buildTrackerRow(
      employeeId, employeeName, "Done", "", true, verified,
    ));
  } else {
    log.error(prefixed(`${employeeId} -> MISMATCH: ${verified} — deleting wrong PDF`));
    try { await (await import("fs/promises")).unlink(dest); } catch { /* ignore */ }
    await writeTracker(TRACKER_PATH, buildTrackerRow(
      employeeId, employeeName, "Failed", `Mismatch: ${verified}`,
    ));
  }
}

/**
 * Kernel definition for the kronos-reports batch workflow.
 *
 * Pool mode: the kernel launches N workers (each with its own Session and
 * persistent UKG sessionDir — see parallel.ts's launchFn injection). All
 * workers pull from a shared queue; each item's handler runs the per-employee
 * UKG pipeline with `ctx.retry` around the flaky Reports navigation.
 *
 * Mutex + date-range state lives in module-scoped `runtime` (initialized by
 * runParallelKronos) — Zod can't validate `Mutex` so it can't ride on TData.
 *
 * `preEmitPending: true` pairs with the CLI adapter's `onPreEmitPending`
 * callback so the dashboard shows the full employee queue before auth finishes.
 *
 * **Name is `"kronos-reports"`** (not `"old-kronos-reports"`) to match the
 * existing dashboard registration and JSONL filenames from the legacy era.
 */
export const kronosReportsWorkflow = defineWorkflow({
  name: "kronos-reports",
  label: "Kronos Reports",
  systems: [
    {
      id: "old-kronos",
      login: async (page, instance) => {
        const ok = await loginToUKG(page, instance);
        if (!ok) throw new Error("UKG authentication failed");
      },
      // sessionDir intentionally omitted here — parallel.ts injects a per-worker
      // sessionDir via opts.launchFn so each worker gets its own Playwright
      // persistent context (workers sharing one dir would conflict on the lock).
    },
  ],
  authSteps: false,
  steps: kronosSteps,
  schema: KronosItemSchema,
  tiling: "single",
  authChain: "sequential",
  batch: {
    mode: "pool",
    poolSize: 4,
    preEmitPending: true,
  },
  detailFields: [
    { key: "name", label: "Employee" },
    { key: "id", label: "ID" },
  ],
  getName: (d) => d.name ?? "",
  getId: (d) => d.id ?? "",
  handler: async (ctx, item) => {
    const { employeeId } = item;
    const rt = requireRuntime();
    const page = await ctx.page("old-kronos");

    // Stamp the EID immediately so the detail panel's ID cell populates before
    // the employee name is extracted (click row happens mid-"extracting").
    ctx.updateData({ id: employeeId });

    // First item on this worker — set the date range once on the page.
    // Subsequent items skip via the WeakSet guard.
    const iframe = await getGeniesIframe(page);
    await ensureDateRangeSet(page, iframe);

    // Per-item employee name, populated in `extracting`, read in `downloading`
    // for filename + verification.
    let employeeName = "";
    let earlyReturn = false;

    await ctx.step("searching", async () => {
      await searchEmployee(page, iframe, employeeId);
      const firstRow = iframe.locator("#row0genieGrid");
      const rowExists = await firstRow.count() > 0;
      const rowText = rowExists ? (await firstRow.innerText()).trim() : "";
      if (!rowExists || !rowText || !rowText.includes(employeeId)) {
        log.step(`${employeeId} -> No matches were found on Kronos`);
        await rt.writeTracker(buildTrackerRow(
          employeeId, "", "Done", "No matches were found on Kronos",
        ));
        earlyReturn = true;
      }
    });
    if (earlyReturn) return;

    await ctx.step("extracting", async () => {
      const empName = await clickEmployeeRow(page, iframe, employeeId);
      if (empName === false) {
        log.step(`${employeeId} -> Could not find row`);
        await rt.writeTracker(buildTrackerRow(
          employeeId, "", "Done", "Could not find row",
        ));
        earlyReturn = true;
        return;
      }
      employeeName = empName ?? "";
      ctx.updateData({ name: employeeName });
      log.step(`Employee name: ${employeeName}`);
    });
    if (earlyReturn) return;

    await ctx.step("downloading", async () => {
      let success = false;

      // ctx.retry handles the flaky "Go To Reports → wait → Run Report → download"
      // sequence: 2 attempts with 3s backoff. Each attempt is wrapped in the
      // cross-worker report mutex (UKG serializes this navigation path
      // server-side, so workers must not interleave).
      const doReportFlow = async (): Promise<boolean> => {
        if (!(await clickGoToReports(page, iframe))) {
          log.step(`${employeeId} -> Could not navigate to Reports`);
          await rt.writeTracker(buildTrackerRow(
            employeeId, employeeName, "Failed", "Could not navigate to Reports",
          ));
          await goBackToMain(page);
          throw new Error("Could not navigate to Reports");
        }
        await page.waitForTimeout(5_000);
        const ok = await handleReportsPage(page, employeeId, employeeName || null, rt.reportsDir);
        await goBackToMain(page);
        if (!ok) throw new Error("handleReportsPage failed");
        return true;
      };

      try {
        success = await ctx.retry(
          async () => {
            const release = await rt.reportMutex.acquire();
            try {
              return await doReportFlow();
            } finally {
              release();
            }
          },
          {
            attempts: 2,
            backoffMs: 3_000,
            onAttempt: (attempt) => {
              log.step(`${employeeId} -> Retrying Reports navigation (attempt ${attempt + 1})...`);
            },
          },
        );
      } catch {
        // Both attempts failed — fall through to the tracker write below.
        success = false;
      }

      if (success) {
        await validateAndRecordTracker(
          employeeId,
          employeeName,
          rt.reportsDir,
          undefined,
          (filePath, data) => rt.writeTracker(data),
        );
      } else {
        log.error(`${employeeId} -> Report failed`);
        await rt.writeTracker(buildTrackerRow(
          employeeId, employeeName, "Failed", "Report failed",
        ));
      }
    });
  },
});

// Re-exports kept for external callers (none production — legacy signature parity).
export { DEFAULT_START_DATE, DEFAULT_END_DATE };
