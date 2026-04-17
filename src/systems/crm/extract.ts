import type { Page } from "playwright";
import { record } from "./selectors.js";

/**
 * Try to extract a single field value from the page using multiple strategies.
 * Returns the trimmed text value or null if not found.
 *
 * Strategies (tried in order):
 *   1. Visualforce: label in `<th>`, value in sibling `<td>`
 *   2. Fallback: label in `<td>`, value in sibling `<td>`
 */
export async function extractField(
  page: Page,
  label: string,
): Promise<string | null> {
  // Visualforce layout: <th class="labelCol"><label>Field:</label></th>
  //                     <td class="data2Col">value</td>

  const strategies = [
    record.thLabelFollowingTd(page, label),
    record.tdLabelFollowingTd(page, label),
  ];

  for (const locator of strategies) {
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
