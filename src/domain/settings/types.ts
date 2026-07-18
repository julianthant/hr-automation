/**
 * Operator settings — the tweakable constants an operator can change from the
 * dashboard Settings page, persisted to a single `config/settings.json` file.
 *
 * This module is the SHARED CONTRACT between the server (which reads the file,
 * applies it to `process.env` / `src/config.ts`, and exposes `/api/settings`)
 * and the dashboard frontend (which renders the Settings page). It is therefore
 * **client-safe**: plain TypeScript types + a defaults object + a pure deep-merge
 * — NO `node:fs`, NO `zod`, no imports with runtime side effects. The Zod
 * validation schema lives server-side in `src/tracker/settings/schema.ts`.
 *
 * ## Precedence (how a value actually takes effect)
 *
 *   explicit env var  >  config/settings.json  >  code default
 *
 * An empty / missing settings file therefore reproduces today's behavior
 * exactly — every default below mirrors the corresponding hardcoded value in
 * `src/config.ts` / the consuming module, so an unconfigured install is a no-op.
 * `applyOperatorSettingsToEnv` only ever populates an env var for a field the
 * operator EXPLICITLY set (present in the on-disk override), and only via `??=`,
 * so a real `.env` value still wins and a dynamic code default (e.g. OCR page
 * concurrency = vision-pool size) is untouched when the operator hasn't chosen.
 */

/** Operator identity used in workflow fills. */
export interface OperatorIdentitySettings {
  /**
   * Timekeeper name for Kuali separation timekeeper-task fills (env
   * `TIMEKEEPER_NAME`). Empty = unset (the separations workflow throws loudly
   * when it actually needs it — see `getTimekeeperName`).
   */
  timekeeperName: string;
}

/** Annual / fiscal-year dates. UPDATE EACH FISCAL YEAR. */
export interface AnnualDateSettings {
  /** Onboarding hire job end date, `MM/DD/YYYY` (env `ANNUAL_DATES_END`). */
  jobEndDate: string;
  /** Kronos report default end date, `M/D/YYYY` (env `KRONOS_DEFAULT_END_DATE`). */
  kronosDefaultEndDate: string;
  /** Kronos report default start date, `M/D/YYYY` (env `KRONOS_DEFAULT_START_DATE`). */
  kronosDefaultStartDate: string;
}

/** Browser window sizing for daemon tiling. */
export interface DisplaySettings {
  /** Daemon browser window width (px). Matches the operator's monitor setup. */
  screenWidth: number;
  /** Daemon browser window height (px). */
  screenHeight: number;
}

/** Output directories. Empty string = use the built-in `data/<subdir>` default. */
export interface PathSettings {
  /** Kronos / separations PDF report downloads. Empty = `<repo>/data/reports`. */
  reportsDir: string;
  /** Browser download fallback dir (Old Kronos filesystem-diff). Empty = `<repo>/data/downloads`. */
  downloadsDir: string;
  /** CRM onboarding-document downloads. Empty = `<repo>/data/onboarding`. */
  onboardingDocsDir: string;
  /** Master I-9 retention tracker xlsx. Empty = `<reportsDir>/i9-check-tracker.xlsx`. */
  i9CheckTrackerPath: string;
}

/** Navigation timeouts (ms). */
export interface TimeoutSettings {
  /** Standard page-navigation timeout (ms). */
  navigationMs: number;
  /** Long/complex page-load timeout (ms) — UKG, Kuali. */
  longNavigationMs: number;
  /** UKG (Old Kronos) page-navigation timeout (ms) — that system is slow to load. */
  ukgNavigationMs: number;
  /** Duo MFA approval wait for onboarding/UCPath flows (SECONDS). */
  duoApprovalSeconds: number;
  /** Duo MFA approval wait for CRM/separations flows (SECONDS). */
  duoApprovalCrmSeconds: number;
  /** Delay between navigation retries (ms). */
  retryDelayMs: number;
}

/**
 * System entry URLs. Empty string = use the built-in production default. Only
 * set these to point the automation at an alternate/test instance of a system.
 */
export interface UrlSettings {
  /** Kuali Build onboarding/separations form space. */
  kualiSpace: string;
  /** New Kronos (WFD) timecard dashboard. */
  newKronos: string;
  /** CRM onboarding search entry. */
  crmEntry: string;
  /** OnBase (Hyland) document management entry. */
  onbase: string;
  /** ACT CRM onboarding search page. */
  crmSearch: string;
  /** UCPath Smart HR Tasks page. */
  ucpathSmartHr: string;
  /** I-9 Complete login. */
  i9: string;
  /** UKG (Old Kronos) workforce management dashboard. */
  ukg: string;
}

/**
 * Audit-screenshot capture geometry. Mirrors the `CAPTURE` object in
 * `src/core/kernel/session.ts` — tune for readability of captured forms.
 */
export interface CaptureSettings {
  /** Fixed minimum layout-viewport width (px) for every capture. */
  width: number;
  /** Hard cap on widening for pathologically wide content (px). */
  maxWidth: number;
  /** Height of each page slice when a tall capture is split (px). */
  sliceHeight: number;
  /** Vertical overlap between consecutive slices (px). Must be < sliceHeight. */
  sliceOverlap: number;
  /** Hard cap on slices per page (runaway guard for very tall docs). */
  maxSlices: number;
}

/** Per-browser health-monitor recovery tuning (the refresh → reopen ladder). */
export interface BrowserHealthSettings {
  /** How often the health monitor probes every launched browser (ms). */
  monitorTickMs: number;
  /** Max consecutive Refresh attempts (rung 1) before escalating to Reopen. */
  maxAutoRefresh: number;
  /** Max consecutive Reopen attempts (rung 2) before surfacing a failure. */
  maxReopen: number;
}

/** Worker-pool concurrency defaults. */
export interface ConcurrencySettings {
  /** Default parallel workers for the old-kronos-reports batch download. */
  defaultWorkers: number;
}

/** Daemon claim-loop timing. Affects how responsively queued work is picked up. */
export interface DaemonSettings {
  /** Idle-sleep window before a daemon runs its heavyweight keepalive tick (ms). */
  idleMs: number;
  /** Bounded idle re-poll backstop — recovers a missed wake within this window (ms). */
  idleRepollMs: number;
}

/** Concurrency / resilience tuning. */
export interface PerformanceSettings {
  /**
   * Navigation retry attempts before failing a run (env
   * `HRAUTO_NAVIGATION_RETRIES`; `launch.ts` default 10).
   */
  navigationRetries: number;
  /**
   * Tolerance window (days) for reusing an approved prior termination as the
   * SAME separation transaction (env
   * `HRAUTO_SEPARATION_TERMINATION_WINDOW_DAYS`; default 14).
   */
  separationTerminationWindowDays: number;
}

/** OCR cost/speed/accuracy knobs (all env-backed, read by the OCR pipeline). */
export interface OcrSettings {
  /** Max suspect records to re-read via the second-opinion pass (env `OCR_SECOND_OPINION_MAX`). */
  secondOpinionMax: number;
  /** Per-page OCR wait budget in ms before a page fails (env `OCR_PAGE_MAX_WAIT_MS`). */
  pageMaxWaitMs: number;
  /**
   * How long a page may wait for a trusted (tier-1) vision model to free up
   * before overflowing to a weaker tier-2 model (env `OCR_TIER1_PATIENCE_MS`).
   * Stops extraction quality from degrading over a long batch as the tier-1
   * per-minute windows saturate. `0` disables (take the best free cell
   * immediately). Always capped by `pageMaxWaitMs`, so it never fails a page.
   */
  tier1PatienceMs: number;
  /**
   * Max concurrent OCR page extractions (env `OCR_PAGE_CONCURRENCY`). `0` means
   * "Auto" — let the pipeline use the vision-pool size (its dynamic default), so
   * an unset value is never forced to a fixed number.
   */
  pageConcurrency: number;
  /** Concurrency for fuzzy-name disambiguation (env `OCR_DISAMBIG_CONCURRENCY`). */
  disambigConcurrency: number;
  /** Concurrency for LLM lookup suggestions (env `OCR_SUGGEST_CONCURRENCY`). */
  suggestConcurrency: number;
  /** Rate-limit backoff base in ms before retrying an OCR cell (env `OCR_BACKOFF_BASE_MS`). */
  backoffBaseMs: number;
  /** Rate-limit backoff ceiling in ms (env `OCR_BACKOFF_CAP_MS`). */
  backoffCapMs: number;
  /** Max OCR form-validation retries before failing a page (env `OCR_MAX_VALIDATION_RETRIES`). */
  maxValidationRetries: number;
}

/** Toggles. */
export interface FeatureSettings {
  /** Write extra debug screenshots in hot paths (env `DEBUG_SCREENSHOTS`). */
  debugScreenshots: boolean;
  /**
   * Hands-off Duo MFA via the WebAuthn virtual authenticator (env
   * `HR_AUTOMATION_DUO_WEBAUTHN`). Requires a prior one-time enrollment.
   */
  duoWebAuthn: boolean;
}

/** The fully-populated operator settings (defaults filled in). */
export interface OperatorSettings {
  operator: OperatorIdentitySettings;
  annualDates: AnnualDateSettings;
  display: DisplaySettings;
  paths: PathSettings;
  urls: UrlSettings;
  timeouts: TimeoutSettings;
  performance: PerformanceSettings;
  ocr: OcrSettings;
  capture: CaptureSettings;
  browserHealth: BrowserHealthSettings;
  concurrency: ConcurrencySettings;
  daemon: DaemonSettings;
  features: FeatureSettings;
}

/** A sparse override — every field optional, one level deep per section. */
export type OperatorSettingsOverride = {
  [K in keyof OperatorSettings]?: Partial<OperatorSettings[K]>;
};

/**
 * Defaults — these MUST mirror the current hardcoded values in `src/config.ts`
 * and the consuming modules, so an empty settings file is behavior-neutral.
 */
export const DEFAULT_OPERATOR_SETTINGS: OperatorSettings = {
  operator: { timekeeperName: "" },
  annualDates: {
    jobEndDate: "06/30/2026",
    kronosDefaultEndDate: "2/1/2026",
    kronosDefaultStartDate: "1/1/2017",
  },
  display: { screenWidth: 2560, screenHeight: 1440 },
  paths: { reportsDir: "", downloadsDir: "", onboardingDocsDir: "", i9CheckTrackerPath: "" },
  urls: {
    kualiSpace: "",
    newKronos: "",
    crmEntry: "",
    onbase: "",
    crmSearch: "",
    ucpathSmartHr: "",
    i9: "",
    ukg: "",
  },
  timeouts: {
    navigationMs: 15_000,
    longNavigationMs: 30_000,
    ukgNavigationMs: 60_000,
    duoApprovalSeconds: 180,
    duoApprovalCrmSeconds: 60,
    retryDelayMs: 5_000,
  },
  performance: { navigationRetries: 10, separationTerminationWindowDays: 14 },
  ocr: {
    secondOpinionMax: 5,
    pageMaxWaitMs: 120_000,
    tier1PatienceMs: 90_000,
    pageConcurrency: 0,
    disambigConcurrency: 4,
    suggestConcurrency: 4,
    backoffBaseMs: 2_000,
    backoffCapMs: 60_000,
    maxValidationRetries: 1,
  },
  capture: { width: 1280, maxWidth: 6000, sliceHeight: 1200, sliceOverlap: 120, maxSlices: 30 },
  browserHealth: { monitorTickMs: 30_000, maxAutoRefresh: 10, maxReopen: 3 },
  concurrency: { defaultWorkers: 4 },
  daemon: { idleMs: 900_000, idleRepollMs: 30_000 },
  features: { debugScreenshots: false, duoWebAuthn: true },
};

/**
 * Deep-merge a sparse override onto the defaults. Pure — shared by the server
 * (config load + the GET response) and the frontend (optimistic preview). A
 * `null`/`undefined` section or field falls through to the default; the merge
 * is one level deep, which matches the flat section shape above.
 */
export function mergeOperatorSettings(
  override: OperatorSettingsOverride | null | undefined,
): OperatorSettings {
  const base = DEFAULT_OPERATOR_SETTINGS;
  const ov = override ?? {};
  return {
    operator: { ...base.operator, ...ov.operator },
    annualDates: { ...base.annualDates, ...ov.annualDates },
    display: { ...base.display, ...ov.display },
    paths: { ...base.paths, ...ov.paths },
    urls: { ...base.urls, ...ov.urls },
    timeouts: { ...base.timeouts, ...ov.timeouts },
    performance: { ...base.performance, ...ov.performance },
    ocr: { ...base.ocr, ...ov.ocr },
    capture: { ...base.capture, ...ov.capture },
    browserHealth: { ...base.browserHealth, ...ov.browserHealth },
    concurrency: { ...base.concurrency, ...ov.concurrency },
    daemon: { ...base.daemon, ...ov.daemon },
    features: { ...base.features, ...ov.features },
  };
}

/**
 * Reduce a fully-populated settings object to a SPARSE override — only the
 * fields that differ from the defaults survive, and a section with no diffs is
 * dropped entirely. This is what the Settings page persists, so an unconfigured
 * field never lands in `config/settings.json` (keeping the file small and the
 * env-population parity-safe). Inverse-ish of {@link mergeOperatorSettings}:
 * `mergeOperatorSettings(diffOperatorSettings(s))` deep-equals `s`.
 */
export function diffOperatorSettings(s: OperatorSettings): OperatorSettingsOverride {
  const base = DEFAULT_OPERATOR_SETTINGS;
  const out: OperatorSettingsOverride = {};
  for (const section of Object.keys(base) as (keyof OperatorSettings)[]) {
    const sectionDiff: Record<string, unknown> = {};
    const baseSection = base[section] as unknown as Record<string, unknown>;
    const curSection = s[section] as unknown as Record<string, unknown>;
    for (const key of Object.keys(baseSection)) {
      if (curSection[key] !== baseSection[key]) {
        sectionDiff[key] = curSection[key];
      }
    }
    if (Object.keys(sectionDiff).length > 0) {
      (out as Record<string, unknown>)[section] = sectionDiff;
    }
  }
  return out;
}

/** Structured clone of the (plain, 2-level) settings object. */
export function cloneOperatorSettings(s: OperatorSettings): OperatorSettings {
  return {
    operator: { ...s.operator },
    annualDates: { ...s.annualDates },
    display: { ...s.display },
    paths: { ...s.paths },
    urls: { ...s.urls },
    timeouts: { ...s.timeouts },
    performance: { ...s.performance },
    ocr: { ...s.ocr },
    capture: { ...s.capture },
    browserHealth: { ...s.browserHealth },
    concurrency: { ...s.concurrency },
    daemon: { ...s.daemon },
    features: { ...s.features },
  };
}

/**
 * Read-only credential presence — booleans only, NEVER the secret values. The
 * `/api/settings` GET attaches this so the Settings page can show which `.env`
 * credentials are configured without ever exposing or editing a password.
 */
export interface CredentialStatus {
  ucpathUser: boolean;
  ucpathPassword: boolean;
  timekeeperName: boolean;
  onboardingRosterUrl: boolean;
}
