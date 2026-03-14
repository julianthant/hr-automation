import type { Page, FrameLocator } from "playwright";
import { log } from "../utils/log.js";

// SELECTOR: URL to be discovered during live testing -- this is a best-guess from PeopleSoft URL convention
const SMART_HR_URL =
  "https://ucpath.universityofcalifornia.edu/psc/ucpathprd/EMPLOYEE/ERP/c/WORKFORCE_ADMIN.HR_TBH_EULIST.GBL";

/**
 * Returns the PeopleSoft content iframe FrameLocator.
 * PeopleSoft wraps all Classic/Classic Plus content in this iframe.
 * Every form interaction after initial navigation must go through this frame.
 */
export function getContentFrame(page: Page): FrameLocator {
  return page.frameLocator("#ptifrmtgtframe");
}

/**
 * Waits for PeopleSoft spinner/processing indicators to appear then disappear.
 * Catches errors silently since the spinner may not appear for every action.
 *
 * @param frame - PeopleSoft content iframe FrameLocator
 * @param timeoutMs - Maximum time to wait (default 10_000ms)
 */
export async function waitForPeopleSoftProcessing(
  frame: FrameLocator,
  timeoutMs = 10_000,
): Promise<void> {
  // SELECTOR: PeopleSoft processing indicators -- adjust after live testing
  const processingSelector =
    "#processing, #WAIT_win0, .ps_box-processing, [id*='PROCESSING']";

  try {
    // Wait for spinner to appear (short timeout -- it may not appear at all)
    await frame
      .locator(processingSelector)
      .first()
      .waitFor({ state: "visible", timeout: 2_000 });

    // Spinner appeared -- wait for it to disappear
    await frame
      .locator(processingSelector)
      .first()
      .waitFor({ state: "hidden", timeout: timeoutMs });
  } catch {
    // Spinner did not appear or already disappeared -- that is fine
  }
}

/**
 * Navigate to the Smart HR Transactions page in UCPath.
 *
 * Strategy A (preferred, per user URL-param preference): Direct URL navigation.
 * Strategy B (fallback): Menu navigation through HR Tasks tiles.
 *
 * @param page - Playwright page instance (already authenticated to UCPath)
 */
export async function navigateToSmartHR(page: Page): Promise<void> {
  log.step("Navigating to Smart HR Transactions...");

  // Strategy A: Direct URL navigation (preferred per feedback_url_params.md)
  try {
    log.step("Trying direct URL navigation...");
    await page.goto(SMART_HR_URL, {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });
    await page.waitForLoadState("networkidle", { timeout: 30_000 });
    log.success("Smart HR Transactions page loaded via direct URL");
    return;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.step(`Direct URL navigation failed: ${msg}`);
    log.step("Falling back to menu navigation...");
  }

  // Strategy B: Menu navigation fallback
  // SELECTOR: HR Tasks tile -- adjust after live testing
  log.step("Clicking HR Tasks tile...");
  const hrTasksLink = page
    .getByRole("link", { name: /HR Tasks/i })
    .or(page.getByText("HR Tasks"));
  await hrTasksLink.first().click({ timeout: 15_000 });
  await page.waitForLoadState("networkidle", { timeout: 15_000 });

  // SELECTOR: Smart HR Templates link -- adjust after live testing
  log.step("Clicking Smart HR Templates...");
  await page.getByText("Smart HR Templates").click({ timeout: 15_000 });
  await page.waitForLoadState("networkidle", { timeout: 15_000 });

  // SELECTOR: Smart HR Transactions link -- adjust after live testing
  log.step("Clicking Smart HR Transactions...");
  await page.getByText("Smart HR Transactions").click({ timeout: 15_000 });
  await page.waitForLoadState("networkidle", { timeout: 15_000 });

  log.success("Smart HR Transactions page loaded via menu navigation");
}
