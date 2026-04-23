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
};

// ─── HR Tasks navigation (top-level page before iframe interactions) ──────

export const hrTasks = {
  /**
   * HR Tasks tile / link. verified 2026-03-16
   * @tags hr-tasks, tile, link, navigation
   */
  tile: (page: Page): Locator =>
    page.getByRole("link", { name: /HR Tasks/i }).or(page.getByText("HR Tasks")),

  /**
   * Sidebar: Smart HR Templates link. verified 2026-03-16
   * @tags sidebar, smart-hr, templates, link, hr-tasks
   */
  smartHRTemplatesLink: (page: Page): Locator =>
    page.getByText("Smart HR Templates"),

  /**
   * Sidebar: Smart HR Transactions link. verified 2026-03-16
   * @tags sidebar, smart-hr, transactions, link, hr-tasks
   */
  smartHRTransactionsLink: (page: Page): Locator =>
    page.getByText("Smart HR Transactions"),
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
  emergencyContact,
  oathSignature,
  getContentFrame,
};
