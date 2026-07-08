import type { Page } from "playwright";
import { log } from "../../utils/log.js";
import { errorMessage } from "../../utils/errors.js";
import { pickI9SignerSearchResult, searchI9Employee } from "./search.js";
import { search as searchSelectors, summary as summarySelectors } from "./selectors.js";
import type { I9SearchCriteria } from "./types.js";

/**
 * Result of `lookupSection2Signer`.
 *
 * `status` classifies the outcome for the caller without forcing them to
 * peek at `signerName` — e.g. `"historical"` explicitly means "a paper I-9
 * was imported; no one electronically signed Section 2" rather than
 * conflating that with a modern I-9 that's genuinely unsigned, and
 * `"unable-to-access"` means the record EXISTS but the operator's account
 * lacks permission to view it (distinct from a genuine `"not-found"`).
 */
export interface Section2SignerResult {
  /** "signed" | "unsigned" | "historical" | "not-found" | "unable-to-access" | "error" */
  status: "signed" | "unsigned" | "historical" | "not-found" | "unable-to-access" | "error";
  /** Signer name when status === "signed". Otherwise null. */
  signerName: string | null;
  /** The I-9 profile ID used (if we got far enough to navigate). */
  profileId?: string;
  /** The I-9 ID used (if we got far enough to navigate). */
  i9Id?: string;
  /** Short reason when status === "error" or "not-found". */
  detail?: string;
}

export function extractSignedSection2Signer(cells: readonly string[]): string | null {
  // Audit-trail columns are [Section, Date, Event, Created By]; the signer is
  // the LAST cell (Created By). Reading the last cell (rather than a fixed
  // index 3) stays correct if a leading icon/checkbox column is ever added.
  const signerName = (cells[cells.length - 1] ?? "").trim();
  return signerName || null;
}

/**
 * Look up who signed Section 2 for a given employee in I-9 Complete.
 *
 * Flow:
 *   1. Use the existing `searchI9Employee` helper (last/first name search)
 *      to find the employee's I-9 record(s). A zero-result search may be a
 *      genuine "not found" OR an access-restricted alert (record exists but
 *      out of the operator's scope) — distinguished via `accessRestrictedAlert`.
 *   2. Pick the first row whose Next Action is not "Complete Section 1" or
 *      "Complete Section 2" (e.g. Purge/Rehire rows).
 *   3. Navigate STRAIGHT to `/form-I9/summary/{profileId}/{i9Id}` using the
 *      hit's IDs (deterministic; paper imports redirect to
 *      `/form-I9-historical/…`).
 *   4. Wait for the summary heading + the audit-trail table, then read the
 *      "Signed Section 2" audit row's Created By cell.
 *
 * Navigation rewritten + selectors re-verified live 2026-06-06 against
 * profile 1670462 / i9 1602018 (Provenzano). The earlier click-through
 * (last-name link → record-accordion expand → Summary tab) was fragile and
 * surfaced as a spurious "not found". See `src/systems/i9/LESSONS.md`.
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
    results = await searchI9Employee(page, criteria, { closeDialog: false });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    log.error(`I9 search failed for ${label}: ${detail}`);
    return { status: "error", signerName: null, detail };
  }

  if (results.length === 0) {
    // A zero-result search shows an access-restricted alert when the record
    // EXISTS but the operator's account can't view it. Detect it (the search
    // dialog is still open — `closeDialog: false`) so the caller reports
    // "unable to access" rather than a genuine "not found". verified 2026-06-06.
    const restricted = await searchSelectors
      .accessRestrictedAlert(page)
      .count()
      .catch((err) => {
        // A count() failure here (e.g. a detached frame) must not silently
        // resolve to "not restricted" without a trace — that would collapse
        // back into the exact "existing record misreported as not-found"
        // problem this check exists to catch (see 2026-06-06 lesson).
        log.warn(
          `I9 ${label}: access-restricted alert check failed, treating as not-restricted — ${errorMessage(err)}`,
        );
        return 0;
      });
    if (restricted > 0) {
      log.step(`I9 ${label}: record exists but operator lacks access (restricted)`);
      return { status: "unable-to-access", signerName: null };
    }
    log.step(`No I9 record found for ${label}`);
    return { status: "not-found", signerName: null };
  }

  const hit = pickI9SignerSearchResult(results);
  if (!hit) {
    log.step(
      `I9 ${label}: no eligible signer lookup row found (only Complete Section 1/2 rows or blank actions)`,
    );
    return {
      status: "unsigned",
      signerName: null,
      detail: "No eligible I-9 row with a signed/purge/rehire action was found",
    };
  }

  const { profileId, i9Id } = hit;
  if (!profileId || !i9Id) {
    return {
      status: "error",
      signerName: null,
      detail: "I9 search result missing profileId/i9Id",
    };
  }

  // Navigate STRAIGHT to the record summary built from the search hit's IDs.
  // The previous click-through (last-name link → `ensureSelectedRecordExpanded`
  // broad-scan-click → Summary-tab click) was fragile: the last-name cell is a
  // hrefless <a> (not a link role), the broad DOM scan could click the wrong
  // element, and the Summary re-click raced the audit-table load — any of which
  // surfaced as a spurious "not found". Direct navigation is deterministic.
  try {
    const summaryUrl = new URL(
      `/form-I9/summary/${profileId}/${i9Id}`,
      page.url(),
    ).toString();
    await page.goto(summaryUrl, { waitUntil: "domcontentloaded", timeout: 20_000 });
    await page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => {});
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { status: "error", signerName: null, profileId, i9Id, detail };
  }

  // Paper-imported records redirect to `/form-I9-historical/…` (no electronic
  // Section 2 audit row). Observable in the final URL after navigation.
  if (page.url().includes("/form-I9-historical/")) {
    log.step(`I9 ${label}: paper/historical record — no electronic Section 2 audit row`);
    return { status: "historical", signerName: null, profileId, i9Id };
  }

  // Wait for the summary view heading. Both routes (`/form-I9/summary` +
  // the historical redirect) expose the same heading.
  try {
    await waitForSummaryView(page);
  } catch {
    return {
      status: "error",
      signerName: null,
      profileId,
      i9Id,
      detail: "I-9 Summary heading never appeared",
    };
  }

  // The heading appears before the audit-trail TABLE populates, so anchoring
  // only on the heading raced the `row.count()` below in the past (count 0 →
  // a signed record mis-read as unsigned; see 2026-06-06 lesson). Wait for
  // the audit-trail header row to confirm the table itself rendered — but
  // track whether that confirmation succeeded, because `row.count()` below
  // is only trustworthy evidence of "unsigned" once we know the table loaded.
  // NEEDS LIVE VERIFY: confirm live whether a genuinely-unsigned I-9 ever
  // takes >10s to render the audit-trail header row under normal load — if
  // so this fix would need a longer timeout rather than reporting "error".
  const auditTableConfirmedRendered = await summarySelectors
    .auditTrailHeaderRow(page)
    .first()
    .waitFor({ state: "visible", timeout: 10_000 })
    .then(() => true)
    .catch(() => false);

  // Find the "Signed Section 2" audit row. Missing on modern I-9s where
  // Section 2 hasn't been signed yet (historical was already returned above).
  const row = summarySelectors.signedSection2Row(page);
  const rowCount = await row.count();
  if (rowCount === 0) {
    if (!auditTableConfirmedRendered) {
      // A 0 count with an unconfirmed audit table is NOT trustworthy evidence
      // of "unsigned" — it may just mean the table hasn't loaded yet. Fail
      // loud instead of reporting a false "unsigned" for a record that could
      // actually be signed.
      log.warn(
        `I9 ${label}: audit-trail table never confirmed rendered before counting — refusing to report "unsigned"`,
      );
      return {
        status: "error",
        signerName: null,
        profileId,
        i9Id,
        detail: "Audit-trail table did not render in time to confirm Section 2 is genuinely unsigned",
      };
    }
    log.step(`I9 ${label}: Section 2 unsigned (no signed-section-2 audit row)`);
    return { status: "unsigned", signerName: null, profileId, i9Id };
  }

  // Audit-trail columns: [Section, Date, Event, Created By] → signer is the
  // last cell.
  const signerName = extractSignedSection2Signer(
    await row.getByRole("cell").allTextContents(), // allow-inline-selector -- row-scoped cell readback, rooted in registry row
  );

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

async function waitForSummaryView(page: Page): Promise<void> {
  const summaryAnchor = summarySelectors.heading(page)
    .or(page.getByText("Electronic I-9 Audit Trail")) // allow-inline-selector -- summary tab audit-history anchor
    .or(page.getByText("Audit History")); // allow-inline-selector -- summary tab fallback anchor
  await summaryAnchor.first().waitFor({ state: "visible", timeout: 10_000 });
}
