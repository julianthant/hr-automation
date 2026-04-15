import type { Page } from "playwright";
import { log } from "../utils/log.js";

/** Known error patterns that indicate the page needs a refresh/re-navigate. */
const ERROR_PATTERNS = [
  /SAML/i,
  /session.*expired/i,
  /session.*timed?\s*out/i,
  /login.*expired/i,
  /your session.*has been/i,
  /no longer authenticated/i,
  /sign.?in.*required/i,
  /access.*denied/i,
  /page.*not.*available/i,
  /unable.*connect/i,
  /err_connection/i,
  /this site can.*t be reached/i,
];

/**
 * Check if the page is in an error state (SAML error, session expired, etc.).
 * Returns true if the page is healthy, false if it needs recovery.
 */
export async function isPageHealthy(page: Page): Promise<boolean> {
  try {
    const url = page.url();
    // URL-based checks
    if (url.includes("SAML") || url.includes("saml") || url.includes("error") || url.includes("failedLogin")) {
      return false;
    }

    // Content-based checks — read visible text from body (fast, no full page parse)
    const bodyText = await page.locator("body").innerText({ timeout: 3_000 }).catch(() => "");
    for (const pattern of ERROR_PATTERNS) {
      if (pattern.test(bodyText)) return false;
    }

    return true;
  } catch {
    // Page might be navigating or crashed
    return false;
  }
}

/**
 * Check page health and recover by refreshing if needed.
 * If the page is in an error state, refreshes and waits for it to settle.
 * Returns true if the page is healthy (either already or after recovery).
 *
 * @param page - Playwright page
 * @param recoveryUrl - Optional URL to navigate to instead of just refreshing
 * @param label - Label for log messages (e.g. "[UCPath]", "[Kuali]")
 */
export async function ensurePageHealthy(
  page: Page,
  recoveryUrl?: string,
  label: string = "",
): Promise<boolean> {
  if (await isPageHealthy(page)) return true;

  const prefix = label ? `${label} ` : "";
  log.step(`${prefix}Page error detected — recovering...`);

  try {
    if (recoveryUrl) {
      await page.goto(recoveryUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
    } else {
      await page.reload({ waitUntil: "domcontentloaded", timeout: 30_000 });
    }
    await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
    await page.waitForTimeout(2_000);

    if (await isPageHealthy(page)) {
      log.success(`${prefix}Page recovered`);
      return true;
    }

    log.error(`${prefix}Page still unhealthy after recovery`);
    return false;
  } catch {
    log.error(`${prefix}Recovery navigation failed`);
    return false;
  }
}
