import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
} from "playwright";
import { log } from "../utils/log.js";

/**
 * Launch a headed Chromium browser with a fresh context.
 *
 * Per user requirement: no session state persistence.
 * Always starts fresh -- login each time, leave browser open.
 */
export async function launchBrowser(): Promise<{
  browser: Browser;
  context: BrowserContext;
  page: Page;
}> {
  log.step("Launching browser...");
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
  });
  const page = await context.newPage();
  return { browser, context, page };
}
