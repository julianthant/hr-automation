import type { Page } from "playwright";
import { log } from "../../utils/log.js";
import {
  searchCrmOnboardingRecords,
  selectLatestResult,
  extractField,
  navigateToSection,
  readOnboardingOathHistory,
  ExtractionError,
} from "../../systems/crm/index.js";

/**
 * CRM onboarding verification for the oath-signature workflow.
 *
 * The ACT CRM `?q=` search is **fuzzy** (a numeric EID that belongs to nobody
 * still returns a plausible-but-wrong person; live-confirmed 2026-07-02). So a
 * bare "≥1 result" is NOT proof — the gate opens the matched record and
 * confirms its **UCPath Employee ID** equals the target EID before trusting it.
 * Only then does it read the onboarding history for the
 * "Witness Ceremony Oath New Hire Signed" event, whose date is the authoritative
 * signature date recorded into UCPath.
 *
 * Fail-loud: a genuine navigation/format error propagates. Only "no search
 * results" and an EID mismatch are treated as "no record → skip" (both are real,
 * expected outcomes).
 */

export interface CrmOathVerification {
  /** A CRM onboarding record whose UCPath Employee ID === the target EID was opened. */
  matched: boolean;
  /** The onboarding history contains a "New Hire Signed" oath event. */
  oathSigned: boolean;
  /** MM/DD/YYYY of the sign event, or null. */
  signedDate: string | null;
  /** Time-of-day of the sign event (e.g. "1:27 PM"), or null. */
  signedTime: string | null;
  /** The record's Process Stage field (e.g. "Completed"), or null. */
  processStage: string | null;
}

export interface CrmGateDecision {
  /** True → do not record an oath; the row is marked skipped with `skipReason`. */
  skip: boolean;
  skipReason: string | null;
  /** Operator-facing "CRM Onboarding" detail-field value. */
  crmOnboarding: string;
  /** Signature date to record when verified (else null). */
  signedDate: string | null;
  /** Signature time to record when verified (else null). */
  signedTime: string | null;
}

const digits = (s: string | null | undefined): string => (s ?? "").replace(/\D/g, "");

/**
 * Turn a CRM verification result into the gate decision. Pure + unit-tested.
 *
 *   - not matched            → skip "No CRM onboarding record"
 *   - matched, not signed    → skip "Oath not signed in onboarding"
 *   - matched, signed        → proceed; carry the CRM signature date/time
 *   - matched, signed, but the timestamp didn't parse → THROW (never proceed
 *     with a null date — that would silently record today's date instead)
 */
export function decideCrmGate(v: CrmOathVerification): CrmGateDecision {
  if (!v.matched) {
    return {
      skip: true,
      skipReason: "No CRM onboarding record",
      crmOnboarding: "No record",
      signedDate: null,
      signedTime: null,
    };
  }
  if (!v.oathSigned) {
    return {
      skip: true,
      skipReason: "Oath not signed in onboarding",
      crmOnboarding: v.processStage ? `Not signed (${v.processStage})` : "Not signed",
      signedDate: null,
      signedTime: null,
    };
  }
  if (!v.signedDate) {
    // CRM demonstrably KNOWS the date here (the signed transition row matched)
    // — proceeding with null would fall through to UCPath's today prefill and
    // record a plausible-but-wrong signature date. Fail loud so the CRM
    // history format surprise gets fixed instead (root CLAUDE.md "Fail loud").
    throw new Error(
      "CRM shows the oath signed but the history timestamp was unparseable — " +
        "refusing to substitute today's date; check the CRM onboarding-history row format",
    );
  }
  return {
    skip: false,
    skipReason: null,
    crmOnboarding: v.processStage ? `Verified (${v.processStage})` : "Verified",
    signedDate: v.signedDate,
    signedTime: v.signedTime,
  };
}

/**
 * Select the latest search result, returning false when the search was empty.
 * "No search results found" is a real outcome (no record); any other error —
 * including an unparseable results grid — propagates (fail loud).
 */
async function selectLatestResultOrEmpty(page: Page): Promise<boolean> {
  try {
    await selectLatestResult(page);
    return true;
  } catch (err) {
    if (err instanceof ExtractionError && /no search results/i.test(err.message)) {
      return false;
    }
    throw err;
  }
}

/**
 * Search CRM by `query`, open the latest result, and confirm its UCPath Employee
 * ID equals `emplId`. Leaves the page on that record when it returns true.
 */
async function tryOpenAndVerify(
  page: Page,
  query: string,
  emplId: string,
): Promise<boolean> {
  await searchCrmOnboardingRecords(page, query);
  if (!(await selectLatestResultOrEmpty(page))) return false;
  const recordEid = digits(await extractField(page, "UCPath Employee ID"));
  const match = recordEid.length > 0 && recordEid === digits(emplId);
  if (!match) {
    log.warn(
      `CRM search for "${query}" opened a record with UCPath ID ${recordEid || "(none)"}, not ${emplId} — not a match.`,
    );
  }
  return match;
}

/**
 * Open the CRM onboarding record whose UCPath Employee ID === `emplId`: try the
 * EID first (exact for real EIDs), then fall back to the name (fuzzy — still
 * gated by the EID confirmation). Leaves the page on the record when true.
 */
async function openMatchingRecord(
  page: Page,
  emplId: string,
  name?: string,
): Promise<boolean> {
  if (await tryOpenAndVerify(page, emplId, emplId)) return true;
  const trimmedName = name?.trim();
  if (trimmedName) {
    log.step(`CRM: no EID match — retrying by name "${trimmedName}"...`);
    if (await tryOpenAndVerify(page, trimmedName, emplId)) return true;
  }
  return false;
}

/**
 * Verify an EID's onboarding oath in ACT CRM. The caller must already be
 * authenticated to CRM (`loginToACTCrm`).
 */
export async function verifyOathInCrm(
  page: Page,
  emplId: string,
  name?: string,
): Promise<CrmOathVerification> {
  const matched = await openMatchingRecord(page, emplId, name);
  if (!matched) {
    return {
      matched: false,
      oathSigned: false,
      signedDate: null,
      signedTime: null,
      processStage: null,
    };
  }
  const processStage = (await extractField(page, "Process Stage"))?.trim() || null;
  await navigateToSection(page, "Onboarding History");
  const history = await readOnboardingOathHistory(page);
  return {
    matched: true,
    oathSigned: history.oathSigned,
    signedDate: history.signedDate,
    signedTime: history.signedTime,
    processStage,
  };
}
