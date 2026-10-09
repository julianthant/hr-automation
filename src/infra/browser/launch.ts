import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
  type Locator,
} from "playwright";
import { log } from "../../utils/log.js";
import { withTimeout } from "../../utils/with-timeout.js";

const FAILED_LAUNCH_CLEANUP_TIMEOUT_MS = 5_000;

/**
 * Error-message fragments that mean "the website didn't load" — a transient
 * condition worth refreshing through. Matched case-insensitively against the
 * thrown error message. Covers Chromium net errors, the `page.goto`/navigation
 * TIMEOUT (the Kuali "Page navigation timed out" case — these were previously
 * NOT retried, so a single slow Kuali Build load failed the whole separation on
 * the first attempt), and the post-load verification miss.
 */
const RETRYABLE_NAVIGATION_PATTERNS = [
  "err_network",
  "err_connection",
  "err_timed_out",
  "err_name_not_resolved",
  "err_internet_disconnected",
  "err_address_unreachable",
  "net::err",
  "chrome-error",
  "timeout",
  "timed out",
  "navigating and changing the content",
  "verification failed",
] as const;

/** Default number of navigation attempts before giving up. */
export const DEFAULT_NAVIGATION_RETRIES = 10;
/** Pause between navigation retries (ms). Operator policy: "5–10 second interval". */
const NAVIGATION_RETRY_DELAY_MS = 6_000;

/**
 * Effective navigation-retry default, read at CALL time so the operator's
 * Settings value (populated onto `HRAUTO_NAVIGATION_RETRIES` by
 * `applyOperatorSettingsToEnv` at config load) is honored regardless of module
 * import order. Falls back to {@link DEFAULT_NAVIGATION_RETRIES} when unset/invalid.
 */
function defaultNavigationRetries(): number {
  const n = Number.parseInt(process.env.HRAUTO_NAVIGATION_RETRIES ?? "", 10);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_NAVIGATION_RETRIES;
}

/**
 * Navigate to a URL, refreshing through transient "site didn't load" failures
 * before giving up. Operator policy (2026-06-24): when a page fails to load,
 * retry the navigation up to `retries` times with a ~5–10s pause between
 * attempts, and only fail the run if it still hasn't loaded after all of them.
 *
 * Each attempt re-runs `page.goto` (a fresh navigation ≈ a refresh). A retry
 * fires only when the thrown error's message matches `RETRYABLE_NAVIGATION_PATTERNS`
 * (network failures, navigation timeouts, or a failed `verify` — the element may
 * just not have rendered yet). Any other error escapes immediately.
 *
 * @param page - Playwright page
 * @param url - URL to navigate to
 * @param verify - A locator or function that returns true when the page loaded correctly.
 *                 If a Locator, checks count > 0.
 * @param retries - Number of attempts (default {@link DEFAULT_NAVIGATION_RETRIES} = 10)
 * @param timeout - Timeout per attempt in ms (default 15000)
 */
export async function gotoWithRetry(
  page: Page,
  url: string,
  verify?: Locator | ((page: Page) => Promise<boolean>),
  retries = defaultNavigationRetries(),
  timeout = 15_000,
): Promise<void> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout });
      await page.waitForLoadState("networkidle", { timeout }).catch(() => {});

      // Check for chrome-error (network failure)
      if (page.url().includes("chrome-error")) {
        throw new Error("chrome-error: network failure");
      }

      // Run verification if provided
      if (verify) {
        const ok = typeof verify === "function"
          ? await verify(page)
          : (await verify.count()) > 0;
        if (!ok) throw new Error("Page verification failed — expected element not found");
      }

      return; // success
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const retryable = RETRYABLE_NAVIGATION_PATTERNS.some((p) => msg.toLowerCase().includes(p));
      if (attempt < retries && retryable) {
        log.step(
          `Navigation failed (attempt ${attempt}/${retries}): ${msg.slice(0, 80)} — ` +
          `refreshing in ${NAVIGATION_RETRY_DELAY_MS / 1_000}s...`,
        );
        await page.waitForTimeout(NAVIGATION_RETRY_DELAY_MS);
        continue;
      }
      throw err;
    }
  }
}

export interface LaunchOptions {
  /** Persistent session directory. When set, uses launchPersistentContext() to reuse login state. */
  sessionDir?: string;
  /**
   * Viewport dimensions. Default `null` — the page viewport tracks the OS window
   * size, so content renders at the visible window's dimensions and native
   * scrollbars appear on overflow. Pass an explicit `{ width, height }` only
   * when a workflow needs a fixed render size regardless of window size.
   */
  viewport?: { width: number; height: number } | null;
  /** Extra Chromium args (e.g. --window-position). */
  args?: string[];
  /** Accept downloads (default: false). */
  acceptDownloads?: boolean;
  /**
   * Run Chromium headless. Default `false` (headed) — production never sets this;
   * it exists for unattended integration tests (`tests/live/`). The CDP WebAuthn
   * virtual-authenticator path (hands-off Duo) works under headless Chromium.
   */
  headless?: boolean;
}

/**
 * Launch a Chromium browser (headed by default; pass `headless: true` for
 * unattended integration tests).
 *
 * Without sessionDir: fresh context every time (default for UCPath/CRM).
 * With sessionDir: persistent context that survives across runs (for UKG).
 */
export async function launchBrowser(options: LaunchOptions = {}): Promise<{
  browser: Browser | null;
  context: BrowserContext;
  page: Page;
}> {
  const viewport = options.viewport === undefined ? null : options.viewport;
  const headless = options.headless ?? false;

  if (options.sessionDir) {
    log.step(`Launching browser (persistent session: ${options.sessionDir})...`);
    let context: BrowserContext | undefined;
    try {
      context = await chromium.launchPersistentContext(options.sessionDir, {
        headless,
        viewport,
        acceptDownloads: options.acceptDownloads ?? false,
        args: options.args,
      });
      const existingPages = context.pages();
      const page = existingPages[0] ?? await context.newPage();
      return { browser: null, context, page };
    } catch (err) {
      if (context) {
        await withTimeout(
          context.close(),
          FAILED_LAUNCH_CLEANUP_TIMEOUT_MS,
          "launchBrowser persistent cleanup",
        ).catch((closeErr: unknown) => {
          log.warn(`Persistent browser cleanup failed after launch error: ${String(closeErr)}`);
        });
      }
      throw err;
    }
  }

  log.step("Launching browser...");
  const browser = await chromium.launch({
    headless,
    args: options.args,
  });
  let context: BrowserContext | undefined;
  try {
    context = await browser.newContext({
      viewport,
      acceptDownloads: options.acceptDownloads ?? false,
    });
    const page = await context.newPage();
    return { browser, context, page };
  } catch (err) {
    if (context) {
      await withTimeout(
        context.close(),
        FAILED_LAUNCH_CLEANUP_TIMEOUT_MS,
        "launchBrowser context cleanup",
      ).catch((closeErr: unknown) => {
        log.warn(`Browser context cleanup failed after launch error: ${String(closeErr)}`);
      });
    }
    await withTimeout(
      browser.close(),
      FAILED_LAUNCH_CLEANUP_TIMEOUT_MS,
      "launchBrowser browser cleanup",
    ).catch((closeErr: unknown) => {
      log.warn(`Browser cleanup failed after launch error: ${String(closeErr)}`);
    });
    throw err;
  }
}
