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

  // Click the "Log in to UCPath" button in the main banner
  // The page has a hidden nav link AND a visible banner button -- target the button
  const loginButton =
    page.getByRole("button", { name: /log in to ucpath/i }).or(
      page.getByRole("link", { name: /log in to ucpath/i }),
    );
  await loginButton.first().click({ timeout: 10_000 });

  // UC-wide identity provider discovery page -- select UCSD campus
  log.step("Selecting UC San Diego...");
  const campusLink = page.getByRole("link", {
    name: "University of California, San Diego",
  });
  await campusLink.click({ timeout: 10_000 });

  // Wait for UCSD SSO login page (a5.ucsd.edu/tritON)
  await page.waitForURL(
    (url) => url.hostname.includes("a5.ucsd.edu"),
    { timeout: 15_000 },
  );
  log.step("SSO login page loaded");

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

  // Click the "Login" button on UCSD SSO page
  const submitButton = page.getByRole("button", {
    name: /^login$|log in|sign in|submit/i,
  });
  await submitButton.first().click({ timeout: 5_000 });

  // Wait for Duo MFA approval — after Duo, redirects to ucphrprdpub.universityofcalifornia.edu
  // Give user 120s total (60s + 60s retry) to approve on their phone
  log.waiting("Waiting for Duo approval (approve on your phone)...");
  let approved = await waitForDuoApproval(
    page,
    "**/*universityofcalifornia.edu/**",
    60_000,
  );

  if (!approved) {
    log.waiting("Still waiting for Duo approval...");
    approved = await waitForDuoApproval(
      page,
      "**/*universityofcalifornia.edu/**",
      60_000,
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
 * Authenticate to ACT CRM onboarding portal via Salesforce Active Directory login.
 *
 * Flow: Navigate to crm.ucsd.edu/hr -> Salesforce login page ->
 *       Select "Active Directory" from dropdown -> Enter credentials ->
 *       Duo MFA -> Redirects to act-crm.my.site.com
 *
 * This is a SEPARATE auth system from UCPath (no shared SSO).
 */
export async function loginToACTCrm(page: Page): Promise<boolean> {
  const ss = async (name: string) => {
    await page.screenshot({ path: `.auth/debug-${name}.png`, fullPage: true });
    log.step(`Screenshot: .auth/debug-${name}.png (${page.url()})`);
  };

  log.step("Navigating to ACT CRM onboarding portal...");
  await page.goto("https://crm.ucsd.edu/hr", {
    waitUntil: "domcontentloaded",
    timeout: 15_000,
  });
  await page.waitForLoadState("networkidle", { timeout: 15_000 });
  await ss("01-after-navigate");

  const currentUrl = page.url();
  if (currentUrl.includes("act-crm.my.site.com") && !currentUrl.includes("login")) {
    log.success("ACT CRM already authenticated");
    return true;
  }

  // Select Active Directory
  log.step("Selecting Active Directory login...");
  try {
    const adOption = page.getByText("Active Directory");
    await adOption.click({ timeout: 5_000 });
  } catch {
    try {
      await page
        .locator("select")
        .first()
        .selectOption({ label: "Active Directory" });
    } catch {
      log.step("Active Directory selector not found -- attempting direct login");
    }
  }

  // Wait for SSO Active Directory login page (e1s2)
  await page.waitForURL(
    (url) => url.hostname.includes("a5.ucsd.edu"),
    { timeout: 10_000 },
  );
  await page.waitForLoadState("networkidle", { timeout: 10_000 });
  await ss("02-sso-page");

  const { userId, password } = validateEnv();

  log.step("Entering credentials...");
  const usernameField =
    page.getByLabel("User name (or email address)").or(
      page.locator('input[name="j_username"]'),
    );
  await usernameField.first().fill(userId, { timeout: 5_000 });

  const passwordField =
    page.getByLabel("Password:").or(
      page.locator('input[name="j_password"]'),
    );
  await passwordField.first().fill(password, { timeout: 5_000 });
  await ss("03-credentials-filled");

  const loginButton = page.getByRole("button", { name: "LOGIN" });
  await loginButton.first().click({ timeout: 5_000 });

  // Wait a moment for Duo or redirect
  await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
  await ss("04-after-login-click");

  // Wait for Duo MFA approval — after Duo, redirects to act-crm.my.site.com
  log.waiting("Waiting for Duo approval (approve on your phone)...");
  let approved = await waitForDuoApproval(
    page,
    "**/*crm*/**",
    60_000,
  );

  if (!approved) {
    await ss("05-duo-timeout-1");
    log.waiting("Still waiting for Duo approval...");
    approved = await waitForDuoApproval(
      page,
      "**/*crm*/**",
      60_000,
    );
  }

  if (!approved) {
    await ss("06-duo-timeout-2");
    log.error("ACT CRM Duo approval timed out");
    return false;
  }

  await ss("07-authenticated");
  log.success("ACT CRM authenticated");
  return true;
}
