import type { Page } from "playwright";
import { log } from "../../utils/log.js";
import { errorMessage } from "../../utils/errors.js";
import { I9_URL } from "../../config.js";
import { login as loginSelectors } from "./selectors.js";
import { clickIfPresent, safeClick } from "../common/index.js";
import {
  fillSsoCredentials,
  clickSsoSubmit,
  isSsoFormReady,
  waitForSsoForm,
} from "../../infra/auth/sso-fields.js";
import { pollDuoApproval } from "../../infra/auth/duo-poll.js";
import { requestDuoApproval } from "../../tracker/sessions/duo-queue.js";

/**
 * Authenticate to I-9 Complete (Tracker I-9 by Mitratech) through the UCOP
 * portal's UCSD Shibboleth SSO with Duo MFA.
 *
 * Flow (mapped + verified live 2026-07-01):
 *   1. Navigate to the UCOP portal (`i9complete.ucop.edu`).
 *   2. Click "Tracker I-9 Complete Application" → `samlproxy.ucop.edu` SAML flow.
 *   3. WAYF identity-provider picker → select "University of California, San
 *      Diego" → "Select" (auto-skipped if the proxy remembered the campus).
 *   4. UCSD TritON SSO form (`a5.ucsd.edu`) → fill campus credentials → submit.
 *   5. Duo MFA → SAML redirect lands on the app host (`wwwe.i9complete.com`).
 *   6. Dismiss the post-login required-training notification if present.
 *
 * This replaced the old standalone `stse.i9complete.com` email/password login
 * on 2026-07-01. Auth now shares the UCSD SSO path (`fillSsoCredentials` /
 * `clickSsoSubmit` / `pollDuoApproval`) and UCPath credentials with every other
 * UCSD system, so hands-off Duo WebAuthn covers it identically. `instance` +
 * `abortSignal` join the global Duo queue when the kernel authenticates ≥2
 * systems (e.g. onboarding: UCPath + I-9). Post-login the app UI is unchanged.
 */
export async function loginToI9(
  page: Page,
  instance?: string,
  abortSignal?: AbortSignal,
): Promise<boolean> {
  log.step("Navigating to I-9 Complete (UCOP portal)...");
  await page.goto(I9_URL, { waitUntil: "domcontentloaded", timeout: 15_000 });
  log.step(`Landing page loaded | URL: ${page.url()}`);

  // Warm session (persistent context) may land straight on the app host.
  if (page.url().includes("i9complete.com")) {
    log.success("I-9 Complete already authenticated");
    return true;
  }

  // Step 1: launch the SSO application from the UCOP landing page.
  await safeClick(loginSelectors.appLaunchLink(page), {
    timeout: 10_000,
    label: "i9 application launch link",
  });
  log.step(`After launch click | URL: ${page.url()}`);

  // Step 2: WAYF identity-provider picker. Present unless the proxy remembered
  // the campus choice (then it auto-forwards straight to the UCSD SSO form).
  const idpSelect = loginSelectors.idpSelect(page);
  if (await idpSelect.isVisible({ timeout: 10_000 }).catch(() => false)) {
    await idpSelect.selectOption(
      { label: "University of California, San Diego" },
      { timeout: 10_000 },
    );
    await safeClick(loginSelectors.idpSelectButton(page), {
      timeout: 10_000,
      label: "i9 WAYF campus select",
    });
    log.step(`Selected UC San Diego | URL: ${page.url()}`);
  }

  // Step 3: UCSD TritON Shibboleth SSO form (the SAML redirect chain may still
  // be in flight — poll for the form to paint, like ServiceNow's SSO hop).
  if (!(await isSsoFormReady(page)) && !(await waitForSsoForm(page, 15_000))) {
    log.error(`I-9 SSO form did not render (URL: ${page.url()})`);
    return false;
  }
  try {
    await fillSsoCredentials(page);
    await clickSsoSubmit(page, { abortSignal });
  } catch (err) {
    if (abortSignal?.aborted) throw err;
    log.error(
      `I-9 SSO field fill/submit failed: ${err instanceof Error ? err.message : err}`,
    );
    return false;
  }
  log.step(`After I-9 SSO submit | URL: ${page.url()}`);

  // Step 4: Duo MFA — success is landing back on the i9complete.com app host.
  const duoOptions = {
    timeoutSeconds: 180,
    successUrlMatch: (url: string) =>
      url.includes("i9complete.com") && !url.includes("duosecurity"),
    systemLabel: "I9",
    abortSignal,
  };
  const approved = instance
    ? await requestDuoApproval(page, { ...duoOptions, system: "I9", instance })
    : await pollDuoApproval(page, duoOptions);
  if (!approved) {
    log.error("I-9 Complete Duo approval failed/timed out");
    return false;
  }
  log.step(`Logged in | URL: ${page.url()}`);

  // Step 5: dismiss the required-training notification if present.
  await dismissTrainingNotification(page);

  log.success("I-9 Complete authenticated");
  return true;
}

/**
 * Dismiss the "Required Training Notification" popup that appears after login.
 * Clicks "Dismiss the Notification" then confirms "Yes". No-ops when the
 * notification is genuinely absent (already on the dashboard) — that's the
 * only case treated as "continuing normally"; a failure AFTER the dismiss
 * button was found (confirm click or the post-dismiss dashboard wait) is a
 * distinct, real failure and is surfaced via `log.warn` rather than folded
 * into the same "no notification" message, since a stuck modal blocking
 * later clicks would otherwise be misdiagnosed downstream with no trail
 * pointing back here.
 */
async function dismissTrainingNotification(page: Page): Promise<void> {
  const dismissBtn = loginSelectors.dismissNotificationButton(page);
  const present = await clickIfPresent(dismissBtn, {
    timeout: 5_000,
    label: "i9 training dismiss button",
  });
  if (!present) {
    log.step("No training notification — continuing");
    return;
  }

  log.step("Dismissing training notification...");
  try {
    // Confirm the dismiss dialog
    await safeClick(loginSelectors.confirmYesButton(page), {
      timeout: 5_000,
      label: "i9 confirm yes button",
    });
    log.step("Training notification dismissed");

    // Wait for dashboard to load
    await page.waitForURL((url) => url.pathname === "/" || url.search.includes("mobile=false"), { timeout: 10_000 });
  } catch (err) {
    log.warn(
      `I9 training notification was present but dismissal did not complete (confirm click or dashboard navigation failed) — page may still show the modal: ${errorMessage(err)}`,
    );
  }
}
