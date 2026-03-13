import { Command } from "commander";
import type { Page } from "playwright";
import { launchBrowser, saveSession, clearSession } from "./browser/launch.js";
import { validateEnv } from "./utils/env.js";
import { log } from "./utils/log.js";
import { isSessionValid } from "./auth/session.js";
import { loginToUCPath, loginToACTCrm } from "./auth/login.js";
import type { LoginOptions, AuthResult } from "./auth/types.js";
import {
  searchByEmail,
  selectLatestResult,
  navigateToEntrySheet,
  extractRawFields,
  validateEmployeeData,
  ExtractionError,
} from "./extraction/index.js";

const program = new Command();

program
  .name("hr-auto")
  .description("UCPath HR Automation Tool")
  .version("0.1.0");

/**
 * Authenticate to a single system with its own browser/session.
 */
async function authSystem(
  name: string,
  sessionName: string,
  checkUrl: string,
  loginFn: (page: Page) => Promise<boolean>,
  fresh: boolean,
): Promise<boolean> {
  if (fresh) {
    clearSession(sessionName);
  }

  let { browser, context, page } = await launchBrowser(sessionName, fresh);

  try {
    // Check existing session
    if (!fresh) {
      const valid = await isSessionValid(page, checkUrl);
      if (valid) {
        log.success(`${name} session valid -- skipping login`);
        await saveSession(context, sessionName);
        await browser.close();
        return true;
      }
      // Stale session — relaunch clean
      log.step(`${name} session expired -- logging in`);
      clearSession(sessionName);
      await context.close();
      context = await browser.newContext();
      page = await context.newPage();
    }

    const ok = await loginFn(page);
    if (!ok) {
      log.error(`${name} authentication failed`);
      await browser.close();
      return false;
    }

    await saveSession(context, sessionName);
    await browser.close();
    return true;
  } catch (error) {
    try { await browser.close(); } catch {}
    throw error;
  }
}

/**
 * Run the full authentication flow: UCPath SSO + ACT CRM (separate sessions).
 */
async function runAuthFlow(
  options: LoginOptions,
): Promise<AuthResult> {
  const result: AuthResult = {
    ucpath: false,
    actCrm: false,
    sessionSaved: false,
  };

  // --- UCPath Authentication (own browser/session) ---
  result.ucpath = await authSystem(
    "UCPath",
    "ucpath",
    "https://ucphrprdpub.universityofcalifornia.edu/",
    loginToUCPath,
    options.fresh,
  );
  if (!result.ucpath) {
    process.exit(1);
  }

  // --- ACT CRM Authentication (own browser/session) ---
  result.actCrm = await authSystem(
    "ACT CRM",
    "actcrm",
    "https://act-crm.my.site.com",
    loginToACTCrm,
    options.fresh,
  );
  if (!result.actCrm) {
    process.exit(1);
  }

  result.sessionSaved = true;
  log.success("Session saved to .auth/");
  log.success("Authentication complete");
  log.step("UCPath: authenticated");
  log.step("ACT CRM: authenticated");

  return result;
}

program
  .command("test-login")
  .description("Test authentication to UCPath and ACT CRM")
  .option("--fresh", "Force fresh login (ignore saved session)")
  .action(async (opts: { fresh?: boolean }) => {
    const options: LoginOptions = { fresh: opts.fresh ?? false };

    try {
      // Validate .env FIRST -- fail early before launching browser
      validateEnv();
      log.success("Environment variables validated");
    } catch (error) {
      // validateEnv throws EnvValidationError with descriptive message
      process.exit(1);
    }

    try {
      await runAuthFlow(options);
    } catch (firstError) {
      // Browser crash / page load failure: retry ONCE
      log.error("Unexpected error -- retrying...");
      try {
        await runAuthFlow(options);
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

    const { browser, page } = await launchBrowser("actcrm");

    try {
      // Verify ACT CRM session is valid
      const valid = await isSessionValid(
        page,
        "https://act-crm.my.site.com",
      );
      if (!valid) {
        log.error("ACT CRM session expired -- run test-login first");
        await browser.close();
        process.exit(1);
      }

      log.step("Searching for employee...");
      await searchByEmail(page, email);

      log.step("Selecting latest result...");
      await selectLatestResult(page);

      log.step("Navigating to UCPath Entry Sheet...");
      await navigateToEntrySheet(page);

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
