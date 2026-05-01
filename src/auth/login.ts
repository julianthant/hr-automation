import type { Page } from "playwright";
import { log } from "../utils/log.js";
import { pollDuoApproval } from "./duo-poll.js";
import { requestDuoApproval } from "../tracker/duo-queue.js";
import { validateEnv } from "../utils/env.js";
import { UKG_URL } from "../config.js";
import { fillSsoCredentials, clickSsoSubmit, isSsoFormReady } from "./sso-fields.js";
import { gotoWithRetry } from "../browser/launch.js";
import { debugScreenshot } from "../utils/screenshot.js";

/**
 * Authenticate to UCPath through UCSD Shibboleth SSO with Duo MFA.
 *
 * Flow: Navigate to UCPath -> Click "Log in" -> Select UC San Diego ->
 *       Enter credentials on SSO page -> Wait for Duo approval -> Return
 *
 * @param page - Playwright page instance
 * @returns true if authentication succeeded, false otherwise
 */
/**
 * UCPath prepare phase: navigate through the login → campus-discovery → SSO
 * hop chain and fill credentials. Leaves the page at the SSO form with the
 * Submit button ready to click. Idempotent — safe to call again on a stale
 * form (the nav resets the Shibboleth token automatically).
 */
export async function ucpathNavigateAndFill(page: Page): Promise<boolean> {
  log.step("Navigating to UCPath...");
  await page.goto("https://ucpath.ucsd.edu", {
    waitUntil: "domcontentloaded",
    timeout: 15_000,
  });
  log.step(`Login page loaded | URL: ${page.url()}`);

  const loginButton =
    page.getByRole("button", { name: /log in to ucpath/i }).or(
      page.getByRole("link", { name: /log in to ucpath/i }),
    );
  await loginButton.first().click({ timeout: 10_000 });
  log.step(`After "Log in" click | URL: ${page.url()}`);

  for (let attempt = 1; attempt <= 3; attempt++) {
    log.step(`Selecting UC San Diego... (attempt ${attempt})`);
    const campusLink = page.getByRole("link", {
      name: "University of California, San Diego",
    });
    await campusLink.click({ timeout: 10_000 });
    log.step(`After campus select | URL: ${page.url()}`);
    try {
      await page.waitForURL((url) => url.hostname.includes("a5.ucsd.edu"), { timeout: 15_000 });
      break;
    } catch {
      if (page.url().includes("chrome-error") && attempt < 3) {
        log.step(`SSO redirect failed (chrome-error) — retrying navigation...`);
        await page.goto("https://ucpath.ucsd.edu", { waitUntil: "domcontentloaded", timeout: 15_000 });
        await loginButton.first().click({ timeout: 10_000 });
        continue;
      }
      return false;
    }
  }
  log.step(`SSO login page loaded | URL: ${page.url()}`);

  try {
    await fillSsoCredentials(page);
  } catch {
    log.error("Could not find UCPath SSO login fields after navigation");
    return false;
  }
  log.step("UCPath: credentials filled (not submitted yet)");
  return true;
}

/**
 * UCPath submit phase: click Submit and wait for Duo approval. Checks
 * staleness first — if the SSO form's submit button is no longer present
 * (Shibboleth token expired while we waited for earlier Duos), re-runs
 * ucpathNavigateAndFill() once before submitting.
 */
export async function ucpathSubmitAndWaitForDuo(page: Page, instance?: string): Promise<boolean> {
  if (!(await isSsoFormReady(page))) {
    log.warn("UCPath SSO form gone stale — re-preparing before submit");
    const ok = await ucpathNavigateAndFill(page);
    if (!ok) return false;
  }

  const navListener = (frame: import("playwright").Frame) => {
    if (frame === page.mainFrame()) log.step(`[NAV] ${frame.url()}`);
  };
  page.on("framenavigated", navListener);

  await clickSsoSubmit(page);
  log.step(`After login click | URL: ${page.url()}`);

  // Wait for Duo approval — poll for URL change or "Yes, this is my device" button
  const duoOptions = {
    successUrlMatch: (url: string) =>
      url.includes("universityofcalifornia.edu") && !url.includes("duosecurity"),
    systemLabel: "UCPath",
  };
  const approved = instance
    ? await requestDuoApproval(page, { ...duoOptions, system: "UCPath", instance })
    : await pollDuoApproval(page, duoOptions);

  page.off("framenavigated", navListener);

  if (!approved) {
    return false;
  }

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
 * Authenticate to UCPath through UCSD Shibboleth SSO with Duo MFA.
 * All-in-one wrapper for workflows that don't use the parallel-prepare
 * optimization — just composes navigateAndFill + submitAndWaitForDuo.
 */
export async function loginToUCPath(page: Page, instance?: string): Promise<boolean> {
  const filled = await ucpathNavigateAndFill(page);
  if (!filled) return false;
  return await ucpathSubmitAndWaitForDuo(page, instance);
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
export async function loginToACTCrm(page: Page, instance?: string): Promise<boolean> {
  log.step("Navigating to ACT CRM onboarding portal...");
  await page.goto("https://crm.ucsd.edu/hr", {
    waitUntil: "domcontentloaded",
    timeout: 15_000,
  });
  await page.waitForLoadState("networkidle", { timeout: 15_000 });
  await debugScreenshot(page, "debug-01-after-navigate", { fullPage: true });

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
  await debugScreenshot(page, "debug-02-sso-page", { fullPage: true });

  // Fill SSO credentials and submit
  await fillSsoCredentials(page);
  await debugScreenshot(page, "debug-03-credentials-filled", { fullPage: true });
  await clickSsoSubmit(page);

  await debugScreenshot(page, "debug-04-after-login-click", { fullPage: true });

  // Now wait for Duo approval -- user approves on their phone
  const duoOptions = {
    timeoutSeconds: 60,
    successUrlMatch: (url: string) =>
      (url.includes("act-crm.my.site.com") || url.includes("crm.ucsd.edu")) &&
      !url.includes("login"),
    systemLabel: "CRM",
  };
  const approved = instance
    ? await requestDuoApproval(page, { ...duoOptions, system: "CRM", instance })
    : await pollDuoApproval(page, duoOptions);

  if (!approved) {
    await debugScreenshot(page, "debug-06-duo-timeout", { fullPage: true });
    log.error("ACT CRM Duo approval timed out");
    return false;
  }

  await debugScreenshot(page, "debug-07-authenticated", { fullPage: true });
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
export async function loginToUKG(page: Page, instance?: string): Promise<boolean> {
  const filled = await ukgNavigateAndFill(page);
  if (filled === "already_logged_in") return true;
  if (!filled) return false;
  return await ukgSubmitAndWaitForDuo(page, instance);
}

/**
 * Navigate to UKG and fill SSO credentials without clicking login.
 * Returns "already_logged_in" if session is still active, true if credentials filled, false on error.
 */
export async function ukgNavigateAndFill(page: Page): Promise<boolean | "already_logged_in"> {
  log.step("Navigating to UKG...");

  // Retry navigation on transient network errors via gotoWithRetry
  await gotoWithRetry(page, UKG_URL, undefined, 3, 60_000);
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
export async function ukgSubmitAndWaitForDuo(page: Page, instance?: string): Promise<boolean> {
  await page.locator('button[name="_eventId_proceed"]').click({ timeout: 5_000 });
  log.step("Credentials submitted — waiting for Duo MFA...");

  const duoOptions = {
    successUrlMatch: () => true,
    successCheck: async (p: Page) =>
      (await p.locator("text=Manage My Department").count()) > 0,
    systemLabel: "OldKronos",
  };
  const approved = instance
    ? await requestDuoApproval(page, { ...duoOptions, system: "OldKronos", instance })
    : await pollDuoApproval(page, duoOptions);

  if (!approved) {
    log.error("UKG authentication timed out waiting for dashboard");
    return false;
  }

  log.success("UKG authenticated — dashboard loaded");
  return true;
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
/**
 * Kuali prepare phase: navigate + fill SSO credentials. Returns
 * "already_logged_in" when a persistent session is still valid.
 */
export async function kualiNavigateAndFill(
  page: Page,
  url: string,
): Promise<boolean | "already_logged_in"> {
  log.step("Navigating to Kuali Build...");
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
  await page.waitForTimeout(3_000);

  if (page.url().includes("kualibuild")) {
    log.success("Kuali Build already authenticated");
    return "already_logged_in";
  }

  log.step("Kuali: filling SSO credentials...");
  try {
    await fillSsoCredentials(page);
  } catch {
    if (page.url().includes("duosecurity.com")) {
      log.step("Kuali SSO auto-forwarded to Duo during prepare — treat as ready");
      return true;
    }
    log.error(`Kuali: could not find SSO login fields (URL: ${page.url()})`);
    return false;
  }
  log.step("Kuali: credentials filled (not submitted yet)");
  return true;
}

/**
 * Kuali submit phase: re-prepare on stale form, click Submit, wait for Duo.
 */
export async function kualiSubmitAndWaitForDuo(
  page: Page,
  url: string,
  instance?: string,
): Promise<boolean> {
  if (page.url().includes("kualibuild")) {
    log.success("Kuali Build authenticated (auto-login detected before submit)");
    return true;
  }
  if (!(await isSsoFormReady(page))) {
    log.warn("Kuali SSO form gone stale — re-preparing before submit");
    const prep = await kualiNavigateAndFill(page, url);
    if (prep === "already_logged_in") return true;
    if (!prep) return false;
  }

  try {
    await clickSsoSubmit(page);
    log.step("Kuali: credentials submitted — waiting for Duo MFA...");
  } catch {
    if (page.url().includes("duosecurity.com")) {
      log.step("Kuali SSO auto-forwarded to Duo — waiting for approval...");
    } else if (page.url().includes("kualibuild")) {
      log.success("Kuali Build authenticated (SSO auto-login)");
      return true;
    } else {
      log.error(`Kuali: submit click failed (URL: ${page.url()})`);
      return false;
    }
  }

  const duoOptions = {
    successUrlMatch: "kualibuild" as const,
    recovery: async (p: Page) => {
      const currentUrl = p.url();
      if (currentUrl.includes("SAML") || currentUrl.includes("saml")) {
        log.step("SAML error detected — re-navigating to Kuali...");
        await p.goto(url, { waitUntil: "domcontentloaded", timeout: 10_000 }).catch(() => {});
        await p.waitForTimeout(3_000);
      }
    },
    systemLabel: "Kuali",
  };
  const approved = instance
    ? await requestDuoApproval(page, { ...duoOptions, system: "Kuali", instance })
    : await pollDuoApproval(page, duoOptions);

  if (!approved) {
    log.error("Kuali Build authentication timed out");
    return false;
  }
  log.success("Kuali Build authenticated");
  return true;
}

/**
 * All-in-one wrapper preserving the legacy callsite contract.
 */
export async function loginToKuali(page: Page, url: string, instance?: string): Promise<boolean> {
  const prep = await kualiNavigateAndFill(page, url);
  if (prep === "already_logged_in") return true;
  if (!prep) return false;
  return await kualiSubmitAndWaitForDuo(page, url, instance);
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
const NEW_KRONOS_WFD_URL = "https://ucsd-sso.prd.mykronos.com/wfd/home";

/**
 * New Kronos prepare phase: navigate + fill SSO credentials.
 */
export async function newKronosNavigateAndFill(
  page: Page,
): Promise<boolean | "already_logged_in"> {
  log.step("Navigating to new Kronos (WFD)...");
  await page.goto(NEW_KRONOS_WFD_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForTimeout(5_000);

  if (page.url().includes("mykronos.com/wfd")) {
    log.success("New Kronos (WFD) already authenticated");
    return "already_logged_in";
  }

  log.step("New Kronos: filling SSO credentials...");
  try {
    await fillSsoCredentials(page);
  } catch {
    log.error("Could not find new Kronos SSO login fields");
    return false;
  }
  log.step("New Kronos: credentials filled (not submitted yet)");
  return true;
}

/**
 * New Kronos submit phase: re-prepare on stale form, click Submit, wait for Duo.
 */
export async function newKronosSubmitAndWaitForDuo(
  page: Page,
  instance?: string,
): Promise<boolean> {
  if (page.url().includes("mykronos.com/wfd")) {
    log.success("New Kronos (WFD) authenticated (auto-login detected before submit)");
    return true;
  }
  if (!(await isSsoFormReady(page))) {
    log.warn("New Kronos SSO form gone stale — re-preparing before submit");
    const prep = await newKronosNavigateAndFill(page);
    if (prep === "already_logged_in") return true;
    if (!prep) return false;
  }

  await clickSsoSubmit(page);
  log.step("New Kronos: credentials submitted — waiting for Duo MFA...");

  const duoOptions = {
    successUrlMatch: "mykronos.com/wfd" as const,
    recovery: async (p: Page) => {
      if (p.url().includes("#failedLogin")) {
        log.step("Session timeout detected — re-navigating...");
        await p.goto(NEW_KRONOS_WFD_URL, { waitUntil: "domcontentloaded", timeout: 10_000 }).catch(() => {});
        await p.waitForTimeout(3_000);
      }
    },
    systemLabel: "NewKronos",
  };
  const approved = instance
    ? await requestDuoApproval(page, { ...duoOptions, system: "NewKronos", instance })
    : await pollDuoApproval(page, duoOptions);

  if (!approved) {
    log.error("New Kronos (WFD) authentication timed out");
    return false;
  }
  log.success("New Kronos (WFD) authenticated");
  return true;
}

/**
 * All-in-one wrapper preserving the legacy callsite contract.
 */
export async function loginToNewKronos(page: Page, instance?: string): Promise<boolean> {
  const prep = await newKronosNavigateAndFill(page);
  if (prep === "already_logged_in") return true;
  if (!prep) return false;
  return await newKronosSubmitAndWaitForDuo(page, instance);
}
