import type { Page } from "playwright";
import { log } from "../../utils/log.js";
import type { I9SearchCriteria, I9SearchResult } from "./types.js";

/**
 * Search for an existing employee in I9 Complete.
 *
 * Opens the "Search Options" dialog on the dashboard, fills in the provided
 * criteria, clicks Search, and parses the results grid.
 *
 * Search fields (mapped via playwright-cli on 2026-03-16):
 *   - Last Name, First Name, Middle Initial
 *   - Social Security Number (XXX-XX-XXXX)
 *   - Employee ID, Profile ID
 *   - Worksite, Date of Birth, Integration ID
 *   - I-9 ID, E-Verify Case ID
 *
 * At least one of: lastName, ssn, employeeId, or profileId is required
 * by the I9 Complete system.
 *
 * @param page - Playwright page, must be authenticated and on I9 dashboard
 * @param criteria - Search fields to fill (uses whichever are provided)
 * @returns Array of matching employees (empty if no results)
 */
export async function searchI9Employee(
  page: Page,
  criteria: I9SearchCriteria,
): Promise<I9SearchResult[]> {
  // Open search dialog by clicking "Search Options"
  log.step("Opening I9 search dialog...");
  await page.locator("#divSearchOptions").click({ timeout: 5_000 });

  // Wait for dialog to appear
  const dialog = page.getByRole("dialog", { name: "Search for Existing Employee" });
  await dialog.waitFor({ state: "visible", timeout: 5_000 });

  // Clear any previous search
  await page.getByRole("link", { name: "Clear Search Filters & Results" }).click({ timeout: 3_000 });

  // Fill whichever fields are provided
  if (criteria.lastName) {
    await dialog.getByRole("textbox", { name: "Last Name" }).fill(criteria.lastName);
    log.step(`Search: Last Name = ${criteria.lastName}`);
  }

  if (criteria.firstName) {
    await dialog.getByRole("textbox", { name: /First Name/ }).fill(criteria.firstName);
    log.step(`Search: First Name = ${criteria.firstName}`);
  }

  if (criteria.ssn) {
    await dialog.getByRole("textbox", { name: "Social Security Number" }).fill(criteria.ssn);
    log.step("Search: SSN = ***");
  }

  if (criteria.profileId) {
    await dialog.getByRole("textbox", { name: "Profile ID" }).fill(criteria.profileId);
    log.step(`Search: Profile ID = ${criteria.profileId}`);
  }

  if (criteria.employeeId) {
    await dialog.getByRole("textbox", { name: "Employee ID" }).fill(criteria.employeeId);
    log.step(`Search: Employee ID = ${criteria.employeeId}`);
  }

  // Click Search
  await page.getByRole("button", { name: "Search" }).click({ timeout: 5_000 });
  log.step("Search submitted");

  // Wait for results to load
  await page.waitForTimeout(1_000);

  // Parse results grid
  return parseSearchResults(page);
}

/**
 * Parse the search results grid into structured data.
 *
 * Grid columns: Last Name, First Name, Employer, Worksite Name,
 *               Employee Profile ID, I-9 ID, Next Action, Start Date, Created On
 */
async function parseSearchResults(page: Page): Promise<I9SearchResult[]> {
  const results: I9SearchResult[] = [];

  // The results grid is the second grid in the search dialog (first is column headers)
  const rows = page.getByRole("dialog", { name: "Search for Existing Employee" })
    .getByRole("grid").last()
    .getByRole("row");

  const rowCount = await rows.count();
  if (rowCount === 0) {
    log.step("No search results found");
    return results;
  }

  for (let i = 0; i < rowCount; i++) {
    const row = rows.nth(i);
    const cells = row.getByRole("gridcell");
    const cellCount = await cells.count();

    if (cellCount < 5) continue; // Skip malformed rows

    const lastName = await cells.nth(0).textContent() ?? "";
    const firstName = await cells.nth(1).textContent() ?? "";
    const employer = await cells.nth(2).textContent() ?? "";
    const worksite = await cells.nth(3).textContent() ?? "";
    const profileId = await cells.nth(4).textContent() ?? "";
    const i9Id = await cells.nth(5).textContent() ?? "";
    const nextAction = await cells.nth(6).textContent() ?? "";
    const startDate = await cells.nth(7).textContent() ?? "";

    // Extract nav URL from the link in the row
    const link = row.getByRole("link");
    const navUrl = await link.first().getAttribute("href").catch(() => "") ?? "";

    results.push({
      lastName: lastName.trim(),
      firstName: firstName.trim(),
      employer: employer.trim(),
      worksite: worksite.trim(),
      profileId: profileId.trim(),
      i9Id: i9Id.trim(),
      nextAction: nextAction.trim(),
      startDate: startDate.trim(),
      navUrl,
    });
  }

  log.step(`Found ${results.length} search result(s)`);
  return results;
}
