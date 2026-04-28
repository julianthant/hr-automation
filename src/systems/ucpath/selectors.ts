import type { Page, Locator, FrameLocator } from "playwright";

/**
 * UCPath selector registry.
 *
 * Every selector used by `src/systems/ucpath/*.ts` lives here. Callers import
 * from this module rather than constructing locators inline. Each selector is
 * a function that takes the appropriate root (page / frame / FrameLocator /
 * scoped Locator) and returns a Playwright Locator, so the call-site
 * `.click()` / `.fill()` / `.selectOption()` is unchanged.
 *
 * Fallback chains (`.or()`) are used where the underlying anchor is known to
 * mutate — specifically PeopleSoft grid input IDs (`$0` vs `$11` after a page
 * refresh). Preferred anchor first (accessible-name via `getByRole`), then
 * the grid-ID fallback, then the pre-refresh variant.
 *
 * Verified-date comments preserve the original in-source verification stamp.
 * This was a re-homing pass, not live re-verification — see
 * docs/superpowers/plans/2026-04-17-subsystem-a-selector-registry.md.
 */

// ─── Iframe root ───────────────────────────────────────────────────────────

/**
 * Returns the PeopleSoft content iframe FrameLocator.
 * UCPath wraps Classic content in #main_target_win0 (not #ptifrmtgtframe).
 * Every form interaction after initial navigation must go through this frame.
 * verified 2026-03-16 (iframe ID: main_target_win0)
 * @tags iframe, frame, content, peoplesoft
 */
export function getContentFrame(page: Page): FrameLocator {
  return page.frameLocator("#main_target_win0");
}

// ─── Smart HR Transactions (sidebar + template setup + controls) ──────────

export const smartHR = {
  /**
   * Sidebar "Smart HR Templates" expand/collapse link. verified 2026-03-16
   * @tags sidebar, templates, smart-hr, link
   */
  sidebarTemplatesLink: (page: Page): Locator =>
    page.getByRole("link", { name: /Smart HR Templates/i }).first(),

  /**
   * Sidebar child link "Smart HR Transactions" (exact match). verified 2026-03-16
   * @tags sidebar, transactions, smart-hr, link
   */
  sidebarTransactionsLink: (page: Page): Locator =>
    page.getByRole("link", { name: "Smart HR Transactions", exact: true }),

  /**
   * Navigation Area button that collapses the sidebar so iframe buttons aren't blocked. verified 2026-03-16
   * @tags sidebar, collapse, navigation, button
   */
  sidebarNavigationToggle: (page: Page): Locator =>
    page.getByRole("button", { name: "Navigation Area" }),

  /**
   * Template selection textbox in the Smart HR Transactions form. verified 2026-03-16
   * @tags template, smart-hr, transaction, textbox
   */
  templateInput: (f: FrameLocator): Locator =>
    f.getByRole("textbox", { name: "Select Template" }),

  /**
   * Effective Date textbox. verified 2026-03-16
   * @tags effective, date, textbox, smart-hr
   */
  effectiveDateInput: (f: FrameLocator): Locator =>
    f.getByRole("textbox", { name: "Effective Date" }),

  /**
   * Create Transaction button. verified 2026-03-16
   * @tags create, transaction, smart-hr, button
   */
  createTransactionButton: (f: FrameLocator): Locator =>
    f.getByRole("button", { name: "Create Transaction" }),

  /**
   * Reason Code dropdown. verified 2026-03-16
   * @tags reason, code, dropdown, transaction
   */
  reasonCodeSelect: (f: FrameLocator): Locator => f.getByLabel("Reason Code"),

  /**
   * Continue button after reason code selection. verified 2026-03-16 (id: HR_TBH_WRK_TBH_NEXT)
   * @tags continue, button, reason, transaction
   */
  continueButton: (f: FrameLocator): Locator =>
    f.getByRole("button", { name: "Continue" }),

  /** Tabs within the transaction form. verified 2026-03-16 */
  tab: {
    /**
     * Personal Data tab inside Smart HR transaction form.
     * @tags tab, personal-data, transaction, smart-hr
     */
    personalData: (f: FrameLocator): Locator =>
      f.getByRole("tab", { name: "Personal Data" }),
    /**
     * Job Data tab inside Smart HR transaction form.
     * @tags tab, job-data, transaction, smart-hr
     */
    jobData: (f: FrameLocator): Locator =>
      f.getByRole("tab", { name: "Job Data" }),
    /**
     * Earns Dist tab inside Smart HR transaction form.
     * @tags tab, earns, dist, transaction, smart-hr
     */
    earnsDist: (f: FrameLocator): Locator =>
      f.getByRole("tab", { name: "Earns Dist" }),
    /**
     * Employee Experience tab inside Smart HR transaction form.
     * @tags tab, employee-experience, transaction, smart-hr
     */
    employeeExperience: (f: FrameLocator): Locator =>
      f.getByRole("tab", { name: "Employee Experience" }),
  },

  /**
   * Save and Submit button (the first match — bottom of every tab). verified 2026-03-16
   * @tags save, submit, transaction, button
   */
  saveAndSubmitButton: (f: FrameLocator): Locator =>
    f.getByRole("button", { name: "Save and Submit" }).first(),

  /**
   * OK button on the confirmation dialog after Save & Submit. verified 2026-04-01
   * @tags ok, confirmation, dialog, save, button
   */
  confirmationOkButton: (f: FrameLocator): Locator =>
    f.getByRole("button", { name: "OK" }),

  /**
   * Error/alert region inside the transaction iframe. verified 2026-03-16
   * @tags error, alert, banner, transaction
   */
  errorBanner: (f: FrameLocator): Locator =>
    f.locator(".PSERROR, #ALERTMSG, .ps_alert-error"),
};

// ─── Personal Data tab (inside transaction form) ───────────────────────────

export const personalData = {
  /**
   * Legal First Name textbox.
   * @tags legal, first-name, name, textbox, personal-data
   */
  legalFirstName: (f: FrameLocator): Locator =>
    f.getByRole("textbox", { name: "Legal First Name" }),
  /**
   * Legal Last Name textbox.
   * @tags legal, last-name, name, textbox, personal-data
   */
  legalLastName: (f: FrameLocator): Locator =>
    f.getByRole("textbox", { name: "Legal Last Name" }),
  /**
   * Legal Middle Name textbox.
   * @tags legal, middle-name, name, textbox, personal-data
   */
  legalMiddleName: (f: FrameLocator): Locator =>
    f.getByRole("textbox", { name: "Legal Middle Name" }),

  /**
   * Preferred/Lived First Name — `exact: true` disambiguates from legal variants. verified 2026-04-16
   * @tags preferred, lived, first-name, name, textbox, personal-data
   */
  preferredFirstName: (f: FrameLocator): Locator =>
    f.getByRole("textbox", { name: "First Name", exact: true }),
  /**
   * Preferred/Lived Last Name — `exact: true` disambiguates from legal variants. verified 2026-04-16
   * @tags preferred, lived, last-name, name, textbox, personal-data
   */
  preferredLastName: (f: FrameLocator): Locator =>
    f.getByRole("textbox", { name: "Last Name", exact: true }),
  /**
   * Preferred/Lived Middle Name — `exact: true` disambiguates from legal variants. verified 2026-04-16
   * @tags preferred, lived, middle-name, name, textbox, personal-data
   */
  preferredMiddleName: (f: FrameLocator): Locator =>
    f.getByRole("textbox", { name: "Middle Name", exact: true }),

  /**
   * Date of Birth textbox.
   * @tags dob, birth, date, textbox, personal-data
   */
  dateOfBirth: (f: FrameLocator): Locator =>
    f.getByRole("textbox", { name: "Date of Birth" }),

  /**
   * SSN / National ID textbox. exact: true avoids matching "National ID Type" dropdown. verified 2026-03-16
   * @tags ssn, national-id, textbox, personal-data
   */
  nationalId: (f: FrameLocator): Locator =>
    f.getByRole("textbox", { name: "National ID", exact: true }),

  /**
   * Address Line 1 textbox.
   * @tags address, line, textbox, personal-data
   */
  addressLine1: (f: FrameLocator): Locator =>
    f.getByRole("textbox", { name: "Address Line 1" }),
  /**
   * City textbox.
   * @tags city, address, textbox, personal-data
   */
  city: (f: FrameLocator): Locator => f.getByRole("textbox", { name: "City" }),
  /**
   * State textbox.
   * @tags state, address, textbox, personal-data
   */
  state: (f: FrameLocator): Locator =>
    f.getByRole("textbox", { name: "State" }),
  /**
   * Postal Code textbox.
   * @tags postal, zip, code, address, textbox, personal-data
   */
  postalCode: (f: FrameLocator): Locator =>
    f.getByRole("textbox", { name: "Postal Code" }),

  /**
   * Phone Type dropdown for row index 6 (Mobile - Personal slot).
   * verified 2026-03-16 (id: HR_TBH_G_SCR_WK_TBH_G_LG_DD1$6)
   * @tags phone, type, dropdown, grid, personal-data
   */
  phoneTypeSelect: (f: FrameLocator): Locator =>
    f.locator('[id="HR_TBH_G_SCR_WK_TBH_G_LG_DD1$6"]'),

  /**
   * Phone number textbox for row index 6.
   * verified 2026-03-16 (id: HR_TBH_G_SCR_WK_TBH_G_SH_EDIT2$6)
   * @tags phone, number, textbox, grid, personal-data
   */
  phoneNumberInput: (f: FrameLocator): Locator =>
    f.locator('[id="HR_TBH_G_SCR_WK_TBH_G_SH_EDIT2$6"]'),

  /**
   * Preferred-phone checkbox for row index 6.
   * verified 2026-03-16 (id: HR_TBH_G_SCR_WK_TBH_G_CHK3$6)
   * @tags phone, preferred, checkbox, grid, personal-data
   */
  phonePreferredCheckbox: (f: FrameLocator): Locator =>
    f.locator('[id="HR_TBH_G_SCR_WK_TBH_G_CHK3$6"]'),

  /**
   * Email Type dropdown for row index 7 (Home slot).
   * verified 2026-03-16 (id: HR_TBH_G_SCR_WK_TBH_G_LG_DD1$7)
   * @tags email, type, dropdown, grid, personal-data
   */
  emailTypeSelect: (f: FrameLocator): Locator =>
    f.locator('[id="HR_TBH_G_SCR_WK_TBH_G_LG_DD1$7"]'),

  /**
   * Email address textbox for row index 7.
   * verified 2026-03-16 (id: HR_TBH_G_SCR_WK_TBH_G_LG_EDIT2$7)
   * @tags email, address, textbox, grid, personal-data
   */
  emailAddressInput: (f: FrameLocator): Locator =>
    f.locator('[id="HR_TBH_G_SCR_WK_TBH_G_LG_EDIT2$7"]'),

  /**
   * Tracker profile ID textbox (I-9 linkage). verified 2026-03-16
   * @tags tracker, profile, i9, textbox, personal-data
   */
  trackerProfileIdInput: (f: FrameLocator): Locator =>
    f.getByRole("textbox", { name: "Tracker Profile ID" }),
};

// ─── Comments section (inside transaction form) ────────────────────────────

export const comments = {
  /**
   * Comments textarea — exact ID preserved from original. verified 2026-03-16
   * @tags comments, textarea, transaction
   */
  commentsTextarea: (f: FrameLocator): Locator =>
    f.locator("#HR_TBH_WRK_DESCRLONG_NOTES"),

  /**
   * Initiator Comments textarea — exact ID preserved from original. verified 2026-03-16
   * @tags initiator, comments, textarea, transaction
   */
  initiatorCommentsTextarea: (f: FrameLocator): Locator =>
    f.locator("#UC_SS_TRANSACT_COMMENTS"),
};

// ─── Job Data tab (inside transaction form) ───────────────────────────────

export const jobData = {
  /**
   * Position Number textbox. exact: true avoids "Reports To Position Number". verified 2026-03-16
   * @tags position, number, textbox, job-data, paypath
   */
  positionNumberInput: (f: FrameLocator): Locator =>
    f.getByRole("textbox", { name: "Position Number", exact: true }),

  /**
   * Employee Classification textbox. verified 2026-03-16
   * @tags employee, classification, textbox, job-data
   */
  employeeClassificationInput: (f: FrameLocator): Locator =>
    f.getByRole("textbox", { name: "Employee Classification" }),

  /**
   * Comp Rate Code input. Primary: accessible name (resilient to grid-index
   * shifts). Fallbacks: 4 known grid-ID variants covering pre- and
   * post-position-number-fill states. verified 2026-04-16
   *
   * PeopleSoft grid input IDs mutate from $11 → $0 after the position number
   * fill triggers a page refresh. Fallback chain captures both.
   * @tags comp, rate, code, compensation, paypath, dropdown, textbox, job-data
   */
  compRateCodeInput: (f: FrameLocator): Locator =>
    f
      .getByRole("textbox", { name: "Comp Rate Code" })
      .or(f.locator('input[id="HR_TBH_G_SCR_WK_TBH_G_SH_EDIT1$0"]'))
      .or(f.locator('input[id="HR_TBH_G_SCR_WK_TBH_G_SH_PROMPT1$11"]'))
      .or(f.locator('input[id="HR_TBH_G_SCR_WK_TBH_G_SH_PROMPT1$0"]'))
      .or(f.locator('input[id="HR_TBH_G_SCR_WK_TBH_G_SH_EDIT1$11"]')),

  /**
   * Compensation Rate input. Same shape as Comp Rate Code. verified 2026-04-16
   * @tags compensation, rate, comp, paypath, textbox, job-data
   */
  compensationRateInput: (f: FrameLocator): Locator =>
    f
      .getByRole("textbox", { name: "Compensation Rate" })
      .or(f.locator('input[id="HR_TBH_G_SCR_WK_TBH_G_SH_EDIT2$0"]'))
      .or(f.locator('input[id="HR_TBH_G_SCR_WK_TBH_G_SH_NUM2$11"]'))
      .or(f.locator('input[id="HR_TBH_G_SCR_WK_TBH_G_SH_NUM2$0"]'))
      .or(f.locator('input[id="HR_TBH_G_SCR_WK_TBH_G_SH_EDIT2$11"]')),

  /**
   * Compensation Frequency textbox (accessible name — resilient). verified 2026-04-16
   * @tags compensation, frequency, comp, textbox, job-data
   */
  compensationFrequencyInput: (f: FrameLocator): Locator =>
    f.getByRole("textbox", { name: "Compensation Frequency" }),

  /**
   * Expected Job End Date textbox. verified 2026-03-16
   * @tags expected, job, end, date, textbox, job-data
   */
  expectedJobEndDateInput: (f: FrameLocator): Locator =>
    f.getByRole("textbox", { name: "Expected Job End Date" }),
};

// ─── Person Search (pre-transaction duplicate check) ───────────────────────

export const personSearch = {
  /**
   * Search Type dropdown (P = Person). verified 2026-03-16
   * @tags search, type, person, dropdown
   */
  searchTypeSelect: (f: FrameLocator): Locator =>
    f.locator("#HCR_SM_PARM_VW_SM_TYPE"),

  /**
   * Parameter code input ("PERSON_SEARCH"). verified 2026-03-16
   * @tags parameter, code, person, search, input
   */
  parameterCodeInput: (f: FrameLocator): Locator =>
    f.locator("#HCR_SM_PARM_VW_SM_PARM_CD"),

  /**
   * Search button on page 1 (loads the search form). verified 2026-03-16
   * @tags search, load, form, button, person
   */
  loadFormButton: (f: FrameLocator): Locator =>
    f.locator("#PTS_CFG_CL_WRK_PTS_SRCH_BTN"),

  /**
   * Result code input ("PERSON_RESULTS"). verified 2026-04-01
   * @tags result, code, person, search, input
   */
  resultCodeInput: (f: FrameLocator): Locator =>
    f.locator('[id="DERIVED_HCR_SM_SM_RSLT_CD"]'),

  /**
   * SSN input (CHAR_INPUT$0). verified 2026-04-01
   * @tags ssn, person, search, input
   */
  ssnInput: (f: FrameLocator): Locator =>
    f.locator('[id="DERIVED_HCR_SM_SM_CHAR_INPUT$0"]'),

  /**
   * First name input (CHAR_INPUT$1). verified 2026-04-01
   * @tags first-name, name, person, search, input
   */
  firstNameInput: (f: FrameLocator): Locator =>
    f.locator('[id="DERIVED_HCR_SM_SM_CHAR_INPUT$1"]'),

  /**
   * Last name input (CHAR_INPUT$2). verified 2026-04-01
   * @tags last-name, name, person, search, input
   */
  lastNameInput: (f: FrameLocator): Locator =>
    f.locator('[id="DERIVED_HCR_SM_SM_CHAR_INPUT$2"]'),

  /**
   * DOB input (DATE_INPUT$3). verified 2026-04-01
   * @tags dob, birth, date, person, search, input
   */
  dobInput: (f: FrameLocator): Locator =>
    f.locator('[id="DERIVED_HCR_SM_SM_DATE_INPUT$3"]'),

  /**
   * National Id magnifying-glass lookup button (CHAR_INPUT$prompt$0). verified 2026-04-01
   * @tags ssn, national-id, lookup, button, person, search
   */
  ssnLookupButton: (f: FrameLocator): Locator =>
    f.locator('[id="DERIVED_HCR_SM_SM_CHAR_INPUT$prompt$0"]'),

  /**
   * Search submit button. verified 2026-04-01
   * @tags search, submit, button, person
   */
  searchSubmitButton: (f: FrameLocator): Locator =>
    f.locator("#DERIVED_HCR_SM_SM_SEARCH_BTN"),

  /**
   * Results grid — rows containing a 5+ digit employee ID. verified 2026-04-01
   * @tags results, grid, rows, person, search
   */
  resultRows: (f: FrameLocator): Locator =>
    f
      .locator('[id*="SEARCH_RESULT"] tr, .PSLEVEL1GRID tr')
      .filter({ hasText: /\d{5,}/ }),
};

// ─── Job Summary page (sidebar-less direct URL + iframe cases) ─────────────

export const jobSummary = {
  /**
   * Campus discovery page — UCSD link. verified 2026-04-01
   * @tags campus, discovery, ucsd, link, job-summary
   */
  campusDiscoveryUcsdLink: (page: Page): Locator =>
    page.getByRole("link", { name: "University of California, San Diego" }),

  /**
   * Empl ID textbox. `root` is either `page.locator("body")` (direct URL) or
   * `page.frameLocator("#main_target_win0").locator("body")` (iframe case).
   * verified 2026-04-01
   * @tags empl, id, employee, textbox, job-summary
   */
  emplIdInput: (root: Locator): Locator =>
    root.getByRole("textbox", { name: "Empl ID" }),

  /**
   * Search button (exact: true). verified 2026-04-01
   * @tags search, button, job-summary
   */
  searchButton: (root: Locator): Locator =>
    root.getByRole("button", { name: "Search", exact: true }),

  /**
   * Work Location tab. verified 2026-04-01
   * @tags work, location, tab, job-summary
   */
  workLocationTab: (root: Locator): Locator =>
    root.getByRole("tab", { name: "Work Location" }),

  /**
   * Job Information tab. verified 2026-04-01
   * @tags job, information, tab, job-summary
   */
  jobInformationTab: (root: Locator): Locator =>
    root.getByRole("tab", { name: "Job Information" }),

  /**
   * Iframe presence probe — when count > 0 we're in iframe mode. verified 2026-04-01
   * @tags iframe, probe, job-summary
   */
  mainTargetIframeProbe: (page: Page): Locator =>
    page.locator("#main_target_win0"),

  /**
   * Multi-row search-results grid container. Zero count → PeopleSoft
   * auto-redirected to the detail page (single-row case). Non-zero count →
   * multiple rows returned; caller must drill into one before clicking
   * detail-page tabs. verified 2026-04-23
   * @tags multi-row, grid, search, results, job-summary
   */
  searchResultsGrid: (root: Locator): Locator =>
    root
      .locator('[id*="SEARCH_RESULT"]')
      .or(root.locator(".PSLEVEL1GRID")),

  /**
   * Data rows inside the multi-row search-results grid. Filter by a 7+ digit
   * pattern matches employee IDs and skips header / separator rows.
   * verified 2026-04-23
   * @tags multi-row, rows, grid, search, results, job-summary
   */
  searchResultRows: (root: Locator): Locator =>
    root
      .locator('[id*="SEARCH_RESULT"] tr, .PSLEVEL1GRID tr')
      .filter({ hasText: /\d{7,}/ }),

  /**
   * HR Status / Empl Status cell inside a single row. PeopleSoft emits the
   * literal text "Terminated" or "Active" (or "Terminated With Pay" /
   * "Suspended"). Caller checks the textContent for the "Terminat" prefix to
   * filter out inactive employments. verified 2026-04-23
   * @tags multi-row, hr-status, terminated, active, cell, job-summary
   */
  rowHrStatusCell: (row: Locator): Locator =>
    row
      .locator('td:has-text("Terminated")')
      .or(row.locator('td:has-text("Active")'))
      .or(row.locator('span:has-text("Terminated")'))
      .or(row.locator('span:has-text("Active")')),

  /**
   * Drill-in link that navigates from the grid to the detail page for the
   * matching row. PeopleSoft variants: "drill in" link (Emergency Contact
   * style), EMPLID hyperlink, or a generic first link inside the row.
   * verified 2026-04-23
   * @tags multi-row, drill-in, select, link, job-summary
   */
  rowDrillInLink: (row: Locator): Locator =>
    row
      .getByRole("link", { name: /drill in/i })
      .or(row.locator('a[id*="EMPLID"]'))
      .or(row.getByRole("link").first()),
};

// ─── HR Tasks navigation (top-level page before iframe interactions) ──────
//
// HR Tasks is the activity-guide landing page reached at the URL stored in
// `UCPATH_SMART_HR_URL`. The left sidebar (`<navigation aria-label="HR Tasks
// Item List">`) has 7 top-level items; 5 of them are expandable categories
// whose toggle href is `javascript:void(0);` and whose accessible name ends
// in "(select to expand or collapse child steps)". The 2 leaf top-level
// items, plus all 18 leaf children, link to `/c/...GBL?NavColl=true` URLs
// that load inside `#main_target_win0`. Top-level link names are duplicated
// (img alt + text — e.g. "Search Person Search Person") so accessible-name
// matchers should use anchored regex rather than `exact: true`.
// Sidebar tree mapped 2026-04-24 via playwright-cli.

export const hrTasks = {
  /**
   * HR Tasks tile / link. verified 2026-03-16
   * @tags hr-tasks, tile, link, navigation
   */
  tile: (page: Page): Locator =>
    page.getByRole("link", { name: /HR Tasks/i }).or(page.getByText("HR Tasks")),

  /**
   * Sidebar `<navigation>` region containing all HR Tasks nav items.
   * Useful as a scoping root for sidebar-only locators. verified 2026-04-24
   * @tags sidebar, navigation, region, hr-tasks
   */
  itemList: (page: Page): Locator =>
    page.getByRole("navigation", { name: "HR Tasks Item List" }),

  /**
   * Sidebar top-level: Search Person (Search/Match form). Top-level links
   * have duplicated accessible names ("X X"), so anchor with `^X`.
   * verified 2026-04-24
   * @tags sidebar, search, person, link, hr-tasks
   */
  searchPersonLink: (page: Page): Locator =>
    page.getByRole("link", { name: /^Search Person/ }),

  /**
   * Sidebar top-level: Person Organizational Summary. verified 2026-04-24
   * @tags sidebar, person-org-summary, link, hr-tasks
   */
  personOrgSummaryLink: (page: Page): Locator =>
    page.getByRole("link", { name: /^Person Organizational Summary/ }),

  /**
   * Sidebar category toggle: Contract Pay (expand/collapse). The "(select to
   * expand or collapse child steps)" suffix disambiguates the category
   * header from any child link starting with the same prefix. verified 2026-04-24
   * @tags sidebar, contract-pay, category, link, hr-tasks
   */
  contractPayLink: (page: Page): Locator =>
    page.getByRole("link", {
      name: /^Contract Pay .*select to expand or collapse/,
    }),

  /**
   * Sidebar leaf under Contract Pay: Contract Payment Details. verified 2026-04-24
   * @tags sidebar, contract-pay, payment-details, link, hr-tasks
   */
  contractPaymentDetailsLink: (page: Page): Locator =>
    page.getByRole("link", { name: "Contract Payment Details", exact: true }),

  /**
   * Sidebar leaf under Contract Pay: Update Contract Pay NA. verified 2026-04-24
   * @tags sidebar, contract-pay, update, link, hr-tasks
   */
  updateContractPayNaLink: (page: Page): Locator =>
    page.getByRole("link", { name: "Update Contract Pay NA", exact: true }),

  /**
   * Sidebar category toggle: PayPath/Additional Pay. verified 2026-04-24
   * @tags sidebar, paypath, additional-pay, category, link, hr-tasks
   */
  payPathLink: (page: Page): Locator =>
    page.getByRole("link", {
      name: /^PayPath\/Additional Pay .*select to expand or collapse/,
    }),

  /**
   * Sidebar leaf under PayPath: Create Additional Pay. verified 2026-04-24
   * @tags sidebar, paypath, additional-pay, create, link, hr-tasks
   */
  createAdditionalPayLink: (page: Page): Locator =>
    page.getByRole("link", { name: "Create Additional Pay", exact: true }),

  /**
   * Sidebar leaf under PayPath: Self Service Additional Pay. verified 2026-04-24
   * @tags sidebar, paypath, self-service, additional-pay, link, hr-tasks
   */
  selfServiceAdditionalPayLink: (page: Page): Locator =>
    page.getByRole("link", {
      name: "Self Service Additional Pay",
      exact: true,
    }),

  /**
   * Sidebar leaf under PayPath: PayPath Actions (combined staff+academic
   * entry). verified 2026-04-24
   * @tags sidebar, paypath, actions, link, hr-tasks
   */
  payPathActionsLink: (page: Page): Locator =>
    page.getByRole("link", { name: "PayPath Actions", exact: true }),

  /**
   * Sidebar leaf under PayPath: PayPath Actions ACAD. verified 2026-04-24
   * @tags sidebar, paypath, actions, academic, link, hr-tasks
   */
  payPathActionsAcadLink: (page: Page): Locator =>
    page.getByRole("link", { name: "PayPath Actions ACAD", exact: true }),

  /**
   * Sidebar leaf under PayPath: PayPath Actions STAFF. verified 2026-04-24
   * @tags sidebar, paypath, actions, staff, link, hr-tasks
   */
  payPathActionsStaffLink: (page: Page): Locator =>
    page.getByRole("link", { name: "PayPath Actions STAFF", exact: true }),

  /**
   * Sidebar category toggle: Job Data Related. verified 2026-04-24
   * @tags sidebar, job-data, category, link, hr-tasks
   */
  jobDataRelatedLink: (page: Page): Locator =>
    page.getByRole("link", {
      name: /^Job Data Related .*select to expand or collapse/,
    }),

  /**
   * Sidebar leaf under Job Data Related: Job Data. verified 2026-04-24
   * @tags sidebar, job-data, link, hr-tasks
   */
  jobDataLink: (page: Page): Locator =>
    page.getByRole("link", { name: "Job Data", exact: true }),

  /**
   * Sidebar leaf under Job Data Related: UC Employee Review. verified 2026-04-24
   * @tags sidebar, job-data, uc-employee-review, link, hr-tasks
   */
  ucEmployeeReviewLink: (page: Page): Locator =>
    page.getByRole("link", { name: "UC Employee Review", exact: true }),

  /**
   * Sidebar leaf under Job Data Related: Workforce Job Summary (separations
   * + emergency-contact entry point). verified 2026-04-24
   * @tags sidebar, job-data, workforce, job-summary, link, hr-tasks
   */
  workforceJobSummaryLink: (page: Page): Locator =>
    page.getByRole("link", { name: "Workforce Job Summary", exact: true }),

  /**
   * Sidebar category toggle: Personal Data Related. verified 2026-04-24
   * @tags sidebar, personal-data, category, link, hr-tasks
   */
  personalDataRelatedLink: (page: Page): Locator =>
    page.getByRole("link", {
      name: /^Personal Data Related .*select to expand or collapse/,
    }),

  /**
   * Sidebar leaf under Personal Data Related: Activities. verified 2026-04-24
   * @tags sidebar, personal-data, activities, link, hr-tasks
   */
  activitiesLink: (page: Page): Locator =>
    page.getByRole("link", { name: "Activities", exact: true }),

  /**
   * Sidebar leaf under Personal Data Related: Emergency Contact. verified 2026-04-24
   * @tags sidebar, personal-data, emergency-contact, link, hr-tasks
   */
  emergencyContactLink: (page: Page): Locator =>
    page.getByRole("link", { name: "Emergency Contact", exact: true }),

  /**
   * Sidebar leaf under Personal Data Related: Identification Data. verified 2026-04-24
   * @tags sidebar, personal-data, identification, link, hr-tasks
   */
  identificationDataLink: (page: Page): Locator =>
    page.getByRole("link", { name: "Identification Data", exact: true }),

  /**
   * Sidebar leaf under Personal Data Related: Modify a Person. verified 2026-04-24
   * @tags sidebar, personal-data, modify, link, hr-tasks
   */
  modifyAPersonLink: (page: Page): Locator =>
    page.getByRole("link", { name: "Modify a Person", exact: true }),

  /**
   * Sidebar leaf under Personal Data Related: Person Checklist. verified 2026-04-24
   * @tags sidebar, personal-data, checklist, link, hr-tasks
   */
  personChecklistLink: (page: Page): Locator =>
    page.getByRole("link", { name: "Person Checklist", exact: true }),

  /**
   * Sidebar leaf under Personal Data Related: Person Profiles (oath-signature
   * entry point). verified 2026-04-24
   * @tags sidebar, personal-data, person-profiles, oath, link, hr-tasks
   */
  personProfilesLink: (page: Page): Locator =>
    page.getByRole("link", { name: "Person Profiles", exact: true }),

  /**
   * Sidebar leaf under Personal Data Related: Security Clearance. verified 2026-04-24
   * @tags sidebar, personal-data, security-clearance, link, hr-tasks
   */
  securityClearanceLink: (page: Page): Locator =>
    page.getByRole("link", { name: "Security Clearance", exact: true }),

  /**
   * Sidebar leaf under Personal Data Related: UC External System IDs.
   * verified 2026-04-24
   * @tags sidebar, personal-data, external-system-ids, link, hr-tasks
   */
  ucExternalSystemIdsLink: (page: Page): Locator =>
    page.getByRole("link", { name: "UC External System IDs", exact: true }),

  /**
   * Sidebar category toggle: Smart HR Templates. The legacy `getByText`
   * variant from before 2026-04-24 still matched this same node loosely;
   * the precise role+regex form here distinguishes the toggle from any
   * descendant "Smart HR Templates" text. verified 2026-04-24
   * @tags sidebar, smart-hr, templates, category, link, hr-tasks
   */
  smartHRTemplatesLink: (page: Page): Locator =>
    page.getByText("Smart HR Templates"),

  /**
   * Sidebar leaf under Smart HR Templates: Smart HR Transactions. verified 2026-03-16
   * @tags sidebar, smart-hr, transactions, link, hr-tasks
   */
  smartHRTransactionsLink: (page: Page): Locator =>
    page.getByText("Smart HR Transactions"),

  /**
   * Sidebar leaf under Smart HR Templates: SS Smart HR Transactions
   * (self-service variant). verified 2026-04-24
   * @tags sidebar, smart-hr, self-service, transactions, link, hr-tasks
   */
  ssSmartHRTransactionsLink: (page: Page): Locator =>
    page.getByRole("link", { name: "SS Smart HR Transactions", exact: true }),

  /**
   * Sidebar leaf under Smart HR Templates: Smart HR Transaction Status.
   * verified 2026-04-24
   * @tags sidebar, smart-hr, status, transactions, link, hr-tasks
   */
  smartHRTransactionStatusLink: (page: Page): Locator =>
    page.getByRole("link", { name: "Smart HR Transaction Status", exact: true }),
};

// ─── Person Organizational Summary (HR Tasks → sidebar leaf) ──────────────
//
// PERSON_ORG_SUMM.GBL is a Find-an-Existing-Value search form distinct from
// `personSearch.*` (which targets the Search/Match form configured for the
// PERSON_SEARCH parameter). This form's primary inputs are Empl ID, Last
// Name, and Name (first/middle); SSN and DOB are not exposed here. eid-lookup
// uses this page; future workflows that need name-keyed person lookup should
// reuse these selectors. Single-result redirects skip the grid (see
// LESSONS.md "Person Org Summary single-result redirect"). verified 2026-04-24

export const personOrgSummary = {
  /**
   * Empl ID textbox. Exact: true avoids matching label-shaped probes
   * elsewhere on the form. verified 2026-04-24
   * @tags empl, id, employee, textbox, person-org-summary
   */
  emplIdInput: (f: FrameLocator): Locator =>
    f.getByRole("textbox", { name: "Empl ID", exact: true }),

  /**
   * Last Name textbox. verified 2026-04-24
   * @tags last-name, name, textbox, person-org-summary
   */
  lastNameInput: (f: FrameLocator): Locator =>
    f.getByRole("textbox", { name: "Last Name" }),

  /**
   * Name (first/middle) textbox. Exact: true is required because "Last Name"
   * also contains "Name". verified 2026-04-24
   * @tags name, first-name, middle-name, textbox, person-org-summary
   */
  nameInput: (f: FrameLocator): Locator =>
    f.getByRole("textbox", { name: "Name", exact: true }),

  /**
   * Case Sensitive checkbox — toggles case-aware name matching. verified 2026-04-24
   * @tags case, sensitive, checkbox, person-org-summary
   */
  caseSensitiveCheckbox: (f: FrameLocator): Locator =>
    f.getByRole("checkbox", { name: "Case Sensitive" }),

  /**
   * Search submit button. The `#PTS_CFG_CL_WRK_PTS_SRCH_BTN` ID is the
   * stable PeopleSoft Find-an-Existing-Value search trigger and is shared
   * with the Search Person / Search/Match form. verified 2026-04-24
   * @tags search, submit, button, person-org-summary
   */
  searchButton: (f: FrameLocator): Locator =>
    f.locator("#PTS_CFG_CL_WRK_PTS_SRCH_BTN"),

  /**
   * Clear search criteria button. Used between iterations of name-strategy
   * fallbacks (Last + First → Last + Middle, etc.) so stale values don't
   * leak across attempts. verified 2026-04-24
   * @tags clear, button, person-org-summary
   */
  clearButton: (f: FrameLocator): Locator =>
    f.getByRole("button", { name: "Clear", exact: true }),
};

// ─── PayPath Actions (HR Tasks → PayPath/Additional Pay → PayPath Actions) ─
//
// `/c/UC_EXTENSIONS.UC_E102_STAFF_ACAD.GBL` — combined staff+academic entry.
// Find-an-Existing-Value search form drills into the actual PayPath edit
// page where Job Data fields (position, comp rate, etc.) are filled. The
// edit page reuses `jobData.*` selectors; this group covers the search
// form. work-study uses this navigation chain via the sidebar (see
// `src/workflows/work-study/enter.ts`). The post-search Save button has
// the unique ID `UC_E102_PP_WRK_SUBMIT_BTN` and is registered here for
// shared reuse. ACAD-only and STAFF-only variants live at
// `UC_E102_ACAD_ACTNS.GBL` / `UC_E102_STAF_ACTNS.GBL` and have the same
// search-form shape — selectors here apply to all three.
// verified 2026-04-24

export const payPathActions = {
  /**
   * Empl ID textbox. Most common search key. verified 2026-04-24
   * @tags empl, id, employee, textbox, paypath-actions
   */
  emplIdInput: (f: FrameLocator): Locator =>
    f.getByRole("textbox", { name: "Empl ID", exact: true }),

  /**
   * Empl Record textbox. Disambiguates between concurrent jobs for the
   * same employee. verified 2026-04-24
   * @tags empl, record, textbox, paypath-actions
   */
  emplRecordInput: (f: FrameLocator): Locator =>
    f.getByRole("textbox", { name: "Empl Record" }),

  /**
   * Name textbox. exact: true required because "Last Name" and other
   * cells contain "Name". verified 2026-04-24
   * @tags name, textbox, paypath-actions
   */
  nameInput: (f: FrameLocator): Locator =>
    f.getByRole("textbox", { name: "Name", exact: true }),

  /**
   * Business Unit textbox. exact: true avoids matching "Look up Business
   * Unit". verified 2026-04-24
   * @tags business-unit, textbox, paypath-actions
   */
  businessUnitInput: (f: FrameLocator): Locator =>
    f.getByRole("textbox", { name: "Business Unit", exact: true }),

  /**
   * Business Unit magnifying-glass lookup button. verified 2026-04-24
   * @tags business-unit, lookup, button, paypath-actions
   */
  businessUnitLookupButton: (f: FrameLocator): Locator =>
    f.getByRole("button", { name: "Look up Business Unit" }),

  /**
   * Position Number textbox. verified 2026-04-24
   * @tags position, number, textbox, paypath-actions
   */
  positionNumberInput: (f: FrameLocator): Locator =>
    f.getByRole("textbox", { name: "Position Number", exact: true }),

  /**
   * Position Number lookup button. verified 2026-04-24
   * @tags position, number, lookup, button, paypath-actions
   */
  positionNumberLookupButton: (f: FrameLocator): Locator =>
    f.getByRole("button", { name: "Look up Position Number" }),

  /**
   * Department textbox. verified 2026-04-24
   * @tags department, textbox, paypath-actions
   */
  departmentInput: (f: FrameLocator): Locator =>
    f.getByRole("textbox", { name: "Department", exact: true }),

  /**
   * Department lookup button. verified 2026-04-24
   * @tags department, lookup, button, paypath-actions
   */
  departmentLookupButton: (f: FrameLocator): Locator =>
    f.getByRole("button", { name: "Look up Department" }),

  /**
   * Job Code textbox. verified 2026-04-24
   * @tags job-code, textbox, paypath-actions
   */
  jobCodeInput: (f: FrameLocator): Locator =>
    f.getByRole("textbox", { name: "Job Code", exact: true }),

  /**
   * Job Code lookup button. verified 2026-04-24
   * @tags job-code, lookup, button, paypath-actions
   */
  jobCodeLookupButton: (f: FrameLocator): Locator =>
    f.getByRole("button", { name: "Look up Job Code" }),

  /**
   * Employee Classification textbox. verified 2026-04-24
   * @tags employee, classification, textbox, paypath-actions
   */
  employeeClassificationInput: (f: FrameLocator): Locator =>
    f.getByRole("textbox", { name: "Employee Classification", exact: true }),

  /**
   * Employee Classification lookup button. verified 2026-04-24
   * @tags employee, classification, lookup, button, paypath-actions
   */
  employeeClassificationLookupButton: (f: FrameLocator): Locator =>
    f.getByRole("button", { name: "Look up Employee Classification" }),

  /**
   * Employee Status combobox. Options: Active, Leave With Pay, Leave of
   * Absence, Short Work Break. verified 2026-04-24
   * @tags employee, status, combobox, paypath-actions
   */
  employeeStatusSelect: (f: FrameLocator): Locator =>
    f.getByRole("combobox", { name: "Employee Status" }),

  /**
   * Case Sensitive checkbox. verified 2026-04-24
   * @tags case, sensitive, checkbox, paypath-actions
   */
  caseSensitiveCheckbox: (f: FrameLocator): Locator =>
    f.getByRole("checkbox", { name: "Case Sensitive" }),

  /**
   * Search submit button. Shared `#PTS_CFG_CL_WRK_PTS_SRCH_BTN` ID with
   * other Find-an-Existing-Value forms. verified 2026-04-24
   * @tags search, submit, button, paypath-actions
   */
  searchButton: (f: FrameLocator): Locator =>
    f.locator("#PTS_CFG_CL_WRK_PTS_SRCH_BTN"),

  /**
   * Clear search criteria button. verified 2026-04-24
   * @tags clear, button, paypath-actions
   */
  clearButton: (f: FrameLocator): Locator =>
    f.getByRole("button", { name: "Clear", exact: true }),

  /**
   * Save and Submit button on the post-search PayPath edit page. The
   * `UC_E102_PP_WRK_SUBMIT_BTN` ID is unique to PayPath Actions (distinct
   * from Smart HR's `smartHR.saveAndSubmitButton`). Verified in
   * `src/workflows/work-study/enter.ts`.
   * @tags save, submit, button, paypath-actions, edit
   */
  saveAndSubmitButton: (f: FrameLocator): Locator =>
    f.locator("#UC_E102_PP_WRK_SUBMIT_BTN"),
};

// ─── SS Smart HR Transactions (self-service Smart HR) ─────────────────────
//
// `/c/UC_EXTENSIONS.UC_SS_TBH.GBL` — self-service variant of Smart HR
// Transactions, surfacing in-flight self-service hires/changes for review.
// Find-an-Existing-Value search form keyed on Transaction ID, Empl ID,
// Action, Approval Status, and Business Unit. Distinct from the standard
// Smart HR Transactions page (which is `smartHR.*`). verified 2026-04-24

export const ssSmartHRTransactions = {
  /**
   * Transaction ID textbox. verified 2026-04-24
   * @tags transaction, id, textbox, ss-smart-hr
   */
  transactionIdInput: (f: FrameLocator): Locator =>
    f.getByRole("textbox", { name: "Transaction ID" }),

  /**
   * Name textbox. verified 2026-04-24
   * @tags name, textbox, ss-smart-hr
   */
  nameInput: (f: FrameLocator): Locator =>
    f.getByRole("textbox", { name: "Name", exact: true }),

  /**
   * Empl ID textbox. verified 2026-04-24
   * @tags empl, id, employee, textbox, ss-smart-hr
   */
  emplIdInput: (f: FrameLocator): Locator =>
    f.getByRole("textbox", { name: "Empl ID", exact: true }),

  /**
   * Action textbox (PeopleSoft action code, e.g. HIR, REH). verified 2026-04-24
   * @tags action, code, textbox, ss-smart-hr
   */
  actionInput: (f: FrameLocator): Locator =>
    f.getByRole("textbox", { name: "Action", exact: true }),

  /**
   * Action lookup button. verified 2026-04-24
   * @tags action, lookup, button, ss-smart-hr
   */
  actionLookupButton: (f: FrameLocator): Locator =>
    f.getByRole("button", { name: "Look up Action" }),

  /**
   * Approval Status combobox. Options: Approved, Denied, Error, Manually
   * Processed, Pending, Pushed Back. verified 2026-04-24
   * @tags approval, status, combobox, ss-smart-hr
   */
  approvalStatusSelect: (f: FrameLocator): Locator =>
    f.getByRole("combobox", { name: "Approval Status" }),

  /**
   * Business Unit textbox. verified 2026-04-24
   * @tags business-unit, textbox, ss-smart-hr
   */
  businessUnitInput: (f: FrameLocator): Locator =>
    f.getByRole("textbox", { name: "Business Unit", exact: true }),

  /**
   * Business Unit lookup button. verified 2026-04-24
   * @tags business-unit, lookup, button, ss-smart-hr
   */
  businessUnitLookupButton: (f: FrameLocator): Locator =>
    f.getByRole("button", { name: "Look up Business Unit" }),

  /**
   * Case Sensitive checkbox. verified 2026-04-24
   * @tags case, sensitive, checkbox, ss-smart-hr
   */
  caseSensitiveCheckbox: (f: FrameLocator): Locator =>
    f.getByRole("checkbox", { name: "Case Sensitive" }),

  /**
   * Search submit button (`#PTS_CFG_CL_WRK_PTS_SRCH_BTN`). verified 2026-04-24
   * @tags search, submit, button, ss-smart-hr
   */
  searchButton: (f: FrameLocator): Locator =>
    f.locator("#PTS_CFG_CL_WRK_PTS_SRCH_BTN"),

  /**
   * Clear search criteria button. verified 2026-04-24
   * @tags clear, button, ss-smart-hr
   */
  clearButton: (f: FrameLocator): Locator =>
    f.getByRole("button", { name: "Clear", exact: true }),
};

// ─── Smart HR Transaction Status (filter + results dashboard) ─────────────
//
// `/c/ADMINISTER_WORKFORCE_(GBL).HR_TBH_STATUS.GBL` — distinct shape from
// the other HR Tasks pages: a filter form with a results grid below it,
// not a Find-an-Existing-Value drill-in form. Surfaces all in-flight
// Smart HR transactions for review (status: Pending, Processed, Cancelled,
// etc.). The Download button stays disabled until a Refresh runs and
// returns rows. Date inputs default to a 20-day window centered on today
// — caller should overwrite both before searching across longer ranges.
// verified 2026-04-24

export const smartHRTransactionStatus = {
  /**
   * HR Review Status combobox — top filter. Options: All, Cancelled,
   * My Transactions, Pending, Processed. verified 2026-04-24
   * @tags hr-review, status, combobox, transaction-status
   */
  hrReviewStatusSelect: (f: FrameLocator): Locator =>
    f.getByRole("combobox", { name: "HR Review Status" }),

  /**
   * Business Unit textbox filter. verified 2026-04-24
   * @tags business-unit, textbox, transaction-status
   */
  businessUnitInput: (f: FrameLocator): Locator =>
    f.getByRole("textbox", { name: "Business Unit", exact: true }),

  /**
   * Business Unit lookup button. verified 2026-04-24
   * @tags business-unit, lookup, button, transaction-status
   */
  businessUnitLookupButton: (f: FrameLocator): Locator =>
    f.getByRole("button", { name: "Look up Business Unit" }),

  /**
   * Transaction Type combobox. Options: All, Change Job Data, Change Job
   * and Profile Data, Change Personal Data, Change Personal and Job Data,
   * Change Personal and Profile Data, Change Personal/Job and Profile Data,
   * Change Profile Data, Hire/Rehire, Hire/Rehire and Profile Data,
   * RecruitingHire/Rehire/Transfer. verified 2026-04-24
   * @tags transaction-type, combobox, transaction-status
   */
  transactionTypeSelect: (f: FrameLocator): Locator =>
    f.getByRole("combobox", { name: "Transaction Type" }),

  /**
   * Empl ID textbox filter. verified 2026-04-24
   * @tags empl, id, employee, textbox, transaction-status
   */
  emplIdInput: (f: FrameLocator): Locator =>
    f.getByRole("textbox", { name: "Empl ID", exact: true }),

  /**
   * Transaction Status combobox. Options: Action Required, All, Cancel,
   * Completed, Denied, Error, Hired/Added, Requested. verified 2026-04-24
   * @tags transaction-status, combobox, status, transaction-status
   */
  transactionStatusSelect: (f: FrameLocator): Locator =>
    f.getByRole("combobox", { name: "Transaction Status" }),

  /**
   * First Name textbox filter. verified 2026-04-24
   * @tags first-name, name, textbox, transaction-status
   */
  firstNameInput: (f: FrameLocator): Locator =>
    f.getByRole("textbox", { name: "First Name" }),

  /**
   * Start Date From textbox (MM/DD/YYYY). Defaults to ~10 days before
   * today. verified 2026-04-24
   * @tags start-date, from, date, textbox, transaction-status
   */
  startDateFromInput: (f: FrameLocator): Locator =>
    f.getByRole("textbox", { name: "Start Date From" }),

  /**
   * Calendar picker for Start Date From. verified 2026-04-24
   * @tags start-date, from, calendar, button, transaction-status
   */
  startDateFromCalendarButton: (f: FrameLocator): Locator =>
    f.getByRole("button", { name: "Calendar Start Date From" }),

  /**
   * "To" date textbox (MM/DD/YYYY) — paired with Start Date From.
   * Defaults to ~10 days after today. verified 2026-04-24
   * @tags to-date, end-date, date, textbox, transaction-status
   */
  toDateInput: (f: FrameLocator): Locator =>
    f.getByRole("textbox", { name: "To", exact: true }),

  /**
   * Calendar picker for the To date. verified 2026-04-24
   * @tags to-date, end-date, calendar, button, transaction-status
   */
  toDateCalendarButton: (f: FrameLocator): Locator =>
    f.getByRole("button", { name: "Calendar To" }),

  /**
   * Last Name textbox filter. verified 2026-04-24
   * @tags last-name, name, textbox, transaction-status
   */
  lastNameInput: (f: FrameLocator): Locator =>
    f.getByRole("textbox", { name: "Last Name" }),

  /**
   * Download button — stays disabled until a Refresh has populated rows.
   * verified 2026-04-24
   * @tags download, button, transaction-status
   */
  downloadButton: (f: FrameLocator): Locator =>
    f.getByRole("button", { name: "Download", exact: true }),

  /**
   * Refresh button — runs the filter and populates the results grid.
   * verified 2026-04-24
   * @tags refresh, button, transaction-status
   */
  refreshButton: (f: FrameLocator): Locator =>
    f.getByRole("button", { name: "Refresh", exact: true }),

  /**
   * Clear button — resets all filter fields to defaults. verified 2026-04-24
   * @tags clear, button, transaction-status
   */
  clearButton: (f: FrameLocator): Locator =>
    f.getByRole("button", { name: "Clear", exact: true }),

  /**
   * Toolbar button: "Download Transaction Status Table to Excel" — exports
   * the results grid as XLSX. verified 2026-04-24
   * @tags download, excel, export, button, transaction-status
   */
  downloadToExcelButton: (f: FrameLocator): Locator =>
    f.getByRole("button", { name: "Download Transaction Status Table to Excel" }),

  /**
   * "Smart HR Transactions" return link at the bottom of the form.
   * Submits a JS action that navigates back to the Smart HR Transactions
   * landing. verified 2026-04-24
   * @tags return, smart-hr, link, transaction-status
   */
  returnToSmartHRLink: (f: FrameLocator): Locator =>
    f.getByRole("link", { name: "Smart HR Transactions" }),
};

// ─── Emergency Contact (standalone, deep-link URL, no iframe) ─────────────

export const emergencyContact = {
  /**
   * Empl ID textbox at page top level. verified 2026-04-14
   * @tags empl, id, employee, textbox, emergency-contact
   */
  emplIdInput: (page: Page): Locator =>
    page.getByRole("textbox", { name: "Empl ID" }).first(),

  /**
   * Search button (exact: true). verified 2026-04-14
   * @tags search, button, emergency-contact
   */
  searchButton: (page: Page): Locator =>
    page.getByRole("button", { name: "Search", exact: true }).first(),

  /**
   * "No matching values were found." message. verified 2026-04-14
   * @tags no-match, message, emergency-contact, search
   */
  noMatchMessage: (page: Page): Locator =>
    page.getByText("No matching values were found."),

  /**
   * Drill-in link in multi-result grid. verified 2026-04-14
   * @tags drill-in, link, results, emergency-contact
   */
  drillInLink: (page: Page): Locator =>
    page.getByRole("link", { name: /drill in/i }),

  /**
   * Every Contact Name textbox on the editor (for duplicate checking).
   * verified 2026-04-14
   * @tags contact, name, textbox, emergency-contact, duplicate
   */
  contactNameInputs: (page: Page): Locator =>
    page.getByRole("textbox", { name: "Contact Name" }),

  /**
   * Every Primary Contact checkbox on the editor — one per row, in
   * document order, parallel to `contactNameInputs`. Used by
   * `demoteExistingContact` to uncheck the primary on a fuzzy-matched
   * historical contact (e.g. "Tomako Langley" demoted in favor of
   * the correctly-spelled "Tomoko Longley"). verified 2026-04-28
   * @tags primary, contact, checkbox, emergency-contact, demote
   */
  primaryContactCheckboxes: (page: Page): Locator =>
    page.getByRole("checkbox", { name: "Primary Contact" }),

  /**
   * Save button at the bottom of the editor. verified 2026-04-14
   * @tags save, button, emergency-contact
   */
  saveButton: (page: Page): Locator =>
    page.getByRole("button", { name: "Save", exact: true }).first(),
};

// ─── Person Profiles → Oath Signature (standalone deep-link URL) ──────────
//
// Person Profile uses a DIFFERENT iframe from Smart HR:
//   - Smart HR / PayPath → `#main_target_win0`   (use `getContentFrame`)
//   - Person Profiles     → `#ptifrmtgtframe`     (use `getPersonProfileFrame`)
//
// The component URL path is `c/SETUP_PROFILE_MANAGEMENT.JPM_PERSON_PROFILE.GBL`.
// See `src/workflows/oath-signature/enter.ts` for the full flow.
// verified 2026-04-22 via playwright-cli on EID 10873075

export const oathSignature = {
  /**
   * Person Profiles content iframe FrameLocator. Distinct from Smart HR's
   * `#main_target_win0` — this component mounts inside `#ptifrmtgtframe`
   * (name="TargetContent"). verified 2026-04-22
   * @tags iframe, frame, person-profile, oath
   */
  getPersonProfileFrame: (page: Page): FrameLocator =>
    page.frameLocator("#ptifrmtgtframe"),

  /**
   * Empl ID textbox on the Find-an-Existing-Value search form. verified 2026-04-22
   * @tags empl, id, employee, textbox, person-profile, search
   */
  emplIdInput: (f: FrameLocator): Locator =>
    f.getByRole("textbox", { name: "Empl ID" }),

  /**
   * Search button (exact: true disambiguates from "Save Search"). verified 2026-04-22
   * @tags search, button, person-profile
   */
  searchButton: (f: FrameLocator): Locator =>
    f.getByRole("button", { name: "Search", exact: true }),

  /**
   * Clear button on the search form — clears Empl ID between iterations. verified 2026-04-22
   * @tags clear, button, person-profile, search
   */
  clearSearchButton: (f: FrameLocator): Locator =>
    f.getByRole("button", { name: "Clear", exact: true }),

  /**
   * "Add New Oath Signature Date" link on the loaded Person Profile. The
   * primary anchor is the PeopleSoft action id; accessible-name fallback
   * covers rename-proof backups. Two links share the same name (icon +
   * text) — `.first()` picks the icon/primary anchor.
   * verified 2026-04-22 (id: DERIVED_JPM_JP_JPM_JP_ADD_CAT_ITM$41$$0)
   * @tags add, new, oath, signature, link, person-profile
   */
  addNewOathLink: (f: FrameLocator): Locator =>
    f
      .locator('[id="DERIVED_JPM_JP_JPM_JP_ADD_CAT_ITM$41$$0"]')
      .or(f.getByRole("link", { name: "Add New Oath Signature Date" }).first()),

  /**
   * "There are currently no Oath Signature Date for this profile..." sentinel.
   * When visible on the loaded profile, the employee has no existing oath —
   * safe to add. When absent, an oath already exists (idempotency skip).
   * verified 2026-04-22
   * @tags no, existing, oath, sentinel, text, person-profile
   */
  noOathSentinel: (f: FrameLocator): Locator =>
    f.getByText("There are currently no Oath Signature Date", { exact: false }),

  /**
   * Oath Signature Date textbox inside the "Add New Oath Signature Date"
   * sub-form. Defaults to today's date on open. verified 2026-04-22
   * @tags oath, signature, date, textbox, person-profile
   */
  oathDateInput: (f: FrameLocator): Locator =>
    f.getByRole("textbox", { name: "Oath Signature Date" }),

  /**
   * OK button on the oath-detail sub-form — applies the row and returns to
   * the profile. verified 2026-04-22
   * @tags ok, button, oath, sub-form, person-profile
   */
  oathOkButton: (f: FrameLocator): Locator =>
    f.getByRole("button", { name: "OK", exact: true }),

  /**
   * Cancel button on the oath-detail sub-form — used by test/dry paths. verified 2026-04-22
   * @tags cancel, button, oath, sub-form, person-profile
   */
  oathCancelButton: (f: FrameLocator): Locator =>
    f.getByRole("button", { name: "Cancel", exact: true }),

  /**
   * Save button at the bottom of the Person Profile form — commits the
   * staged oath row to the database. verified 2026-04-22
   * @tags save, button, person-profile
   */
  saveButton: (f: FrameLocator): Locator =>
    f.getByRole("button", { name: "Save", exact: true }),

  /**
   * Return to Search button shown after save — clears the profile and
   * returns to the empty search form for the next EID. verified 2026-04-22
   * @tags return, search, button, person-profile
   */
  returnToSearchButton: (f: FrameLocator): Locator =>
    f.getByRole("button", { name: "Return to Search", exact: true }),

  /**
   * Employee name display on the loaded Person Profile — visible near the
   * Empl ID header. Extracted for tracker rows + dashboard. verified 2026-04-22
   * @tags employee, name, display, person-profile
   */
  employeeNameDisplay: (f: FrameLocator): Locator =>
    f.locator('[id*="UC_JPM_PRS_I_PERSON_NAME"], [id*="PSXLATITEM_XLATLONGNAME"]').first(),
};

// ─── Barrel: grouped namespace export ──────────────────────────────────────

/**
 * Grouped namespace for ergonomic call sites:
 *   ucpathSelectors.jobData.positionNumberInput(frame).fill(positionNum)
 *
 * Flat per-group imports (`import { jobData } from "./selectors.js"`) are also
 * supported for files that only touch one group.
 */
export const ucpathSelectors = {
  smartHR,
  personalData,
  comments,
  jobData,
  personSearch,
  jobSummary,
  hrTasks,
  personOrgSummary,
  payPathActions,
  ssSmartHRTransactions,
  smartHRTransactionStatus,
  emergencyContact,
  oathSignature,
  getContentFrame,
};
