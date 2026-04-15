import type { Page } from "playwright";
import { log } from "../../utils/log.js";
import { validateEnv } from "../../utils/env.js";
import { I9_URL } from "../../config.js";

/**
 * Authenticate to I9 Complete (Tracker I-9 by Mitratech).
 *
 * Two-step login: email first, then password.
 * Uses UCPATH_USER_ID@ucsd.edu as the email and UCPATH_PASSWORD.
 * No Duo MFA — standard email/password auth.
 *
 * After login, domain changes from stse.i9complete.com to wwwe.i9complete.com.
 * A training notification popup appears and must be dismissed.
 */
export async function loginToI9(page: Page): Promise<boolean> {
  const { userId, password } = validateEnv();
  const email = userId.includes("@") ? userId : `${userId}@ucsd.edu`;

  log.step("Navigating to I9 Complete...");
  await page.goto(I9_URL, { waitUntil: "domcontentloaded", timeout: 15_000 });
  log.step(`Login page loaded | URL: ${page.url()}`);

  // Step 1: Fill email and click Next
  await page.getByRole("textbox", { name: "Username or Email*" }).fill(email, { timeout: 5_000 });
  await page.getByRole("button", { name: "Next" }).click({ timeout: 5_000 });
  log.step("Email entered, clicked Next");

  // Step 2: Fill password and click Log in
  await page.getByRole("textbox", { name: "Password*" }).fill(password, { timeout: 5_000 });
  await page.getByRole("button", { name: "Log in" }).click({ timeout: 10_000 });
  log.step("Password entered, clicking Log in...");

  // Wait for post-login navigation (domain changes to wwwe.i9complete.com)
  await page.waitForURL((url) => url.hostname.includes("wwwe.i9complete.com"), { timeout: 15_000 });
  log.step(`Logged in | URL: ${page.url()}`);

  // Dismiss training notification if present
  await dismissTrainingNotification(page);

  log.success("I9 Complete authenticated");
  return true;
}

/**
 * Dismiss the "Required Training Notification" popup that appears after login.
 * Clicks "Dismiss the Notification" then confirms "Yes".
 */
async function dismissTrainingNotification(page: Page): Promise<void> {
  try {
    const dismissBtn = page.getByRole("button", { name: "Dismiss the Notification" });
    await dismissBtn.click({ timeout: 5_000 });
    log.step("Dismissing training notification...");

    // Confirm the dismiss dialog
    const yesBtn = page.getByRole("button", { name: "Yes" });
    await yesBtn.click({ timeout: 5_000 });
    log.step("Training notification dismissed");

    // Wait for dashboard to load
    await page.waitForURL((url) => url.pathname === "/" || url.search.includes("mobile=false"), { timeout: 10_000 });
  } catch {
    // No notification — already on dashboard
    log.step("No training notification — continuing");
  }
}
