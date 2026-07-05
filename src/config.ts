// ─── Global configuration ───
// Shared URLs and constants used across all workflows.

import { homedir } from "os";
import { join } from "path";

import { screenshotsDir } from "./tracker/paths.js";
import {
  applyOperatorSettingsToEnv,
  loadMergedOperatorSettings,
} from "./tracker/settings/store.js";
import { EnvValidationError } from "./utils/env.js";

// Operator settings (`config/settings.json`) layer in UNDER explicit env vars
// and OVER the hardcoded defaults below: env > settings.json > default. An empty
// / missing file is a no-op (every settings default mirrors a literal here).
// `applyOperatorSettingsToEnv` populates the cross-module env-backed knobs (OCR,
// feature flags, nav retries, separations window) BEFORE anything reads them;
// the config.ts-owned constants below read the merged settings directly.
applyOperatorSettingsToEnv();
const SETTINGS = loadMergedOperatorSettings();

const HOME = homedir();
// Tracker root. `HRAUTO_TRACKER_DIR` is set by the daemon spawner
// (`src/core/daemon/registry.ts`) on the spawned subprocess's env so a daemon
// running at an isolated tracker root has `PATHS.screenshotDir`/`PATHS.trackerDir`
// follow that root. Unset (the normal case) → `.tracker`. Backward-compatible.
const TRACKER_DIR = process.env.HRAUTO_TRACKER_DIR ?? ".tracker";

// ─── Paths (user-agnostic via homedir()) ─────────────────────
// `.tracker/` subdir layout is owned by `src/tracker/paths.ts` — derive
// subdir paths from its helpers, never re-spell them as literals here.

export const PATHS = {
  // An operator-set path wins; an empty setting falls back to the homedir default.
  reportsDir: SETTINGS.paths.reportsDir || join(HOME, "Downloads", "reports"),
  downloadsDir: join(HOME, "Downloads"),
  // CRM onboarding-document output lives under ~/Documents/onboarding (moved
  // off ~/Downloads on 2026-06-18). crm-doc-download zips each run's per-person
  // folder(s) into this dir; onboarding's in-process iDocs download also lands
  // its per-person folders here via buildCrmDocumentDownloadPath.
  onboardingDocsDir: SETTINGS.paths.onboardingDocsDir || join(HOME, "Documents", "onboarding"),
  ukgSessionBase: join(HOME, "ukg_session"),
  ukgSessionSep: join(HOME, "ukg_session_sep"),
  screenshotDir: screenshotsDir(TRACKER_DIR),
  trackerDir: TRACKER_DIR,
} as const;

// ─── Timeouts (ms) ──────────────────────────────────────────

export const TIMEOUTS = {
  fast: 5_000,
  normal: 10_000,
  navigation: SETTINGS.timeouts.navigationMs,
  longNavigation: SETTINGS.timeouts.longNavigationMs,
  ukgNavigation: SETTINGS.timeouts.ukgNavigationMs,
  duoApproval: SETTINGS.timeouts.duoApprovalSeconds,       // seconds (used by duo-poll.ts)
  duoApprovalCrm: SETTINGS.timeouts.duoApprovalCrmSeconds, // seconds
  retryDelay: SETTINGS.timeouts.retryDelayMs,
} as const;

// ─── Screen layout ──────────────────────────────────────────

export const SCREEN = {
  width: SETTINGS.display.screenWidth,
  height: SETTINGS.display.screenHeight,
} as const;

// ─── Annual dates (UPDATE EACH FISCAL YEAR) ─────────────────
// Each value is overrideable via env var — see .env.example:
//   ANNUAL_DATES_END         → jobEndDate            (e.g. 06/30/2027)
//   KRONOS_DEFAULT_END_DATE  → kronosDefaultEndDate  (e.g. 2/1/2027)
//   KRONOS_DEFAULT_START_DATE → kronosDefaultStartDate (e.g. 1/1/2017)
// Env values override at module-load time; unset → fall back to hardcoded default.

export const ANNUAL_DATES = {
  jobEndDate: process.env.ANNUAL_DATES_END ?? SETTINGS.annualDates.jobEndDate,
  kronosDefaultEndDate: process.env.KRONOS_DEFAULT_END_DATE ?? SETTINGS.annualDates.kronosDefaultEndDate,
  kronosDefaultStartDate: process.env.KRONOS_DEFAULT_START_DATE ?? SETTINGS.annualDates.kronosDefaultStartDate,
} as const;

// ─── Separations ─────────────────────────────────────────────
// TIMEKEEPER_NAME comes from .env (or the Settings page) — used by
// fillTimekeeperTasks (Kuali). Validated lazily so dashboard/other commands
// don't require it at startup. Env wins over the settings value.
export function getTimekeeperName(): string {
  const name = process.env.TIMEKEEPER_NAME || SETTINGS.operator.timekeeperName;
  if (!name) throw new EnvValidationError(["TIMEKEEPER_NAME"]);
  return name;
}

// ─── URLs not yet centralized ───────────────────────────────
// Each URL is operator-overrideable via the Settings page (`settings.urls.*`).
// An empty/unset setting falls back to the production default literal below, so
// an unconfigured install is byte-identical. Use an override only to point a
// system at an alternate/test instance.

export const KUALI_SPACE_URL =
  SETTINGS.urls.kualiSpace || "https://ucsd.kualibuild.com/build/space/5e47518b90adda9474c14adb";
export const NEW_KRONOS_URL = SETTINGS.urls.newKronos || "https://ucsd-sso.prd.mykronos.com/wfd/home";
export const CRM_ENTRY_URL = SETTINGS.urls.crmEntry || "https://crm.ucsd.edu/hr";

/** OnBase (Hyland) document management — UCSD Shibboleth SSO entry point. */
export const ONBASE_URL = SETTINGS.urls.onbase || "https://ucsd.hylandcloud.com/251ids/NavPanel.aspx";

// --- CRM ---

/** ACT CRM onboarding search page (accepts ?q= email param). */
export const CRM_SEARCH_URL =
  SETTINGS.urls.crmSearch || "https://act-crm.my.site.com/hr/ONB_SearchOnboardings";

/** ACT CRM section URL mappings — record ID appended as ?id= param. */
export const CRM_SECTION_URLS: Record<string, string> = {
  "UCPath Entry Sheet": "https://act-crm.my.site.com/hr/ONB_PPSEntrySheet",
  "Onboarding History": "https://act-crm.my.site.com/hr/ONB_ShowOnboardingHistory",
};

// --- UCPath ---

/** UCPath Smart HR Tasks page — must use ucphrprdpub subdomain (not ucpath.) to avoid re-triggering SSO. */
export const UCPATH_SMART_HR_URL =
  SETTINGS.urls.ucpathSmartHr ||
  "https://ucphrprdpub.universityofcalifornia.edu/psc/ucphrprd/EMPLOYEE/HRMS/c/NUI_FRAMEWORK.PT_AGSTARTPAGE_NUI.GBL?CONTEXTIDPARAMS=TEMPLATE_ID%3aPTPPNAVCOL&scname=ADMN_UC_ADMIN_LOC_HIRE_NAVCOLL&PanelCollapsible=Y&PTPPB_GROUPLET_ID=UC_HIRE_TASKS_TILE_FL&CRefName=UC_HIRE_TASKS_TILE_FL&AJAXTRANSFER=Y";

// --- I9 ---

/**
 * I-9 Complete entry URL — the UCOP portal landing page. Its "Tracker I-9
 * Complete Application" link fires the campus SSO SAML flow
 * (samlproxy.ucop.edu WAYF → UCSD TritON Shibboleth → Duo), which lands on the
 * authenticated app host `I9_APP_URL`. This replaced the old direct vendor
 * login (`stse.i9complete.com`) on 2026-07-01 — auth is now UCSD SSO + Duo,
 * not a standalone i9 email/password. See `src/systems/i9/login.ts`.
 */
export const I9_URL = SETTINGS.urls.i9 || "https://i9complete.ucop.edu";

/**
 * Authenticated I-9 Complete application host. Stable regardless of the entry
 * portal — the SAML flow always lands here post-Duo. Used for deep-links (e.g.
 * the employee-profile `saveAndContinue` navigation in `create.ts`) that must
 * target the app host directly rather than the UCOP landing page.
 */
export const I9_APP_URL = "https://wwwe.i9complete.com";

// --- UKG (Kronos) ---

/** UKG workforce management dashboard URL. */
export const UKG_URL =
  SETTINGS.urls.ukg ||
  "https://ucsd.kronos.net/wfcstatic/applications/navigator/html5/dist/container/index.html?version=8.1.18.502#/";
