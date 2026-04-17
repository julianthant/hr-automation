import type { Page } from "playwright";
import { log } from "../../utils/log.js";
import { ExtractionError } from "./types.js";
import { CRM_SEARCH_URL } from "../../config.js";
import { search as searchSelectors } from "./selectors.js";

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
  // Direct URL navigation with query param — faster and avoids hidden search
  // input issues.
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
 * Table columns:
 *   Onboarding Name | Offer Sent On | Hiring Supervisor Last Name |
 *   Hiring Supervisor First Name | Process Stage
 */
export async function selectLatestResult(page: Page): Promise<void> {
  const rows = searchSelectors.resultRows(page);

  const count = await rows.count();
  if (count === 0) {
    throw new ExtractionError("No search results found");
  }

  log.step(`Found ${count} result(s) -- selecting latest...`);

  let latestIndex = -1;
  let latestDate = new Date(0);

  for (let i = 0; i < count; i++) {
    // "Offer Sent On" is column 2 (index 1). Compound path rooted in registry.
    const dateCell = searchSelectors.nthResultRow(page, i).locator("td").nth(1); // allow-inline-selector -- compound .locator("td").nth(i)
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

  // Click the name link in the first column to navigate to the employee
  // record (not the row itself). Compound path rooted in registry.
  const nameLink = searchSelectors
    .nthResultRow(page, latestIndex)
    .locator("td") // allow-inline-selector -- compound .locator("td").first().locator("a")
    .first()
    .locator("a"); // allow-inline-selector -- compound path continues
  const hasLink = (await nameLink.count()) > 0;

  if (hasLink) {
    await nameLink.click();
  } else {
    // Fallback: click the name cell text directly
    await searchSelectors
      .nthResultRow(page, latestIndex)
      .locator("td") // allow-inline-selector -- compound cell click fallback
      .first()
      .click();
  }

  await page.waitForLoadState("domcontentloaded", { timeout: 15_000 });
  await page.waitForLoadState("networkidle", { timeout: 15_000 });

  log.step("Selected result row");
}
