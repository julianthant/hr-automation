import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
  type Locator,
} from "playwright";
import { log } from "../utils/log.js";

/**
 * Navigate to a URL with network error retry and page load verification.
 *
 * @param page - Playwright page
 * @param url - URL to navigate to
 * @param verify - A locator or function that returns true when the page loaded correctly.
 *                 If a Locator, checks count > 0 within timeout.
 * @param retries - Number of retry attempts (default 3)
 * @param timeout - Timeout per attempt in ms (default 15000)
 */
export async function gotoWithRetry(
  page: Page,
  url: string,
  verify?: Locator | ((page: Page) => Promise<boolean>),
  retries = 3,
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
      if (attempt < retries && (msg.includes("ERR_NETWORK") || msg.includes("chrome-error") || msg.includes("ERR_CONNECTION") || msg.includes("verification failed"))) {
        log.step(`Navigation failed (attempt ${attempt}/${retries}): ${msg.slice(0, 80)} — retrying in 5s...`);
        await page.waitForTimeout(5_000);
        continue;
      }
      throw err;
    }
  }
}

export interface LaunchOptions {
  /** Persistent session directory. When set, uses launchPersistentContext() to reuse login state. */
  sessionDir?: string;
  /** Viewport dimensions (default: 1920x1080). */
  viewport?: { width: number; height: number };
  /** Extra Chromium args (e.g. --window-position). */
  args?: string[];
  /** Accept downloads (default: false). */
  acceptDownloads?: boolean;
}

/**
 * Launch a headed Chromium browser.
 *
 * Without sessionDir: fresh context every time (default for UCPath/CRM).
 * With sessionDir: persistent context that survives across runs (for UKG).
 */
export async function launchBrowser(options: LaunchOptions = {}): Promise<{
  browser: Browser | null;
  context: BrowserContext;
  page: Page;
}> {
  const viewport = options.viewport ?? { width: 1920, height: 1080 };

  if (options.sessionDir) {
    log.step(`Launching browser (persistent session: ${options.sessionDir})...`);
    const context = await chromium.launchPersistentContext(options.sessionDir, {
      headless: false,
      viewport,
      acceptDownloads: options.acceptDownloads ?? false,
      args: options.args,
    });
    const existingPages = context.pages();
    const page = existingPages[0] ?? await context.newPage();
    return { browser: null, context, page };
  }

  log.step("Launching browser...");
  const browser = await chromium.launch({
    headless: false,
    args: options.args,
  });
  const context = await browser.newContext({
    viewport,
    acceptDownloads: options.acceptDownloads ?? false,
  });
  const page = await context.newPage();
  return { browser, context, page };
}
