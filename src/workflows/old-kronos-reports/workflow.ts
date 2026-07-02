import type { Page, Frame } from "playwright";
import type { Mutex } from "async-mutex";
import { existsSync } from "fs";
import { stat } from "fs/promises";
import { join } from "path";
import { z } from "zod";
import { defineWorkflow } from "../../core/index.js";
import { log } from "../../utils/log.js";
import { buildOperatorSubject } from "../../domain/operator-subject.js";
import { DEFAULT_WORKFLOW_RUNTIME_POLICY } from "../../domain/workflow-runtime/default-policy.js";
import type { WorkflowRuntimePolicy } from "../../domain/workflow-runtime/types.js";
import { loginToUKG } from "../../infra/auth/login.js";
import { requireLogin } from "../../infra/auth/require-login.js";
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
  buildTrackerRow,
  TRACKER_PATH,
} from "./tracker.js";
import type { KronosTrackerRow } from "./tracker.js";
import { EmployeeIdSchema } from "./schema.js";
import { DEFAULT_WORKERS } from "./config.js";

/**
 * Module-scoped runtime state. Old Kronos is not exposed through the dashboard
 * until a dashboard-owned runner can initialize this state before launching a
 * kernel batch. The per-item handler reads from this state (tracker mutex,
 * report-navigation mutex, date range, reports dir) without needing each of
 * them on the TData or in the Ctx.
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

/** Called by a future dashboard-owned runner before launching the kernel batch. */
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
      "Kronos runtime not initialized — a dashboard-owned runner must call setKronosRuntime before the kernel launches",
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

/** Kernel item shape — one entry per employee ID. */
export const KronosItemSchema = z.object({ employeeId: EmployeeIdSchema });
export type KronosItem = z.infer<typeof KronosItemSchema>;

const kronosSteps = ["searching", "extracting", "downloading"] as const;

export const KRONOS_REPORTS_WORKFLOW_RUNTIME_POLICY: WorkflowRuntimePolicy =
  DEFAULT_WORKFLOW_RUNTIME_POLICY;

/**
 * Post-download validation + tracker row write. Used by the kernel handler's
 * `downloading` step for the shared "validate → write final tracker row" logic.
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
 * persistent UKG sessionDir). All workers pull from a shared queue; each
 * item's handler runs the per-employee UKG pipeline with `ctx.retry` around the
 * flaky Reports navigation.
 *
 * Mutex + date-range state lives in module-scoped `runtime` — Zod can't
 * validate `Mutex` so it can't ride on TData.
 *
 * `preEmitPending: true` is kept for a future dashboard-owned batch runner so
 * the dashboard can show the full employee queue before auth finishes.
 *
 * **Name is `"kronos-reports"`** (not `"old-kronos-reports"`) to match the
 * existing dashboard registration and JSONL filenames from the legacy era.
 */
export const kronosReportsWorkflow = defineWorkflow({
  name: "kronos-reports",
  label: "Kronos Reports",
  archetype: "operation",
  inputSubject: "eid",
  code: "kr",
  category: "Timekeeping",
  iconName: "FileText",
  systems: [
    {
      id: "old-kronos",
      login: requireLogin(loginToUKG, "UKG authentication failed"),
      // sessionDir intentionally omitted here. A future dashboard-owned runner
      // should inject a per-worker sessionDir via opts.launchFn so each worker
      // gets its own Playwright persistent context (workers sharing one dir
      // would conflict on the lock).
    },
  ],
  authSteps: false,
  steps: kronosSteps,
  schema: KronosItemSchema,
  runtimePolicy: KRONOS_REPORTS_WORKFLOW_RUNTIME_POLICY,
  batch: {
    mode: "pool",
    poolSize: DEFAULT_WORKERS,
    preEmitPending: true,
  },
  detailFields: [
    { key: "name", label: "Employee" },
    { key: "id", label: "ID" },
  ],
  getName: (d) => d.name ?? "",
  getId: (d) => d.id ?? "",
  operatorSubject: (input) =>
    buildOperatorSubject({ kind: "report", value: input.employeeId }),
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
        log.step(`[kronos-reports] ${employeeId} -> No matches were found on Kronos`);
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
        log.step(`[kronos-reports] ${employeeId} -> Could not find row`);
        await rt.writeTracker(buildTrackerRow(
          employeeId, "", "Done", "Could not find row",
        ));
        earlyReturn = true;
        return;
      }
      employeeName = empName ?? "";
      ctx.updateData({ name: employeeName });
      log.step(`[kronos-reports] Employee name: ${employeeName}`);
    });
    if (earlyReturn) return;

    await ctx.step("downloading", async () => {
      // ctx.retry handles the flaky "Go To Reports → wait → Run Report → download"
      // sequence: 2 attempts with 3s backoff. Each attempt is wrapped in the
      // cross-worker report mutex (UKG serializes this navigation path
      // server-side, so workers must not interleave).
      const doReportFlow = async (): Promise<boolean> => {
        if (!(await clickGoToReports(page, iframe))) {
          log.step(`[kronos-reports] ${employeeId} -> Could not navigate to Reports`);
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

      let success: boolean;
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
              log.step(`[kronos-reports] ${employeeId} -> Retrying Reports navigation (attempt ${attempt + 1})...`);
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
          "[kronos-reports]",
          (_filePath, data) => rt.writeTracker(data),
        );
      } else {
        log.error(`[kronos-reports] ${employeeId} -> Report failed`);
        await rt.writeTracker(buildTrackerRow(
          employeeId, employeeName, "Failed", "Report failed",
        ));
      }
    });
  },
});
