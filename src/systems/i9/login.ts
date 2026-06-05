import type { Page } from "playwright";
import { log } from "../../utils/log.js";
import { validateI9Env } from "../../utils/env.js";
import { I9_URL } from "../../config.js";
import { login as loginSelectors } from "./selectors.js";
import { safeClick, safeFill } from "../common/index.js";

/**
 * Authenticate to I9 Complete (Tracker I-9 by Mitratech).
 *
 * Two-step login: email first, then password.
 * Uses I9_USER_ID + I9_PASSWORD when set, otherwise falls back to
 * UCPATH_USER_ID@ucsd.edu + UCPATH_PASSWORD.
 * No Duo MFA — standard email/password auth.
 *
 * After login, domain changes from stse.i9complete.com to wwwe.i9complete.com.
 * A training notification popup appears and must be dismissed.
 */
export async function loginToI9(page: Page): Promise<boolean> {
  const { userId, password } = validateI9Env();
  const email = userId.includes("@") ? userId : `${userId}@ucsd.edu`;

  log.step("Navigating to I9 Complete...");
  await page.goto(I9_URL, { waitUntil: "domcontentloaded", timeout: 15_000 });
  log.step(`Login page loaded | URL: ${page.url()}`);

  // Step 1: Fill email and click Next
  await safeFill(loginSelectors.usernameInput(page), email, {
    timeout: 5_000,
    label: "i9 login username",
  });
  await safeClick(loginSelectors.nextButton(page), {
    timeout: 5_000,
    label: "i9 login next button",
  });
  log.step("Email entered, clicked Next");

  // Step 2: Fill password and click Log in
  await safeFill(loginSelectors.passwordInput(page), password, {
    timeout: 5_000,
    label: "i9 login password",
  });
  await safeClick(loginSelectors.loginButton(page), {
    timeout: 10_000,
    label: "i9 login button",
  });
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
    const dismissBtn = loginSelectors.dismissNotificationButton(page);
    await safeClick(dismissBtn, { timeout: 5_000, label: "i9 training dismiss button" });
    log.step("Dismissing training notification...");

    // Confirm the dismiss dialog
    await safeClick(loginSelectors.confirmYesButton(page), {
      timeout: 5_000,
      label: "i9 confirm yes button",
    });
    log.step("Training notification dismissed");

    // Wait for dashboard to load
    await page.waitForURL((url) => url.pathname === "/" || url.search.includes("mobile=false"), { timeout: 10_000 });
  } catch {
    // No notification — already on dashboard
    log.step("No training notification — continuing");
  }
}
