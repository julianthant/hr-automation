import type { Page } from "playwright";
import { log } from "../utils/log.js";
import { waitForDuoApproval } from "./duo-wait.js";
import { validateEnv } from "../utils/env.js";

/**
 * Authenticate to UCPath through UCSD Shibboleth SSO with Duo MFA.
 *
 * Flow: Navigate to UCPath -> Click "Log in" -> Select UC San Diego ->
 *       Enter credentials on SSO page -> Wait for Duo approval -> Return
 *
 * @param page - Playwright page instance
 * @returns true if authentication succeeded, false otherwise
 */
export async function loginToUCPath(page: Page): Promise<boolean> {
  log.step("Navigating to UCPath...");
  await page.goto("https://ucpath.ucsd.edu", {
    waitUntil: "domcontentloaded",
    timeout: 15_000,
  });
  log.step("Login page loaded");

  // Click the "Log in to UCPath" link/button
  // SELECTOR: may need adjustment after live testing
  // PeopleSoft generates dynamic IDs -- use text-based locators
  const loginLink =
    page.getByRole("link", { name: /log in/i }).or(
      page.getByText("Log in to UCPath"),
    );
  await loginLink.first().click({ timeout: 10_000 });

  // If a campus/institution selector appears, select "UC San Diego"
  // SELECTOR: may need adjustment after live testing
  try {
    const campusOption = page.getByText("UC San Diego");
    await campusOption.click({ timeout: 5_000 });
  } catch {
    // Campus selector may not appear if UCPath redirects directly to UCSD SSO
    log.step("No campus selector -- proceeding to SSO");
  }

  // Wait for SSO login page to load (URL should contain "shibboleth" or "login.ucsd.edu")
  try {
    await page.waitForURL(
      (url) =>
        url.hostname.includes("shibboleth") ||
        url.hostname.includes("login.ucsd.edu") ||
        url.pathname.includes("/idp/"),
      { timeout: 10_000 },
    );
  } catch {
    // May already be on the SSO page or have a different URL pattern
    log.step("Proceeding with credential entry");
  }

  // Get credentials from validated env
  const { userId, password } = validateEnv();

  log.step("Entering credentials...");

  // Fill username field
  // SELECTOR: may need adjustment after live testing
  // SSO pages typically use name="j_username" or label "Username"
  const usernameField =
    page.getByLabel("Username").or(
      page.locator('input[name="j_username"]'),
    );
  await usernameField.first().fill(userId, { timeout: 5_000 });

  // Fill password field
  // SELECTOR: may need adjustment after live testing
  const passwordField =
    page.getByLabel("Password").or(
      page.locator('input[name="j_password"]'),
    );
  await passwordField.first().fill(password, { timeout: 5_000 });

  // Click submit/login button
  // SELECTOR: may need adjustment after live testing
  const submitButton = page.getByRole("button", {
    name: /log in|sign in|submit/i,
  });
  await submitButton.first().click({ timeout: 5_000 });

  // Wait for Duo MFA approval (first attempt)
  log.waiting("Waiting for Duo approval...");
  let approved = await waitForDuoApproval(
    page,
    "**/ucpath.ucsd.edu/**",
    15_000,
  );

  // Retry once if first attempt times out
  if (!approved) {
    log.waiting("Retrying -- waiting for Duo approval...");
    approved = await waitForDuoApproval(
      page,
      "**/ucpath.ucsd.edu/**",
      15_000,
    );
  }

  if (!approved) {
    log.error("Duo approval timed out after two attempts");
    return false;
  }

  log.success("UCPath authenticated");
  return true;
}

/**
 * Authenticate to ACT CRM onboarding portal.
 *
 * Checks if SSO session from UCPath carries over. If not, runs a
 * separate login flow with Active Directory option.
 *
 * @param page - Playwright page instance (should already be authenticated to UCPath)
 * @returns true if authentication succeeded, false otherwise
 */
export async function loginToACTCrm(page: Page): Promise<boolean> {
  log.step("Navigating to ACT CRM...");
  await page.goto("https://act-crm.my.site.com", {
    waitUntil: "domcontentloaded",
    timeout: 15_000,
  });

  // Check if already authenticated (SSO session may carry over from UCPath)
  const currentUrl = page.url();
  if (!currentUrl.includes("login")) {
    log.success("ACT CRM already authenticated (SSO session)");
    return true;
  }

  // Login page detected -- need separate authentication
  log.step("ACT CRM requires separate login");

  // Look for "Active Directory" option in login dropdown
  // SELECTOR: may need adjustment after live testing
  // Salesforce Experience Cloud may use a custom component or native select
  try {
    // Try clicking a visible "Active Directory" text option first
    const adOption = page.getByText("Active Directory");
    await adOption.click({ timeout: 5_000 });
  } catch {
    // If text click fails, try selecting from a dropdown/select element
    try {
      await page
        .locator("select")
        .first()
        .selectOption({ label: "Active Directory" });
    } catch {
      // SELECTOR: may need adjustment -- log but continue
      log.step("Active Directory selector not found -- attempting direct login");
    }
  }

  // Get credentials
  const { userId, password } = validateEnv();

  log.step("Entering credentials...");

  // Fill username field
  // SELECTOR: may need adjustment after live testing
  // Salesforce login forms typically use name="username" and name="password"
  const usernameField =
    page.locator('input[name="username"]').or(
      page.getByLabel("Username"),
    );
  await usernameField.first().fill(userId, { timeout: 5_000 });

  // Fill password field
  // SELECTOR: may need adjustment after live testing
  const passwordField =
    page.locator('input[name="password"]').or(
      page.getByLabel("Password"),
    );
  await passwordField.first().fill(password, { timeout: 5_000 });

  // Click login button
  // SELECTOR: may need adjustment after live testing
  const loginButton = page.getByRole("button", {
    name: /log in|sign in|submit/i,
  });
  await loginButton.first().click({ timeout: 5_000 });

  // Wait for Duo MFA approval (if triggered for ACT CRM)
  log.waiting("Waiting for Duo approval...");
  let approved = await waitForDuoApproval(
    page,
    "**/*.my.site.com/**",
    15_000,
  );

  // Retry once if first attempt times out
  if (!approved) {
    log.waiting("Retrying -- waiting for Duo approval...");
    approved = await waitForDuoApproval(
      page,
      "**/*.my.site.com/**",
      15_000,
    );
  }

  if (!approved) {
    log.error("ACT CRM Duo approval timed out");
    return false;
  }

  log.success("ACT CRM authenticated");
  return true;
}
