import type { Page } from "playwright";
import { validateEnv } from "../../utils/env.js";
import { log } from "../../utils/log.js";
import { armDuoWebAuthn, isDuoWebAuthnEnabled } from "./duo-webauthn.js";

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
export async function clickSsoSubmit(page: Page, opts: { abortSignal?: AbortSignal } = {}): Promise<void> {
  opts.abortSignal?.throwIfAborted();
  // Hands-off Duo (opt-in): arm the WebAuthn virtual authenticator BEFORE this
  // click navigates to the Duo prompt. ACT CRM auto-fires a passkey request the
  // instant its prompt loads, so the (resident) authenticator must already exist
  // to answer it — otherwise Chrome's native "insert your security key" dialog
  // blocks the page. Idempotent + best-effort; failure degrades to manual Duo.
  if (isDuoWebAuthnEnabled()) {
    try {
      await armDuoWebAuthn(page, { abortSignal: opts.abortSignal });
    } catch (err) {
      if (opts.abortSignal?.aborted) throw err;
    }
  }
  opts.abortSignal?.throwIfAborted();
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

/**
 * Wait up to `timeoutMs` for the SSO submit button to render. Unlike the
 * one-shot `isSsoFormReady`, this *polls* — needed when a SAML redirect chain is
 * still in flight and the form hasn't painted yet. ServiceNow is the motivating
 * case: navigating to the HR Inquiry deep-link hops
 * `support.ucsd.edu/esc` → `support.ucsd.edu/auth_redirect.do` → `a5.ucsd.edu`
 * client-side, so the form isn't on the interstitial. A single `waitForLoadState`
 * resolves on that interstitial and a form check then fails spuriously; waiting
 * for the button itself bridges the redirect (the a5 form lands ~1–2s later).
 * Returns true once the button appears, false on timeout.
 */
export async function waitForSsoForm(page: Page, timeoutMs = 15_000): Promise<boolean> {
  try {
    await page
      .locator(SSO_SUBMIT_SELECTOR)
      .first()
      .waitFor({ state: "visible", timeout: timeoutMs });
    return true;
  } catch {
    return false;
  }
}
