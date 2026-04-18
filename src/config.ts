// ─── Global configuration ───
// Shared URLs and constants used across all workflows.

import { homedir } from "os";
import { join } from "path";

const HOME = homedir();

// ─── Paths (user-agnostic via homedir()) ─────────────────────

export const PATHS = {
  reportsDir: join(HOME, "Downloads", "reports"),
  downloadsDir: join(HOME, "Downloads"),
  ukgSessionBase: join(HOME, "ukg_session"),
  ukgSessionSep: join(HOME, "ukg_session_sep"),
  screenshotDir: ".auth",
  trackerDir: ".tracker",
} as const;

// ─── Timeouts (ms) ──────────────────────────────────────────

export const TIMEOUTS = {
  fast: 5_000,
  normal: 10_000,
  navigation: 15_000,
  longNavigation: 30_000,
  ukgNavigation: 60_000,
  duoApproval: 180,      // seconds (used by duo-poll.ts)
  duoApprovalCrm: 60,    // seconds
  retryDelay: 5_000,
} as const;

// ─── Screen layout ──────────────────────────────────────────

export const SCREEN = {
  width: 2560,
  height: 1440,
} as const;

// ─── Annual dates (UPDATE EACH FISCAL YEAR) ─────────────────
// Each value is overrideable via env var — see .env.example:
//   ANNUAL_DATES_END         → jobEndDate            (e.g. 06/30/2027)
//   KRONOS_DEFAULT_END_DATE  → kronosDefaultEndDate  (e.g. 2/1/2027)
//   KRONOS_DEFAULT_START_DATE → kronosDefaultStartDate (e.g. 1/1/2017)
// Env values override at module-load time; unset → fall back to hardcoded default.

export const ANNUAL_DATES = {
  jobEndDate: process.env.ANNUAL_DATES_END ?? "06/30/2026",
  kronosDefaultEndDate: process.env.KRONOS_DEFAULT_END_DATE ?? "2/1/2026",
  kronosDefaultStartDate: process.env.KRONOS_DEFAULT_START_DATE ?? "1/1/2017",
} as const;

// ─── URLs not yet centralized ───────────────────────────────

export const KUALI_SPACE_URL = "https://ucsd.kualibuild.com/build/space/5e47518b90adda9474c14adb";
export const NEW_KRONOS_URL = "https://ucsd-sso.prd.mykronos.com/wfd/home";
export const CRM_ENTRY_URL = "https://crm.ucsd.edu/hr";

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

// --- UKG (Kronos) ---

/** UKG workforce management dashboard URL. */
export const UKG_URL =
  "https://ucsd.kronos.net/wfcstatic/applications/navigator/html5/dist/container/index.html?version=8.1.18.502#/";
