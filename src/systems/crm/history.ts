import type { Page } from "playwright";
import { onboardingHistory } from "./selectors.js";

/**
 * ACT CRM onboarding-history reader.
 *
 * The onboarding record's "Show Onboarding History" view (`ONB_ShowOnboardingHistory`)
 * is a `ProcessStageText` transition log — a `table.detailList` whose data rows
 * are `Date | Created By | Field | Old Value | New Value`. The oath is signed in
 * the onboarding ceremony the moment the stage transitions **to**
 * `"Witness Ceremony Oath New Hire Signed"`; that row's Date cell
 * (`M/D/YYYY H:MM AM/PM`) is the authoritative signature timestamp.
 *
 * Live-verified 2026-07-02 on EID 10883906 (Emma Sheredy) and 10883915
 * (Aliana Villalobos).
 */

/**
 * The New-Value stage that marks the new hire having signed the oath. This
 * exact string also appears as the OLD value of the *next* row (the
 * HR-Counter-Signed transition), so the reader matches the **New Value column
 * only** — never a bare "row contains this text".
 */
export const WITNESS_OATH_NEW_HIRE_SIGNED = "Witness Ceremony Oath New Hire Signed";

export interface OnboardingOathHistory {
  /** True when a `→ New Hire Signed` transition is present in the history. */
  oathSigned: boolean;
  /** MM/DD/YYYY of the sign event, or null when not signed / unparseable. */
  signedDate: string | null;
  /** Time-of-day of the sign event (e.g. "1:27 PM"), or null. */
  signedTime: string | null;
}

/**
 * Parse a CRM history timestamp (`M/D/YYYY H:MM AM/PM`) into a padded
 * `MM/DD/YYYY` date + the raw time-of-day. Returns nulls when the shape does
 * not match, so a locale/format surprise degrades rather than throwing.
 */
export function parseCrmHistoryTimestamp(raw: string): {
  date: string | null;
  time: string | null;
} {
  const m = raw.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(.+))?$/);
  if (!m) return { date: null, time: null };
  const [, mm, dd, yyyy, time] = m;
  return {
    date: `${mm.padStart(2, "0")}/${dd.padStart(2, "0")}/${yyyy}`,
    time: time?.trim() || null,
  };
}

/**
 * Pure history scan: given the grid as rows of trimmed cell strings, find the
 * transition whose **New Value** (5th cell) is the oath-signed stage and read
 * its Date (1st cell). Only the first match counts. Rows that are not the
 * 5-cell data shape are ignored, so the header/wrapper rows are harmless.
 */
export function findOathSignedTransition(rows: string[][]): OnboardingOathHistory {
  for (const cells of rows) {
    if (cells.length !== 5) continue;
    if (cells[4].trim() !== WITNESS_OATH_NEW_HIRE_SIGNED) continue;
    const { date, time } = parseCrmHistoryTimestamp(cells[0]);
    return { oathSigned: true, signedDate: date, signedTime: time };
  }
  return { oathSigned: false, signedDate: null, signedTime: null };
}

/** Scrape the onboarding-history grid into rows of trimmed cell strings. */
async function scrapeHistoryRows(page: Page): Promise<string[][]> {
  const rows = onboardingHistory.historyRows(page);
  const rowCount = await rows.count();
  const out: string[][] = [];
  for (let i = 0; i < rowCount; i++) {
    // Direct-child cells only — the grid nests inside an outer detailList, so a
    // descendant `td` selector would pull wrapper cells. Compound path rooted
    // in the registry locator.
    const cells = rows.nth(i).locator(":scope > td, :scope > th"); // allow-inline-selector -- row-scoped direct cells
    const cellCount = await cells.count();
    if (cellCount !== 5) continue;
    const texts: string[] = [];
    for (let j = 0; j < cellCount; j++) {
      texts.push(((await cells.nth(j).textContent()) ?? "").trim());
    }
    out.push(texts);
  }
  return out;
}

/**
 * Read the currently-loaded onboarding-history page for the oath-signed event.
 * Navigate there first (`navigateToSection(page, "Onboarding History")` or the
 * "Show Onboarding History" button).
 */
export async function readOnboardingOathHistory(
  page: Page,
): Promise<OnboardingOathHistory> {
  return findOathSignedTransition(await scrapeHistoryRows(page));
}
