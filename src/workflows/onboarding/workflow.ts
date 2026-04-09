import type { Page } from "playwright";
import { launchBrowser } from "../../browser/launch.js";
import { log } from "../../utils/log.js";
import { errorMessage } from "../../utils/errors.js";
import { loginToUCPath, loginToACTCrm } from "../../auth/login.js";
import { startDashboard, stopDashboard } from "../../tracker/dashboard.js";
import {
  searchByEmail,
  selectLatestResult,
  navigateToSection,
  ExtractionError,
} from "../../crm/index.js";
import { TransactionError } from "../../ucpath/types.js";
import { searchPerson } from "../../ucpath/navigate.js";
import {
  updateOnboardingTracker as defaultUpdateTracker,
  buildTrackerRow,
  TRACKER_PATH,
} from "./tracker.js";
import type { OnboardingTrackerRow as TrackerRow } from "./tracker.js";
import {
  extractRawFields,
  extractRecordPageFields,
  validateEmployeeData,
  buildTransactionPlan,
} from "./index.js";
import type { EmployeeData } from "./index.js";

export interface OnboardingOptions {
  dryRun?: boolean;
  /** Pre-launched CRM page (for parallel worker reuse). If omitted, launches a new browser. */
  crmPage?: Page;
  /** Pre-launched UCPath page (for parallel worker reuse). If omitted, launches a new browser. */
  ucpathPage?: Page;
  /** Mutex-wrapped tracker write function. If omitted, uses default updateTracker. */
  updateTrackerFn?: (filePath: string, data: TrackerRow) => Promise<void>;
  /** Log prefix for worker identification, e.g. "[Worker 1]". */
  logPrefix?: string;
}

function prefixed(prefix: string | undefined, msg: string): string {
  return prefix ? `${prefix} ${msg}` : msg;
}

/**
 * Run the full onboarding workflow for a single employee.
 *
 * In single mode (no options.crmPage): launches its own browsers, exits on error.
 * In parallel mode (options.crmPage provided): uses worker's browsers, throws on error.
 */
export async function runOnboarding(
  email: string,
  options: OnboardingOptions = {},
): Promise<void> {
  const p = options.logPrefix;
  const writeTracker = options.updateTrackerFn ?? defaultUpdateTracker;
  const isParallel = Boolean(options.crmPage);

  // Start live dashboard only in single (non-parallel) mode
  if (!isParallel) startDashboard("onboarding");
  let data: EmployeeData;

  // Helper: exit in single mode, throw in parallel mode
  function fail(msg: string): never {
    if (isParallel) throw new Error(msg);
    log.error(prefixed(p, msg));
    process.exit(1);
  }

  // --- Step 1: Extract data from ACT CRM ---
  const crmPage = options.crmPage ?? (await launchBrowser()).page;
  let recordFields: { departmentNumber: string | null; recruitmentNumber: string | null } = {
    departmentNumber: null,
    recruitmentNumber: null,
  };

  try {
    log.step(prefixed(p, "Authenticating to ACT CRM..."));
    const authOk = await loginToACTCrm(crmPage);
    if (!authOk) fail("ACT CRM authentication failed -- cannot extract");

    log.step(prefixed(p, `Searching for ${email}...`));
    await searchByEmail(crmPage, email);

    log.step(prefixed(p, "Selecting latest result..."));
    await selectLatestResult(crmPage);

    log.step(prefixed(p, "Extracting record page fields..."));
    recordFields = await extractRecordPageFields(crmPage);

    // TODO: PDF download step will be added here (Task 13)

    log.step(prefixed(p, "Navigating to UCPath Entry Sheet..."));
    await navigateToSection(crmPage, "UCPath Entry Sheet");

    log.step(prefixed(p, "Extracting employee data..."));
    const rawData = await extractRawFields(crmPage);

    log.step(prefixed(p, "Validating extracted data..."));
    data = validateEmployeeData(rawData);

    if (recordFields.departmentNumber) {
      data = { ...data, departmentNumber: recordFields.departmentNumber };
    }
    if (recordFields.recruitmentNumber) {
      data = { ...data, recruitmentNumber: recordFields.recruitmentNumber };
    }

    log.success(prefixed(p, "Employee data extracted and validated"));
  } catch (error) {
    const errMsg = error instanceof ExtractionError
      ? error.message
      : `Extraction failed: ${errorMessage(error)}`;

    // In parallel mode, write error to tracker before throwing
    if (isParallel) {
      try {
        // data may not be populated — use email as identifier
        await writeTracker(TRACKER_PATH, {
          firstName: "", middleName: "", lastName: "", ssn: "", dob: "",
          phone: "", email, address: "", city: "", state: "", postalCode: "",
          departmentNumber: "", recruitmentNumber: "", positionNumber: "",
          wage: "", effectiveDate: "", appointment: "",
          crmExtraction: "Failed", personSearch: "", rehire: "",
          i9Record: "", transaction: "", pdfDownload: "",
          i9ProfileId: "", status: "Failed", error: errMsg,
          timestamp: new Date().toISOString(),
        });
      } catch {
        // Non-fatal
      }
    }

    fail(errMsg);
  }

  // --- Step 2: Dry-run mode ---
  if (options.dryRun) {
    const plan = buildTransactionPlan(data, null as unknown as Page, "DRY_RUN");
    log.step(prefixed(p, "=== DRY RUN MODE ==="));
    plan.preview();

    try {
      await writeTracker(TRACKER_PATH, buildTrackerRow(data, {
        crmExtraction: "Done",
        personSearch: "Dry Run",
        rehire: "",
        i9Record: "Dry Run",
        transaction: "Dry Run",
        pdfDownload: "Dry Run",
        i9ProfileId: "Dry Run",
        status: "Dry Run",
        error: "",
      }));
      log.success(prefixed(p, `Tracker updated: ${TRACKER_PATH}`));
    } catch (trackerErr) {
      log.error(prefixed(p, `Tracker update failed (non-fatal): ${errorMessage(trackerErr)}`));
    }

    log.success(prefixed(p, "Dry run complete -- no changes made to UCPath"));
    if (!isParallel) stopDashboard();
    return;
  }

  // --- Step 3: UCPath -- person search + transaction ---
  const ucpathPage = options.ucpathPage ?? (await launchBrowser()).page;
  try {
    log.step(prefixed(p, "Authenticating to UCPath..."));
    const ucpathOk = await loginToUCPath(ucpathPage);
    if (!ucpathOk) fail("UCPath authentication failed");

    const ssnDigits = data.ssn?.replace(/-/g, "") ?? "";
    log.step(prefixed(p, "Checking for existing person in UCPath..."));
    const searchResult = await searchPerson(
      ucpathPage,
      ssnDigits,
      data.firstName,
      data.lastName,
      data.dob ?? "",
    );

    if (searchResult.found) {
      log.error(prefixed(p, "Person already exists in UCPath -- rehire"));
      if (searchResult.matches) {
        for (const m of searchResult.matches) {
          log.step(prefixed(p, `  Empl ID: ${m.emplId}, Name: ${m.firstName} ${m.lastName}`));
        }
      }

      try {
        await writeTracker(TRACKER_PATH, buildTrackerRow(data, {
          crmExtraction: "Done",
          personSearch: "Done",
          rehire: "X",
          i9Record: "N/A",
          transaction: "N/A",
          pdfDownload: "",
          i9ProfileId: "N/A",
          status: "Rehire",
          error: "",
        }));
        log.success(prefixed(p, `Tracker updated: ${TRACKER_PATH}`));
      } catch (trackerErr) {
        log.error(prefixed(p, `Tracker update failed (non-fatal): ${errorMessage(trackerErr)}`));
      }

      if (!isParallel) stopDashboard();
      return;
    }

    log.success(prefixed(p, "No duplicate found -- proceeding with transaction"));

    const i9ProfileId = "MOCK_I9";
    log.step(prefixed(p, "I9 skipped (mock mode) -- Profile ID: MOCK_I9"));

    const plan = buildTransactionPlan(data, ucpathPage, i9ProfileId);
    log.step(prefixed(p, "Executing transaction plan..."));
    await plan.execute();

    log.success(prefixed(p, "Transaction created successfully in UCPath"));

    try {
      await writeTracker(TRACKER_PATH, buildTrackerRow(data, {
        crmExtraction: "Done",
        personSearch: "Done",
        rehire: "",
        i9Record: "Done",
        transaction: "Done",
        pdfDownload: "",
        i9ProfileId,
        status: "Done",
        error: "",
      }));
      log.success(prefixed(p, `Tracker updated: ${TRACKER_PATH}`));
    } catch (trackerErr) {
      log.error(prefixed(p, `Tracker update failed (non-fatal): ${errorMessage(trackerErr)}`));
    }
    if (!isParallel) stopDashboard();
  } catch (error) {
    // In parallel mode, update tracker with error then re-throw
    if (isParallel) {
      const errMsg = error instanceof TransactionError
        ? `Transaction failed at step: ${error.step ?? "unknown"} — ${error.message}`
        : errorMessage(error);

      try {
        await writeTracker(TRACKER_PATH, buildTrackerRow(data, {
          crmExtraction: "Done",
          personSearch: "Done",
          rehire: "",
          i9Record: "",
          transaction: "Failed",
          pdfDownload: "",
          i9ProfileId: "",
          status: "Failed",
          error: errMsg,
        }));
      } catch {
        // Non-fatal
      }

      throw error;
    }

    // Single mode: log and exit
    if (error instanceof TransactionError) {
      log.error(`Transaction failed at step: ${error.step ?? "unknown"}`);
      log.error(error.message);
    } else {
      log.error(`Transaction failed: ${errorMessage(error)}`);
    }
    process.exit(1);
  }
}
