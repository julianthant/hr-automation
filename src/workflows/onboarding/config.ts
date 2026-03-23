// ─── Onboarding workflow configuration ───
// Constants specific to the UC_FULL_HIRE onboarding transaction.
// Other workflows (offboarding, pay change) will have their own config.ts.

/** Template ID for full hire transaction. */
export const TEMPLATE_ID = "UC_FULL_HIRE";

/** Reason code label for new hires with no prior UC affiliation. */
export const REASON_CODE = "Hire - No Prior UC Affiliation";

/** Compensation rate code for hourly employees. */
export const COMP_RATE_CODE = "UCHRLY";

/** Expected job end date for current fiscal year. */
export const JOB_END_DATE = "06/30/2026";
