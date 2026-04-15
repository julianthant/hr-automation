import type { Page, FrameLocator } from "playwright";
import { log } from "../../utils/log.js";
import { UCPATH_SMART_HR_URL } from "../../config.js";
import { errorMessage } from "../../utils/errors.js";
import { debugScreenshot } from "../../utils/screenshot.js";

// SELECTOR: verified v1.2 -- must use ucphrprdpub domain (same as auth session), not ucpath domain
const SMART_HR_URL = UCPATH_SMART_HR_URL;

/**
 * Returns the PeopleSoft content iframe FrameLocator.
 * UCPath wraps Classic content in #main_target_win0 (not #ptifrmtgtframe).
 * Every form interaction after initial navigation must go through this frame.
 * SELECTOR: verified v1.3 -- iframe ID is main_target_win0
 */
export function getContentFrame(page: Page): FrameLocator {
  return page.frameLocator("#main_target_win0");
}

/**
 * Waits for PeopleSoft spinner/processing indicators to appear then disappear.
 * Catches errors silently since the spinner may not appear for every action.
 *
 * @param frame - PeopleSoft content iframe FrameLocator
 * @param timeoutMs - Maximum time to wait (default 10_000ms)
 */
export async function waitForPeopleSoftProcessing(
  frame: FrameLocator,
  timeoutMs = 10_000,
): Promise<void> {
  // SELECTOR: PeopleSoft processing indicators -- adjust after live testing
  const processingSelector =
    "#processing, #WAIT_win0, .ps_box-processing, [id*='PROCESSING']";

  try {
    // Wait for spinner to appear (short timeout -- it may not appear at all)
    await frame
      .locator(processingSelector)
      .first()
      .waitFor({ state: "visible", timeout: 2_000 });

    // Spinner appeared -- wait for it to disappear
    await frame
      .locator(processingSelector)
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
 * All selectors verified interactively v2.1 against live UCPath.
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

  const frame = getContentFrame(page);

  // PAGE 1: Search Type = Person, Parameter = PERSON_SEARCH
  // SELECTOR: verified v1.4
  log.step("Setting search type to Person...");
  await frame.locator("#HCR_SM_PARM_VW_SM_TYPE").selectOption("P", { timeout: 10_000 });
  await page.waitForTimeout(5_000);
  await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});

  await frame.locator("#HCR_SM_PARM_VW_SM_PARM_CD").fill("PERSON_SEARCH", { timeout: 10_000 });
  await frame.locator("#PTS_CFG_CL_WRK_PTS_SRCH_BTN").click({ timeout: 10_000 });
  await page.waitForTimeout(5_000);
  await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
  log.step("Person search form loaded");

  // PAGE 2: Fill search criteria
  // SELECTOR: all verified v1.7/v2.0 — use [id=""] attribute selectors for $ in IDs
  await frame.locator('[id="DERIVED_HCR_SM_SM_RSLT_CD"]').fill("PERSON_RESULTS", { timeout: 10_000 });
  await frame.locator('[id="DERIVED_HCR_SM_SM_CHAR_INPUT$0"]').fill(ssn, { timeout: 10_000 });
  await frame.locator('[id="DERIVED_HCR_SM_SM_CHAR_INPUT$1"]').fill(firstName, { timeout: 10_000 });
  await frame.locator('[id="DERIVED_HCR_SM_SM_CHAR_INPUT$2"]').fill(lastName, { timeout: 10_000 });
  await frame.locator('[id="DERIVED_HCR_SM_SM_DATE_INPUT$3"]').fill(dob, { timeout: 10_000 });
  log.step("Search criteria filled");

  // Click National Id magnifying glass — triggers PeopleSoft validation
  // SELECTOR: verified v2.2 — ID is $prompt$0 (not $0$prompt)
  log.step("Clicking National Id lookup...");
  await frame.locator('[id="DERIVED_HCR_SM_SM_CHAR_INPUT$prompt$0"]').click({ timeout: 10_000 });
  await page.waitForTimeout(5_000);
  await debugScreenshot(page, "debug-ps-after-magnify", { fullPage: true });

  // Helper: dismiss PeopleSoft modal dialog (#ICOK button) via JS.
  // Playwright locator.click() cannot bypass PeopleSoft's modal mask overlay,
  // so we use frame.evaluate() to call .click() directly on the #ICOK button.
  // SELECTOR: verified v2.2 — button is <input id="#ICOK" onclick="closeMsg(this)">
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
  // SELECTOR: verified v2.2
  const magnifyDialogDismissed = await dismissDialog();
  if (magnifyDialogDismissed) {
    log.step("Dismissed National Id dialog");
  }
  await page.waitForTimeout(3_000);
  await debugScreenshot(page, "debug-ps-after-magnify-ok", { fullPage: true });

  // Click Search — SELECTOR: verified v2.2
  log.step("Clicking Search...");
  await frame.locator("#DERIVED_HCR_SM_SM_SEARCH_BTN").click({ timeout: 10_000 });
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
    const rows = await frame.locator('[id*="SEARCH_RESULT"] tr, .PSLEVEL1GRID tr').filter({ hasText: /\d{5,}/ }).evaluateAll((els) =>
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
  // SELECTOR: HR Tasks tile -- adjust after live testing
  log.step("Clicking HR Tasks tile...");
  const hrTasksLink = page
    .getByRole("link", { name: /HR Tasks/i })
    .or(page.getByText("HR Tasks"));
  await hrTasksLink.first().click({ timeout: 15_000 });
  await page.waitForLoadState("networkidle", { timeout: 15_000 });

  // SELECTOR: Smart HR Templates link -- adjust after live testing
  log.step("Clicking Smart HR Templates...");
  await page.getByText("Smart HR Templates").click({ timeout: 15_000 });
  await page.waitForLoadState("networkidle", { timeout: 15_000 });

  // SELECTOR: Smart HR Transactions link -- adjust after live testing
  log.step("Clicking Smart HR Transactions...");
  await page.getByText("Smart HR Transactions").click({ timeout: 15_000 });
  await page.waitForLoadState("networkidle", { timeout: 15_000 });

  log.success("Smart HR Transactions page loaded via menu navigation");
}
