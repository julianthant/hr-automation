// ─── Global configuration ───
// Shared URLs and constants used across all workflows.

// --- CRM ---

/** ACT CRM onboarding search page (accepts ?q= email param). */
export const CRM_SEARCH_URL = "https://act-crm.my.site.com/hr/ONB_SearchOnboardings";

/** ACT CRM section URL mappings — record ID appended as ?id= param. */
export const CRM_SECTION_URLS: Record<string, string> = {
  "UCPath Entry Sheet": "https://act-crm.my.site.com/hr/ONB_PPSEntrySheet",
};

// --- UCPath ---

/** UCPath Smart HR Tasks page — must use ucphrprdpub subdomain (not ucpath.) to avoid re-triggering SSO. */
export const UCPATH_SMART_HR_URL =
  "https://ucphrprdpub.universityofcalifornia.edu/psc/ucphrprd/EMPLOYEE/HRMS/c/NUI_FRAMEWORK.PT_AGSTARTPAGE_NUI.GBL?CONTEXTIDPARAMS=TEMPLATE_ID%3aPTPPNAVCOL&scname=ADMN_UC_ADMIN_LOC_HIRE_NAVCOLL&PanelCollapsible=Y&PTPPB_GROUPLET_ID=UC_HIRE_TASKS_TILE_FL&CRefName=UC_HIRE_TASKS_TILE_FL&AJAXTRANSFER=Y";

// --- I9 ---

/** I9 Complete login URL. */
export const I9_URL = "https://stse.i9complete.com";

// --- Tracker ---

/** Default path for the onboarding tracker spreadsheet. */
export const TRACKER_PATH = "./src/workflows/onboarding/onboarding-tracker.xlsx";
