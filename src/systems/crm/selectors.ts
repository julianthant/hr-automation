import type { Page, Locator } from "playwright";

/**
 * ACT CRM (Salesforce) selector registry.
 *
 * Salesforce Visualforce pages — selectors are CSS / XPath / getByRole
 * mostly. No grid-index mutation issues here (selectors are
 * table-structural or role-based).
 */

// ─── Search results (/hr/ONB_OnboardingSearch results page) ───────────────

export const search = {
  /**
   * All result rows in the search-results table. verified 2026-04-14
   * @tags search, results, rows, table, crm
   */
  resultRows: (page: Page): Locator => page.locator("table tbody tr"),

  /**
   * Nth result row. Use: `search.nthResultRow(page, i).locator("td").nth(1)`
   * for the "Offer Sent On" column (index 1). verified 2026-04-14
   * @tags search, result, row, nth, table, crm
   */
  nthResultRow: (page: Page, i: number): Locator =>
    page.locator("table tbody tr").nth(i),
};

// ─── Record page (/hr/ONB_ViewOnboarding?id=...) ──────────────────────────

export const record = {
  /**
   * Visualforce label → value locator strategy 1: label in <th>, value in
   * the next sibling <td>. verified 2026-04-14
   * @tags visualforce, label, value, th, extract, record, crm
   */
  thLabelFollowingTd: (page: Page, label: string): Locator =>
    page
      .locator(`th:has-text("${label}")`)
      .locator("xpath=following-sibling::td[1]"),

  /**
   * Visualforce label → value locator strategy 2 (fallback): label in <td>,
   * value in the next sibling <td>. verified 2026-04-14
   * @tags visualforce, label, value, td, extract, record, fallback, crm
   */
  tdLabelFollowingTd: (page: Page, label: string): Locator =>
    page
      .locator(`td:has-text("${label}")`)
      .locator("xpath=following-sibling::td[1]"),
};

// ─── Section navigation ────────────────────────────────────────────────────

export const sectionNav = {
  /**
   * Fallback chain for "click a section by name" when direct URL mapping
   * isn't available in CRM_SECTION_URLS. Tries link, then text, then tab.
   * verified 2026-04-14
   * @tags section, navigation, name, fallback, link, tab, crm
   */
  byName: (page: Page, sectionName: string): Locator =>
    page
      .getByRole("link", { name: new RegExp(sectionName, "i") })
      .or(page.getByText(sectionName))
      .or(page.getByRole("tab", { name: new RegExp(sectionName, "i") })),
};

export const crmSelectors = {
  search,
  record,
  sectionNav,
};
