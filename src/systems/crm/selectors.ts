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

// ─── Onboarding History (/hr/ONB_ShowOnboardingHistory?id=...) ─────────────
//
// The history page is a Visualforce page with a single `<table class="list">`
// of audit-log rows. Each row has 5 `<td class="dataCell">` columns:
//   0 Date        — "M/D/YYYY h:mm AM/PM" (no leading zeros)
//   1 Created By
//   2 Field       — "ProcessStageText" for state transitions
//   3 Old Value
//   4 New Value
//
// We pick the row whose New Value is "Witness Ceremony Oath New Hire Signed"
// — that's the moment the new hire signed the oath. Old Value would be the
// previous state ("Witness Ceremony Oath Created") and Date is the timestamp
// the workflow needs.
//
// Search by EID at /hr/ONB_SearchOnboardings?q=<EID> works (same endpoint
// the email search uses; the `q=` param is value-agnostic). The first row's
// link href is `/hr/ONB_ViewOnboarding?id=<RECORD_ID>`. The history page
// then takes that same RECORD_ID — no button click needed (the live mapping
// session showed `/hr/ONB_ShowOnboardingHistory?id=<RECORD_ID>` is a stable
// deep link).

export const onboardingHistory = {
  /**
   * Every history row in the audit-log table on the ONB_ShowOnboardingHistory
   * page. verified 2026-04-28
   * @tags onboarding, history, audit, log, row, crm
   */
  historyRows: (page: Page): Locator => page.locator("table.list tr.dataRow"),

  /**
   * The cells inside a single history row — 5 columns: Date, Created By,
   * Field, Old Value, New Value. verified 2026-04-28
   * @tags onboarding, history, audit, cell, td, crm
   */
  rowCells: (row: Locator): Locator => row.locator("td.dataCell"),

  /**
   * The single result row on the search page after navigating to
   * `/hr/ONB_SearchOnboardings?q=<EID>` — its first `<a>` link has the
   * record-page URL `/hr/ONB_ViewOnboarding?id=<RECORD_ID>` we need to
   * reach the history page. verified 2026-04-28
   * @tags onboarding, search, result, link, record-id, crm
   */
  firstResultLink: (page: Page): Locator =>
    page.locator("table tbody tr").first().locator("a").first(),
};

export const crmSelectors = {
  search,
  record,
  sectionNav,
  onboardingHistory,
};
