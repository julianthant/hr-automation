import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
} from "playwright";
import { log } from "../utils/log.js";

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
