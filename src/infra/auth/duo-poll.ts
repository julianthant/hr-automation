import type { Page } from "playwright";
import { setTimeout as sleep } from "node:timers/promises";
import { log } from "../../utils/log.js";
import { cueDuo } from "./voice-cue.js";
import {
  beginDuoWebAuthn,
  finishDuoWebAuthn,
  isDuoWebAuthnEnabled,
  resyncDuoWebAuthnSignCounts,
} from "./duo-webauthn.js";

export function extractDuoVerificationCode(text: string): string | undefined {
  const normalized = text.replace(/\s+/g, " ").trim();
  const marker = normalized.search(/enter code in duo mobile/i);
  if (marker < 0) return undefined;
  return normalized.slice(marker).match(/\b(\d{4,8})\b/)?.[1];
}

export function buildDuoWaitingDetail(code: string | undefined): string {
  return code ? `Enter Duo code ${code} in Duo Mobile` : "Approve on your phone";
}

export function buildDuoResentDetail(
  currentCode: string | undefined,
  previousCode: string | undefined,
): string {
  const code = currentCode?.trim() || previousCode?.trim();
  return code ? buildDuoWaitingDetail(code) : "Push resent";
}

async function readDuoVerificationCode(page: Page): Promise<string | undefined> {
  const bodyText = await page.locator("body").innerText({ timeout: 1_000 }).catch(() => "");
  return extractDuoVerificationCode(bodyText);
}

export const DUO_INITIAL_CODE_WAIT_MS = 3_000;
export const DUO_CODE_WAIT_INTERVAL_MS = 250;

export async function readDuoVerificationCodeWhenVisible(
  page: Page,
  opts: {
    timeoutMs?: number;
    intervalMs?: number;
    previousCode?: string;
    abortSignal?: AbortSignal;
  } = {},
): Promise<string | undefined> {
  const timeoutMs = opts.timeoutMs ?? DUO_INITIAL_CODE_WAIT_MS;
  const intervalMs = opts.intervalMs ?? DUO_CODE_WAIT_INTERVAL_MS;
  const deadline = Date.now() + Math.max(0, timeoutMs);
  let lastVisibleCode: string | undefined;

  do {
    opts.abortSignal?.throwIfAborted();
    const code = await readDuoVerificationCode(page);
    if (code) {
      lastVisibleCode = code;
      if (!opts.previousCode || code !== opts.previousCode) return code;
    }
    if (Date.now() >= deadline) break;
    await waitForDuoPoll(intervalMs, opts.abortSignal);
  } while (Date.now() < deadline);

  return lastVisibleCode;
}

async function readDuoVerificationCodeAfterResend(
  page: Page,
  previousCode: string | undefined,
  abortSignal?: AbortSignal,
): Promise<string | undefined> {
  return readDuoVerificationCodeWhenVisible(page, {
    previousCode,
    timeoutMs: DUO_INITIAL_CODE_WAIT_MS,
    intervalMs: DUO_CODE_WAIT_INTERVAL_MS,
    abortSignal,
  });
}

async function waitForDuoPoll(ms: number, abortSignal?: AbortSignal): Promise<void> {
  await sleep(ms, undefined, { signal: abortSignal });
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
 * Pre-announce grace window. Before firing the voice cue + waiting log,
 * briefly check whether the page has already transitioned to the success URL.
 * When Duo's "Yes, this is my device" trust token is cached, the SAML chain
 * redirects straight through without pushing to Duo Mobile — in that case we
 * don't want to announce a Duo prompt that didn't happen.
 *
 * 2000ms covers the typical SAML-redirect-with-cached-trust path observed
 * in production. Cached trust usually settles in well under a second; the
 * 2s headroom catches slow-network variants without delaying real Duo
 * notifications meaningfully.
 */
export const DUO_PRE_CHECK_MS = 2_000;
export const DUO_PRE_CHECK_INTERVAL_MS = 500;

/**
 * How long to wait for Duo to approve once the WebAuthn virtual authenticator
 * has selected its factor (opt-in `HR_AUTOMATION_DUO_WEBAUTHN=1`). Chrome answers
 * the ceremony in well under a second; this headroom covers the SSO→app redirect
 * chain plus the optional "Yes, this is my device" trust click. If the window
 * elapses without success, the loop tears the authenticator down and falls back
 * to the manual approval flow. Tests override via `webauthnGraceMs`.
 */
export const DUO_WEBAUTHN_GRACE_MS = 25_000;

/**
 * Shortened manual-approval window used ONLY after a hands-off WebAuthn assertion
 * signed but did not complete within its grace window (the signCount-drift hang
 * seen as "stuck on Use Touch ID"). On that path no phone push was ever sent — the
 * prompt is stuck mid-WebAuthn-ceremony — so the normal 180s "approve on your
 * phone" wait cannot complete on its own and would just stall before the kernel's
 * auto-retry (which re-arms from the resynced counter and approves hands-off). We
 * keep a SHORT window rather than skipping it so the operator can still hand-rescue
 * the *visible* browser via "Other options → Duo Push", then fail fast into the
 * retry. Tests/callers override via `webauthnFallbackSeconds`.
 */
export const DUO_WEBAUTHN_FALLBACK_MANUAL_SECONDS = 30;

/**
 * Bounded approval wait used by the WebAuthn path: each tick clicks the
 * "Yes, this is my device" trust button if present, then checks the success
 * URL (with the optional `successCheck`). Returns true on success, false when
 * the window elapses — at which point the caller falls back to manual Duo.
 */
async function waitForApproval(
  page: Page,
  opts: {
    urlMatches: (url: string) => boolean;
    successCheck?: (page: Page) => Promise<boolean>;
    timeoutMs: number;
    intervalMs?: number;
    abortSignal?: AbortSignal;
  },
): Promise<boolean> {
  const interval = opts.intervalMs ?? 1_000;
  const deadline = Date.now() + opts.timeoutMs;
  while (Date.now() < deadline) {
    opts.abortSignal?.throwIfAborted();
    try {
      const trust = page.getByText("Yes, this is my device");
      if ((await trust.count()) > 0) {
        await trust.click({ timeout: 5_000 }).catch(() => {});
      }
      if (opts.urlMatches(page.url())) {
        if (!opts.successCheck || (await opts.successCheck(page).catch(() => false))) {
          return true;
        }
      }
    } catch {
      // Page may be mid-navigation — swallow and retry.
    }
    await waitForDuoPoll(interval, opts.abortSignal);
  }
  return false;
}

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
   * Override the pre-announce grace window in milliseconds. Default:
   * `DUO_PRE_CHECK_MS` (2000ms). During this window the loop only checks
   * for an already-matched success URL — if found, the voice cue + waiting
   * log are skipped entirely (cached Duo trust path). Set to 0 to disable
   * the pre-check and announce immediately. Tests use small values for fast
   * asserts.
   */
  preCheckMs?: number;

  /**
   * Override the pre-check poll cadence in milliseconds. Default:
   * `DUO_PRE_CHECK_INTERVAL_MS` (500ms). Independent from the main
   * `pollIntervalMs` so the pre-check can sample more aggressively.
   */
  preCheckIntervalMs?: number;

  /**
   * Short bounded wait for the visible Duo Mobile verification code before
   * logging the waiting message. Default: 3000ms. This lets the initial log
   * include the code without blocking indefinitely if Duo only shows push
   * approval.
   */
  initialCodeWaitMs?: number;

  /**
   * Poll cadence for `initialCodeWaitMs`. Default: 250ms.
   */
  initialCodeWaitIntervalMs?: number;

  /**
   * Abort a pending Duo wait. Daemon/session stop passes this through so
   * polling does not continue sleeping in the background after auth is
   * interrupted.
   */
  abortSignal?: AbortSignal;

  /**
   * Override the WebAuthn approval grace window in milliseconds. Default:
   * `DUO_WEBAUTHN_GRACE_MS` (25000ms). Only consulted when the operator opts
   * into hands-off Duo via `HR_AUTOMATION_DUO_WEBAUTHN=1`. Tests pass small
   * values; production should leave unset.
   */
  webauthnGraceMs?: number;

  /**
   * Override the shortened manual-approval window (in seconds) applied only after
   * a WebAuthn assertion signed but did not complete in its grace window
   * (`DUO_WEBAUTHN_FALLBACK_MANUAL_SECONDS`, 30s). Not consulted on the normal
   * (WebAuthn-off, or factor-not-found) manual path. Tests pass small values.
   */
  webauthnFallbackSeconds?: number;

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

  /**
   * Optional workflow instance label (e.g. "Oath Signature 1"). Passed
   * through from the session queue so caller context is available.
   */
  instance?: string;
}

/**
 * Duo's Universal Prompt now defaults to a device factor ("Use Touch ID" /
 * "Use your security key") and does NOT auto-send a push — so the poll loop,
 * which only waits for the success URL, would sit out the whole timeout while
 * the page is parked on that screen with nothing to approve on the phone. This
 * is also where the hands-off WebAuthn path lands when its assertion is rejected
 * ("signs but never completes"). The documented manual rescue is "Other options
 * → Duo Push"; this fires it automatically.
 *
 * Gated tightly so it never disturbs a working prompt: it acts ONLY when a
 * device-factor screen is visible AND no push is already pending (no "request
 * sent" text, "Try Again", or code-entry state). Returns true once a Duo Push
 * was triggered (the caller then waits the full window for phone approval),
 * false when this isn't the stuck-factor screen. Best-effort — never throws.
 */
async function triggerDuoPushFromFactorScreen(page: Page, abortSignal?: AbortSignal): Promise<boolean> {
  try {
    abortSignal?.throwIfAborted();
    // Don't touch a prompt that already pushed (or is mid-resend / code entry).
    const pushPending =
      (await page
        .getByText(/pushed a (login )?request|check for a duo push|sent a request|enter code/i)
        .count()
        .catch(() => 0)) > 0;
    if (pushPending) return false;

    // Only act on the stuck device-factor screen the manual loop can't clear.
    const onFactorScreen =
      (await page
        .getByText(/use touch id|use your security key|verify your identity using this device/i)
        .count()
        .catch(() => 0)) > 0;
    if (!onFactorScreen) return false;

    const pushLink = (): ReturnType<Page["getByRole"]> =>
      page
        .getByRole("link", { name: /duo push|send me a push/i })
        .or(page.getByRole("button", { name: /duo push|send me a push/i }))
        .first();

    // Push may already be listed (factor list directly on screen); else reveal
    // the full "Other options" list first, then click it.
    if ((await pushLink().count()) > 0) {
      await pushLink().click({ timeout: 5_000 }).catch(() => {});
      return true;
    }

    const other = page
      .getByRole("link", { name: /other options|other methods/i })
      .or(page.getByRole("button", { name: /other options|other methods/i }))
      .first();
    if ((await other.count()) > 0) {
      await other.click({ timeout: 3_000 }).catch(() => {});
      // Let the options list finish rendering before clicking — clicking
      // mid-navigation lands Duo on a /error page (the UCPath race).
      await page.waitForTimeout(1_500);
      if ((await pushLink().count()) > 0) {
        await pushLink().click({ timeout: 5_000 }).catch(() => {});
        return true;
      }
    }
  } catch (err) {
    if (abortSignal?.aborted) throw err;
    // Best-effort — fall through to the normal manual wait.
  }
  return false;
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
  const preCheckMs = options.preCheckMs ?? DUO_PRE_CHECK_MS;
  const preCheckIntervalMs = options.preCheckIntervalMs ?? DUO_PRE_CHECK_INTERVAL_MS;
  const initialCodeWaitMs = options.initialCodeWaitMs ?? DUO_INITIAL_CODE_WAIT_MS;
  const initialCodeWaitIntervalMs = options.initialCodeWaitIntervalMs ?? DUO_CODE_WAIT_INTERVAL_MS;

  const urlMatches = (url: string): boolean => {
    if (typeof successUrlMatch === "string") {
      return url.includes(successUrlMatch);
    }
    return successUrlMatch(url);
  };

  // Finalize WebAuthn on EVERY exit — including a thrown abort. An armed
  // virtual authenticator (set up at `clickSsoSubmit`) that is abandoned
  // mid-ceremony without `finishDuoWebAuthn` leaks the CDP authenticator AND,
  // worse, fails to persist the advanced signCount — so the NEXT assertion
  // replays a counter Duo already observed and is rejected as a cloned key
  // ("signs but never completes"). The daemon stop path and our live-test
  // abort both cancel auth via `abortSignal`, so the throw-on-abort path
  // MUST clean up exactly like a normal timeout/success. `finishDuoWebAuthn`
  // is idempotent (no-op once the page is finished or was never armed), so
  // the success-path calls inside the try block stay correct and this catch
  // only fires for the abort/error escape.
  try {
    return await runDuoPollLoop();
  } catch (err) {
    await finishDuoWebAuthn(page);
    throw err;
  }

  // ── inner loop — wrapped so any throw (abort) still finalizes WebAuthn ──
  async function runDuoPollLoop(): Promise<boolean> {

  // Set when a hands-off WebAuthn assertion signed but did not complete in its
  // grace window — shortens the manual fallback (no push was sent; the retry
  // heals it hands-off). See DUO_WEBAUTHN_FALLBACK_MANUAL_SECONDS.
  let webauthnFellBack = false;

  // Pre-check phase: if Duo's "Yes, this is my device" trust token is
  // cached, the SAML chain redirects through to the success URL without
  // pushing to Duo Mobile. We don't want to fire a voice cue claiming a
  // Duo prompt was sent in that case.
  //
  // Silent loop — only check the success condition; skip recovery, the
  // tryAgain button, the trust button, and the Stale-Request guard
  // (those only matter once a real Duo iframe is present, which means
  // the URL won't match success and pre-check will time out anyway).
  if (preCheckMs > 0) {
    const preCheckDeadline = Date.now() + preCheckMs;
    while (Date.now() < preCheckDeadline) {
      options.abortSignal?.throwIfAborted();
      try {
        if (urlMatches(page.url())) {
          const verified =
            !successCheck || (await successCheck(page).catch(() => false));
          if (verified) {
            log.step(`Duo skipped (cached trust) | URL: ${page.url()}`);
            // Tear down the authenticator armed at clickSsoSubmit — no Duo
            // prompt appeared, so it went unused (no-op when not armed).
            await finishDuoWebAuthn(page);
            if (postApproval) await postApproval(page);
            return true;
          }
        }
      } catch {
        // Page may be navigating — swallow and retry.
      }
      await waitForDuoPoll(preCheckIntervalMs, options.abortSignal);
    }
  }

  // Hands-off WebAuthn path (opt-in via HR_AUTOMATION_DUO_WEBAUTHN=1). Loads the
  // enrolled credential into a CDP virtual authenticator and selects the matching
  // factor at the Duo prompt; Chrome answers the ceremony automatically, so Duo
  // approves with no phone push. Any failure (flag off, no credential, factor
  // not found, ceremony rejected) degrades to the manual flow below — the
  // operator's phone approval still works exactly as before.
  if (isDuoWebAuthnEnabled()) {
    const handle = await beginDuoWebAuthn(page, { abortSignal: options.abortSignal }).catch((err) => {
      if (options.abortSignal?.aborted) throw err;
      log.warn(
        `Duo WebAuthn unavailable (${err instanceof Error ? err.message : String(err)}) — falling back to manual approval`,
      );
      return undefined;
    });
    if (handle) {
      log.step(`Duo: asserting via WebAuthn (${handle.factorLabel}) — no phone push expected`);
      const approved = await waitForApproval(page, {
        urlMatches,
        ...(successCheck ? { successCheck } : {}),
        timeoutMs: options.webauthnGraceMs ?? DUO_WEBAUTHN_GRACE_MS,
        abortSignal: options.abortSignal,
      });
      if (approved) {
        await handle.finish({ approved: true });
        log.step(`Duo approved via WebAuthn (${handle.factorLabel}) | URL: ${page.url()}`);
        if (postApproval) await postApproval(page);
        return true;
      }
      await handle.finish({ approved: false });
      // The authenticator signed but Duo never redirected to success — the classic
      // signCount-drift "stuck on Use Touch ID" hang: the local counter fell
      // at/below Duo's server-side counter, so Duo treats the assertion as a
      // possible clone and silently refuses. Resync the persisted counter forward
      // so the kernel's NEXT login attempt re-arms above Duo's counter and approves
      // hands-off. Best-effort + monotonic, so it's safe even if the failure wasn't
      // counter-related (a chronically-rejected credential keeps signing but never
      // completing — bumping won't help, and the auto-Push below is what actually
      // unblocks). Enter the manual window below, which auto-sends a Duo Push for
      // phone approval; if no push can be sent it stays a short window and fails
      // fast into the kernel's auto-retry.
      const resynced = resyncDuoWebAuthnSignCounts();
      webauthnFellBack = true;
      log.warn(
        resynced
          ? "Duo WebAuthn signed but did not complete — bumped counter; sending a Duo Push for phone approval, else auto-retry"
          : "Duo WebAuthn did not complete within grace window — sending a Duo Push for phone approval, else auto-retry",
      );
    }
  }

  // Pre-check elapsed without an auto-success → a real Duo push is
  // pending. Announce now.
  //
  // Best-effort voice cue — opt-in via HR_AUTOMATION_VOICE_CUES=1 + macOS.
  // Fires once before the polling loop begins so the operator hears a cue if
  // they're not looking at the terminal. Never blocks; never throws.
  await cueDuo(systemLabel ?? "system").catch(() => {});

  const initialDuoCode = await readDuoVerificationCodeWhenVisible(page, {
    timeoutMs: initialCodeWaitMs,
    intervalMs: initialCodeWaitIntervalMs,
    abortSignal: options.abortSignal,
  });
  let lastDuoCode = initialDuoCode;

  log.waiting(
    initialDuoCode
      ? `Waiting for Duo approval (enter code ${initialDuoCode} in Duo Mobile)...`
      : "Waiting for Duo approval (approve on your phone)...",
  );

  // After a WebAuthn assertion signed-but-stalled, no push was sent yet, so cap the
  // manual wait to a short window: long enough to auto-trigger (or hand-rescue) a
  // Duo Push, short enough to fail fast into the kernel's auto-retry. The instant a
  // push IS sent (auto-trigger below), the window opens back up to the full timeout
  // so the operator has time to approve on their phone.
  let effectiveTimeoutSeconds = webauthnFellBack
    ? Math.min(timeoutSeconds, options.webauthnFallbackSeconds ?? DUO_WEBAUTHN_FALLBACK_MANUAL_SECONDS)
    : timeoutSeconds;
  // Auto-send-a-push fires at most once — re-clicking thrashes the prompt.
  let pushTriggered = false;

  for (let elapsed = 0; elapsed < effectiveTimeoutSeconds; elapsed += pollIntervalSec) {
    options.abortSignal?.throwIfAborted();
    try {
      // Run optional recovery callback to handle mid-auth errors (e.g., SAML redirects)
      if (recovery) {
        log.step("Duo: running mid-auth recovery check...");
        await recovery(page).catch(() => {});
      }

      // Duo defaulted to a device factor ("Use Touch ID" / security key) without
      // auto-sending a push (also where a rejected hands-off WebAuthn assertion
      // lands) — the loop would otherwise wait out the whole window. Send a Duo
      // Push ourselves so the operator can approve on their phone, once, and open
      // the wait back up to the full timeout now that a push is actually pending.
      if (!pushTriggered) {
        const sent = await triggerDuoPushFromFactorScreen(page, options.abortSignal);
        if (sent) {
          pushTriggered = true;
          effectiveTimeoutSeconds = timeoutSeconds;
          log.waiting("Duo defaulted to a device prompt — sent a Duo Push; approve on your phone...");
          await waitForDuoPoll(pollIntervalMs, options.abortSignal);
          continue;
        }
      }

      // Check for Duo push timeout — click "Try Again" to resend
      const tryAgainBtn = page.getByRole("button", { name: /try again/i })
        .or(page.locator('button:has-text("Try Again")'));
      if ((await tryAgainBtn.count()) > 0) {
        log.step("Duo push timed out — clicking Try Again...");
        await tryAgainBtn.first().click({ timeout: 5_000 });
        const resentDuoCode = await readDuoVerificationCodeAfterResend(
          page,
          lastDuoCode,
          options.abortSignal,
        );
        const codeForResend = resentDuoCode?.trim() || lastDuoCode;
        lastDuoCode = codeForResend;
        log.waiting(
          codeForResend
            ? `Duo prompt resent — enter code ${codeForResend} in Duo Mobile...`
            : "Duo push resent — approve on your phone...",
        );
        await waitForDuoPoll(pollIntervalMs, options.abortSignal);
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
            await waitForDuoPoll(pollIntervalMs, options.abortSignal);
            continue;
          }
        }

        log.step(`Duo approved | URL: ${page.url()}`);
        // Persist signCount + tear down any authenticator armed at clickSsoSubmit
        // (no-op if WebAuthn wasn't in play).
        await finishDuoWebAuthn(page);

        // Run post-approval hook if provided
        if (postApproval) {
          await postApproval(page);
        }

        return true;
      }
    } catch {
      // Page may be navigating — swallow and retry
    }

    await waitForDuoPoll(pollIntervalMs, options.abortSignal);
  }

  log.error(
    webauthnFellBack
      ? "Duo WebAuthn fallback window elapsed without manual rescue — returning false so the kernel retries (re-arms from the resynced counter)"
      : "Duo approval timed out",
  );
  await finishDuoWebAuthn(page);
  return false;
  } // end runDuoPollLoop
}
