import type { Page } from "playwright";
import { log } from "../../utils/log.js";
import { ExtractionError } from "./types.js";
import { CRM_SEARCH_URL } from "../../config.js";
import { search as searchSelectors } from "./selectors.js";
import { clickIfPresent, safeClick } from "../common/index.js";
import { pickLatestOnboardingSearchRowIndex, type CrmSearchRowPickInput } from "./pick-latest-search-row.js";
import { errorMessage } from "../../utils/errors.js";

/**
 * Search results page -- accepts email as query param.
 * Discovered from live testing: navigating directly via URL params
 * is faster and more reliable than clicking the search toggle UI.
 */
const SEARCH_URL = CRM_SEARCH_URL;

/**
 * Search for an employee on the ACT CRM onboarding portal.
 * Navigates directly to the search results page via URL query param.
 */
export async function searchCrmOnboardingRecords(
  page: Page,
  query: string,
): Promise<void> {
  // Direct URL navigation with query param — faster and avoids hidden search
  // input issues.
  log.step("Searching for employee...");
  const searchUrl = `${SEARCH_URL}?q=${encodeURIComponent(query)}`;
  await page.goto(searchUrl, {
    waitUntil: "domcontentloaded",
    timeout: 15_000,
  });
  await page.waitForLoadState("networkidle", { timeout: 15_000 });
}

/**
 * Search for an employee by email on the ACT CRM onboarding portal.
 */
export async function searchByEmail(
  page: Page,
  email: string,
): Promise<void> {
  await searchCrmOnboardingRecords(page, email);
}

/**
 * Select the search result row with the latest live "Offer Sent On" date.
 * Clicks the name link (first column) to navigate to the employee record.
 *
 * Table columns:
 *   Onboarding Name | Offer Sent On | Hiring Supervisor Last Name |
 *   Hiring Supervisor First Name | Process Stage
 *
 * Skips the header-ish "Search Results" row (no record link) and dead stages
 * such as Offer Rescinded — those records have no iDocs viewer, so opening
 * the newest date can look like "PDF.js never loaded".
 */
export async function selectLatestResult(page: Page): Promise<void> {
  const rows = searchSelectors.resultRows(page);
  await rows.locator("a").first().waitFor({ timeout: 15_000 }); // allow-inline-selector -- wait for a real record link, not the header row

  const count = await rows.count();
  if (count === 0) {
    throw new ExtractionError("No search results found");
  }

  log.step(`Found ${count} result(s) -- selecting latest live offer...`);

  const inputs: CrmSearchRowPickInput[] = [];
  for (let i = 0; i < count; i++) {
    const cells = searchSelectors.resultRowCells(page, i);
    const cellCount = await cells.count();
    const hasNameLink = (await searchSelectors.resultRowNameLink(page, i).count()) > 0;
    const offerSentOn = cellCount > 1 ? ((await cells.nth(1).textContent())?.trim() ?? "") : "";
    const processStage = cellCount > 4 ? ((await cells.nth(4).textContent())?.trim() ?? "") : "";
    inputs.push({ hasNameLink, offerSentOn, processStage });
  }

  let latestIndex: number;
  try {
    latestIndex = pickLatestOnboardingSearchRowIndex(inputs);
  } catch (err) {
    throw new ExtractionError(errorMessage(err));
  }

  const picked = inputs[latestIndex];
  log.step(
    `Opening search row ${latestIndex} (${picked.processStage || "unknown stage"}, offer ${picked.offerSentOn || "undated"})`,
  );

  const nameLink = searchSelectors.resultRowNameLink(page, latestIndex);
  if (!(await clickIfPresent(nameLink, { label: "crm latest result name link" }))) {
    await safeClick(
      searchSelectors.resultRowCells(page, latestIndex).first(),
      { label: "crm latest result name cell" },
    );
  }

  await page.waitForLoadState("domcontentloaded", { timeout: 15_000 });
  await page.waitForLoadState("networkidle", { timeout: 15_000 });

  log.step("Selected result row");
}
