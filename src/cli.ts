import { Command } from "commander";
import type { Browser, BrowserContext, Page } from "playwright";
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
} from "./onboarding/index.js";

const program = new Command();

program
  .name("hr-auto")
  .description("UCPath HR Automation Tool")
  .version("0.1.0");

/**
 * Ensure authenticated to a system. Checks saved session first,
 * logs in if expired. All in one browser — no separate auth step needed.
 */
async function ensureAuth(
  sessionName: string,
  checkUrl: string,
  loginFn: (page: Page) => Promise<boolean>,
  fresh: boolean,
): Promise<{ browser: Browser; context: BrowserContext; page: Page }> {
  if (fresh) {
    clearSession(sessionName);
  }

  const { browser, context: initialCtx, page: initialPage } =
    await launchBrowser(sessionName, fresh);

  // Check existing session
  if (!fresh) {
    const valid = await isSessionValid(initialPage, checkUrl);
    if (valid) {
      log.success(`Session valid -- skipping login`);
      return { browser, context: initialCtx, page: initialPage };
    }
  }

  // Session expired — relaunch clean and login
  log.step("Session expired -- logging in...");
  clearSession(sessionName);
  await initialCtx.close();
  const context = await browser.newContext();
  const page = await context.newPage();

  const ok = await loginFn(page);
  if (!ok) {
    await browser.close();
    log.error("Authentication failed");
    process.exit(1);
  }

  await saveSession(context, sessionName);
  return { browser, context, page };
}

/**
 * Run the full authentication flow: UCPath + ACT CRM (separate sessions, separate browsers).
 */
async function runAuthFlow(
  options: LoginOptions,
): Promise<AuthResult> {
  const result: AuthResult = {
    ucpath: false,
    actCrm: false,
    sessionSaved: false,
  };

  // --- UCPath Authentication ---
  const ucpath = await ensureAuth(
    "ucpath",
    "https://ucphrprdpub.universityofcalifornia.edu/",
    loginToUCPath,
    options.fresh,
  );
  await ucpath.browser.close();
  result.ucpath = true;

  // --- ACT CRM Authentication (separate session, Active Directory login) ---
  const actCrm = await ensureAuth(
    "onboarding",
    "https://crm.ucsd.edu/hr",
    loginToACTCrm,
    options.fresh,
  );
  await actCrm.browser.close();
  result.actCrm = true;

  result.sessionSaved = true;
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

    // Single browser: auth + extraction in one session
    const { browser, context, page } = await ensureAuth(
      "onboarding",
      "https://crm.ucsd.edu/hr",
      loginToACTCrm,
      false,
    );

    try {
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
