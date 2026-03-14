import type { Page } from "playwright";
import { log } from "../utils/log.js";
import { ExtractionError } from "./types.js";

/**
 * Search for an employee by email on the ACT CRM onboarding portal.
 * Navigates to the search page, enters the email, and submits.
 *
 * IMPORTANT: Does NOT log the email value (PII). Only logs step names.
 */
export async function searchByEmail(
  page: Page,
  email: string,
): Promise<void> {
  // After auth, we're already on act-crm.my.site.com
  // SELECTOR: may need adjustment after live testing
  log.step("Entering search query...");

  // SELECTOR: Salesforce Experience Cloud -- likely a Lightning input component
  const searchInput = page
    .getByPlaceholder("Search")
    .or(page.getByRole("searchbox"))
    .or(page.locator('input[type="search"]'));

  await searchInput.first().fill(email, { timeout: 10_000 });
  await searchInput.first().press("Enter");

  log.step("Waiting for search results...");
  await page.waitForLoadState("networkidle", { timeout: 15_000 });
}

/**
 * Select the search result row with the latest date.
 * Iterates all result rows, parses dates from the last column,
 * and clicks the row with the most recent date.
 */
export async function selectLatestResult(page: Page): Promise<void> {
  // SELECTOR: may need adjustment after live testing
  const rows = page
    .locator("table tbody tr")
    .or(page.locator('[role="row"]'));

  const count = await rows.count();
  if (count === 0) {
    throw new ExtractionError("No search results found");
  }

  log.step(`Found ${count} result(s) -- selecting latest...`);

  let latestIndex = 0;
  let latestDate = new Date(0);

  for (let i = 0; i < count; i++) {
    // SELECTOR: date column position may vary
    const dateCell = rows.nth(i).locator("td").last();
    const dateText = await dateCell.textContent();
    if (dateText) {
      const parsed = new Date(dateText.trim());
      if (!isNaN(parsed.getTime()) && parsed > latestDate) {
        latestDate = parsed;
        latestIndex = i;
      }
    }
  }

  await rows.nth(latestIndex).click();
  await page.waitForLoadState("domcontentloaded", { timeout: 15_000 });

  log.step("Selected result row");
}
