import { existsSync } from "node:fs";

/**
 * Setup for the LIVE integration pool. Loads the real operator `.env` (UCPath
 * creds, TIMEKEEPER_NAME so `src/config.ts` doesn't throw on import) and turns
 * on hands-off Duo, since unattended logins are the entire point of this pool.
 *
 * Runs before any test-file import, so `src/config.ts` (loaded transitively via
 * the login flows) sees the env it requires.
 *
 * Override knobs:
 *   - HR_TEST_HEADED=1        run headed instead of headless (visible window)
 *   - HR_AUTOMATION_DUO_WEBAUTHN=0  force manual Duo (not recommended in tests)
 */
if (existsSync(".env")) {
  // Node >=26 (see package.json engines) ships process.loadEnvFile.
  process.loadEnvFile(".env");
}

if (process.env.HR_AUTOMATION_DUO_WEBAUTHN === undefined) {
  process.env.HR_AUTOMATION_DUO_WEBAUTHN = "1";
}
