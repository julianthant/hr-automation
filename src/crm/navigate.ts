import type { Page } from "playwright";
import { log } from "../utils/log.js";

/**
 * Navigate from an employee record page to a named section.
 * Looks for a link, tab, or text element matching the section name
 * and clicks it.
 *
 * @param page - Playwright page instance
 * @param sectionName - The section to navigate to (e.g., "UCPath Entry Sheet")
 */
export async function navigateToSection(
  page: Page,
  sectionName: string,
): Promise<void> {
  log.step(`Looking for ${sectionName}...`);

  // SELECTOR: may need adjustment after live testing
  // Salesforce may render this as a link, tab, or button
  const sectionLink = page
    .getByRole("link", { name: new RegExp(sectionName, "i") })
    .or(page.getByText(sectionName))
    .or(page.getByRole("tab", { name: new RegExp(sectionName, "i") }));

  await sectionLink.first().click({ timeout: 10_000 });

  log.step(`Waiting for ${sectionName} to load...`);
  await page.waitForLoadState("networkidle", { timeout: 15_000 });

  log.step(`${sectionName} loaded`);
}
