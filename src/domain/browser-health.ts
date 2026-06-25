/**
 * Pure browser-health classification — shared by the kernel `Session` health
 * monitor and unit tests (no Node/Playwright deps, so it is testable in
 * isolation and safe in any layer).
 *
 * The kernel gathers three raw observations about a system's page — is it
 * closed, what URL is it on, and does a trivial JS round-trip succeed — and
 * this module maps them onto a recovery VERDICT. The verdict drives the
 * monitor's escalation ladder:
 *
 *   - `ok`       — usable; nothing to do.
 *   - `soft`     — a transient navigation/render fault (chrome-error page).
 *                  A plain page reload (Refresh) usually clears it.
 *   - `wedged`   — the page is broken but the SERVER SESSION IS STILL VALID:
 *                  a dead iframe execution context (UCPath's `#main_target_win0`
 *                  context destroyed), a stalled `about:blank` redirect, or a
 *                  closed tab. A reload often can't fix these; a fresh tab on
 *                  the SAME authenticated context (Reopen) does — no Duo.
 *   - `expired`  — the page is sitting on an SSO/login host, i.e. the server
 *                  session is GONE. Refresh/Reopen would just re-land on login;
 *                  this needs full re-auth (Duo) and is surfaced, never auto-fixed.
 *   - `closed`   — the page object is closed. NOT fatal: the browser process is
 *                  alive, so Reopen (a new tab on the context) recovers it.
 *   - `dead`     — no browser slot at all (worker teardown / never launched).
 *
 * Grounded in the UCPath/PeopleSoft failure taxonomy in
 * `src/systems/ucpath/LESSONS.md` (modal-mask, dead iframe context, SSO
 * redirect, chrome-error, about:blank) — see `docs`/the systems lessons.
 */

export type BrowserHealthKind = "ok" | "soft" | "wedged" | "expired" | "closed" | "dead";

export interface BrowserHealthVerdict {
  kind: BrowserHealthKind;
  /** Short human reason for a non-`ok` verdict (rides the dashboard tile). */
  reason?: string;
}

/**
 * URL fragments that mean "this page is on an SSO/login surface" — i.e. the
 * server session expired and the only fix is full re-auth (Duo). Matched
 * case-insensitively as substrings. Kept deliberately SPECIFIC to known
 * SSO/login hosts so a normal authenticated app URL (e.g.
 * `ucpath.universityofcalifornia.edu/psp/...`) never matches.
 */
export const LOGIN_URL_PATTERNS: readonly string[] = [
  "a5.ucsd.edu", // UCSD Shibboleth IdP
  "duosecurity.com", // Duo MFA
  "shibboleth", // generic Shibboleth IdP path
  "login.microsoftonline.com", // Azure AD (some flows)
  "/cas/login", // CAS login endpoint
  "universityofcalifornia.edu/login", // UC login landing
  "idpz.utad", // (defensive — other UC IdP variants)
] as const;

/** True when `url` is on a known SSO/login surface (session expired → re-auth). */
export function isLoginLikeUrl(url: string): boolean {
  if (!url) return false;
  const u = url.toLowerCase();
  return LOGIN_URL_PATTERNS.some((p) => u.includes(p));
}

/** True when `url` is a Chromium network-error interstitial. */
export function isChromeErrorUrl(url: string): boolean {
  return url.toLowerCase().startsWith("chrome-error");
}

/** True when `url` is unnavigated / a stalled redirect. */
export function isBlankUrl(url: string): boolean {
  return !url || url === "about:blank";
}

/**
 * Map raw page observations onto a recovery verdict. Pure.
 *
 * Order matters: a CLOSED page is reported first (its url/probe are meaningless);
 * then a login URL (expired — even if the JS context is live, it's the SSO
 * page's context); then chrome-error (soft); then blank/unresponsive (wedged).
 */
export function classifyBrowserHealth(input: {
  closed: boolean;
  url: string;
  /** Result of a trivial `page.evaluate(() => 1)` round-trip (false on throw/timeout). */
  probed: boolean;
}): BrowserHealthVerdict {
  if (input.closed) return { kind: "closed", reason: "browser tab closed" };
  const url = input.url ?? "";
  if (isLoginLikeUrl(url)) return { kind: "expired", reason: "session expired — re-auth needed" };
  if (isChromeErrorUrl(url)) return { kind: "soft", reason: "chrome error page" };
  if (isBlankUrl(url)) return { kind: "wedged", reason: "page un-navigated (about:blank)" };
  if (!input.probed) return { kind: "wedged", reason: "page unresponsive (execution context lost)" };
  return { kind: "ok" };
}

/** Whether a verdict is recoverable by an in-place page reload (Refresh). */
export function isRefreshable(kind: BrowserHealthKind): boolean {
  return kind === "soft";
}

/** Whether a verdict is recoverable by a fresh tab on the same context (Reopen). */
export function isReopenable(kind: BrowserHealthKind): boolean {
  return kind === "soft" || kind === "wedged" || kind === "closed";
}
