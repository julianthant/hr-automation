import type { Page } from "playwright";
import { log } from "../utils/log.js";
import { ExtractionError } from "./types.js";
import { CRM_SEARCH_URL } from "../config.js";

/**
 * Search results page -- accepts email as query param.
 * Discovered from live testing: navigating directly via URL params
 * is faster and more reliable than clicking the search toggle UI.
 */
const SEARCH_URL = CRM_SEARCH_URL;

/**
 * Search for an employee by email on the ACT CRM onboarding portal.
 * Navigates directly to the search results page via URL query param.
 *
 * IMPORTANT: Does NOT log the email value (PII). Only logs step names.
 */
export async function searchByEmail(
  page: Page,
  email: string,
): Promise<void> {
  // SELECTOR: adjusted from live testing -- direct URL navigation with
  // query param is faster and avoids hidden search input issues
  log.step("Searching for employee...");
  const searchUrl = `${SEARCH_URL}?q=${encodeURIComponent(email)}`;
  await page.goto(searchUrl, {
    waitUntil: "domcontentloaded",
    timeout: 15_000,
  });
  await page.waitForLoadState("networkidle", { timeout: 15_000 });
}

/**
 * Select the search result row with the latest "Offer Sent On" date.
 * Clicks the name link (first column) to navigate to the employee record.
 *
 * SELECTOR: adjusted from live testing -- table columns are:
 * Onboarding Name | Offer Sent On | Hiring Supervisor Last Name |
 * Hiring Supervisor First Name | Process Stage
 */
export async function selectLatestResult(page: Page): Promise<void> {
  const rows = page.locator("table tbody tr");

  const count = await rows.count();
  if (count === 0) {
    throw new ExtractionError("No search results found");
  }

  log.step(`Found ${count} result(s) -- selecting latest...`);

  let latestIndex = -1;
  let latestDate = new Date(0);

  for (let i = 0; i < count; i++) {
    // SELECTOR: adjusted from live testing -- "Offer Sent On" is column 2 (index 1)
    const dateCell = rows.nth(i).locator("td").nth(1);
    const dateText = await dateCell.textContent();
    if (dateText) {
      const parsed = new Date(dateText.trim());
      if (!isNaN(parsed.getTime()) && parsed > latestDate) {
        latestDate = parsed;
        latestIndex = i;
      }
    }
  }

  if (latestIndex === -1) {
    throw new ExtractionError("No search results found");
  }

  // SELECTOR: adjusted from live testing -- click the name link in the
  // first column to navigate to the employee record, not the row itself
  const nameLink = rows.nth(latestIndex).locator("td").first().locator("a");
  const hasLink = (await nameLink.count()) > 0;

  if (hasLink) {
    await nameLink.click();
  } else {
    // Fallback: click the name cell text directly
    await rows.nth(latestIndex).locator("td").first().click();
  }

  await page.waitForLoadState("domcontentloaded", { timeout: 15_000 });
  await page.waitForLoadState("networkidle", { timeout: 15_000 });

  log.step("Selected result row");
}
