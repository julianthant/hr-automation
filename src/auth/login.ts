import type { Page } from "playwright";
import { log } from "../utils/log.js";
import { waitForDuoApproval } from "./duo-wait.js";
import { validateEnv } from "../utils/env.js";

/**
 * Take a debug screenshot and log the path + current URL.
 */
async function ss(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: `.auth/debug-${name}.png`, fullPage: true });
  log.step(`Screenshot: .auth/debug-${name}.png (${page.url()})`);
}

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
  // SELECTOR: adjusted after live testing -- button OR link
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
  // SELECTOR: adjusted after live testing -- "User name (or email address)" label
  const usernameField =
    page.getByLabel("User name (or email address)").or(
      page.getByLabel("Username"),
    ).or(
      page.locator('input[name="j_username"]'),
    );
  await usernameField.first().fill(userId, { timeout: 5_000 });

  // Fill password field
  // SELECTOR: adjusted after live testing -- "Password:" label with colon
  const passwordField =
    page.getByLabel("Password:").or(
      page.getByLabel("Password"),
    ).or(
      page.locator('input[name="j_password"]'),
    );
  await passwordField.first().fill(password, { timeout: 5_000 });

  // Click the actual form submit button (not the "Enroll in Two-Step Login" nav link
  // which also has role="button" and contains "Login" in its text)
  // SELECTOR: adjusted after live testing -- target by name attribute to avoid nav link match
  await page.locator('button[name="_eventId_proceed"]').click({ timeout: 5_000 });

  // After clicking LOGIN, the SSO may:
  //   a) Show a Duo iframe on the same page
  //   b) Redirect to duosecurity.com (Duo Universal Prompt)
  //   c) Redirect directly to the app if Duo is remembered
  // Wait for either Duo challenge or the target app URL
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
 *       Active Directory is pre-selected -> Enter credentials ->
 *       Wait for Duo MFA -> Redirects to act-crm.my.site.com
 *
 * This is a SEPARATE auth system from UCPath (no shared SSO).
 *
 * FIXED: The "Enroll in Two-Step Login" nav link has role="button" and contained
 * "Login" in its text, causing getByRole("button", { name: "LOGIN" }) to match it
 * instead of the actual form submit button. Fix: target button[name="_eventId_proceed"].
 */
export async function loginToACTCrm(page: Page): Promise<boolean> {
  log.step("Navigating to ACT CRM onboarding portal...");
  await page.goto("https://crm.ucsd.edu/hr", {
    waitUntil: "domcontentloaded",
    timeout: 15_000,
  });
  await page.waitForLoadState("networkidle", { timeout: 15_000 });
  await ss(page, "01-after-navigate");

  const currentUrl = page.url();
  if (currentUrl.includes("act-crm.my.site.com") && !currentUrl.includes("login")) {
    log.success("ACT CRM already authenticated");
    return true;
  }

  // The login page may already show "Active Directory" pre-selected,
  // or it may need to be selected from a dropdown.
  // SELECTOR: adjusted after live testing -- check if AD dropdown needs selection
  log.step("Checking Active Directory selection...");
  try {
    // Try selecting from dropdown first (seen on the SSO page)
    const adDropdown = page.locator("select");
    const dropdownCount = await adDropdown.count();
    if (dropdownCount > 0) {
      const currentValue = await adDropdown.first().inputValue();
      if (!currentValue.includes("Active Directory")) {
        await adDropdown.first().selectOption({ label: "Active Directory" });
        log.step("Selected Active Directory from dropdown");
      } else {
        log.step("Active Directory already selected");
      }
    }
  } catch {
    // No dropdown -- AD might be the only option or selected by default
    log.step("No login type dropdown found -- proceeding");
  }

  // Wait for SSO Active Directory login page (a5.ucsd.edu)
  // If we're not already on the SSO page, navigate may be needed
  const onSsoPage = page.url().includes("a5.ucsd.edu");
  if (!onSsoPage) {
    // The initial navigate to crm.ucsd.edu/hr should redirect to SSO
    // If it didn't, wait for the redirect to complete
    try {
      await page.waitForURL(
        (url) => url.hostname.includes("a5.ucsd.edu"),
        { timeout: 10_000 },
      );
    } catch {
      // May already be on a login page that's not a5.ucsd.edu
      log.step(`Current page: ${page.url()} -- attempting login`);
    }
  }
  await ss(page, "02-sso-page");

  const { userId, password } = validateEnv();

  log.step("Entering credentials...");
  // SELECTOR: adjusted after live testing -- matches debug-03 screenshot
  // Label text is "User name (or email address)"
  const usernameField =
    page.getByLabel("User name (or email address)").or(
      page.locator('input[name="j_username"]'),
    );
  await usernameField.first().fill(userId, { timeout: 5_000 });

  // SELECTOR: adjusted after live testing -- label is "Password:" with colon
  const passwordField =
    page.getByLabel("Password:").or(
      page.locator('input[name="j_password"]'),
    );
  await passwordField.first().fill(password, { timeout: 5_000 });
  await ss(page, "03-credentials-filled");

  // Click the actual form submit button (not the "Enroll in Two-Step Login" nav link
  // which also has role="button" and contains "Login" in its text)
  // SELECTOR: adjusted after live testing -- target by name attribute to avoid nav link match
  await page.locator('button[name="_eventId_proceed"]').click({ timeout: 5_000 });

  await ss(page, "04-after-login-click");

  // Now wait for Duo approval -- user approves on their phone
  log.waiting("Waiting for Duo approval (approve on your phone)...");

  // After Duo approval, the page redirects to act-crm.my.site.com or crm.ucsd.edu
  let approved = await waitForDuoApproval(
    page,
    "**/*crm*/**",
    60_000,
  );

  if (!approved) {
    await ss(page, "05-duo-timeout-1");
    log.waiting("Still waiting for Duo approval...");
    approved = await waitForDuoApproval(
      page,
      "**/*crm*/**",
      60_000,
    );
  }

  if (!approved) {
    // Also check if we already made it to the target
    if (page.url().includes("act-crm.my.site.com") && !page.url().includes("login")) {
      log.step("Already on ACT CRM -- Duo may have been auto-approved");
      approved = true;
    }
  }

  if (!approved) {
    await ss(page, "06-duo-timeout-2");
    log.error("ACT CRM Duo approval timed out");
    return false;
  }

  await ss(page, "07-authenticated");
  log.success("ACT CRM authenticated");
  return true;
}
