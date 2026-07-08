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

  /**
   * All `<td>` cells of result row `i`, in column order. Used to scrape a
   * whole row (name / offer-sent-on / process-stage) by index without an
   * inline `page.locator` at the call site — column indices are documented on
   * the reader (`src/systems/crm/onboarding-records.ts`). Compound path
   * rooted in `nthResultRow`. verified 2026-04-14
   * @tags search, result, row, cells, table, crm
   */
  resultRowCells: (page: Page, i: number): Locator =>
    page.locator("table tbody tr").nth(i).locator("td"),

  /**
   * The `<a>` link inside result row `i`'s first (name) cell — the record
   * link to follow into `ONB_ViewOnboarding`. Compound path rooted in
   * `nthResultRow`. verified 2026-04-14
   * @tags search, result, row, link, name, crm
   */
  resultRowNameLink: (page: Page, i: number): Locator =>
    page.locator("table tbody tr").nth(i).locator("td").first().locator("a"),
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

  /**
   * Visualforce label → value locator strategy 3 (broader fallback): label in
   * ANY cell (`<th>` OR `<td>`), value in the next sibling `<td>`. Catches
   * record-page rows whose label cell tag varies between the rowheader (`<th>`)
   * and a plain data cell (`<td>`) — a single `.or()` chain so one extract pass
   * tries both without the caller ordering them. Live-probed 2026-07-08 on a
   * real record page ("UCPath Employee ID"): the th arm resolves the value
   * (same element strategy 1 hits); the td arm's first match had an EMPTY
   * following td, which extractField's empty-guard skips — the arm cannot
   * return a wrong value there, it just misses. verified 2026-07-08
   * @tags visualforce, label, value, th, td, extract, record, fallback, crm
   */
  cellLabelFollowingTd: (page: Page, label: string): Locator =>
    page
      .locator(`th:has-text("${label}")`)
      .locator("xpath=following-sibling::td[1]")
      .or(
        page
          .locator(`td:has-text("${label}")`)
          .locator("xpath=following-sibling::td[1]"),
      ),

  /**
   * Visualforce label → value locator strategy 4 (row-scoped fallback): find
   * the table ROW that contains the label, then read its LAST cell as the value
   * — robust when the value sits in the same `<tr>` as the label but is NOT the
   * immediate following sibling (extra spacer/format cells between label and
   * value), and when the label text is split across child nodes inside the
   * label cell (the `:has-text` row match still accumulates the descendant
   * text). Live-probed 2026-07-08 on a real record page: `tr:has-text` ALSO
   * matches enclosing outer-table rows, so `.first()` landed on an outer row
   * whose last td was EMPTY (extractField's empty-guard skipped it — inert,
   * not wrong) while the 2nd match held the right value. CAUTION: on a row
   * with multiple label/value pairs the last cell can be a DIFFERENT field's
   * value — keep this arm LAST among the table strategies and never promote
   * it. verified 2026-07-08
   * @tags visualforce, label, value, row, last-cell, extract, record, fallback, crm
   */
  rowLabelLastCell: (page: Page, label: string): Locator =>
    page
      .locator(`tr:has-text("${label}")`)
      .locator("td:last-child"),

  /**
   * Salesforce Lightning record-detail fallback: a `slds-form-element` whose
   * label text matches, read its value control. Lightning renders fields as
   * label/value div pairs (`.slds-form-element__label` + `.slds-form-element__control`)
   * rather than the Visualforce `<th>/<td>` table — this catches a record page
   * served by the Lightning UI instead of classic Visualforce. Live-probed
   * 2026-07-08 on a real record page: ZERO `.slds-form-element` nodes exist —
   * the hr portal serves classic Visualforce, so this arm is currently a dead
   * (harmless) fallback kept only for a future Lightning migration.
   * verified 2026-07-08
   * @tags lightning, label, value, form-element, extract, record, fallback, crm
   */
  lightningFieldValue: (page: Page, label: string): Locator =>
    page
      .locator(
        `.slds-form-element:has(.slds-form-element__label:has-text("${label}")) .slds-form-element__control`,
      ),
};

// ─── Section navigation ────────────────────────────────────────────────────

export const sectionNav = {
  /**
   * Fallback chain for "click a section by name" when direct URL mapping
   * isn't available in CRM_SECTION_URLS. Tries link, then text, then tab.
   * Live-checked on a real onboarding record page: "Onboarding History"
   * resolves via the getByText arm (case-insensitive substring match on the
   * "Show Onboarding History" button — the documented click fallback);
   * "UCPath Entry Sheet" has NO in-page anchor on that page shape, so only
   * the CRM_SECTION_URLS direct-URL path reaches it — do not rely on this
   * chain for it. verified 2026-07-08
   * @tags section, navigation, name, fallback, link, tab, crm
   */
  byName: (page: Page, sectionName: string): Locator =>
    page
      .getByRole("link", { name: new RegExp(sectionName, "i") })
      .or(page.getByText(sectionName))
      .or(page.getByRole("tab", { name: new RegExp(sectionName, "i") })),
};

// ─── Onboarding history (/hr/ONB_ShowOnboardingHistory?id=...) ─────────────

export const onboardingHistory = {
  /**
   * "Show Onboarding History" button on the ViewOnboarding record page. Opens
   * the ProcessStageText transition log. Direct URL nav (`CRM_SECTION_URLS`)
   * is preferred; this button is the click fallback. verified 2026-07-02
   * @tags onboarding, history, button, show, crm
   */
  showHistoryButton: (page: Page): Locator =>
    page.getByRole("button", { name: "Show Onboarding History" }),

  /**
   * Every row of the onboarding-history detail table(s). The history grid is a
   * `table.detailList`; each DATA row has exactly 5 direct `td`/`th` cells —
   * `Date | Created By | Field (ProcessStageText) | Old Value | New Value`.
   * The reader (`history.ts`) scopes to the 5-direct-cell rows and matches the
   * New Value column, so this locator can safely span the header/wrapper rows.
   * verified 2026-07-02 (EID 10883906 / 10883915)
   * @tags onboarding, history, rows, table, detaillist, crm
   */
  historyRows: (page: Page): Locator => page.locator("table.detailList tr"),
};

export const crmSelectors = {
  search,
  record,
  sectionNav,
  onboardingHistory,
};
