import type { Page } from "playwright";
import { log } from "../utils/log.js";

/**
 * Check whether a saved session is still valid for a given target URL.
 *
 * Navigates to the target URL and checks if we land on the app
 * or get redirected to a login/SSO page.
 *
 * @param page - Playwright page instance (should be in a context with loaded storageState)
 * @param targetUrl - The application URL to check (e.g., "https://ucpath.ucsd.edu")
 * @returns true if session is valid (not redirected to login), false otherwise
 */
export async function isSessionValid(
  page: Page,
  targetUrl: string,
): Promise<boolean> {
  try {
    await page.goto(targetUrl, {
      waitUntil: "domcontentloaded",
      timeout: 10_000,
    });

    const currentUrl = page.url();

    // If we ended up on a login/SSO/IdP page, the session is NOT valid
    const isOnLoginPage =
      currentUrl.includes("shibboleth") ||
      currentUrl.includes("login") ||
      currentUrl.includes("idp") ||
      currentUrl.includes("a5.ucsd.edu") ||
      currentUrl.includes("disco.php") ||
      currentUrl.includes("simplesaml");

    if (isOnLoginPage) {
      log.step("Session expired -- login required");
      return false;
    }

    return true;
  } catch {
    // Network failure, timeout, or other error -- treat as invalid session
    log.step("Could not verify session -- will attempt login");
    return false;
  }
}
