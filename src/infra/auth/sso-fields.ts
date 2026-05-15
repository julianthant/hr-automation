import type { Page } from "playwright";
import { validateEnv } from "../../utils/env.js";
import { log } from "../../utils/log.js";

/**
 * Fill UCSD Shibboleth SSO credentials (username + password) on the current page.
 *
 * Builds 3-level .or() fallback chains for both fields, then calls validateEnv()
 * to retrieve credentials from environment and fills them.
 *
 * @param page - Playwright page instance (must already be on the SSO login page)
 */
export async function fillSsoCredentials(page: Page): Promise<void> {
  const { userId, password } = validateEnv();

  log.step("Entering credentials...");

  const usernameField =
    page.getByLabel("User name (or email address)")
      .or(page.getByLabel("Username"))
      .or(page.locator('input[name="j_username"]'));
  await usernameField.first().fill(userId, { timeout: 5_000 });

  const passwordField =
    page.getByLabel("Password:")
      .or(page.getByLabel("Password"))
      .or(page.locator('input[name="j_password"]'));
  await passwordField.first().fill(password, { timeout: 5_000 });
  await page.waitForTimeout(500);
  log.step("SSO: credentials filled via 3-level fallback chain");
}

const SSO_SUBMIT_SELECTOR = 'button[name="_eventId_proceed"]';

/**
 * Click the SSO form submit button.
 *
 * Uses `button[name="_eventId_proceed"]` to avoid collision with the
 * "Enroll in Two-Step Login" nav link which also has role="button".
 *
 * @param page - Playwright page instance
 */
export async function clickSsoSubmit(page: Page): Promise<void> {
  await page.locator(SSO_SUBMIT_SELECTOR).click({ timeout: 5_000 });
  log.step("SSO submit clicked");
}

/**
 * True if the SSO submit button is currently on the page. Used to detect
 * whether a prepared (navigated + credentials-filled) page is still at the
 * SSO form, or whether Shibboleth's anti-CSRF token has expired and
 * re-navigation is needed.
 *
 * Shibboleth tokens typically live 5–10 minutes. When a downstream system
 * has been sitting pre-filled while earlier Duos are approved, the form
 * can drift out of that window — detected here as "submit button missing".
 */
export async function isSsoFormReady(page: Page): Promise<boolean> {
  try {
    const count = await page.locator(SSO_SUBMIT_SELECTOR).count();
    return count > 0;
  } catch {
    return false;
  }
}
