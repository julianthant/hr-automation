import type { Page } from "playwright";
import { log } from "../utils/log.js";

/**
 * Wait for Duo MFA approval by polling for URL change.
 *
 * The user approves Duo on their phone during this window.
 * We detect completion when the page URL matches the success pattern
 * (indicating redirect back to the application after MFA).
 *
 * @param page - Playwright page instance
 * @param successUrlPattern - Glob pattern for the post-MFA URL (e.g., "**​/ucpath.ucsd.edu/**")
 * @param timeoutMs - Max wait time in milliseconds (default: 15_000)
 * @returns true if MFA approved within timeout, false on timeout
 */
export async function waitForDuoApproval(
  page: Page,
  successUrlPattern: string,
  timeoutMs: number = 15_000,
): Promise<boolean> {
  try {
    await page.waitForURL(successUrlPattern, { timeout: timeoutMs });
    return true;
  } catch {
    // Timed out waiting for Duo approval -- caller decides retry or exit
    return false;
  }
}
