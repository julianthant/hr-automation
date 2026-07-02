import type { Page } from "playwright";
import { onbaseSelectors } from "./selectors.js";

/**
 * OnBase (Hyland) is a load-balanced ASP.NET WebForms cluster
 * (`ucsd.hylandcloud.com`). Instead of the app, `NavPanel.aspx` and its
 * postbacks intermittently serve a transient error/reset page at the *normal*
 * URL. This module classifies which page we actually landed on so the nav and
 * auth flows can recover deliberately (fresh re-nav or re-auth) instead of
 * blind-waiting for the Main Menu until timeout.
 *
 * The observed bad-landing states (all captured live 2026-07-01):
 *   - `viewstate-error`  — ASP.NET "Validation of viewstate MAC failed". A
 *     postback whose `__VIEWSTATE` was signed by one farm node is validated by
 *     another (affinity loss). NOT bot protection — a fresh GET rebuilds the
 *     ViewState on the current node. Recover by re-navigating.
 *   - `session-closed`   — the "It is safe to close this window" logout page;
 *     the OnBase session was terminated. Needs re-authentication.
 *   - `forbidden`        — IIS `403 - Forbidden` served at the NavPanel URL.
 *     Transient after affinity loss, but PERSISTENT while the account's single
 *     app-session slot is held by another (possibly dead) browser — see
 *     `session-contention` below and LESSONS 2026-07-02.
 *   - `login`            — redirected to `Login.aspx`; the session expired and
 *     SSO must run again. Needs re-authentication.
 *   - `session-contention` — Login.aspx's "User Interaction Required" dialog:
 *     "Another session is currently active." OnBase allows ONE app session per
 *     identity; the only dialog option aborts THIS login. Recover by clearing
 *     the stale session via `Logout.aspx`, then re-entering through
 *     `Login.aspx` (the login flow owns that hop).
 *   - `authenticated`    — NavPanel with the nine-squares Main Menu visible.
 *   - `unknown`          — anything else (e.g. the form reset to Document
 *     Retrieval); treated as recoverable via a fresh re-nav.
 */
export type OnbasePageState =
  | "authenticated"
  | "viewstate-error"
  | "session-closed"
  | "forbidden"
  | "login"
  | "session-contention"
  | "unknown";

/** States that require re-authentication (a fresh re-nav cannot recover them). */
const REAUTH_STATES: ReadonlySet<OnbasePageState> = new Set([
  "session-closed",
  "login",
  "session-contention",
]);

/** ASP.NET ViewState MAC validation failure surfaced as a full page. */
const VIEWSTATE_ERROR_RE =
  /validation of viewstate mac failed|viewstate mac|the state information is invalid for this page/i;

/** OnBase logout landing ("It is safe to close this window if it does not close automatically."). */
const SESSION_CLOSED_RE = /it is safe to close this window/i;

/** IIS 403 Forbidden page title/body. */
const FORBIDDEN_RE = /\b403\b[\s\S]*forbidden|forbidden[\s\S]*access\s+is\s+denied/i;

/**
 * Login.aspx single-session contention marker. Rendered inside a nested
 * EmbeddedPage iframe of the "User Interaction Required" dialog, so detection
 * must sweep child frames — `page.content()` alone never sees it.
 */
const SESSION_CONTENTION_RE = /another session is currently active/i;

/** True when a state can only be cleared by authenticating again. */
export function onbaseStateNeedsReauth(state: OnbasePageState): boolean {
  return REAUTH_STATES.has(state);
}

/** True when NavPanel is loaded with the nine-squares Main Menu (authenticated). */
export async function isOnbaseMainMenuReady(
  page: Page,
  timeoutMs = 2_000,
): Promise<boolean> {
  return onbaseSelectors.nav
    .mainMenuButton(page)
    .isVisible({ timeout: timeoutMs })
    .catch(() => false);
}

/**
 * Read the page title + HTML once for text-based error detection. Guard-safe:
 * `title()`/`content()` are not Playwright locator constructors, so this stays
 * clear of the inline-selector guard. Both are wrapped — a page mid-navigation
 * can reject either, and a detection failure must degrade to "" (not throw).
 */
async function readOnbasePageText(page: Page): Promise<string> {
  const [title, content] = await Promise.all([
    page.title().catch(() => ""),
    page.content().catch(() => ""),
  ]);
  return `${title}\n${content}`;
}

/** True when the page is the ASP.NET "Validation of viewstate MAC failed" error. */
export async function isOnbaseViewstateError(page: Page): Promise<boolean> {
  return VIEWSTATE_ERROR_RE.test(await readOnbasePageText(page));
}

/** True when the page is the OnBase "safe to close this window" logout landing. */
export async function isOnbaseSessionClosed(page: Page): Promise<boolean> {
  return SESSION_CLOSED_RE.test(await readOnbasePageText(page));
}

/** True when the NavPanel URL is serving an IIS 403 Forbidden. */
export async function isOnbaseForbidden(
  page: Page,
  responseStatus?: number,
): Promise<boolean> {
  if (responseStatus === 403) return true;
  const url = page.url();
  if (url.toLowerCase().includes("403") || url.includes("Forbidden")) return true;
  return FORBIDDEN_RE.test(await page.title().catch(() => ""));
}

/** True when OnBase redirected to `Login.aspx` (session expired). */
export function isOnbaseLoginUrl(page: Page): boolean {
  return page.url().includes("Login.aspx");
}

/**
 * True when Login.aspx is showing the single-session contention dialog
 * ("Another session is currently active."). The marker text lives in a nested
 * iframe, so every frame's content is swept (best-effort — a frame detached
 * mid-read degrades to "not seen").
 */
export async function isOnbaseSessionContention(page: Page): Promise<boolean> {
  let frames: ReturnType<Page["frames"]>;
  try {
    frames = page.frames();
  } catch {
    return false;
  }
  for (const frame of frames) {
    const text = await frame.content().catch(() => "");
    if (SESSION_CONTENTION_RE.test(text)) return true;
  }
  return false;
}

/**
 * Classify which OnBase page we actually landed on. Checks the cheap, common
 * happy path (Main Menu visible) and URL-based signals first, then reads the
 * page text once for the error-page bodies. Never throws — an unreadable page
 * degrades to `"unknown"` (recoverable via a fresh re-nav).
 */
export async function classifyOnbasePage(
  page: Page,
  responseStatus?: number,
): Promise<OnbasePageState> {
  if (await isOnbaseMainMenuReady(page)) return "authenticated";

  const url = page.url();
  if (
    responseStatus === 403 ||
    url.toLowerCase().includes("403") ||
    url.includes("Forbidden")
  ) {
    return "forbidden";
  }
  // Contention outranks the Login.aspx URL — the contention dialog is SERVED at
  // Login.aspx, and it needs the Logout.aspx hop, not a plain SSO re-run.
  if (await isOnbaseSessionContention(page)) return "session-contention";
  if (isOnbaseLoginUrl(page)) return "login";

  const text = await readOnbasePageText(page);
  if (FORBIDDEN_RE.test(text)) return "forbidden";
  if (VIEWSTATE_ERROR_RE.test(text)) return "viewstate-error";
  if (SESSION_CLOSED_RE.test(text)) return "session-closed";
  return "unknown";
}

/**
 * Thrown when OnBase lands on a bad state that the current step cannot recover
 * from in place. The kernel retry re-runs the handler from `authenticate`, so a
 * `session-closed` / `login` state re-authenticates, and a persistent
 * `viewstate-error` gets a fresh browser + form. Carries the `state` for logs
 * and tests.
 */
export class OnbasePageStateError extends Error {
  readonly state: OnbasePageState;

  constructor(state: OnbasePageState, context: string) {
    super(
      `OnBase landed on "${state}" during ${context} — not the expected app page` +
        (onbaseStateNeedsReauth(state) ? " (re-authentication required)" : ""),
    );
    this.name = "OnbasePageStateError";
    this.state = state;
  }
}
