import type { Page } from "playwright";
import { log } from "../../utils/log.js";
import { pollDuoApproval } from "./duo-poll.js";
import { requestDuoApproval } from "../../tracker/sessions/duo-queue.js";
import { validateEnv } from "../../utils/env.js";
import { UKG_URL, ONBASE_URL } from "../../config.js";
import { fillSsoCredentials, clickSsoSubmit, isSsoFormReady, waitForSsoForm } from "./sso-fields.js";
import { gotoWithRetry } from "../browser/launch.js";
import { debugScreenshot } from "../../utils/screenshot.js";
import { hrInquiry } from "../../systems/servicenow/selectors.js";
import { HR_INQUIRY_FORM_URL } from "../../systems/servicenow/navigate.js";
import { onbaseSelectors } from "../../systems/onbase/selectors.js";
import {
  isOnbaseForbidden,
  isOnbaseViewstateError,
  isOnbaseSessionClosed,
  isOnbaseSessionContention,
} from "../../systems/onbase/page-state.js";

type SsoPrepareResult = boolean | "already_logged_in";

type SsoLoginConfig<TArgs extends unknown[]> = {
  id: string;
  prepare?: (page: Page, ...args: TArgs) => Promise<SsoPrepareResult>;
  submit: (page: Page, ...args: TArgs) => Promise<boolean>;
};

export function defineSsoLogin<TArgs extends unknown[]>(
  cfg: SsoLoginConfig<TArgs>,
): (page: Page, ...args: TArgs) => Promise<boolean> {
  return async (page, ...args) => {
    const prep = cfg.prepare ? await cfg.prepare(page, ...args) : true;
    if (prep === "already_logged_in") return true;
    if (!prep) return false;
    return await cfg.submit(page, ...args);
  };
}

async function selectUcSanDiegoCampus(page: Page, label: string): Promise<void> {
  log.step(`${label}: selecting UC San Diego...`);
  await page.getByRole("link", { name: "University of California, San Diego" }).click({ timeout: 10_000 });
  log.step(`${label}: after campus select | URL: ${page.url()}`);
}

async function retrySelectCampus(
  page: Page,
  label: string,
  onChromeErrorRetry: () => Promise<void>,
  attempts = 3,
): Promise<boolean> {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    await selectUcSanDiegoCampus(page, `${label} (attempt ${attempt})`);
    try {
      await page.waitForURL((url) => url.hostname.includes("a5.ucsd.edu"), { timeout: 15_000 });
      return true;
    } catch {
      if (page.url().includes("chrome-error") && attempt < attempts) {
        log.step("SSO redirect failed (chrome-error) — retrying navigation...");
        await onChromeErrorRetry();
        continue;
      }
      return false;
    }
  }
  return false;
}

export function isAuthenticatedUcpathAppUrl(rawUrl: string): boolean {
  const url = rawUrl.toLowerCase();
  return (
    url.includes("universityofcalifornia.edu") &&
    !url.includes("ucpathdiscovery/disco") &&
    !url.includes("duosecurity.com") &&
    !url.includes("a5.ucsd.edu") &&
    !url.includes("/login") &&
    // PeopleSoft classic-PIA session expiry lands on the signon URL
    // `…/psp/<site>/?cmd=login` (or `?cmd=expire`) — same domain, and the
    // "/login" path exclusion above does not match the query-string shape.
    !url.includes("cmd=login") &&
    !url.includes("cmd=expire") &&
    !url.includes("shibboleth") &&
    !url.startsWith("chrome-error")
  );
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
/**
 * UCPath prepare phase: navigate through the login → campus-discovery → SSO
 * hop chain and fill credentials. Leaves the page at the SSO form with the
 * Submit button ready to click. Idempotent — safe to call again on a stale
 * form (the nav resets the Shibboleth token automatically).
 */
export async function ucpathNavigateAndFill(page: Page): Promise<SsoPrepareResult> {
  if (isAuthenticatedUcpathAppUrl(page.url())) {
    log.success("UCPath already authenticated — reusing existing session");
    return "already_logged_in";
  }

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

  const selected = await retrySelectCampus(page, "UCPath", async () => {
    await page.goto("https://ucpath.ucsd.edu", { waitUntil: "domcontentloaded", timeout: 15_000 });
    await loginButton.first().click({ timeout: 10_000 });
  });
  if (!selected) return false;
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
export async function ucpathSubmitAndWaitForDuo(
  page: Page,
  instance?: string,
  abortSignal?: AbortSignal,
): Promise<boolean> {
  if (!(await isSsoFormReady(page))) {
    log.warn("UCPath SSO form gone stale — re-preparing before submit");
    const ok = await ucpathNavigateAndFill(page);
    // Tri-state: a warm page reports "already_logged_in" — there is no SSO
    // form to submit, so falling through to clickSsoSubmit would be a
    // guaranteed TimeoutError. Short-circuit as success instead.
    if (ok === "already_logged_in") return true;
    if (!ok) return false;
  }

  const navListener = (frame: import("playwright").Frame) => {
    if (frame === page.mainFrame()) log.step(`[NAV] ${frame.url()}`);
  };
  page.on("framenavigated", navListener);

  await clickSsoSubmit(page, { abortSignal });
  log.step(`After login click | URL: ${page.url()}`);

  // Wait for Duo approval — poll for URL change or "Yes, this is my device" button
  const duoOptions = {
    successUrlMatch: (url: string) =>
      url.includes("universityofcalifornia.edu") && !url.includes("duosecurity"),
    systemLabel: "UCPath",
    abortSignal,
  };
  const approved = instance
    ? await requestDuoApproval(page, { ...duoOptions, system: "UCPath", instance })
    : await pollDuoApproval(page, duoOptions);

  page.off("framenavigated", navListener);

  if (!approved) {
    return false;
  }

  // After Duo, wait for redirects to settle. networkidle alone is sufficient —
  // the preceding sleep was redundant.
  log.step("Waiting for post-Duo redirects to settle...");
  await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
  log.step(`Post-Duo URL: ${page.url()}`);

  // If redirected back to the campus discovery page, re-select UCSD.
  // Check by URL (not by link text -- the main page also has UC San Diego links).
  for (let attempt = 0; attempt < 3; attempt++) {
    if (page.url().includes("ucpathdiscovery/disco")) {
      log.step(`Campus discovery page detected (attempt ${attempt + 1}) -- re-selecting UC San Diego...`);
      await selectUcSanDiegoCampus(page, "UCPath rediscovery");
      // networkidle guards the redirect after campus re-selection.
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
export const loginToUCPath = defineSsoLogin<[instance?: string, abortSignal?: AbortSignal]>({
  id: "UCPath",
  prepare: (page) => ucpathNavigateAndFill(page),
  submit: ucpathSubmitAndWaitForDuo,
});

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
async function loginToACTCrmFlow(
  page: Page,
  instance?: string,
  abortSignal?: AbortSignal,
): Promise<boolean> {
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
  await clickSsoSubmit(page, { abortSignal });

  await debugScreenshot(page, "debug-04-after-login-click", { fullPage: true });

  // Now wait for Duo approval -- user approves on their phone
  const duoOptions = {
    timeoutSeconds: 60,
    successUrlMatch: (url: string) =>
      (url.includes("act-crm.my.site.com") || url.includes("crm.ucsd.edu")) &&
      !url.includes("login"),
    systemLabel: "CRM",
    abortSignal,
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

export const loginToACTCrm = defineSsoLogin<[instance?: string, abortSignal?: AbortSignal]>({
  id: "CRM",
  submit: loginToACTCrmFlow,
});

/** True when NavPanel is loaded with the nine-squares Main Menu (not Login.aspx). */
async function isOnbaseAuthenticated(page: Page): Promise<boolean> {
  if (page.url().includes("Login.aspx")) return false;
  return onbaseSelectors.nav
    .mainMenuButton(page)
    .isVisible({ timeout: 5_000 })
    .catch(() => false);
}

/**
 * Poll until OnBase lands on a recognized page — NavPanel (authenticated),
 * SSO, Duo, the single-session contention dialog, or one of the cluster's
 * transient error landings (403 / ViewState-MAC failure / logout) — rather
 * than spinning on a blank redirect hop. The cheap URL/title/menu checks run
 * first so the happy path never reads page content; the text-based error
 * checks only fire once the page is genuinely stuck on an unrecognized page.
 *
 * Deliberately does NOT return on the bare `Login.aspx` URL: Login.aspx is a
 * ROUTER page ("Please Wait…") that either redirects onward to SSO or renders
 * the "Another session is currently active" contention dialog a beat later —
 * returning on its URL races both outcomes.
 */
async function waitForOnbaseAuthLanding(page: Page, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const url = page.url();
    if (url.includes("a5.ucsd.edu") || url.includes("duosecurity.com")) return;
    if (await isOnbaseForbidden(page)) return;
    if (await isOnbaseAuthenticated(page)) return;
    if (await isSsoFormReady(page)) return;
    if (await isOnbaseViewstateError(page)) return;
    if (await isOnbaseSessionClosed(page)) return;
    if (await isOnbaseSessionContention(page)) return;
    await page.waitForTimeout(400);
  }
}

/**
 * Clear a stale OnBase app session holding the account's SINGLE session slot.
 *
 * OnBase allows one app session per identity. A daemon/browser that died
 * without logging out leaves the slot held server-side; every new login then
 * hits the abort-only "Another session is currently active" dialog on
 * Login.aspx, and direct NavPanel GETs serve a PERSISTENT 403 (verified live
 * 2026-07-02). `Logout.aspx` terminates the stale app session, and re-entering
 * through `Login.aspx` rides the still-valid identity-server session straight
 * back in (or falls to the normal SSO form when there is none). Idempotent —
 * Logout.aspx with no active session is a harmless "Session Ended" no-op.
 */
async function clearOnbaseActiveSession(page: Page, reason: string): Promise<void> {
  log.step(`OnBase: ${reason} — clearing the stale app session via Logout.aspx`);
  await page
    .goto(ONBASE_URL.replace(/NavPanel\.aspx$/i, "Logout.aspx"), {
      waitUntil: "domcontentloaded",
      timeout: 15_000,
    })
    .catch(() => undefined);
  await page.waitForTimeout(1_000);
  await page
    .goto(ONBASE_URL.replace(/NavPanel\.aspx$/i, "Login.aspx"), {
      waitUntil: "domcontentloaded",
      timeout: 15_000,
    })
    .catch(() => undefined);
  await waitForOnbaseAuthLanding(page);
}

async function reloadOnbaseNavPanelAfterError(
  page: Page,
  reason: string,
  attempt: number,
): Promise<void> {
  log.step(
    `OnBase NavPanel returned ${reason} after SSO — reloading NavPanel.aspx (${attempt}/2)`,
  );
  await page.reload({ waitUntil: "domcontentloaded", timeout: 15_000 }).catch(async () => {
    await page.goto(ONBASE_URL, { waitUntil: "domcontentloaded", timeout: 15_000 });
  });
  await waitForOnbaseAuthLanding(page, 5_000);
}

function buildOnbaseSuccessCheck(): (page: Page) => Promise<boolean> {
  let recoveryReloads = 0;
  let logoutHops = 0;
  return async (page: Page): Promise<boolean> => {
    if (await isOnbaseAuthenticated(page)) return true;

    // Single-session contention post-Duo, or a 403 that plain reloads cannot
    // clear (the slot-held limbo): take the Logout.aspx hop once. The IdP
    // session exists at this point, so the Login.aspx re-entry is silent.
    const contention = await isOnbaseSessionContention(page);
    if (logoutHops < 1 && (contention || recoveryReloads >= 2)) {
      const forbidden = contention ? false : await isOnbaseForbidden(page);
      if (contention || forbidden) {
        logoutHops += 1;
        await clearOnbaseActiveSession(
          page,
          contention ? "another session is active post-Duo" : "NavPanel 403 persists post-Duo",
        );
        return await isOnbaseAuthenticated(page);
      }
    }

    if (recoveryReloads < 2) {
      // Both a post-Duo 403 and a ViewState-MAC failure land at the NavPanel URL
      // and recover the same way — a fresh reload rebuilds ViewState/routing on
      // the current farm node.
      const forbidden = await isOnbaseForbidden(page);
      const viewstate = forbidden ? false : await isOnbaseViewstateError(page);
      if (forbidden || viewstate) {
        recoveryReloads += 1;
        await reloadOnbaseNavPanelAfterError(
          page,
          forbidden ? "403" : "a ViewState MAC error",
          recoveryReloads,
        );
        return await isOnbaseAuthenticated(page);
      }
    }
    return false;
  };
}

/**
 * Authenticate to OnBase (Hyland) via UCSD Shibboleth SSO with Duo MFA.
 *
 * Flow: Navigate to the OnBase NavPanel → it redirects straight to the
 *       a5.ucsd.edu SSO form (Active Directory, no campus-discovery hop) →
 *       fill credentials → submit → wait for Duo → land back on
 *       NavPanel.aspx with the Main Menu visible.
 *
 * Same `fillSsoCredentials` path as every other UCSD system (reuses
 * UCPATH_USER_ID / UCPATH_PASSWORD), so the hands-off WebAuthn Duo path
 * covers it identically. Mirrors `loginToACTCrm` minus the Salesforce
 * Active-Directory dropdown (OnBase has no login-type picker).
 */
async function loginToOnBaseFlow(
  page: Page,
  instance?: string,
  abortSignal?: AbortSignal,
): Promise<boolean> {
  log.step("Navigating to OnBase...");
  const navResponse = await page.goto(ONBASE_URL, {
    waitUntil: "domcontentloaded",
    timeout: 15_000,
  });
  // Let the SAML redirect chain settle without blocking on networkidle — OnBase
  // keeps background requests open and networkidle can hang for the full timeout.
  await waitForOnbaseAuthLanding(page);

  if (await isOnbaseForbidden(page, navResponse?.status())) {
    log.step("OnBase NavPanel returned 403 — retrying via Login.aspx");
    await page.goto(ONBASE_URL.replace(/NavPanel\.aspx$/i, "Login.aspx"), {
      waitUntil: "domcontentloaded",
      timeout: 15_000,
    });
    await waitForOnbaseAuthLanding(page);
  } else if (await isOnbaseViewstateError(page)) {
    // A ViewState-MAC error at the fresh NavPanel landing — a clean re-nav
    // rebuilds ViewState on the current farm node before we probe for SSO.
    log.step("OnBase NavPanel returned a ViewState MAC error — re-navigating NavPanel.aspx");
    await page.goto(ONBASE_URL, { waitUntil: "domcontentloaded", timeout: 15_000 });
    await waitForOnbaseAuthLanding(page);
  }

  // A stale session holds the account's single app-session slot (the Login.aspx
  // hop above surfaces this as the abort-only contention dialog). Clear it via
  // Logout.aspx and re-enter — the flow then continues on whatever renders:
  // NavPanel (IdP session still valid) or the SSO form.
  if (await isOnbaseSessionContention(page)) {
    await clearOnbaseActiveSession(page, "another session is currently active");
  }

  if (await isOnbaseAuthenticated(page)) {
    log.success("OnBase already authenticated");
    return true;
  }

  // Wait for the Shibboleth SSO form to paint (the SAML redirect chain may
  // still be in flight), then fill + submit.
  if (!(await waitForSsoForm(page, 15_000)) || !(await isSsoFormReady(page))) {
    log.error(`OnBase SSO form did not render (URL: ${page.url()})`);
    return false;
  }
  await fillSsoCredentials(page);
  await clickSsoSubmit(page, { abortSignal });

  const duoOptions = {
    timeoutSeconds: 180,
    successUrlMatch: (url: string) =>
      url.includes("hylandcloud.com") &&
      !url.includes("Login.aspx") &&
      !url.includes("duosecurity"),
    successCheck: buildOnbaseSuccessCheck(),
    systemLabel: "OnBase",
    abortSignal,
  };
  const approved = instance
    ? await requestDuoApproval(page, { ...duoOptions, system: "OnBase", instance })
    : await pollDuoApproval(page, duoOptions);

  if (!approved) {
    log.error("OnBase Duo approval timed out");
    return false;
  }

  if (!(await isOnbaseAuthenticated(page))) {
    log.warn(`OnBase post-Duo landing verification failed; URL=${page.url()}`);
    return false;
  }

  log.success("OnBase authenticated");
  return true;
}

export const loginToOnBase = defineSsoLogin<[instance?: string, abortSignal?: AbortSignal]>({
  id: "OnBase",
  submit: loginToOnBaseFlow,
});

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
export const loginToUKG = defineSsoLogin<[instance?: string, abortSignal?: AbortSignal]>({
  id: "OldKronos",
  prepare: (page) => ukgNavigateAndFill(page),
  submit: ukgSubmitAndWaitForDuo,
});

/**
 * Navigate to UKG and fill SSO credentials without clicking login.
 * Returns "already_logged_in" if session is still active, true if credentials filled, false on error.
 */
export async function ukgNavigateAndFill(page: Page): Promise<boolean | "already_logged_in"> {
  log.step("Navigating to UKG...");

  // Retry navigation on transient network errors via gotoWithRetry
  await gotoWithRetry(page, UKG_URL, undefined, 3, 60_000);
  // Short settle to let UKG's SPA initialize before probing the session state
  // (reduced from 5s — "Manage My Department" appears quickly on warm sessions).
  await page.waitForTimeout(2_000);

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
export async function ukgSubmitAndWaitForDuo(
  page: Page,
  instance?: string,
  abortSignal?: AbortSignal,
): Promise<boolean> {
  // Route through the shared clickSsoSubmit helper (not a raw button click) so
  // the hands-off Duo WebAuthn authenticator is armed before the Duo prompt,
  // exactly like every other SSO flow. UKG offers Touch ID and does not auto-fire
  // a passkey request, so late-arming in beginDuoWebAuthn would still work — but
  // routing here keeps all six SSO flows on one arming path and is robust if
  // UKG's Duo prompt behavior ever changes.
  await clickSsoSubmit(page, { abortSignal });
  log.step("Credentials submitted — waiting for Duo MFA...");

  const duoOptions = {
    successUrlMatch: () => true,
    successCheck: async (p: Page) =>
      (await p.locator("text=Manage My Department").count()) > 0,
    systemLabel: "OldKronos",
    abortSignal,
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
  // networkidle guards the initial load; sleep was redundant.
  await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});

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
  abortSignal?: AbortSignal,
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
    await clickSsoSubmit(page, { abortSignal });
    log.step("Kuali: credentials submitted — waiting for Duo MFA...");
  } catch (err) {
    if (abortSignal?.aborted) throw err;
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
        // Short settle after SAML recovery re-navigation (Shibboleth redirect takes ~1s).
        await p.waitForTimeout(1_500);
      }
    },
    systemLabel: "Kuali",
    abortSignal,
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
export const loginToKuali = defineSsoLogin<[
  url: string,
  instance?: string,
  abortSignal?: AbortSignal,
]>({
  id: "Kuali",
  prepare: kualiNavigateAndFill,
  submit: kualiSubmitAndWaitForDuo,
});

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
  // Short settle for SSO redirect chain to land. Use waitForURL for the
  // already-logged-in fast path; otherwise fall through to credential fill.
  // Reduced from 5s — SSO redirects settle within ~1s on warm sessions.
  await page.waitForTimeout(2_000);

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
  abortSignal?: AbortSignal,
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

  await clickSsoSubmit(page, { abortSignal });
  log.step("New Kronos: credentials submitted — waiting for Duo MFA...");

  const duoOptions = {
    successUrlMatch: "mykronos.com/wfd" as const,
    recovery: async (p: Page) => {
      if (p.url().includes("#failedLogin")) {
        log.step("Session timeout detected — re-navigating...");
        await p.goto(NEW_KRONOS_WFD_URL, { waitUntil: "domcontentloaded", timeout: 10_000 }).catch(() => {});
        // Short settle after session-timeout recovery re-navigation.
        await p.waitForTimeout(1_500);
      }
    },
    systemLabel: "NewKronos",
    abortSignal,
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
export const loginToNewKronos = defineSsoLogin<[instance?: string, abortSignal?: AbortSignal]>({
  id: "NewKronos",
  prepare: (page) => newKronosNavigateAndFill(page),
  submit: newKronosSubmitAndWaitForDuo,
});

/**
 * Authenticate to UCSD's HR Employee Center on support.ucsd.edu (ServiceNow).
 *
 * Flow: Navigate to the HR Inquiry deep-link → SAML redirects to TritON
 * (`a5.ucsd.edu`) → fill UCSD SSO credentials → submit → poll Duo via
 * `requestDuoApproval` → return on landing back on the form.
 *
 * Reuses the existing UCPATH_USER_ID/UCPATH_PASSWORD env vars — UCSD SSO
 * is the same realm as UCPath/Kuali/Kronos.
 *
 * @returns true on success, false on failure (kernel's loginWithRetry handles retries)
 */
async function loginToServiceNowFlow(
  page: Page,
  instance?: string,
  abortSignal?: AbortSignal,
): Promise<boolean> {
  log.step("Navigating to support.ucsd.edu HR Inquiry form...");
  await page.goto(HR_INQUIRY_FORM_URL, { waitUntil: "domcontentloaded", timeout: 15_000 });

  // Already authenticated? Subject textbox visible → skip the SSO dance.
  if (
    await hrInquiry
      .subjectInput(page)
      .isVisible({ timeout: 2_000 })
      .catch(() => false)
  ) {
    log.success("ServiceNow already authenticated");
    return true;
  }

  // Otherwise we're mid-redirect toward the TritON SSO page. The
  // support.ucsd.edu → auth_redirect.do → a5.ucsd.edu hop chain is client-side,
  // so the SSO form isn't on the interstitial yet — poll for it to render (a
  // single waitForLoadState resolves on the interstitial and the form check
  // would then fail spuriously). The a5 form lands ~1–2s after navigation.
  if (!(await isSsoFormReady(page))) {
    if (!(await waitForSsoForm(page, 15_000))) {
      log.warn(`[Auth: servicenow] SSO form not ready; URL=${page.url()}`);
      return false;
    }
  }

  try {
    await fillSsoCredentials(page);
    await clickSsoSubmit(page, { abortSignal });
  } catch (err) {
    if (abortSignal?.aborted) throw err;
    log.warn(
      `[Auth: servicenow] SSO field fill failed: ${err instanceof Error ? err.message : err}`,
    );
    return false;
  }
  log.step(`After ServiceNow SSO submit | URL: ${page.url()}`);

  // Duo approval. Success criteria: back on support.ucsd.edu AND the
  // HR Inquiry form's Subject textbox is visible (so we know we landed
  // on the correct form, not some other ServiceNow redirect target).
  const duoOptions = {
    timeoutSeconds: 300,
    successUrlMatch: (url: string) =>
      url.includes("support.ucsd.edu") && !url.includes("duosecurity"),
    successCheck: async (p: Page) =>
      hrInquiry.subjectInput(p).isVisible({ timeout: 5_000 }).catch(() => false),
    systemLabel: "ServiceNow",
    abortSignal,
  };

  const approved = instance
    ? await requestDuoApproval(page, { ...duoOptions, system: "ServiceNow", instance })
    : await pollDuoApproval(page, duoOptions);

  if (!approved) {
    log.warn("[Auth: servicenow] Duo approval failed/timed out");
    return false;
  }

  // Final landing verification — sanity check that we're really on the form.
  if (
    !(await hrInquiry
      .subjectInput(page)
      .isVisible({ timeout: 5_000 })
      .catch(() => false))
  ) {
    log.warn(
      `[Auth: servicenow] post-Duo landing verification failed; URL=${page.url()}`,
    );
    return false;
  }

  log.success("ServiceNow authenticated");
  return true;
}

export const loginToServiceNow = defineSsoLogin<[instance?: string, abortSignal?: AbortSignal]>({
  id: "ServiceNow",
  submit: loginToServiceNowFlow,
});
