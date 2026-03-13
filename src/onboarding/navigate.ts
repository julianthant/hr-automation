import type { Page } from "playwright";
import { log } from "../utils/log.js";

/**
 * Navigate from an employee record page to the UCPath Entry Sheet.
 * Looks for a link, tab, or text element containing "UCPath Entry Sheet"
 * and clicks it.
 */
export async function navigateToEntrySheet(page: Page): Promise<void> {
  log.step("Looking for UCPath Entry Sheet...");

  // SELECTOR: may need adjustment after live testing
  // Salesforce may render this as a link, tab, or button
  const entrySheetLink = page
    .getByRole("link", { name: /UCPath Entry Sheet/i })
    .or(page.getByText("UCPath Entry Sheet"))
    .or(page.getByRole("tab", { name: /UCPath Entry Sheet/i }));

  await entrySheetLink.first().click({ timeout: 10_000 });

  log.step("Waiting for entry sheet to load...");
  await page.waitForLoadState("networkidle", { timeout: 15_000 });

  log.step("UCPath Entry Sheet loaded");
}
