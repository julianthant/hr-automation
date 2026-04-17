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
 */
export function getContentFrame(page: Page): FrameLocator {
  return page.frameLocator("#main_target_win0");
}

// ─── Smart HR Transactions (sidebar + template setup + controls) ──────────

export const smartHR = {
  /** Sidebar "Smart HR Templates" expand/collapse link. verified 2026-03-16 */
  sidebarTemplatesLink: (page: Page): Locator =>
    page.getByRole("link", { name: /Smart HR Templates/i }).first(),

  /** Sidebar child link "Smart HR Transactions" (exact match). verified 2026-03-16 */
  sidebarTransactionsLink: (page: Page): Locator =>
    page.getByRole("link", { name: "Smart HR Transactions", exact: true }),

  /** Navigation Area button that collapses the sidebar so iframe buttons aren't blocked. verified 2026-03-16 */
  sidebarNavigationToggle: (page: Page): Locator =>
    page.getByRole("button", { name: "Navigation Area" }),

  /** Template selection textbox in the Smart HR Transactions form. verified 2026-03-16 */
  templateInput: (f: FrameLocator): Locator =>
    f.getByRole("textbox", { name: "Select Template" }),

  /** Effective Date textbox. verified 2026-03-16 */
  effectiveDateInput: (f: FrameLocator): Locator =>
    f.getByRole("textbox", { name: "Effective Date" }),

  /** Create Transaction button. verified 2026-03-16 */
  createTransactionButton: (f: FrameLocator): Locator =>
    f.getByRole("button", { name: "Create Transaction" }),

  /** Reason Code dropdown. verified 2026-03-16 */
  reasonCodeSelect: (f: FrameLocator): Locator => f.getByLabel("Reason Code"),

  /** Continue button after reason code selection. verified 2026-03-16 (id: HR_TBH_WRK_TBH_NEXT) */
  continueButton: (f: FrameLocator): Locator =>
    f.getByRole("button", { name: "Continue" }),

  /** Tabs within the transaction form. verified 2026-03-16 */
  tab: {
    personalData: (f: FrameLocator): Locator =>
      f.getByRole("tab", { name: "Personal Data" }),
    jobData: (f: FrameLocator): Locator =>
      f.getByRole("tab", { name: "Job Data" }),
    earnsDist: (f: FrameLocator): Locator =>
      f.getByRole("tab", { name: "Earns Dist" }),
    employeeExperience: (f: FrameLocator): Locator =>
      f.getByRole("tab", { name: "Employee Experience" }),
  },

  /** Save and Submit button (the first match — bottom of every tab). verified 2026-03-16 */
  saveAndSubmitButton: (f: FrameLocator): Locator =>
    f.getByRole("button", { name: "Save and Submit" }).first(),

  /** OK button on the confirmation dialog after Save & Submit. verified 2026-04-01 */
  confirmationOkButton: (f: FrameLocator): Locator =>
    f.getByRole("button", { name: "OK" }),

  /** Error/alert region inside the transaction iframe. verified 2026-03-16 */
  errorBanner: (f: FrameLocator): Locator =>
    f.locator(".PSERROR, #ALERTMSG, .ps_alert-error"),
};

// ─── Personal Data tab (inside transaction form) ───────────────────────────

export const personalData = {
  legalFirstName: (f: FrameLocator): Locator =>
    f.getByRole("textbox", { name: "Legal First Name" }),
  legalLastName: (f: FrameLocator): Locator =>
    f.getByRole("textbox", { name: "Legal Last Name" }),
  legalMiddleName: (f: FrameLocator): Locator =>
    f.getByRole("textbox", { name: "Legal Middle Name" }),

  /** Preferred/Lived name fields — `exact: true` disambiguates from legal variants. verified 2026-04-16 */
  preferredFirstName: (f: FrameLocator): Locator =>
    f.getByRole("textbox", { name: "First Name", exact: true }),
  preferredLastName: (f: FrameLocator): Locator =>
    f.getByRole("textbox", { name: "Last Name", exact: true }),
  preferredMiddleName: (f: FrameLocator): Locator =>
    f.getByRole("textbox", { name: "Middle Name", exact: true }),

  dateOfBirth: (f: FrameLocator): Locator =>
    f.getByRole("textbox", { name: "Date of Birth" }),

  /** SSN / National ID textbox. exact: true avoids matching "National ID Type" dropdown. verified 2026-03-16 */
  nationalId: (f: FrameLocator): Locator =>
    f.getByRole("textbox", { name: "National ID", exact: true }),

  addressLine1: (f: FrameLocator): Locator =>
    f.getByRole("textbox", { name: "Address Line 1" }),
  city: (f: FrameLocator): Locator => f.getByRole("textbox", { name: "City" }),
  state: (f: FrameLocator): Locator =>
    f.getByRole("textbox", { name: "State" }),
  postalCode: (f: FrameLocator): Locator =>
    f.getByRole("textbox", { name: "Postal Code" }),

  /**
   * Phone Type dropdown for row index 6 (Mobile - Personal slot).
   * verified 2026-03-16 (id: HR_TBH_G_SCR_WK_TBH_G_LG_DD1$6)
   */
  phoneTypeSelect: (f: FrameLocator): Locator =>
    f.locator('[id="HR_TBH_G_SCR_WK_TBH_G_LG_DD1$6"]'),

  /**
   * Phone number textbox for row index 6.
   * verified 2026-03-16 (id: HR_TBH_G_SCR_WK_TBH_G_SH_EDIT2$6)
   */
  phoneNumberInput: (f: FrameLocator): Locator =>
    f.locator('[id="HR_TBH_G_SCR_WK_TBH_G_SH_EDIT2$6"]'),

  /**
   * Preferred-phone checkbox for row index 6.
   * verified 2026-03-16 (id: HR_TBH_G_SCR_WK_TBH_G_CHK3$6)
   */
  phonePreferredCheckbox: (f: FrameLocator): Locator =>
    f.locator('[id="HR_TBH_G_SCR_WK_TBH_G_CHK3$6"]'),

  /**
   * Email Type dropdown for row index 7 (Home slot).
   * verified 2026-03-16 (id: HR_TBH_G_SCR_WK_TBH_G_LG_DD1$7)
   */
  emailTypeSelect: (f: FrameLocator): Locator =>
    f.locator('[id="HR_TBH_G_SCR_WK_TBH_G_LG_DD1$7"]'),

  /**
   * Email address textbox for row index 7.
   * verified 2026-03-16 (id: HR_TBH_G_SCR_WK_TBH_G_LG_EDIT2$7)
   */
  emailAddressInput: (f: FrameLocator): Locator =>
    f.locator('[id="HR_TBH_G_SCR_WK_TBH_G_LG_EDIT2$7"]'),

  /** Tracker profile ID textbox (I-9 linkage). verified 2026-03-16 */
  trackerProfileIdInput: (f: FrameLocator): Locator =>
    f.getByRole("textbox", { name: "Tracker Profile ID" }),
};

// ─── Comments section (inside transaction form) ────────────────────────────

export const comments = {
  /** Comments textarea — exact ID preserved from original. verified 2026-03-16 */
  commentsTextarea: (f: FrameLocator): Locator =>
    f.locator("#HR_TBH_WRK_DESCRLONG_NOTES"),

  /** Initiator Comments textarea — exact ID preserved from original. verified 2026-03-16 */
  initiatorCommentsTextarea: (f: FrameLocator): Locator =>
    f.locator("#UC_SS_TRANSACT_COMMENTS"),
};

// ─── Job Data tab (inside transaction form) ───────────────────────────────

export const jobData = {
  /** Position Number textbox. exact: true avoids "Reports To Position Number". verified 2026-03-16 */
  positionNumberInput: (f: FrameLocator): Locator =>
    f.getByRole("textbox", { name: "Position Number", exact: true }),

  /** Employee Classification textbox. verified 2026-03-16 */
  employeeClassificationInput: (f: FrameLocator): Locator =>
    f.getByRole("textbox", { name: "Employee Classification" }),

  /**
   * Comp Rate Code input. Primary: accessible name (resilient to grid-index
   * shifts). Fallbacks: 4 known grid-ID variants covering pre- and
   * post-position-number-fill states. verified 2026-04-16
   *
   * PeopleSoft grid input IDs mutate from $11 → $0 after the position number
   * fill triggers a page refresh. Fallback chain captures both.
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
   */
  compensationRateInput: (f: FrameLocator): Locator =>
    f
      .getByRole("textbox", { name: "Compensation Rate" })
      .or(f.locator('input[id="HR_TBH_G_SCR_WK_TBH_G_SH_EDIT2$0"]'))
      .or(f.locator('input[id="HR_TBH_G_SCR_WK_TBH_G_SH_NUM2$11"]'))
      .or(f.locator('input[id="HR_TBH_G_SCR_WK_TBH_G_SH_NUM2$0"]'))
      .or(f.locator('input[id="HR_TBH_G_SCR_WK_TBH_G_SH_EDIT2$11"]')),

  /** Compensation Frequency textbox (accessible name — resilient). verified 2026-04-16 */
  compensationFrequencyInput: (f: FrameLocator): Locator =>
    f.getByRole("textbox", { name: "Compensation Frequency" }),

  /** Expected Job End Date textbox. verified 2026-03-16 */
  expectedJobEndDateInput: (f: FrameLocator): Locator =>
    f.getByRole("textbox", { name: "Expected Job End Date" }),
};

// ─── Person Search (pre-transaction duplicate check) ───────────────────────

export const personSearch = {
  /** Search Type dropdown (P = Person). verified 2026-03-16 */
  searchTypeSelect: (f: FrameLocator): Locator =>
    f.locator("#HCR_SM_PARM_VW_SM_TYPE"),

  /** Parameter code input ("PERSON_SEARCH"). verified 2026-03-16 */
  parameterCodeInput: (f: FrameLocator): Locator =>
    f.locator("#HCR_SM_PARM_VW_SM_PARM_CD"),

  /** Search button on page 1 (loads the search form). verified 2026-03-16 */
  loadFormButton: (f: FrameLocator): Locator =>
    f.locator("#PTS_CFG_CL_WRK_PTS_SRCH_BTN"),

  /** Result code input ("PERSON_RESULTS"). verified 2026-04-01 */
  resultCodeInput: (f: FrameLocator): Locator =>
    f.locator('[id="DERIVED_HCR_SM_SM_RSLT_CD"]'),

  /** SSN input (CHAR_INPUT$0). verified 2026-04-01 */
  ssnInput: (f: FrameLocator): Locator =>
    f.locator('[id="DERIVED_HCR_SM_SM_CHAR_INPUT$0"]'),

  /** First name input (CHAR_INPUT$1). verified 2026-04-01 */
  firstNameInput: (f: FrameLocator): Locator =>
    f.locator('[id="DERIVED_HCR_SM_SM_CHAR_INPUT$1"]'),

  /** Last name input (CHAR_INPUT$2). verified 2026-04-01 */
  lastNameInput: (f: FrameLocator): Locator =>
    f.locator('[id="DERIVED_HCR_SM_SM_CHAR_INPUT$2"]'),

  /** DOB input (DATE_INPUT$3). verified 2026-04-01 */
  dobInput: (f: FrameLocator): Locator =>
    f.locator('[id="DERIVED_HCR_SM_SM_DATE_INPUT$3"]'),

  /** National Id magnifying-glass lookup button (CHAR_INPUT$prompt$0). verified 2026-04-01 */
  ssnLookupButton: (f: FrameLocator): Locator =>
    f.locator('[id="DERIVED_HCR_SM_SM_CHAR_INPUT$prompt$0"]'),

  /** Search submit button. verified 2026-04-01 */
  searchSubmitButton: (f: FrameLocator): Locator =>
    f.locator("#DERIVED_HCR_SM_SM_SEARCH_BTN"),

  /** Results grid — rows containing a 5+ digit employee ID. verified 2026-04-01 */
  resultRows: (f: FrameLocator): Locator =>
    f
      .locator('[id*="SEARCH_RESULT"] tr, .PSLEVEL1GRID tr')
      .filter({ hasText: /\d{5,}/ }),
};

// ─── Job Summary page (sidebar-less direct URL + iframe cases) ─────────────

export const jobSummary = {
  /** Campus discovery page — UCSD link. verified 2026-04-01 */
  campusDiscoveryUcsdLink: (page: Page): Locator =>
    page.getByRole("link", { name: "University of California, San Diego" }),

  /**
   * Empl ID textbox. `root` is either `page.locator("body")` (direct URL) or
   * `page.frameLocator("#main_target_win0").locator("body")` (iframe case).
   * verified 2026-04-01
   */
  emplIdInput: (root: Locator): Locator =>
    root.getByRole("textbox", { name: "Empl ID" }),

  /** Search button (exact: true). verified 2026-04-01 */
  searchButton: (root: Locator): Locator =>
    root.getByRole("button", { name: "Search", exact: true }),

  /** Work Location tab. verified 2026-04-01 */
  workLocationTab: (root: Locator): Locator =>
    root.getByRole("tab", { name: "Work Location" }),

  /** Job Information tab. verified 2026-04-01 */
  jobInformationTab: (root: Locator): Locator =>
    root.getByRole("tab", { name: "Job Information" }),

  /** Iframe presence probe — when count > 0 we're in iframe mode. verified 2026-04-01 */
  mainTargetIframeProbe: (page: Page): Locator =>
    page.locator("#main_target_win0"),
};

// ─── HR Tasks navigation (top-level page before iframe interactions) ──────

export const hrTasks = {
  /** HR Tasks tile / link. verified 2026-03-16 */
  tile: (page: Page): Locator =>
    page.getByRole("link", { name: /HR Tasks/i }).or(page.getByText("HR Tasks")),

  /** Sidebar: Smart HR Templates link. verified 2026-03-16 */
  smartHRTemplatesLink: (page: Page): Locator =>
    page.getByText("Smart HR Templates"),

  /** Sidebar: Smart HR Transactions link. verified 2026-03-16 */
  smartHRTransactionsLink: (page: Page): Locator =>
    page.getByText("Smart HR Transactions"),
};

// ─── Emergency Contact (standalone, deep-link URL, no iframe) ─────────────

export const emergencyContact = {
  /** Empl ID textbox at page top level. verified 2026-04-14 */
  emplIdInput: (page: Page): Locator =>
    page.getByRole("textbox", { name: "Empl ID" }).first(),

  /** Search button (exact: true). verified 2026-04-14 */
  searchButton: (page: Page): Locator =>
    page.getByRole("button", { name: "Search", exact: true }).first(),

  /** "No matching values were found." message. verified 2026-04-14 */
  noMatchMessage: (page: Page): Locator =>
    page.getByText("No matching values were found."),

  /** Drill-in link in multi-result grid. verified 2026-04-14 */
  drillInLink: (page: Page): Locator =>
    page.getByRole("link", { name: /drill in/i }),

  /**
   * Every Contact Name textbox on the editor (for duplicate checking).
   * verified 2026-04-14
   */
  contactNameInputs: (page: Page): Locator =>
    page.getByRole("textbox", { name: "Contact Name" }),
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
  getContentFrame,
};
