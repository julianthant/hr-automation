import type { Page, FrameLocator } from "playwright";
import { log } from "../../utils/log.js";
import { UCPATH_SMART_HR_URL } from "../../config.js";
import { errorMessage } from "../../utils/errors.js";
import { debugScreenshot } from "../../utils/screenshot.js";
import { personSearch, hrTasks } from "./selectors.js";

// Re-exports for API stability — selectors.ts is the source of truth.
export { getContentFrame } from "./selectors.js";
// Dismiss the PeopleSoft page-level modal mask that can linger after tab
// switches. Legacy name alias — implementation lives in
// src/systems/common/modal.ts.
export { dismissPeopleSoftModalMask as dismissModalMask } from "../common/modal.js";

// verified 2026-03-16 -- must use ucphrprdpub domain (same as auth session), not ucpath domain
const SMART_HR_URL = UCPATH_SMART_HR_URL;

/**
 * Waits for PeopleSoft spinner/processing indicators to appear then disappear.
 * Catches errors silently since the spinner may not appear for every action.
 *
 * This helper is PeopleSoft-specific (targets `#processing`, `#WAIT_win0`,
 * `.ps_box-processing`, `[id*='PROCESSING']`) and lives here rather than in
 * `src/systems/common/` because no other system uses those anchors.
 *
 * @param frame - PeopleSoft content iframe FrameLocator
 * @param timeoutMs - Maximum time to wait (default 10_000ms)
 */
export async function waitForPeopleSoftProcessing(
  frame: FrameLocator,
  timeoutMs = 10_000,
): Promise<void> {
  // PeopleSoft processing indicators. These are not Playwright selectors for
  // user input — they are spinner probes scoped to this helper. allow-inline-selector
  const processingSelector =
    "#processing, #WAIT_win0, .ps_box-processing, [id*='PROCESSING']"; // allow-inline-selector

  try {
    // Wait for spinner to appear (short timeout -- it may not appear at all)
    await frame
      .locator(processingSelector) // allow-inline-selector
      .first()
      .waitFor({ state: "visible", timeout: 2_000 });

    // Spinner appeared -- wait for it to disappear
    await frame
      .locator(processingSelector) // allow-inline-selector
      .first()
      .waitFor({ state: "hidden", timeout: timeoutMs });
  } catch {
    // Spinner did not appear or already disappeared -- that is fine
  }
}

export interface PersonSearchResult {
  found: boolean;
  matches?: Array<{ emplId: string; firstName: string; lastName: string }>;
}

/**
 * Search for a person in UCPath to check for duplicates before creating a transaction.
 * Navigates to HR Tasks, fills the person search form, and returns whether a match was found.
 *
 * @param page - Playwright page (already authenticated to UCPath)
 * @param ssn - National ID (SSN without dashes, e.g. "123456789")
 * @param firstName - Legal first name
 * @param lastName - Legal last name
 * @param dob - Date of birth in MM/DD/YYYY format
 */
export async function searchPerson(
  page: Page,
  ssn: string,
  firstName: string,
  lastName: string,
  dob: string,
): Promise<PersonSearchResult> {
  log.step("Navigating to HR Tasks for person search...");
  await page.goto(SMART_HR_URL, {
    waitUntil: "domcontentloaded",
    timeout: 30_000,
  });
  await page.waitForTimeout(5_000);
  await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});

  const frame = page.frameLocator("#main_target_win0"); // allow-inline-selector -- see selectors.ts getContentFrame

  // PAGE 1: Search Type = Person, Parameter = PERSON_SEARCH
  log.step("Setting search type to Person...");
  await personSearch.searchTypeSelect(frame).selectOption("P", { timeout: 10_000 });
  await page.waitForTimeout(5_000);
  await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});

  await personSearch
    .parameterCodeInput(frame)
    .fill("PERSON_SEARCH", { timeout: 10_000 });
  await personSearch.loadFormButton(frame).click({ timeout: 10_000 });
  await page.waitForTimeout(5_000);
  await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
  log.step("Person search form loaded");

  // PAGE 2: Fill search criteria
  await personSearch.resultCodeInput(frame).fill("PERSON_RESULTS", { timeout: 10_000 });
  await personSearch.ssnInput(frame).fill(ssn, { timeout: 10_000 });
  await personSearch.firstNameInput(frame).fill(firstName, { timeout: 10_000 });
  await personSearch.lastNameInput(frame).fill(lastName, { timeout: 10_000 });
  await personSearch.dobInput(frame).fill(dob, { timeout: 10_000 });
  log.step("Search criteria filled");

  // Click National Id magnifying glass — triggers PeopleSoft validation
  log.step("Clicking National Id lookup...");
  await personSearch.ssnLookupButton(frame).click({ timeout: 10_000 });
  await page.waitForTimeout(5_000);
  await debugScreenshot(page, "debug-ps-after-magnify", { fullPage: true });

  // Helper: dismiss PeopleSoft modal dialog (#ICOK button) via JS.
  // Playwright locator.click() cannot bypass PeopleSoft's modal mask overlay,
  // so we use frame.evaluate() to call .click() directly on the #ICOK button.
  // This is a JS eval path — not a Playwright locator — so it stays inline.
  // verified 2026-04-01 (button is <input id="#ICOK" onclick="closeMsg(this)">)
  const dismissDialog = async (): Promise<boolean> => {
    for (const f of page.frames()) {
      const clicked = await f.evaluate(() => {
        const btn = document.getElementById("#ICOK");
        if (btn) { btn.click(); return true; }
        return false;
      }).catch(() => false);
      if (clicked) return true;
    }
    return false;
  };

  // Dismiss dialog if present after magnifying glass (just a step to get through)
  const magnifyDialogDismissed = await dismissDialog();
  if (magnifyDialogDismissed) {
    log.step("Dismissed National Id dialog");
  }
  await page.waitForTimeout(3_000);
  await debugScreenshot(page, "debug-ps-after-magnify-ok", { fullPage: true });

  // Click Search
  log.step("Clicking Search...");
  await personSearch.searchSubmitButton(frame).click({ timeout: 10_000 });
  await page.waitForTimeout(5_000);
  await debugScreenshot(page, "debug-ps-after-search", { fullPage: true });

  // Determination: dialog after Search = new hire, results table = rehire.
  const searchDialogDismissed = await dismissDialog();
  await page.waitForTimeout(3_000);
  await debugScreenshot(page, "debug-ps-search-result", { fullPage: true });

  if (searchDialogDismissed) {
    // Dialog appeared after Search → new hire
    log.step("No duplicate found — person is a new hire");
    return { found: false };
  }

  // No dialog after Search → results table appeared → rehire
  log.step("Duplicate person found in UCPath!");
  try {
    const rows = await personSearch
      .resultRows(frame)
      .evaluateAll((els) =>
        els.map((row) => {
          const cells = Array.from(row.querySelectorAll("td, th"));
          const emplId = cells.find((c) => /^\d{5,}$/.test(c.textContent?.trim() ?? ""))?.textContent?.trim() ?? "";
          const allText = cells.map((c) => c.textContent?.trim()).filter(Boolean);
          return {
            emplId,
            firstName: allText[3] ?? "",
            lastName: allText[5] ?? "",
          };
        }),
      );
    const validRows = rows.filter((r) => r.emplId);
    return { found: true, matches: validRows.length > 0 ? validRows : undefined };
  } catch {
    return { found: true };
  }
}

/**
 * Navigate to the Smart HR Transactions page in UCPath.
 *
 * Strategy A (preferred, per user URL-param preference): Direct URL navigation.
 * Strategy B (fallback): Menu navigation through HR Tasks tiles.
 *
 * @param page - Playwright page instance (already authenticated to UCPath)
 */
export async function navigateToSmartHR(page: Page): Promise<void> {
  log.step("Navigating to Smart HR Transactions...");

  // Strategy A: Direct URL navigation (preferred per feedback_url_params.md)
  try {
    log.step("Trying direct URL navigation...");
    await page.goto(SMART_HR_URL, {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });
    await page.waitForLoadState("networkidle", { timeout: 30_000 });
    log.success("Smart HR Transactions page loaded via direct URL");
    return;
  } catch (err) {
    log.step(`Direct URL navigation failed: ${errorMessage(err)}`);
    log.step("Falling back to menu navigation...");
  }

  // Strategy B: Menu navigation fallback
  log.step("Clicking HR Tasks tile...");
  await hrTasks.tile(page).first().click({ timeout: 15_000 });
  await page.waitForLoadState("networkidle", { timeout: 15_000 });

  log.step("Clicking Smart HR Templates...");
  await hrTasks.smartHRTemplatesLink(page).click({ timeout: 15_000 });
  await page.waitForLoadState("networkidle", { timeout: 15_000 });

  log.step("Clicking Smart HR Transactions...");
  await hrTasks.smartHRTransactionsLink(page).click({ timeout: 15_000 });
  await page.waitForLoadState("networkidle", { timeout: 15_000 });

  log.success("Smart HR Transactions page loaded via menu navigation");
}
