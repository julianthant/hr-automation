import type { Locator, Page } from "playwright";
import { record } from "./selectors.js";

/**
 * The subset of the CRM `record` selector registry `extractField` drives. The
 * default is the real registry; tests inject a fake to exercise the strategy
 * ordering / label stripping against an in-memory DOM without a live page.
 */
export type CrmRecordFieldSelectors = {
  thLabelFollowingTd: (page: Page, label: string) => Locator;
  tdLabelFollowingTd: (page: Page, label: string) => Locator;
  cellLabelFollowingTd: (page: Page, label: string) => Locator;
  rowLabelLastCell: (page: Page, label: string) => Locator;
  lightningFieldValue: (page: Page, label: string) => Locator;
};

/**
 * Strip a single field label out of an extracted cell's text.
 *
 * The row-scoped / cell fallbacks may return a cell whose text still contains
 * the label (e.g. a `tr:has-text(...) td:last-child` that captured "Date
 * Signed 11/1/2021 1:47 PM" when label + value share one cell). Remove the
 * label (with an optional trailing colon) so the caller gets just the value.
 * Case-insensitive; only strips a leading occurrence.
 */
export function stripLabel(text: string, label: string): string {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return text.replace(new RegExp(`^\\s*${escaped}\\s*:?\\s*`, "i"), "").trim();
}

/**
 * Build the label variants to try for one logical field. CRM record pages are
 * inconsistent about a trailing colon on the label ("Date Signed" vs "Date
 * Signed:"), so try both forms. `:has-text` is already case-insensitive
 * substring matching, so casing variants are not needed.
 */
export function labelVariants(label: string): string[] {
  const base = label.trim();
  const variants = [base];
  if (!base.endsWith(":")) variants.push(`${base}:`);
  return variants;
}

/**
 * Try to extract a single field value from the page using multiple strategies.
 * Returns the trimmed text value or null if not found.
 *
 * Strategies (tried in order, each across the label-with/without-colon
 * variants):
 *   1. Visualforce: label in `<th>`, value in following-sibling `<td>`
 *   2. Visualforce fallback: label in `<td>`, value in following-sibling `<td>`
 *   3. Broader: label in any cell (`<th>` OR `<td>`), value in following td
 *   4. Row-scoped: the `<tr>` containing the label, its last cell (handles the
 *      value living in the same row but not the immediate sibling, and a label
 *      split across child nodes)
 *   5. Salesforce Lightning: `.slds-form-element` label/value div pair
 *
 * The label is stripped from any returned text (strategies 4/5 can capture the
 * label + value in one node) so the caller always gets just the value.
 *
 * Perf (2026-06-07): timeout per attempt dropped from 2 000 ms to 500 ms.
 * Present elements resolve near-instantly; only missing fields pay the full
 * timeout. Worst case across both variants and all five strategies:
 * 2 × 5 × 500 ms = 5 s per missing field (was up to 2 × 5 × 2 000 ms = 20 s).
 * The short-timeout loop is kept (rather than a single `.or()` chain) so an
 * empty-text strategy is still skipped and later strategies can fill the gap.
 *
 * IMPORTANT (2026-06-07): strategies 3-5 are strictly-additive permissiveness
 * widenings that have NOT been verified against the live CRM record page (needs
 * auth + a real onboarding record). They only ever run as FALLBACKS after the
 * two verified Visualforce strategies miss, so they can only find MORE values,
 * never break a currently-working extract. Re-verify against the live DOM and
 * bump the `// verified` dates in `selectors.ts` once confirmed.
 */
export async function extractField(
  page: Page,
  label: string,
  selectors: CrmRecordFieldSelectors = record,
): Promise<string | null> {
  const buildStrategy = (variant: string) => [
    selectors.thLabelFollowingTd(page, variant),
    selectors.tdLabelFollowingTd(page, variant),
    selectors.cellLabelFollowingTd(page, variant),
    selectors.rowLabelLastCell(page, variant),
    selectors.lightningFieldValue(page, variant),
  ];

  for (const variant of labelVariants(label)) {
    for (const locator of buildStrategy(variant)) {
      try {
        const text = await locator.first().textContent({ timeout: 500 });
        if (text && text.trim()) {
          const value = stripLabel(text.trim(), variant);
          if (value) return value;
        }
      } catch {
        continue;
      }
    }
  }

  return null;
}
