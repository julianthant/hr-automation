import type { Page } from "playwright";
import { log } from "../../utils/log.js";
import {
  openI9SearchResult,
  pickI9SignerSearchResult,
  searchI9Employee,
} from "./search.js";
import { summary as summarySelectors } from "./selectors.js";
import type { I9SearchCriteria, I9SearchResult } from "./types.js";
import { safeClick } from "../common/index.js";

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

export function extractSignedSection2Signer(cells: readonly string[]): string | null {
  const signerName = (cells[3] ?? "").trim();
  return signerName || null;
}

/**
 * Look up who signed Section 2 for a given employee in I-9 Complete.
 *
 * Flow:
 *   1. Use the existing `searchI9Employee` helper (last/first name search)
 *      to find the employee's I-9 record(s).
 *   2. Pick the first row whose Next Action is not "Complete Section 1" or
 *      "Complete Section 2" (e.g. Purge/Rehire rows).
 *   3. Click that row's Last Name link, expand the matching I-9 summary row
 *      when I-9 Complete lands on the profile page, then open Summary.
 *   4. Wait for the summary view, then look for the audit-trail row
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
    results = await searchI9Employee(page, criteria, { closeDialog: false });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    log.error(`I9 search failed for ${label}: ${detail}`);
    return { status: "error", signerName: null, detail };
  }

  if (results.length === 0) {
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

  try {
    await openI9SearchResult(page, hit);
    await ensureSelectedRecordExpanded(page, hit);
    await openSummaryTab(page);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { status: "error", signerName: null, profileId, i9Id, detail };
  }

  // Wait for the summary view to render. Both the modern `/form-I9/summary`
  // route and the redirected `/form-I9-historical` route expose the same
  // heading, so this works for both.
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

async function ensureSelectedRecordExpanded(page: Page, result: I9SearchResult): Promise<void> {
  const name = `${result.firstName} ${result.lastName}`.trim();
  const expanded = await page.evaluate(
    ({ name, createdOn, nextAction }) => {
      const normalize = (value: string | null | undefined) =>
        (value ?? "").replace(/\s+/g, " ").trim().toLowerCase();
      const wantedName = normalize(name);
      const wantedCreatedOn = normalize(createdOn);
      const wantedAction = normalize(nextAction);
      const candidates = Array.from(
        document.querySelectorAll<HTMLElement>("button,a,div,span"),
      );
      const matching = candidates
        .map((el) => ({ el, text: normalize(el.innerText || el.textContent) }))
        .filter(({ text }) => {
          if (!text || text.length > 500) return false;
          if (wantedName && !text.includes(wantedName)) return false;
          if (wantedCreatedOn && !text.includes(wantedCreatedOn)) return false;
          return !wantedAction || text.includes(`next action: ${wantedAction}`);
        });

      const withArrow = matching.find(({ text }) => /[▼▾▲▴]/u.test(text));
      const match = withArrow ?? matching[0];
      if (!match) return { found: false, clicked: false, text: "" };

      const rawText = match.el.innerText || match.el.textContent || "";
      const isExpanded = /[▲▴]/u.test(rawText);
      const isCollapsed = /[▼▾]/u.test(rawText);
      if (!isExpanded && (isCollapsed || !/[▲▴]/u.test(rawText))) {
        match.el.click();
        return { found: true, clicked: true, text: rawText };
      }
      return { found: true, clicked: false, text: rawText };
    },
    {
      name,
      createdOn: result.createdOn,
      nextAction: result.nextAction,
    },
  );

  if (!expanded.found) {
    log.warn(
      `I9 ${result.profileId}/${result.i9Id}: could not find record accordion for Next Action "${result.nextAction}"`,
    );
    return;
  }
  if (expanded.clicked) {
    log.step(`Expanded I9 record row for Next Action "${result.nextAction}"`);
    await page.waitForTimeout(500);
  }
}

async function openSummaryTab(page: Page): Promise<void> {
  const summaryTab = page.getByRole("tab", { name: /^Summary$/i }) // allow-inline-selector -- I9 summary can render as a tab
    .or(page.getByRole("link", { name: /^Summary$/i })) // allow-inline-selector -- I9 summary fallback when tabs render as anchors
    .or(page.getByRole("button", { name: /^Summary$/i })); // allow-inline-selector -- I9 summary fallback when tabs render as buttons

  const visible = await summaryTab.first().isVisible({ timeout: 3_000 }).catch(() => false);
  if (!visible) {
    log.step("I9 Summary tab not visible; assuming selected record already landed on summary");
    return;
  }

  await safeClick(summaryTab.first(), {
    timeout: 5_000,
    label: "i9 summary tab",
  });
  await page.waitForLoadState("domcontentloaded", { timeout: 10_000 }).catch(() => {});
  await page.waitForTimeout(500);
}

async function waitForSummaryView(page: Page): Promise<void> {
  const summaryAnchor = summarySelectors.heading(page)
    .or(page.getByText("Electronic I-9 Audit Trail")) // allow-inline-selector -- summary tab audit-history anchor
    .or(page.getByText("Audit History")); // allow-inline-selector -- summary tab fallback anchor
  await summaryAnchor.first().waitFor({ state: "visible", timeout: 10_000 });
}
