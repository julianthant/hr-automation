import type { Page } from "playwright";
import { log } from "../utils/log.js";

/**
 * SELECTOR: adjusted from live testing -- known section URL mappings.
 * The onboarding record ID from the ViewOnboarding URL can be reused
 * to navigate directly via URL params instead of clicking UI buttons.
 */
const SECTION_URLS: Record<string, string> = {
  "UCPath Entry Sheet": "https://act-crm.my.site.com/hr/ONB_PPSEntrySheet",
};

/**
 * Navigate from an employee record page to a named section.
 * Uses direct URL navigation when the section URL pattern is known,
 * falls back to clicking a link/tab/button otherwise.
 *
 * @param page - Playwright page instance
 * @param sectionName - The section to navigate to (e.g., "UCPath Entry Sheet")
 */
export async function navigateToSection(
  page: Page,
  sectionName: string,
): Promise<void> {
  log.step(`Navigating to ${sectionName}...`);

  const sectionBaseUrl = SECTION_URLS[sectionName];
  const currentUrl = new URL(page.url());
  const recordId = currentUrl.searchParams.get("id");

  if (sectionBaseUrl && recordId) {
    // Fast path: navigate directly via URL params
    await page.goto(`${sectionBaseUrl}?id=${recordId}`, {
      waitUntil: "domcontentloaded",
      timeout: 15_000,
    });
  } else {
    // Fallback: click the section link/tab/button
    const sectionLink = page
      .getByRole("link", { name: new RegExp(sectionName, "i") })
      .or(page.getByText(sectionName))
      .or(page.getByRole("tab", { name: new RegExp(sectionName, "i") }));

    await sectionLink.first().click({ timeout: 10_000 });
  }

  await page.waitForLoadState("networkidle", { timeout: 15_000 });
  log.step(`${sectionName} loaded`);
}
