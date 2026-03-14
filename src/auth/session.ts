import type { Page } from "playwright";
import { log } from "../utils/log.js";

/**
 * Check if the page is already on an authenticated ACT CRM page.
 * Used after navigation to detect if login is needed.
 *
 * This is a lightweight URL check -- NOT session persistence.
 * Per user requirement: no session state tracking, just login fresh each time.
 */
export function isOnAuthenticatedPage(page: Page): boolean {
  const url = page.url();
  // If we're on act-crm and NOT on a login page, we're authenticated
  if (url.includes("act-crm.my.site.com") && !url.includes("login")) {
    return true;
  }
  return false;
}
