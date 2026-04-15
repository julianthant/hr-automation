import type { Page } from "playwright";
import { log } from "../../utils/log.js";

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
  // SELECTOR: adjusted from live testing on ONB_PPSEntrySheet page.
  // Visualforce layout: <th class="labelCol"><label>Field:</label></th>
  //                     <td class="data2Col">value</td>

  // Strategy 1 -- Visualforce: label in <th>, value in sibling <td>
  const byThSibling = page
    .locator(`th:has-text("${label}")`)
    .locator("xpath=following-sibling::td[1]");

  // Strategy 2 -- fallback: label in <td>, value in sibling <td>
  const byTdSibling = page
    .locator(`td:has-text("${label}")`)
    .locator("xpath=following-sibling::td[1]");

  for (const locator of [byThSibling, byTdSibling]) {
    try {
      const text = await locator.first().textContent({ timeout: 2_000 });
      if (text && text.trim()) {
        return text.trim();
      }
    } catch {
      continue;
    }
  }

  return null;
}
