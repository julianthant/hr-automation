import type { Page } from "playwright";
import { log } from "../../utils/log.js";
import { I9_URL } from "../../config.js";
import { searchI9Employee } from "./search.js";
import { summary as summarySelectors } from "./selectors.js";
import type { I9SearchCriteria } from "./types.js";

/**
 * Result of `lookupSection2Signer`.
 *
 * `status` classifies the outcome for the caller without forcing them to
 * peek at `signerName` — e.g. `"historical"` explicitly means "a paper I-9
 * was imported; no one electronically signed Section 2" rather than
 * conflating that with a modern I-9 that's genuinely unsigned.
 */
export interface Section2SignerResult {
  /** "signed" | "unsigned" | "historical" | "not-found" | "error" */
  status: "signed" | "unsigned" | "historical" | "not-found" | "error";
  /** Signer name when status === "signed". Otherwise null. */
  signerName: string | null;
  /** The I-9 profile ID used (if we got far enough to navigate). */
  profileId?: string;
  /** The I-9 ID used (if we got far enough to navigate). */
  i9Id?: string;
  /** Short reason when status === "error" or "not-found". */
  detail?: string;
}

/**
 * Look up who signed Section 2 for a given employee in I-9 Complete.
 *
 * Flow:
 *   1. Use the existing `searchI9Employee` helper (last/first name search)
 *      to find the employee's I-9 record(s).
 *   2. Pick the first result (`I9SearchResult[0]`) — multi-match is rare
 *      in practice; picking the first mirrors eid-lookup's SDCMP strategy.
 *   3. Navigate to the summary URL derived from `profileId` + `i9Id`.
 *      Modern records resolve to `/form-I9/summary/{p}/{i}`; paper imports
 *      redirect to `/form-I9-historical/{p}/{i}/0` — both show the same
 *      "I-9 Record Summary Information" heading and audit-trail table.
 *   4. Wait for the summary heading, then look for the audit-trail row
 *      whose event reads "Signed Section 2" and read its 4th cell.
 *
 * Mapping verified live on 2026-04-22 against a completed remote I-9
 * (Profile ID 2082422). See `src/systems/i9/LESSONS.md`.
 *
 * @param page - Authenticated I9 Complete page (post `loginToI9`).
 * @param criteria - Search fields; typically `{ lastName, firstName }`.
 *                   At least one of lastName/ssn/employeeId/profileId required.
 * @returns Structured result describing signer / status.
 */
export async function lookupSection2Signer(
  page: Page,
  criteria: I9SearchCriteria,
): Promise<Section2SignerResult> {
  const label = criteria.lastName || criteria.profileId || criteria.ssn || "?";
  log.step(`I9 Section 2 signer lookup for ${label}...`);

  let results;
  try {
    results = await searchI9Employee(page, criteria);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    log.error(`I9 search failed for ${label}: ${detail}`);
    return { status: "error", signerName: null, detail };
  }

  if (results.length === 0) {
    log.step(`No I9 record found for ${label}`);
    return { status: "not-found", signerName: null };
  }

  // First result wins. Multiple I-9s for the same person happen on rehire
  // (previous record purged, new one created) — the most recent is what
  // the operator almost always wants, and search results are date-sorted
  // with newest first.
  const hit = results[0];
  const { profileId, i9Id } = hit;
  if (!profileId || !i9Id) {
    return {
      status: "error",
      signerName: null,
      detail: "I9 search result missing profileId/i9Id",
    };
  }

  const summaryUrl = `${I9_URL.replace("stse.", "wwwe.")}/form-I9/summary/${profileId}/${i9Id}?isRemoteAccess=False`;
  log.step(`Navigating to I9 summary ${profileId}/${i9Id}...`);
  try {
    await page.goto(summaryUrl, { waitUntil: "domcontentloaded", timeout: 15_000 });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { status: "error", signerName: null, profileId, i9Id, detail };
  }

  // Wait for the summary view to render. Both the modern `/form-I9/summary`
  // route and the redirected `/form-I9-historical` route expose the same
  // heading, so this works for both.
  try {
    await summarySelectors.heading(page).waitFor({ state: "visible", timeout: 10_000 });
  } catch {
    return {
      status: "error",
      signerName: null,
      profileId,
      i9Id,
      detail: "I-9 Summary heading never appeared",
    };
  }

  // Find the "Signed Section 2" audit row. Missing on historical/paper
  // imports and on modern I-9s where Section 2 hasn't been signed yet.
  const row = summarySelectors.signedSection2Row(page);
  const rowCount = await row.count();
  if (rowCount === 0) {
    // Distinguish historical (paper) from genuinely unsigned. The
    // historical redirect is observable in the final URL after navigation.
    const landedHistorical = page.url().includes("/form-I9-historical/");
    const status = landedHistorical ? "historical" : "unsigned";
    log.step(`I9 ${label}: Section 2 ${status} (no signed-section-2 audit row)`);
    return { status, signerName: null, profileId, i9Id };
  }

  // Audit-trail columns: [Section, Date, Event, Created By] → signer is cell 3.
  const signerName = (
    await row.getByRole("cell").nth(3).textContent() // allow-inline-selector -- row-scoped cell readback, rooted in registry row
  )?.trim() ?? "";

  if (!signerName) {
    return {
      status: "error",
      signerName: null,
      profileId,
      i9Id,
      detail: "Signer cell was empty",
    };
  }

  log.success(`I9 ${label}: Section 2 signed by ${signerName}`);
  return { status: "signed", signerName, profileId, i9Id };
}
