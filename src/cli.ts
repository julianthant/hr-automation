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
  validateEmployeeData,
} from "./workflows/onboarding/index.js";

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

program.parse();
