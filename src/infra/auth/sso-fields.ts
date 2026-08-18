import type { Locator, Page } from "playwright";
import { validateEnv } from "../../utils/env.js";
import { log } from "../../utils/log.js";
import { armDuoBeforeSsoNavigation } from "./duo-webauthn.js";

/**
 * Fill UCSD Shibboleth SSO credentials (username + password) on the current page.
 *
 * Resolves each field through an ordered candidate list anchored on the
 * live-mapped UCSD TritON ids, proves the two are distinct (and that the
 * password box really is a password input), fills them, and reads the values
 * back. Any mis-resolution fails loud rather than submitting a password as a
 * username.
 *
 * @param page - Playwright page instance (must already be on the SSO login page)
 */

/**
 * First candidate locator that actually resolves to exactly one element on the
 * page, tried in CHAIN ORDER. Unlike `a.or(b).or(c).first()` — which resolves
 * in DOM order and can silently return a different field than intended — this
 * honours the precedence the caller wrote.
 *
 * Throws naming every candidate when none is present, rather than returning a
 * locator that will fail later with an opaque timeout.
 */
async function firstPresent(candidates: Locator[], label: string): Promise<Locator> {
  const seen: string[] = [];
  for (const candidate of candidates) {
    const count = await candidate.count().catch(() => 0);
    seen.push(String(count));
    if (count === 1) return candidate;
    if (count > 1) return candidate.first();
  }
  throw new Error(
    `${label} field not found on the SSO form — none of the ${candidates.length} known anchors matched `
    + `(match counts: ${seen.join(", ")}). The login form markup has changed; re-map it before retrying.`,
  );
}

export async function fillSsoCredentials(page: Page): Promise<void> {
  const { userId, password } = validateEnv();

  log.step("Entering credentials...");

  // LIVE-MAPPED 2026-08-18 (playwright-cli against the real UCSD TritON form):
  //   username: id="ssousername"  name="urn:mace:ucsd.edu:sso:username"  label "Account ID or email address"
  //   password: id="ssopassword"  name="urn:mace:ucsd.edu:sso:password"  label "Password:"
  //
  // The previous chain used `.or()` + `.first()`, which is a trap here for two
  // reasons: (1) `.or()` resolves in DOM ORDER, not chain order, so a loose
  // match can hand back the USERNAME box when resolving the password — which is
  // exactly the "both values typed into the username slot, password left empty"
  // failure; and (2) none of its username anchors actually matched this form
  // ("User name (or email address)" / "Username" / input[name=j_username] are
  // all absent), so it was relying on incidental matches.
  //
  // Resolve each field in CHAIN ORDER instead, and prove the two are distinct
  // before typing a password anywhere.
  const usernameCandidates: Locator[] = [
    page.locator("#ssousername"),
    page.locator('input[name="urn:mace:ucsd.edu:sso:username"]'),
    page.getByLabel("Account ID or email address"),
    page.getByLabel("User name (or email address)"),
    page.getByLabel("Username"),
    page.locator('input[name="j_username"]'),
  ];
  const passwordCandidates: Locator[] = [
    page.locator("#ssopassword"),
    page.locator('input[name="urn:mace:ucsd.edu:sso:password"]'),
    page.locator('input[type="password"]'),
    page.getByLabel("Password:"),
    page.locator('input[name="j_password"]'),
  ];

  const usernameField = await firstPresent(usernameCandidates, "SSO username");
  const passwordField = await firstPresent(passwordCandidates, "SSO password");

  // The password field must really be a password input, and must not be the
  // same node as the username field. Typing a password into a text box that is
  // about to be submitted as a username is the failure this guards.
  const passwordType = await passwordField.getAttribute("type").catch(() => null);
  if (passwordType !== "password") {
    throw new Error(
      `SSO password field resolved to an input of type '${passwordType ?? "unknown"}', not 'password' `
      + `— refusing to type the password into it.`,
    );
  }
  const [userId_, passId] = await Promise.all([
    usernameField.evaluate((el) => el.id || el.getAttribute("name") || "").catch(() => ""),
    passwordField.evaluate((el) => el.id || el.getAttribute("name") || "").catch(() => ""),
  ]);
  if (userId_ && passId && userId_ === passId) {
    throw new Error(
      `SSO username and password resolved to the SAME field ('${userId_}') — refusing to type both `
      + `into one box (this leaves the password empty and sends it as the username).`,
    );
  }

  await usernameField.fill(userId, { timeout: 5_000 });
  await passwordField.fill(password, { timeout: 5_000 });
  await page.waitForTimeout(500);

  // Positive read-back: the username must hold the user id, and the password
  // field must be non-empty. A silent mis-fill is what this whole block exists
  // to prevent, so verify rather than assume.
  const filledUser = await usernameField.inputValue().catch(() => "");
  const filledPassLen = (await passwordField.inputValue().catch(() => "")).length;
  if (filledUser !== userId || filledPassLen === 0) {
    throw new Error(
      `SSO credential fill did not take: username field reads '${filledUser}' (expected the configured `
      + `user id) and the password field holds ${filledPassLen} character(s).`,
    );
  }
  log.step(`SSO: credentials filled (username='${userId_ || "?"}', password='${passId || "?"}')`);
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
  await armDuoBeforeSsoNavigation(page, {
    label: "SSO submit",
    ...(opts.abortSignal ? { abortSignal: opts.abortSignal } : {}),
  });
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
