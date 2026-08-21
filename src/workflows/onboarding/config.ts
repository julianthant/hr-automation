// ─── Onboarding workflow configuration ───
// Constants specific to the UC_FULL_HIRE onboarding transaction.
// Other workflows (offboarding, pay change) will have their own config.ts.

import { ANNUAL_DATES } from "../../config.js";

/** Template ID for full hire transaction. */
export const TEMPLATE_ID = "UC_FULL_HIRE";

/** Reason code label for new hires with no prior UC affiliation. */
export const REASON_CODE = "Hire - No Prior UC Affiliation";

/**
 * Template ID for the REHIRE run mode — an existing UCPath person (active
 * elsewhere on campus) taking an additional Dining job. Filed as a Smart HR
 * "Staff Concurrent Hire/Inter Location Transfer" on their Empl ID; no I-9
 * profile is created. Live-mapped 2026-08-21 (operator procedure 2026-08-20,
 * T002216750).
 */
export const CONC_HIRE_TEMPLATE_ID = "UC_CONC_HIRE";

/** Reason code label for the concurrent-hire (rehire run mode) transaction. */
export const CONC_HIRE_REASON_CODE = "Concurrent Hire - Non Dual Emp";

/** Compensation rate code for hourly employees. */
export const COMP_RATE_CODE = "UCHRLY";

/**
 * Expected job end date for current fiscal year.
 * Sourced from `ANNUAL_DATES.jobEndDate` — override via `ANNUAL_DATES_END` env var
 * when the fiscal year rolls without editing code.
 */
export const JOB_END_DATE = ANNUAL_DATES.jobEndDate;
