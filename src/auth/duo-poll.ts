import type { Page } from "playwright";
import { log } from "../utils/log.js";

/**
 * Options for polling Duo MFA approval.
 */
export interface DuoPollOptions {
  /**
   * How long to wait total before timing out.
   * Default: 180 seconds.
   */
  timeoutSeconds?: number;

  /**
   * Determines whether the current URL indicates successful authentication.
   * Pass a string for a simple substring match, or a function for custom logic.
   */
  successUrlMatch: string | ((url: string) => boolean);

  /**
   * Optional additional verification beyond URL matching.
   * Called when the URL check passes — return false to keep polling.
   */
  successCheck?: (page: Page) => Promise<boolean>;

  /**
   * Optional async hook executed once after approval is confirmed.
   * Runs before pollDuoApproval returns true.
   */
  postApproval?: (page: Page) => Promise<void>;

  /**
   * Optional recovery callback — runs each poll iteration to handle mid-auth errors
   * (e.g., SAML redirects in Kuali, #failedLogin in New Kronos).
   */
  recovery?: (page: Page) => Promise<void>;
}

/**
 * Unified Duo MFA polling loop.
 *
 * Replaces the 5 near-identical polling loops in login.ts:
 * - loginToUCPath
 * - loginToACTCrm (via ukgSubmitAndWaitForDuo)
 * - ukgSubmitAndWaitForDuo
 * - loginToKuali
 * - loginToNewKronos
 *
 * Every 2 seconds, the loop:
 * 1. Checks for "Yes, this is my device" trust button and clicks it
 * 2. Checks if the current URL satisfies successUrlMatch
 * 3. If URL matches, optionally runs successCheck for additional verification
 * 4. On success, runs postApproval hook then returns true
 *
 * @param page - Playwright page instance
 * @param options - Polling configuration
 * @returns true if Duo approved within timeout, false otherwise
 */
export async function pollDuoApproval(
  page: Page,
  options: DuoPollOptions,
): Promise<boolean> {
  const { timeoutSeconds = 180, successUrlMatch, successCheck, postApproval, recovery } = options;

  const urlMatches = (url: string): boolean => {
    if (typeof successUrlMatch === "string") {
      return url.includes(successUrlMatch);
    }
    return successUrlMatch(url);
  };

  log.waiting("Waiting for Duo approval (approve on your phone)...");

  for (let elapsed = 0; elapsed < timeoutSeconds; elapsed += 2) {
    try {
      // Run optional recovery callback to handle mid-auth errors (e.g., SAML redirects)
      if (recovery) {
        log.step("Duo: running mid-auth recovery check...");
        await recovery(page).catch(() => {});
      }

      // Check for "Yes, this is my device" trust button and click it
      const trustButton = page.getByText("Yes, this is my device");
      if ((await trustButton.count()) > 0) {
        log.step('Clicking "Yes, this is my device"...');
        await trustButton.click({ timeout: 5_000 });
        log.step('Duo: clicked "Yes, this is my device" trust button');
      }

      // Check if the URL indicates successful auth
      if (urlMatches(page.url())) {
        // Run optional additional verification
        if (successCheck) {
          const verified = await successCheck(page);
          if (!verified) {
            await page.waitForTimeout(2_000);
            continue;
          }
        }

        log.step(`Duo approved | URL: ${page.url()}`);

        // Run post-approval hook if provided
        if (postApproval) {
          await postApproval(page);
        }

        return true;
      }
    } catch {
      // Page may be navigating — swallow and retry
    }

    await page.waitForTimeout(2_000);
  }

  log.error("Duo approval timed out");
  return false;
}
