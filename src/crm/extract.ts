import type { Page, Locator } from "playwright";
import { log } from "../utils/log.js";

/**
 * Try to extract a single field value from the page using multiple strategies.
 * Returns the trimmed text value or null if not found.
 *
 * Strategies:
 * 1. Label-based: find the label text, go to parent, get value from span/dd/td
 * 2. ARIA: use getByLabel for accessibility-associated elements
 * 3. Table cell: find a td containing the label, get the next sibling td
 */
export async function extractField(
  page: Page,
  label: string,
): Promise<string | null> {
  // SELECTOR: Strategy 1 -- label-based (Salesforce dt/dd, label/span pairs)
  const byLabel: Locator = page
    .locator(`text="${label}"`)
    .locator("xpath=..")
    .locator("span, dd, td")
    .last();

  // SELECTOR: Strategy 2 -- ARIA label association
  const byAria: Locator = page.getByLabel(label);

  // SELECTOR: Strategy 3 -- table cell lookup (label in one cell, value in next)
  const byTableCell: Locator = page
    .locator(`td:has-text("${label}")`)
    .locator("xpath=following-sibling::td[1]");

  for (const locator of [byLabel, byAria, byTableCell]) {
    try {
      const text = await locator.first().textContent({ timeout: 3_000 });
      if (text && text.trim()) {
        return text.trim();
      }
    } catch {
      continue;
    }
  }

  return null;
}
