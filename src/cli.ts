import { Command } from "commander";
import type { Page } from "playwright";
import { launchBrowser } from "./browser/launch.js";
import { validateEnv } from "./utils/env.js";
import { log } from "./utils/log.js";
import { loginToUCPath, loginToACTCrm } from "./auth/login.js";
import type { AuthResult } from "./auth/types.js";
import {
  searchByEmail,
  selectLatestResult,
  navigateToSection,
  ExtractionError,
} from "./crm/index.js";
import {
  extractRawFields,
  extractRecordPageFields,
  validateEmployeeData,
  buildTransactionPlan,
} from "./workflows/onboarding/index.js";
import type { EmployeeData } from "./workflows/onboarding/index.js";
import { TransactionError } from "./ucpath/types.js";
import { searchPerson } from "./ucpath/navigate.js";
import { loginToI9, createI9Employee } from "./i9/index.js";
import { updateTracker, maskSsn } from "./tracker/index.js";
import type { TrackerRow } from "./tracker/index.js";

const TRACKER_PATH = "./onboarding-tracker.xlsx";

const program = new Command();

program
  .name("hr-auto")
  .description("UCPath HR Automation Tool")
  .version("0.1.0");

/**
 * Run the full authentication flow: UCPath + ACT CRM.
 *
 * Per user requirement: always login fresh, no session persistence.
 * Each system gets its own browser (separate auth, no shared SSO).
 */
async function runAuthFlow(): Promise<AuthResult> {
  const result: AuthResult = {
    ucpath: false,
    actCrm: false,
  };

  // --- UCPath Authentication (separate browser) ---
  log.step("Starting UCPath authentication...");
  const ucpath = await launchBrowser();
  try {
    const ok = await loginToUCPath(ucpath.page);
    if (!ok) {
      log.error("UCPath authentication failed");
      await ucpath.browser.close();
      process.exit(1);
    }
    result.ucpath = true;
  } finally {
    await ucpath.browser.close();
  }

  // --- ACT CRM Authentication (separate browser) ---
  log.step("Starting ACT CRM authentication...");
  const actCrm = await launchBrowser();
  try {
    const ok = await loginToACTCrm(actCrm.page);
    if (!ok) {
      log.error("ACT CRM authentication failed");
      await actCrm.browser.close();
      process.exit(1);
    }
    result.actCrm = true;
  } finally {
    await actCrm.browser.close();
  }

  log.success("Authentication complete");
  log.step("UCPath: authenticated");
  log.step("ACT CRM: authenticated");

  return result;
}

program
  .command("test-login")
  .description("Test authentication to UCPath and ACT CRM")
  .action(async () => {
    try {
      // Validate .env FIRST -- fail early before launching browser
      validateEnv();
      log.success("Environment variables validated");
    } catch (error) {
      // validateEnv throws EnvValidationError with descriptive message
      process.exit(1);
    }

    try {
      await runAuthFlow();
    } catch (firstError) {
      // Browser crash / page load failure: retry ONCE
      log.error("Unexpected error -- retrying...");
      try {
        await runAuthFlow();
      } catch (secondError) {
        const msg =
          secondError instanceof Error
            ? secondError.message
            : String(secondError);
        log.error(`Authentication failed after retry: ${msg}`);
        process.exit(1);
      }
    }
  });

program
  .command("extract")
  .description("Extract employee data from ACT CRM")
  .argument("<email>", "Employee email to search for")
  .action(async (email: string) => {
    try {
      validateEnv();
    } catch {
      process.exit(1);
    }

    // Launch browser and authenticate to ACT CRM
    const { browser, page } = await launchBrowser();

    try {
      log.step("Authenticating to ACT CRM...");
      const authOk = await loginToACTCrm(page);
      if (!authOk) {
        log.error("ACT CRM authentication failed -- cannot extract");
        await browser.close();
        process.exit(1);
      }

      log.step("Searching for employee...");
      await searchByEmail(page, email);

      log.step("Selecting latest result...");
      await selectLatestResult(page);

      log.step("Navigating to UCPath Entry Sheet...");
      await navigateToSection(page, "UCPath Entry Sheet");

      log.step("Extracting employee data...");
      const rawData = await extractRawFields(page);

      log.step("Validating extracted data...");
      const data = validateEmployeeData(rawData);

      log.success("Employee data extracted and validated");
      log.step(`Fields extracted: ${Object.keys(data).length}`);
    } catch (error) {
      if (error instanceof ExtractionError) {
        // Do NOT log raw data -- may contain PII
        log.error(error.message);
      } else {
        const msg =
          error instanceof Error ? error.message : String(error);
        log.error(`Extraction failed: ${msg}`);
      }
      process.exit(1);
    } finally {
      await browser.close();
    }
  });

program
  .command("start-onboarding")
  .description("Start onboarding: extract from CRM, search UCPath, create transaction")
  .argument("<email>", "Employee email to extract data for")
  .option("--dry-run", "Preview actions without creating transaction")
  .action(async (email: string, options: { dryRun?: boolean }) => {
    try {
      validateEnv();
    } catch {
      process.exit(1);
    }

    let data: EmployeeData;

    // --- Step 1: Extract data from ACT CRM ---
    const crmBrowser = await launchBrowser();
    let recordFields: { departmentNumber: string | null; recruitmentNumber: string | null } = {
      departmentNumber: null,
      recruitmentNumber: null,
    };

    try {
      log.step("Authenticating to ACT CRM...");
      const authOk = await loginToACTCrm(crmBrowser.page);
      if (!authOk) {
        log.error("ACT CRM authentication failed -- cannot extract");
        process.exit(1);
      }

      log.step("Searching for employee...");
      await searchByEmail(crmBrowser.page, email);

      log.step("Selecting latest result...");
      await selectLatestResult(crmBrowser.page);

      // Extract record page fields (dept#, recruitment#) BEFORE navigating away
      log.step("Extracting record page fields...");
      recordFields = await extractRecordPageFields(crmBrowser.page);

      log.step("Navigating to UCPath Entry Sheet...");
      await navigateToSection(crmBrowser.page, "UCPath Entry Sheet");

      log.step("Extracting employee data...");
      const rawData = await extractRawFields(crmBrowser.page);

      log.step("Validating extracted data...");
      data = validateEmployeeData(rawData);

      // Merge record page fields into validated data
      if (recordFields.departmentNumber) {
        data = { ...data, departmentNumber: recordFields.departmentNumber };
      }
      if (recordFields.recruitmentNumber) {
        data = { ...data, recruitmentNumber: recordFields.recruitmentNumber };
      }

      log.success("Employee data extracted and validated");
    } catch (error) {
      if (error instanceof ExtractionError) {
        log.error(error.message);
      } else {
        const msg =
          error instanceof Error ? error.message : String(error);
        log.error(`Extraction failed: ${msg}`);
      }
      process.exit(1);
    }

    // Keep ACT CRM browser open for reuse with next employee
    // (per user requirement: don't close browsers, reuse for batch processing)

    // --- Step 2: Dry-run mode ---
    if (options.dryRun) {
      const plan = buildTransactionPlan(data, null as unknown as Page);
      log.step("=== DRY RUN MODE ===");
      log.step(`Effective date: ${data.effectiveDate}`);
      log.step(`Fields validated: ${Object.keys(data).length}`);
      plan.preview();

      // Write tracker row with dry-run status
      const dryRunRow: TrackerRow = {
        firstName: data.firstName,
        lastName: data.lastName,
        ssnMasked: maskSsn(data.ssn),
        dob: data.dob ?? "N/A",
        departmentNumber: data.departmentNumber ?? "N/A",
        recruitmentNumber: data.recruitmentNumber ?? "N/A",
        rehire: "",
        effectiveDate: data.effectiveDate,
        crmExtracted: "Done",
        personSearch: "Dry Run",
        transaction: "Dry Run",
      };

      try {
        await updateTracker(TRACKER_PATH, dryRunRow);
        log.success(`Tracker updated: ${TRACKER_PATH}`);
      } catch (trackerErr) {
        const msg = trackerErr instanceof Error ? trackerErr.message : String(trackerErr);
        log.error(`Tracker update failed (non-fatal): ${msg}`);
      }

      log.success("Dry run complete -- no changes made to UCPath");
      return;
    }

    // --- Step 3: UCPath -- person search + transaction ---
    const ucpathBrowser = await launchBrowser();
    try {
      log.step("Authenticating to UCPath...");
      const ucpathOk = await loginToUCPath(ucpathBrowser.page);
      if (!ucpathOk) {
        log.error("UCPath authentication failed");
        process.exit(1);
      }

      // Step 3a: Person duplicate check
      // SSN may have dashes from CRM -- strip them for UCPath search
      const ssnDigits = data.ssn?.replace(/-/g, "") ?? "";
      log.step("Checking for existing person in UCPath...");
      const searchResult = await searchPerson(
        ucpathBrowser.page,
        ssnDigits,
        data.firstName,
        data.lastName,
        data.dob ?? "",
      );

      // --- Update onboarding tracker ---
      const trackerRow: TrackerRow = {
        firstName: data.firstName,
        lastName: data.lastName,
        ssnMasked: maskSsn(data.ssn),
        dob: data.dob ?? "N/A",
        departmentNumber: data.departmentNumber ?? "N/A",
        recruitmentNumber: data.recruitmentNumber ?? "N/A",
        rehire: searchResult.found ? "X" : "",
        effectiveDate: data.effectiveDate,
        crmExtracted: "Done",
        personSearch: searchResult.found ? "Rehire" : "Done",
        transaction: "Pending",
      };

      try {
        await updateTracker(TRACKER_PATH, trackerRow);
        log.success(`Tracker updated: ${TRACKER_PATH}`);
      } catch (trackerErr) {
        // Tracker failure should NOT abort the workflow
        const msg = trackerErr instanceof Error ? trackerErr.message : String(trackerErr);
        log.error(`Tracker update failed (non-fatal): ${msg}`);
      }

      if (searchResult.found) {
        log.error("Person already exists in UCPath -- cannot create new hire");
        if (searchResult.matches) {
          log.step(`Found ${searchResult.matches.length} match(es):`);
          for (const m of searchResult.matches) {
            log.step(`  Empl ID: ${m.emplId}, Name: ${m.firstName} ${m.lastName}`);
          }
        }
        log.step("This may be a rehire. Stopping.");
        // Leave browser open for manual review
        process.exit(1);
      }

      log.success("No duplicate found -- proceeding with transaction");

      // Step 3b: Create transaction
      const plan = buildTransactionPlan(data, ucpathBrowser.page);
      log.step("Executing transaction plan...");
      await plan.execute();

      log.success("Transaction created successfully in UCPath");
      // Do NOT close UCPath browser -- leave it open per user preference
    } catch (error) {
      if (error instanceof TransactionError) {
        log.error(`Transaction failed at step: ${error.step ?? "unknown"}`);
        log.error(error.message);
      } else {
        const msg =
          error instanceof Error ? error.message : String(error);
        log.error(`Transaction failed: ${msg}`);
      }
      // Leave browser open for debugging even on failure
      process.exit(1);
    }
  });

program
  .command("create-i9")
  .description("Create I-9 employee record in I9 Complete")
  .argument("<email>", "Employee email to extract data for")
  .action(async (email: string) => {
    try {
      validateEnv();
    } catch {
      process.exit(1);
    }

    let data;

    // --- Step 1: Extract data from ACT CRM ---
    const crmBrowser = await launchBrowser();
    try {
      log.step("Authenticating to ACT CRM...");
      const authOk = await loginToACTCrm(crmBrowser.page);
      if (!authOk) {
        log.error("ACT CRM authentication failed");
        process.exit(1);
      }

      log.step("Searching for employee...");
      await searchByEmail(crmBrowser.page, email);

      log.step("Selecting latest result...");
      await selectLatestResult(crmBrowser.page);

      log.step("Navigating to UCPath Entry Sheet...");
      await navigateToSection(crmBrowser.page, "UCPath Entry Sheet");

      log.step("Extracting employee data...");
      const rawData = await extractRawFields(crmBrowser.page);

      log.step("Validating extracted data...");
      data = validateEmployeeData(rawData);

      log.success("Employee data extracted and validated");
    } catch (error) {
      if (error instanceof ExtractionError) {
        log.error(error.message);
      } else {
        const msg = error instanceof Error ? error.message : String(error);
        log.error(`Extraction failed: ${msg}`);
      }
      process.exit(1);
    }

    // --- Step 2: Create I-9 record ---
    const i9Browser = await launchBrowser();
    try {
      log.step("Authenticating to I9 Complete...");
      const i9Ok = await loginToI9(i9Browser.page);
      if (!i9Ok) {
        log.error("I9 Complete authentication failed");
        process.exit(1);
      }

      const ssnDigits = data.ssn?.replace(/-/g, "") ?? "";
      const result = await createI9Employee(i9Browser.page, {
        firstName: data.firstName,
        lastName: data.lastName,
        ssn: ssnDigits,
        dob: data.dob ?? "",
        email,
        departmentNumber: "000412", // TODO: Phase 3.1 will extract this from CRM
        startDate: data.effectiveDate,
      });

      if (!result.success) {
        log.error(`I-9 creation failed: ${result.error}`);
        process.exit(1);
      }

      log.success(`I-9 created — Profile ID: ${result.profileId}`);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      log.error(`I-9 workflow failed: ${msg}`);
      process.exit(1);
    }
  });

program.parse();
