import type { Page } from "playwright";
import { log } from "../../utils/log.js";
import type { I9SearchCriteria, I9SearchResult } from "./types.js";
import { dashboard, search as searchSelectors } from "./selectors.js";
import {
  clickWithKendoRecovery,
  closeAllKendoWindows,
  snapshotKendoWindows,
} from "./navigate.js";
import { safeClick, safeFill } from "../common/index.js";

export interface I9SearchOptions {
  /** Close the Kendo search dialog after parsing. Defaults to true. */
  closeDialog?: boolean;
}

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
  options: I9SearchOptions = {},
): Promise<I9SearchResult[]> {
  const closeDialog = options.closeDialog ?? true;

  // Open search dialog by clicking "Search Options"
  log.step("Opening I9 search dialog...");
  await clickWithKendoRecovery(page, dashboard.searchOptionsButton(page), "search options", 5_000);

  // Wait for dialog to appear
  const dialog = searchSelectors.dialog(page);
  await dialog.waitFor({ state: "visible", timeout: 5_000 });

  // Clear any previous search
  await safeClick(searchSelectors.clearFiltersLink(page), {
    timeout: 3_000,
    label: "i9 clear filters link",
  });

  // Fill whichever fields are provided
  if (criteria.lastName) {
    await safeFill(searchSelectors.lastNameInput(page), criteria.lastName, {
      label: "i9 search last name",
    });
    log.step(`Search: Last Name = ${criteria.lastName}`);
  }

  if (criteria.firstName) {
    await safeFill(searchSelectors.firstNameInput(page), criteria.firstName, {
      label: "i9 search first name",
    });
    log.step(`Search: First Name = ${criteria.firstName}`);
  }

  if (criteria.ssn) {
    await safeFill(searchSelectors.ssnInput(page), criteria.ssn, {
      label: "i9 search ssn",
    });
    log.step("Search: SSN = ***");
  }

  if (criteria.profileId) {
    await safeFill(searchSelectors.profileIdInput(page), criteria.profileId, {
      label: "i9 search profile id",
    });
    log.step(`Search: Profile ID = ${criteria.profileId}`);
  }

  if (criteria.employeeId) {
    await safeFill(searchSelectors.employeeIdInput(page), criteria.employeeId, {
      label: "i9 search employee id",
    });
    log.step(`Search: Employee ID = ${criteria.employeeId}`);
  }

  // Click Search
  await safeClick(searchSelectors.submitButton(page), {
    timeout: 5_000,
    label: "i9 search submit button",
  });
  log.step("Search submitted");

  // Wait for results to load
  await page.waitForTimeout(1_000);

  // Parse results grid
  log.debug(`I9 search complete — post-parse state: ${await snapshotKendoWindows(page)}`);
  const results = await parseSearchResults(page);
  if (closeDialog) await closeAllKendoWindows(page);
  return results;
}

export function isIncompleteI9SectionAction(nextAction: string): boolean {
  return /^complete\s+section\s+[12]$/i.test(nextAction.trim().replace(/\s+/g, " "));
}

export function isSelectableI9SignerLookupAction(nextAction: string): boolean {
  const normalized = nextAction.trim().replace(/\s+/g, " ");
  return normalized.length > 0 && !isIncompleteI9SectionAction(normalized);
}

export function pickI9SignerSearchResult(
  results: readonly I9SearchResult[],
): I9SearchResult | undefined {
  return results.find((result) => isSelectableI9SignerLookupAction(result.nextAction));
}

export async function openI9SearchResult(page: Page, result: I9SearchResult): Promise<void> {
  const row = searchSelectors.resultRows(page).nth(result.rowIndex);
  const lastNameLink = row
    .getByRole("link", { name: new RegExp(`^${escapeRegExp(result.lastName)}$`, "i") }) // allow-inline-selector -- row-scoped search-result last-name link
    .first();
  const fallbackLink = row.getByRole("link").first(); // allow-inline-selector -- row-scoped fallback when link accessible name includes extra text
  const target = result.lastName ? lastNameLink.or(fallbackLink).first() : fallbackLink;

  log.step(
    `Opening I9 search result row ${result.rowIndex + 1}: ${result.lastName}, ${result.firstName} — ${result.nextAction}`,
  );
  await safeClick(target, {
    timeout: 10_000,
    label: "i9 selected search result last name",
  });
  await page.waitForLoadState("domcontentloaded", { timeout: 15_000 }).catch(() => {});
  await page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => {});
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Parse the search results grid into structured data.
 *
 * Grid columns: Last Name, First Name, Employer, Worksite Name,
 *               Employee Profile ID, I-9 ID, Next Action, Start Date, Created On
 */
async function parseSearchResults(page: Page): Promise<I9SearchResult[]> {
  const results: I9SearchResult[] = [];

  const rows = searchSelectors.resultRows(page);

  const rowCount = await rows.count();
  if (rowCount === 0) {
    log.step("No search results found");
    return results;
  }

  for (let i = 0; i < rowCount; i++) {
    const row = rows.nth(i);
    const cells = row.getByRole("gridcell"); // allow-inline-selector -- row-scoped cell readback, rooted in registry row
    const cellCount = await cells.count();

    if (cellCount < 5) {
      // A row with fewer than 5 cells doesn't match the expected grid shape
      // (Last Name, First Name, Employer, Worksite, Profile ID, ...). Silently
      // dropping it without a trace risks a false "not found"/"unsigned" for a
      // record that's actually present but mis-parsed — surface it so a
      // shrinking result set is diagnosable instead of invisible.
      // LIVE-VERIFIED 2026-07-08: a real "Smith" search renders results rows
      // with uniformly 10 cells (the dashboard's separate reverification grid
      // is uniformly 5), and a zero-result search renders NO tbody rows at
      // all (no short placeholder row) — so a sub-5-cell row here is always
      // a genuine parse anomaly, never a legitimate grid state.
      log.warn(`I9 search: skipping malformed result row ${i} (only ${cellCount} cell(s))`);
      continue;
    }

    const cellTexts = await cells.allTextContents();
    const lastName = cellTexts[0] ?? "";
    const firstName = cellTexts[1] ?? "";
    const employer = cellTexts[2] ?? "";
    const worksite = cellTexts[3] ?? "";
    const profileId = cellTexts[4] ?? "";
    const i9Id = cellTexts[5] ?? "";
    const nextAction = cellTexts[6] ?? "";
    const startDate = cellTexts[7] ?? "";
    const createdOn = cellTexts[8] ?? "";

    // Extract nav URL from the link in the row
    const link = row.getByRole("link"); // allow-inline-selector -- row-scoped link readback
    const navUrl = await link.first().getAttribute("href").catch(() => "") ?? "";

    results.push({
      rowIndex: i,
      lastName: lastName.trim(),
      firstName: firstName.trim(),
      employer: employer.trim(),
      worksite: worksite.trim(),
      profileId: profileId.trim(),
      i9Id: i9Id.trim(),
      nextAction: nextAction.trim(),
      startDate: startDate.trim(),
      createdOn: createdOn.trim(),
      navUrl,
    });
  }

  log.step(`Found ${results.length} search result(s)`);
  return results;
}
