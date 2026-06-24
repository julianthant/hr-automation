import type { Page, FrameLocator } from "playwright";
import { log } from "../../utils/log.js";
import { UCPATH_SMART_HR_URL } from "../../config.js";
import { errorMessage } from "../../utils/errors.js";
import { debugScreenshot } from "../../utils/screenshot.js";
import { personSearch, hrTasks, smartHR } from "./selectors.js";
import { safeClick, safeFill } from "../common/index.js";

// Re-exports for API stability — selectors.ts is the source of truth.
export { getContentFrame } from "./selectors.js";

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
    const probe = frame.locator(processingSelector).first(); // allow-inline-selector
    // Wait for spinner to appear (short timeout -- it may not appear at all)
    await probe.waitFor({ state: "visible", timeout: 2_000 });

    // Spinner appeared -- wait for it to disappear
    await probe.waitFor({ state: "hidden", timeout: timeoutMs });
  } catch {
    // Spinner did not appear or already disappeared -- that is fine
  }
}

export async function collapseSidebar(
  page: Page,
  opts: { onlyIfExpanded?: boolean; quiet?: boolean } = {},
): Promise<void> {
  try {
    const navBtn = smartHR.sidebarNavigationToggle(page);
    if (!opts.onlyIfExpanded || await navBtn.getAttribute("aria-expanded") === "true") {
      await safeClick(navBtn, { timeout: 5_000, label: "ucpath sidebar navigation toggle" });
      await page.waitForTimeout(1_000);
      if (!opts.quiet) log.step("Sidebar collapsed");
    }
  } catch {
    if (!opts.quiet) log.step("Sidebar collapse failed (non-fatal) — may already be collapsed");
  }
}

/** Click the PeopleSoft modal OK button (#ICOK) in whichever frame holds it.
 *  Playwright can't click behind the PS modal mask, so we JS-click by id.
 *  (The live button's id literally contains '#'.)
 *  verified 2026-04-01 (button is <input id="#ICOK" onclick="closeMsg(this)">)
 */
export async function dismissPeopleSoftDialog(page: Page): Promise<boolean> {
  for (const f of page.frames()) {
    const clicked = await f.evaluate(() => {
      const btn = document.getElementById("#ICOK");
      if (btn) { btn.click(); return true; }
      return false;
    }).catch(() => false);
    if (clicked) return true;
  }
  return false;
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
  // networkidle alone guards the transition; the preceding sleep was redundant.
  await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});

  const frame = page.frameLocator("#main_target_win0"); // allow-inline-selector -- see selectors.ts getContentFrame

  // PAGE 1: Search Type = Person, Parameter = PERSON_SEARCH
  log.step("Setting search type to Person...");
  await personSearch.searchTypeSelect(frame).selectOption("P", { timeout: 10_000 });
  // networkidle guards the PeopleSoft roundtrip after selectOption.
  await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});

  await safeFill(personSearch.parameterCodeInput(frame), "PERSON_SEARCH", {
    timeout: 10_000,
    label: "ucpath person search parameter code",
  });
  await safeClick(personSearch.loadFormButton(frame), {
    timeout: 10_000,
    label: "ucpath load person search form button",
  });
  // networkidle guards the form reload after Load Form; sleep was redundant.
  await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
  log.step("Person search form loaded");

  // PAGE 2: Fill search criteria
  await safeFill(personSearch.resultCodeInput(frame), "PERSON_RESULTS", {
    timeout: 10_000,
    label: "ucpath person search result code",
  });
  await safeFill(personSearch.ssnInput(frame), ssn, {
    timeout: 10_000,
    label: "ucpath person search ssn",
  });
  await safeFill(personSearch.firstNameInput(frame), firstName, {
    timeout: 10_000,
    label: "ucpath person search first name",
  });
  await safeFill(personSearch.lastNameInput(frame), lastName, {
    timeout: 10_000,
    label: "ucpath person search last name",
  });
  await safeFill(personSearch.dobInput(frame), dob, {
    timeout: 10_000,
    label: "ucpath person search dob",
  });
  log.step("Search criteria filled");

  // Click National Id magnifying glass — triggers PeopleSoft validation
  log.step("Clicking National Id lookup...");
  await safeClick(personSearch.ssnLookupButton(frame), {
    timeout: 10_000,
    label: "ucpath national id lookup button",
  });
  // The magnify button triggers a PeopleSoft dialog (or networkidle roundtrip).
  // Guard with networkidle so we don't read a mid-flight DOM.
  await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
  await debugScreenshot(page, "debug-ps-after-magnify", { fullPage: true });

  // Dismiss dialog if present after magnifying glass (just a step to get through)
  const magnifyDialogDismissed = await dismissPeopleSoftDialog(page);
  if (magnifyDialogDismissed) {
    log.step("Dismissed National Id dialog");
    // Short settle after JS dialog dismiss — no networkidle signal available.
    await page.waitForTimeout(1_000);
  }
  await debugScreenshot(page, "debug-ps-after-magnify-ok", { fullPage: true });

  // Click Search
  log.step("Clicking Search...");
  await safeClick(personSearch.searchSubmitButton(frame), {
    timeout: 10_000,
    label: "ucpath person search submit button",
  });
  // networkidle guards the search-results load.
  await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
  await debugScreenshot(page, "debug-ps-after-search", { fullPage: true });

  // Determination: dialog after Search = new hire, results table = rehire.
  const searchDialogDismissed = await dismissPeopleSoftDialog(page);
  if (searchDialogDismissed) {
    // Short settle after JS dialog dismiss; no networkidle signal available.
    await page.waitForTimeout(1_000);
  }
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
  await safeClick(hrTasks.tile(page).first(), { timeout: 15_000, label: "ucpath hr tasks tile" });
  await page.waitForLoadState("networkidle", { timeout: 15_000 });

  log.step("Clicking Smart HR Templates...");
  await safeClick(hrTasks.smartHRTemplatesLink(page), {
    timeout: 15_000,
    label: "ucpath smart hr templates menu link",
  });
  await page.waitForLoadState("networkidle", { timeout: 15_000 });

  log.step("Clicking Smart HR Transactions...");
  await safeClick(hrTasks.smartHRTransactionsLink(page), {
    timeout: 15_000,
    label: "ucpath smart hr transactions menu link",
  });
  await page.waitForLoadState("networkidle", { timeout: 15_000 });

  log.success("Smart HR Transactions page loaded via menu navigation");
}
