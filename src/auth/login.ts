import type { Page } from "playwright";
import { log } from "../utils/log.js";
import { waitForDuoApproval } from "./duo-wait.js";
import { validateEnv } from "../utils/env.js";
import { UKG_URL } from "../config.js";
import { fillSsoCredentials, clickSsoSubmit } from "./sso-fields.js";

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
  // Track every navigation for debugging the redirect chain
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) {
      log.step(`[NAV] ${frame.url()}`);
    }
  });

  log.step("Navigating to UCPath...");
  await page.goto("https://ucpath.ucsd.edu", {
    waitUntil: "domcontentloaded",
    timeout: 15_000,
  });
  log.step(`Login page loaded | URL: ${page.url()}`);

  // Click the "Log in to UCPath" button in the main banner
  // SELECTOR: adjusted after live testing -- button OR link
  const loginButton =
    page.getByRole("button", { name: /log in to ucpath/i }).or(
      page.getByRole("link", { name: /log in to ucpath/i }),
    );
  await loginButton.first().click({ timeout: 10_000 });
  log.step(`After "Log in" click | URL: ${page.url()}`);

  // UC-wide identity provider discovery page -- select UCSD campus
  // Retry up to 3 times if the redirect fails (chrome-error / network glitch)
  for (let attempt = 1; attempt <= 3; attempt++) {
    log.step(`Selecting UC San Diego... (attempt ${attempt})`);
    const campusLink = page.getByRole("link", {
      name: "University of California, San Diego",
    });
    await campusLink.click({ timeout: 10_000 });
    log.step(`After campus select | URL: ${page.url()}`);

    try {
      await page.waitForURL(
        (url) => url.hostname.includes("a5.ucsd.edu"),
        { timeout: 15_000 },
      );
      break; // success
    } catch {
      if (page.url().includes("chrome-error") && attempt < 3) {
        log.step(`SSO redirect failed (chrome-error) — retrying navigation...`);
        await page.goto("https://ucpath.ucsd.edu", {
          waitUntil: "domcontentloaded",
          timeout: 15_000,
        });
        await loginButton.first().click({ timeout: 10_000 });
        continue;
      }
      throw new Error(`SSO redirect failed after ${attempt} attempts (URL: ${page.url()})`);
    }
  }
  log.step(`SSO login page loaded | URL: ${page.url()}`);

  // Fill SSO credentials and submit
  await fillSsoCredentials(page);
  await clickSsoSubmit(page);
  log.step(`After login click | URL: ${page.url()}`);

  // Wait for Duo approval — poll for URL change or "Yes, this is my device" button
  log.waiting("Waiting for Duo approval (approve on your phone)...");
  let approved = false;
  const maxWaitSecondsUcpath = 180;
  for (let elapsed = 0; elapsed < maxWaitSecondsUcpath; elapsed += 2) {
    try {
      // Check if "Yes, this is my device" button appeared
      const trustButton = page.getByText("Yes, this is my device");
      if ((await trustButton.count()) > 0) {
        log.step('Clicking "Yes, this is my device"...');
        await trustButton.click({ timeout: 5_000 });
      }

      // Check if we made it past Duo
      if (page.url().includes("universityofcalifornia.edu") && !page.url().includes("duosecurity")) {
        approved = true;
        break;
      }
    } catch {
      // Page may be navigating
    }
    await page.waitForTimeout(2_000);
  }

  if (!approved) {
    log.error("Duo approval timed out");
    return false;
  }

  log.step(`Duo approved | URL: ${page.url()}`);

  // After Duo, wait for redirects to settle.
  log.step("Waiting for post-Duo redirects to settle...");
  await page.waitForTimeout(5_000);
  await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
  log.step(`Post-Duo URL: ${page.url()}`);

  // If redirected back to the campus discovery page, re-select UCSD.
  // Check by URL (not by link text -- the main page also has UC San Diego links).
  for (let attempt = 0; attempt < 3; attempt++) {
    if (page.url().includes("ucpathdiscovery/disco")) {
      log.step(`Campus discovery page detected (attempt ${attempt + 1}) -- re-selecting UC San Diego...`);
      const campusLinkRetry = page.getByRole("link", {
        name: "University of California, San Diego",
      });
      await campusLinkRetry.click({ timeout: 10_000 });
      log.step(`After re-selection click | URL: ${page.url()}`);
      await page.waitForTimeout(5_000);
      await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
      log.step(`After re-selection settle | URL: ${page.url()}`);
    } else {
      break;
    }
  }

  log.step(`Final auth URL: ${page.url()}`);
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

  // Fill SSO credentials and submit
  await fillSsoCredentials(page);
  await ss(page, "03-credentials-filled");
  await clickSsoSubmit(page);

  await ss(page, "04-after-login-click");

  // Now wait for Duo approval -- user approves on their phone
  log.waiting("Waiting for Duo approval (approve on your phone)...");

  // After Duo approval, the page redirects to act-crm.my.site.com or crm.ucsd.edu.
  // Poll in 15s intervals so we can detect the "Yes, this is my device" button
  // quickly instead of waiting the full timeout.
  let approved = false;
  const MAX_ATTEMPTS = 4; // 4 × 15s = 60s total
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    approved = await waitForDuoApproval(page, "**/*crm*/**", 15_000);
    if (approved) break;

    // Check if "Yes, this is my device" appeared (Duo approved but not yet redirected)
    try {
      const yesBtn = page.getByRole("button", { name: /yes/i })
        .or(page.locator('button:has-text("Yes")'))
        .or(page.locator('input[value="Yes"]'));
      const yesVisible = await yesBtn.first().isVisible({ timeout: 2_000 });
      if (yesVisible) {
        log.step("Clicking 'Yes, this is my device'...");
        await yesBtn.first().click({ timeout: 5_000 });
        await page.waitForTimeout(2_000);
        // After clicking, wait for CRM redirect
        approved = await waitForDuoApproval(page, "**/*crm*/**", 15_000);
        if (approved) break;
      }
    } catch {
      // No device confirmation screen
    }

    // Check if we already made it to CRM
    if (page.url().includes("act-crm.my.site.com") && !page.url().includes("login")) {
      log.step("Already on ACT CRM -- Duo may have been auto-approved");
      approved = true;
      break;
    }

    if (attempt < MAX_ATTEMPTS) {
      log.waiting(`Still waiting for Duo approval (attempt ${attempt}/${MAX_ATTEMPTS})...`);
    }
  }

  if (!approved) {
    await ss(page, "06-duo-timeout");
    log.error("ACT CRM Duo approval timed out");
    return false;
  }

  await ss(page, "07-authenticated");
  log.success("ACT CRM authenticated");
  return true;
}

/**
 * Authenticate to UKG (Kronos) via UCSD SSO.
 *
 * Flow: Navigate to UKG → SSO login page (if not already logged in) →
 *       Enter credentials → Wait for Duo MFA → Dashboard loads
 *
 * Uses persistent browser context, so subsequent runs may skip login entirely.
 *
 * @param page - Playwright page instance (from persistent context)
 * @returns true if authenticated (or already was), false on failure
 */
export async function loginToUKG(page: Page): Promise<boolean> {
  const filled = await ukgNavigateAndFill(page);
  if (filled === "already_logged_in") return true;
  if (!filled) return false;
  return await ukgSubmitAndWaitForDuo(page);
}

/**
 * Navigate to UKG and fill SSO credentials without clicking login.
 * Returns "already_logged_in" if session is still active, true if credentials filled, false on error.
 */
export async function ukgNavigateAndFill(page: Page): Promise<boolean | "already_logged_in"> {
  log.step("Navigating to UKG...");

  // Retry navigation on transient network errors (ERR_NETWORK_CHANGED, etc.)
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await page.goto(UKG_URL, {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      });
      break;
    } catch (err) {
      const msg = String(err);
      if (attempt < 3 && (msg.includes("ERR_NETWORK") || msg.includes("ERR_CONNECTION") || msg.includes("ERR_NAME"))) {
        log.step(`Navigation failed (attempt ${attempt}/3): ${msg.slice(0, 80)}. Retrying in 5s...`);
        await page.waitForTimeout(5_000);
        continue;
      }
      throw err;
    }
  }
  await page.waitForTimeout(5_000);

  // Check if already logged in (persistent session)
  if (await page.locator("text=Manage My Department").count() > 0) {
    log.success("UKG already authenticated (persistent session)");
    return "already_logged_in";
  }

  log.step("Filling SSO credentials...");
  const { userId, password } = validateEnv();

  try {
    await page.locator("#ssousername").fill(userId, { timeout: 10_000 });
    await page.locator("#ssopassword").fill(password, { timeout: 5_000 });
  } catch {
    log.error("Could not find UKG SSO login fields");
    return false;
  }

  log.step("Credentials filled (not submitted yet)");
  return true;
}

/**
 * Click the login button and wait for Duo MFA approval.
 * Call after ukgNavigateAndFill() has filled credentials.
 */
export async function ukgSubmitAndWaitForDuo(page: Page): Promise<boolean> {
  await page.locator('button[name="_eventId_proceed"]').click({ timeout: 5_000 });
  log.step("Credentials submitted — waiting for Duo MFA...");

  log.waiting("Waiting for Duo approval (approve on your phone)...");
  const maxWaitSeconds = 180;
  for (let elapsed = 0; elapsed < maxWaitSeconds; elapsed += 2) {
    try {
      const trustButton = page.getByText("Yes, this is my device");
      if ((await trustButton.count()) > 0) {
        log.step('Clicking "Yes, this is my device"...');
        await trustButton.click({ timeout: 5_000 });
      }

      if (await page.locator("text=Manage My Department").count() > 0) {
        log.success("UKG authenticated — dashboard loaded");
        return true;
      }
    } catch {
      // Page may be navigating
    }
    await page.waitForTimeout(2_000);
  }

  log.error("UKG authentication timed out waiting for dashboard");
  return false;
}

/**
 * Authenticate to Kuali Build through UCSD Shibboleth SSO with Duo MFA.
 *
 * Flow: Navigate to Kuali URL -> If already on kualibuild, done ->
 *       Enter credentials on SSO page -> Wait for Duo approval ->
 *       Handle SAML error retry -> Return
 *
 * @param page - Playwright page instance
 * @param url - Kuali Build URL to navigate to
 * @returns true if authentication succeeded, false otherwise
 */
export async function loginToKuali(page: Page, url: string): Promise<boolean> {
  log.step("Navigating to Kuali Build...");
  await page.goto(url, {
    waitUntil: "domcontentloaded",
    timeout: 60_000,
  });
  await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
  await page.waitForTimeout(3_000);

  // Check if already logged in (must still be on kualibuild after redirects settle)
  if (page.url().includes("kualibuild")) {
    log.success("Kuali Build already authenticated");
    return true;
  }

  log.step("Logging in via UCSD SSO...");

  try {
    await fillSsoCredentials(page);
    await clickSsoSubmit(page);
    log.step("Credentials submitted — waiting for Duo MFA...");
  } catch {
    // SSO may have auto-forwarded to Duo (credentials remembered) — check before bailing
    if (page.url().includes("duosecurity.com")) {
      log.step("SSO auto-forwarded to Duo — waiting for approval...");
    } else if (page.url().includes("kualibuild")) {
      log.success("Kuali Build authenticated (SSO auto-login)");
      return true;
    } else {
      log.error(`Could not find Kuali SSO login fields (URL: ${page.url()})`);
      return false;
    }
  }

  // Poll for Duo approval or URL change
  log.waiting("Waiting for Duo approval (approve on your phone)...");
  const maxWaitSeconds = 180;
  for (let elapsed = 0; elapsed < maxWaitSeconds; elapsed += 2) {
    try {
      // Check if "Yes, this is my device" button appeared
      const trustButton = page.getByText("Yes, this is my device");
      if ((await trustButton.count()) > 0) {
        log.step('Clicking "Yes, this is my device"...');
        await trustButton.click({ timeout: 5_000 });
      }

      // Check if we landed on Kuali
      if (page.url().includes("kualibuild")) {
        log.success("Kuali Build authenticated");
        return true;
      }

      // Handle SAML error page — retry navigation
      if (page.url().includes("SAML") || (await page.content()).includes("SAML")) {
        log.step("SAML error detected — retrying navigation to Kuali...");
        await page.goto(url, {
          waitUntil: "domcontentloaded",
          timeout: 60_000,
        });
        await page.waitForTimeout(3_000);
      }
    } catch {
      // Page may be navigating
    }
    await page.waitForTimeout(2_000);
  }

  log.error("Kuali Build authentication timed out");
  return false;
}

/**
 * Authenticate to new Kronos (WFD) through UCSD Shibboleth SSO with Duo MFA.
 *
 * Flow: Navigate to WFD home -> If already on mykronos, done ->
 *       Enter credentials on SSO page -> Wait for Duo approval ->
 *       Handle session timeout retry -> Return
 *
 * @param page - Playwright page instance
 * @returns true if authentication succeeded, false otherwise
 */
export async function loginToNewKronos(page: Page): Promise<boolean> {
  const wfdUrl = "https://ucsd-sso.prd.mykronos.com/wfd/home";

  log.step("Navigating to new Kronos (WFD)...");
  await page.goto(wfdUrl, {
    waitUntil: "domcontentloaded",
    timeout: 60_000,
  });
  await page.waitForTimeout(5_000);

  // Check if already logged in
  if (page.url().includes("mykronos.com/wfd")) {
    log.success("New Kronos (WFD) already authenticated");
    return true;
  }

  log.step("Logging in via UCSD SSO...");

  try {
    await fillSsoCredentials(page);
  } catch {
    log.error("Could not find new Kronos SSO login fields");
    return false;
  }

  await clickSsoSubmit(page);
  log.step("Credentials submitted — waiting for Duo MFA...");

  // Poll for Duo approval or URL change
  log.waiting("Waiting for Duo approval (approve on your phone)...");
  const maxWaitSecondsWfd = 180;
  for (let elapsed = 0; elapsed < maxWaitSecondsWfd; elapsed += 2) {
    try {
      // Check if "Yes, this is my device" button appeared
      const trustButton = page.getByText("Yes, this is my device");
      if ((await trustButton.count()) > 0) {
        log.step('Clicking "Yes, this is my device"...');
        await trustButton.click({ timeout: 5_000 });
      }

      // Check if we landed on WFD
      if (page.url().includes("mykronos.com/wfd")) {
        log.success("New Kronos (WFD) authenticated");
        return true;
      }

      // Handle session timeout page
      if (page.url().includes("#failedLogin")) {
        log.step("Session timeout detected — retrying navigation...");
        await page.goto(wfdUrl, {
          waitUntil: "domcontentloaded",
          timeout: 60_000,
        });
        await page.waitForTimeout(3_000);
      }
    } catch {
      // Page may be navigating
    }
    await page.waitForTimeout(2_000);
  }

  log.error("New Kronos (WFD) authentication timed out");
  return false;
}
