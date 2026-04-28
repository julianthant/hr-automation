import type { Page } from "playwright";
import { getLogRunId, getLogWorkflow, log } from "../utils/log.js";
import { cueDuo } from "./voice-cue.js";
import {
  notifyAuthEvent,
  type AuthEventKind,
} from "./telegram-notify.js";

/**
 * Fire a best-effort Telegram notification with the active log context's
 * workflow + runId. Reads ALS each call so the message includes the kernel
 * item that triggered the auth wait. Always swallows errors.
 */
function emitTelegram(
  kind: AuthEventKind,
  systemLabel: string,
  detail?: string,
): void {
  const workflow = getLogWorkflow() ?? "(unknown)";
  const runId = getLogRunId();
  void notifyAuthEvent({
    kind,
    systemLabel,
    workflow,
    ...(runId ? { runId } : {}),
    ...(detail ? { detail } : {}),
  }).catch(() => {
    /* notifyAuthEvent already swallows; this is belt-and-suspenders */
  });
}

/**
 * Fixed Duo poll cadence. Replaces the prior 2-second cadence.
 *
 * Rationale (2026-04-28): when separations launches 4 systems with
 * `parallel-staggered` Duo, the 2s cadence produced bursty SSO/Duo
 * requests that occasionally tripped UCSD-side errors. A fixed 5s
 * cadence keeps the per-system request rate low and the cross-system
 * total well under SSO's tolerance, at the cost of a small detection
 * latency increase (worst case ≈5s after approval).
 *
 * Exported so tests can override via the `pollIntervalMs` option.
 */
export const DUO_POLL_INTERVAL_MS = 5_000;

/**
 * Options for polling Duo MFA approval.
 */
export interface DuoPollOptions {
  /**
   * How long to wait total before timing out.
   * Default: 180 seconds.
   */
  timeoutSeconds?: number;

  /**
   * Override the poll cadence in milliseconds. Default: `DUO_POLL_INTERVAL_MS`
   * (5000ms). Tests pass smaller values; production should leave unset.
   */
  pollIntervalMs?: number;

  /**
   * Determines whether the current URL indicates successful authentication.
   * Pass a string for a simple substring match, or a function for custom logic.
   */
  successUrlMatch: string | ((url: string) => boolean);

  /**
   * Optional additional verification beyond URL matching.
   * Called when the URL check passes — return false to keep polling.
   */
  successCheck?: (page: Page) => Promise<boolean>;

  /**
   * Optional async hook executed once after approval is confirmed.
   * Runs before pollDuoApproval returns true.
   */
  postApproval?: (page: Page) => Promise<void>;

  /**
   * Optional recovery callback — runs each poll iteration to handle mid-auth errors
   * (e.g., SAML redirects in Kuali, #failedLogin in New Kronos).
   */
  recovery?: (page: Page) => Promise<void>;

  /**
   * Optional human-readable label for the system being authenticated (e.g.
   * "UCPath", "Kuali"). Currently used only by the opt-in macOS voice cue
   * (`HR_AUTOMATION_VOICE_CUES=1`) to say "Duo for <systemLabel>" when the
   * polling loop starts. Silently ignored when unset or on non-darwin.
   */
  systemLabel?: string;
}

/**
 * Unified Duo MFA polling loop.
 *
 * Replaces the 5 near-identical polling loops in login.ts:
 * - loginToUCPath
 * - loginToACTCrm (via ukgSubmitAndWaitForDuo)
 * - ukgSubmitAndWaitForDuo
 * - loginToKuali
 * - loginToNewKronos
 *
 * Every 2 seconds, the loop:
 * 1. Checks for "Yes, this is my device" trust button and clicks it
 * 2. Checks if the current URL satisfies successUrlMatch
 * 3. If URL matches, optionally runs successCheck for additional verification
 * 4. On success, runs postApproval hook then returns true
 *
 * @param page - Playwright page instance
 * @param options - Polling configuration
 * @returns true if Duo approved within timeout, false otherwise
 */
export async function pollDuoApproval(
  page: Page,
  options: DuoPollOptions,
): Promise<boolean> {
  const { timeoutSeconds = 180, successUrlMatch, successCheck, postApproval, recovery, systemLabel } = options;
  const pollIntervalMs = options.pollIntervalMs ?? DUO_POLL_INTERVAL_MS;
  const pollIntervalSec = pollIntervalMs / 1000;

  const urlMatches = (url: string): boolean => {
    if (typeof successUrlMatch === "string") {
      return url.includes(successUrlMatch);
    }
    return successUrlMatch(url);
  };

  // Best-effort voice cue — opt-in via HR_AUTOMATION_VOICE_CUES=1 + macOS.
  // Fires once before the polling loop begins so the operator hears a cue if
  // they're not looking at the terminal. Never blocks; never throws.
  await cueDuo(systemLabel ?? "system").catch(() => {});

  // Best-effort Telegram DM. Activated when TELEGRAM_BOT_TOKEN +
  // TELEGRAM_CHAT_ID are set; otherwise no-op.
  emitTelegram("duo-waiting", systemLabel ?? "system", "Approve on your phone");

  log.waiting("Waiting for Duo approval (approve on your phone)...");

  for (let elapsed = 0; elapsed < timeoutSeconds; elapsed += pollIntervalSec) {
    try {
      // Run optional recovery callback to handle mid-auth errors (e.g., SAML redirects)
      if (recovery) {
        log.step("Duo: running mid-auth recovery check...");
        await recovery(page).catch(() => {});
      }

      // Check for Duo push timeout — click "Try Again" to resend
      const tryAgainBtn = page.getByRole("button", { name: /try again/i })
        .or(page.locator('button:has-text("Try Again")'));
      if ((await tryAgainBtn.count()) > 0) {
        log.step("Duo push timed out — clicking Try Again...");
        await tryAgainBtn.first().click({ timeout: 5_000 });
        log.waiting("Duo push resent — approve on your phone...");
        emitTelegram("duo-resent", systemLabel ?? "system", "Push resent");
        await page.waitForTimeout(pollIntervalMs);
        continue;
      }

      // Check for "Yes, this is my device" trust button and click it
      const trustButton = page.getByText("Yes, this is my device");
      if ((await trustButton.count()) > 0) {
        log.step('Clicking "Yes, this is my device"...');
        await trustButton.click({ timeout: 5_000 });
        log.step('Duo: clicked "Yes, this is my device" trust button');
      }

      // Detect the UCSD SSO "Web Login Service - Stale Request" page —
      // shown when the SAML execution context expires between the
      // initial SSO form and the post-Duo assertion. The recovery
      // callback above gets first crack; if the page is still showing
      // "Stale Request", abort this attempt so loginWithRetry can
      // navigate to the service URL fresh (which triggers a new SAML
      // flow with a fresh execution id).
      const currentUrl = page.url();
      if (currentUrl.includes("a5.ucsd.edu")) {
        const staleCount = await page
          .getByText("Web Login Service - Stale Request")
          .count()
          .catch(() => 0);
        if (staleCount > 0) {
          log.error(
            `[Auth${systemLabel ? `: ${systemLabel}` : ""}] SSO Stale Request page detected at ${currentUrl} — SAML execution expired during Duo. Returning false so loginWithRetry can restart with a fresh navigation.`,
          );
          return false;
        }
      }

      // Check if the URL indicates successful auth
      if (urlMatches(page.url())) {
        // Run optional additional verification
        if (successCheck) {
          const verified = await successCheck(page);
          if (!verified) {
            await page.waitForTimeout(pollIntervalMs);
            continue;
          }
        }

        log.step(`Duo approved | URL: ${page.url()}`);
        emitTelegram("duo-approved", systemLabel ?? "system");

        // Run post-approval hook if provided
        if (postApproval) {
          await postApproval(page);
        }

        return true;
      }
    } catch {
      // Page may be navigating — swallow and retry
    }

    await page.waitForTimeout(pollIntervalMs);
  }

  log.error("Duo approval timed out");
  emitTelegram("duo-timeout", systemLabel ?? "system");
  return false;
}
