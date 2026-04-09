import type { Page } from "playwright";
import { validateEnv } from "../utils/env.js";
import { log } from "../utils/log.js";

/**
 * Returns selector configuration for standard UCSD Shibboleth SSO forms.
 *
 * All UCSD SSO forms (UCPath, ACT CRM, Kuali, New Kronos) use the same
 * 3-level fallback selectors for username and password fields.
 */
export function getSsoFieldSelectors(): {
  usernameLabels: [string, string, string];
  passwordLabels: [string, string, string];
  submitSelector: string;
} {
  return {
    usernameLabels: [
      "User name (or email address)",
      "Username",
      'input[name="j_username"]',
    ],
    passwordLabels: [
      "Password:",
      "Password",
      'input[name="j_password"]',
    ],
    submitSelector: 'button[name="_eventId_proceed"]',
  };
}

/**
 * Returns selector configuration for UKG (Old Kronos) SSO login form.
 *
 * UKG uses different field IDs (#ssousername, #ssopassword) compared to
 * the standard UCSD Shibboleth SSO form.
 */
export function getUkgFieldSelectors(): {
  usernameSelector: string;
  passwordSelector: string;
  submitSelector: string;
} {
  return {
    usernameSelector: "#ssousername",
    passwordSelector: "#ssopassword",
    submitSelector: 'button[name="_eventId_proceed"]',
  };
}

/**
 * Fill UCSD Shibboleth SSO credentials (username + password) on the current page.
 *
 * Builds 3-level .or() fallback chains for both fields, then calls validateEnv()
 * to retrieve credentials from environment and fills them.
 *
 * @param page - Playwright page instance (must already be on the SSO login page)
 */
export async function fillSsoCredentials(page: Page): Promise<void> {
  const { usernameLabels, passwordLabels } = getSsoFieldSelectors();
  const { userId, password } = validateEnv();

  log.step("Entering credentials...");

  // Build username field with 3-level fallback
  const usernameField =
    page.getByLabel(usernameLabels[0])
      .or(page.getByLabel(usernameLabels[1]))
      .or(page.locator(usernameLabels[2]));
  await usernameField.first().fill(userId, { timeout: 5_000 });

  // Build password field with 3-level fallback
  const passwordField =
    page.getByLabel(passwordLabels[0])
      .or(page.getByLabel(passwordLabels[1]))
      .or(page.locator(passwordLabels[2]));
  await passwordField.first().fill(password, { timeout: 5_000 });
}

/**
 * Click the SSO form submit button.
 *
 * Uses `button[name="_eventId_proceed"]` to avoid collision with the
 * "Enroll in Two-Step Login" nav link which also has role="button".
 *
 * @param page - Playwright page instance
 */
export async function clickSsoSubmit(page: Page): Promise<void> {
  const { submitSelector } = getSsoFieldSelectors();
  await page.locator(submitSelector).click({ timeout: 5_000 });
}
