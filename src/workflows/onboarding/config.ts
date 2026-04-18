// ─── Onboarding workflow configuration ───
// Constants specific to the UC_FULL_HIRE onboarding transaction.
// Other workflows (offboarding, pay change) will have their own config.ts.

import { ANNUAL_DATES } from "../../config.js";

/** Template ID for full hire transaction. */
export const TEMPLATE_ID = "UC_FULL_HIRE";

/** Reason code label for new hires with no prior UC affiliation. */
export const REASON_CODE = "Hire - No Prior UC Affiliation";

/** Compensation rate code for hourly employees. */
export const COMP_RATE_CODE = "UCHRLY";

/**
 * Expected job end date for current fiscal year.
 * Sourced from `ANNUAL_DATES.jobEndDate` — override via `ANNUAL_DATES_END` env var
 * when the fiscal year rolls without editing code.
 */
export const JOB_END_DATE = ANNUAL_DATES.jobEndDate;
