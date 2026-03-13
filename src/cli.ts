import { Command } from "commander";
import { launchBrowser, saveSession, clearSession } from "./browser/launch.js";
import { validateEnv } from "./utils/env.js";
import { log } from "./utils/log.js";
import { isSessionValid } from "./auth/session.js";
import { loginToUCPath, loginToACTCrm } from "./auth/login.js";
import type { LoginOptions, AuthResult } from "./auth/types.js";

const program = new Command();

program
  .name("hr-auto")
  .description("UCPath HR Automation Tool")
  .version("0.1.0");

/**
 * Run the full authentication flow: UCPath SSO + ACT CRM.
 * Returns the auth result or throws on unrecoverable error.
 */
async function runAuthFlow(
  options: LoginOptions,
): Promise<AuthResult> {
  const result: AuthResult = {
    ucpath: false,
    actCrm: false,
    sessionSaved: false,
  };

  // If --fresh flag, clear any saved session first
  if (options.fresh) {
    clearSession();
  }

  // Launch browser (with or without saved state)
  let { browser, context, page } = await launchBrowser(options.fresh);

  try {
    // --- UCPath Authentication ---
    if (!options.fresh) {
      const ucpathSessionValid = await isSessionValid(
        page,
        "https://ucpath.ucsd.edu",
      );

      if (ucpathSessionValid) {
        log.success("UCPath session valid -- skipping login");
        result.ucpath = true;
      } else {
        // Session stale: clear, close context, relaunch without saved state
        log.step("Stale session detected -- clearing and retrying");
        clearSession();
        await context.close();
        const fresh = await browser.newContext();
        context = fresh;
        page = await fresh.newPage();
      }
    }

    if (!result.ucpath) {
      const ucpathOk = await loginToUCPath(page);
      if (!ucpathOk) {
        log.error("UCPath authentication failed");
        await browser.close();
        process.exit(1);
      }
      result.ucpath = true;
    }

    // --- ACT CRM Authentication ---
    const actSessionValid = await isSessionValid(
      page,
      "https://act-crm.my.site.com",
    );

    if (actSessionValid) {
      log.success("ACT CRM session valid -- skipping login");
      result.actCrm = true;
    } else {
      const actOk = await loginToACTCrm(page);
      if (!actOk) {
        log.error("ACT CRM authentication failed");
        await browser.close();
        process.exit(1);
      }
      result.actCrm = true;
    }

    // --- Save Session ---
    await saveSession(context);
    log.success("Session saved to .auth/");
    result.sessionSaved = true;

    // --- Summary ---
    log.success("Authentication complete");
    log.step("UCPath: authenticated");
    log.step("ACT CRM: authenticated");

    // Close browser after successful test-login
    await browser.close();

    return result;
  } catch (error) {
    // Close browser on unexpected error, then rethrow for retry logic
    try {
      await browser.close();
    } catch {
      // Browser may already be closed
    }
    throw error;
  }
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

program.parse();
