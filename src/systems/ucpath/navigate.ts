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

/**
 * Non-destructive presence probe for the PeopleSoft #ICOK confirmation dialog —
 * the read-only counterpart of {@link dismissPeopleSoftDialog} (it looks but does
 * NOT click). Used to RACE the dialog against the results grid when classifying a
 * person-search outcome, so we don't dismiss the dialog before we've decided.
 */
export async function isPeopleSoftDialogPresent(page: Page): Promise<boolean> {
  for (const f of page.frames()) {
    const present = await f
      .evaluate(() => document.getElementById("#ICOK") !== null)
      .catch(() => false);
    if (present) return true;
  }
  return false;
}

/**
 * Wait for the Search/Match Search button (`DERIVED_HCR_SM_SM_SEARCH_BTN`) to
 * become ENABLED before clicking it. PeopleSoft renders the button DISABLED
 * (class `PSPUSHBUTTONDISABLED`, the `disabled` DOM property set) until the
 * filled criteria satisfy a search order (10 NID Only / 20 Legal Name+Bday+NID /
 * 30 Legal First Name+DOB). Each criteria fill fires a FieldChange server
 * roundtrip that re-renders the button and only then flips it to enabled; a click
 * while it is still disabled just times out. Bounded best-effort poll — the
 * subsequent `safeClick` actionability wait is the backstop, so we never hard-fail
 * here (a truly unsearchable record is already caught upstream by
 * {@link personSearchCriteriaSufficient}).
 *
 * Live 2026-07-01 (dummy NID 123456789 + Test/Person + 01/01/2000): filling the
 * criteria ALONE flips the button to `PSPUSHBUTTON` (enabled) and the click
 * advances straight to the results grid — NO National Id magnifier needed. The
 * magnifier only raised a "There are no prompt values currently available for
 * this field" dialog whose MAIN-PAGE `#pt_modalMask` (z-index 210, rendered
 * OUTSIDE `#main_target_win0`) then intercepted the in-frame Search click for the
 * full 10 s — the exact person-search timeout this replaces.
 */
async function waitForPersonSearchButtonEnabled(
  page: Page,
  frame: FrameLocator,
  timeoutMs = 10_000,
): Promise<void> {
  const btn = personSearch.searchSubmitButton(frame);
  await btn
    .waitFor({ state: "visible", timeout: Math.min(timeoutMs, 10_000) })
    .catch(() => {});
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await btn.isEnabled().catch(() => false)) return;
    await page.waitForTimeout(300);
  }
  log.warn(
    "Person-search Search button still disabled after wait — clicking anyway (safeClick actionability is the backstop)",
  );
}

/**
 * Fire the National Id lookup magnifier, then clear the dialog it raises.
 *
 * The magnifier's click is LOAD-BEARING: it fires the PeopleSoft FieldChange
 * postback that flips the Search button from `PSPUSHBUTTONDISABLED` to enabled.
 * Live 2026-07-01 (real DAEMON flow): filling the criteria alone does NOT enable
 * Search — the button stayed disabled and the click timed out ("Search button
 * still disabled"). (An earlier interactive playwright-cli check enabled Search
 * from the fills, but the automated back-to-back `safeFill` sequence does not
 * commit the FieldChange the same way — the magnifier's postback does.)
 *
 * The National Id field has no prompt table, so the magnifier ALSO raises a
 * "There are no prompt values currently available for this field" dialog whose
 * `#ICOK` button and `#pt_modalMask` overlay both render on the MAIN page
 * (z-index 210, OUTSIDE `#main_target_win0`). That mask intercepts the in-frame
 * Search click until dismissed. The dialog renders client-side slightly AFTER the
 * magnifier click (no reliable networkidle signal), so a one-shot dismiss raced
 * it and left the mask up — we POLL for the dialog, dismiss the main-page `#ICOK`
 * (`dismissPeopleSoftDialog` scans every frame incl. main), and confirm the
 * main-page mask has cleared, retrying a few times.
 */
async function fireNationalIdLookupAndClearDialog(page: Page, frame: FrameLocator): Promise<void> {
  await safeClick(personSearch.ssnLookupButton(frame), {
    timeout: 10_000,
    label: "ucpath national id lookup button",
  });
  const mask = page.locator("#pt_modalMask, .ps_modalmask").first(); // allow-inline-selector -- main-page PeopleSoft modal overlay
  for (let attempt = 0; attempt < 4; attempt++) {
    // Wait for the client-side dialog to actually render before dismissing it.
    for (let i = 0; i < 10; i++) {
      if (await isPeopleSoftDialogPresent(page)) break;
      await page.waitForTimeout(300);
    }
    if (await dismissPeopleSoftDialog(page)) {
      await page.waitForTimeout(500); // let closeMsg() tear the mask down
    }
    const cleared = await mask
      .waitFor({ state: "hidden", timeout: 3_000 })
      .then(() => true)
      .catch(() => false);
    if (cleared) return;
  }
  log.warn(
    "Person-search: National Id lookup dialog/mask may still be up after retries — proceeding (safeClick actionability is the backstop)",
  );
}

/** Which definitive person-search outcome resolved first. */
export type PersonSearchSignal = "duplicate-dialog" | "results-grid" | "none";

/**
 * Pure classification of a person-search outcome signal.
 *
 * - `"results-grid"` (the search results table listing matching people) →
 *   REHIRE (`found: true`).
 * - `"duplicate-dialog"` (the "no matching person" confirmation dialog raised
 *   after Search) → NEW HIRE (`found: false`).
 * - `"none"` (neither appeared within the bounded race) → AMBIGUOUS; the caller
 *   must FAIL LOUD (throw) rather than guess — guessing can misclassify a rehire
 *   as a new hire and create a DUPLICATE PERSON.
 *
 * Extracted as a pure function so the new-hire-vs-rehire decision is unit-pinned
 * without a live page.
 */
export function classifyPersonSearchSignal(
  signal: PersonSearchSignal,
): { found: boolean; ambiguous: boolean } {
  if (signal === "results-grid") return { found: true, ambiguous: false };
  if (signal === "duplicate-dialog") return { found: false, ambiguous: false };
  return { found: false, ambiguous: true };
}

/**
 * Can UCPath person search even run with these criteria? UCPath offers only
 * NID-based or DOB-based search orders (live page: "NID Only" / "Legal Name +
 * Bday + NID" / "Legal First Name + DOB"). A record with NEITHER a National ID
 * (SSN) NOR a Date of Birth satisfies none of them, so the Search button stays
 * DISABLED and any click just times out. Pure predicate so the "can we even
 * search?" gate is unit-pinned. (Live: juzaw@ucsd.edu — no SSN + no DOB → Search
 * greyed out; the click timed out 10s ×2 before this guard existed.)
 */
export function personSearchCriteriaSufficient(ssn: string, dob: string): boolean {
  return ssn.trim().length > 0 || dob.trim().length > 0;
}

/**
 * RACE the two definitive person-search outcomes — {results grid carrying an
 * employee-id row} vs {#ICOK confirmation dialog present} — polling until one is
 * actually there (bounded by `timeoutMs`). The grid is checked FIRST each tick so
 * a real rehire's grid wins over a lingering post-magnify dialog: misclassifying
 * a rehire as a new hire would create a DUPLICATE PERSON. Returns `"none"` if
 * neither resolves in time (caller falls back to the legacy single probe).
 */
async function raceNewHireVsRehireSignal(
  page: Page,
  frame: FrameLocator,
  opts: { timeoutMs?: number; pollMs?: number } = {},
): Promise<PersonSearchSignal> {
  const { timeoutMs = 15_000, pollMs = 500 } = opts;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const gridRows = await personSearch.resultRows(frame).count().catch(() => 0);
    if (gridRows > 0) return "results-grid";
    if (await isPeopleSoftDialogPresent(page)) return "duplicate-dialog";
    await page.waitForTimeout(pollMs);
  }
  return "none";
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

  // Fail LOUD + actionable when the record can't be searched at all. UCPath
  // person search needs an SSN or a DOB (see personSearchCriteriaSufficient); a
  // name-only record leaves the Search button DISABLED, so clicking it just
  // times out 10s ×2 and the run fails with an opaque "Timed out" error. Bail
  // early with a message the operator can act on (live: juzaw@ucsd.edu).
  if (!personSearchCriteriaSufficient(ssn, dob)) {
    await debugScreenshot(page, "debug-ps-insufficient-criteria", { fullPage: true });
    throw new Error(
      `Cannot check UCPath for a duplicate person: the record for `
      + `"${firstName} ${lastName}" has neither an SSN nor a Date of Birth, and `
      + `UCPath person search requires a National ID or Date of Birth. `
      + `Add a DOB or SSN to the CRM record and re-run.`,
    );
  }

  // Fire the National Id lookup magnifier: its FieldChange postback is what
  // ENABLES the Search button in the automated flow (filling the criteria alone
  // does NOT — live daemon 2026-07-01: "Search button still disabled"). The
  // magnifier also raises a "no prompt values" dialog whose MAIN-PAGE mask blocks
  // the Search click; `fireNationalIdLookupAndClearDialog` dismisses it (main-page
  // `#ICOK`) and waits for that mask to clear. Then confirm Search is enabled.
  await fireNationalIdLookupAndClearDialog(page, frame);
  await waitForPersonSearchButtonEnabled(page, frame);

  // Click Search
  log.step("Clicking Search...");
  await safeClick(personSearch.searchSubmitButton(frame), {
    timeout: 10_000,
    label: "ucpath person search submit button",
  });
  // networkidle guards the search-results load.
  await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
  await debugScreenshot(page, "debug-ps-after-search", { fullPage: true });

  // Determination: RACE the two definitive outcomes — results grid (rehire) vs
  // #ICOK confirmation dialog (new hire) — instead of sampling a single
  // dismissPeopleSoftDialog probe right after networkidle. That single probe
  // could read the page BEFORE either the dialog or the results grid had
  // rendered and, finding no dialog yet, misclassify a real rehire as a new hire
  // — which then creates a DUPLICATE PERSON. We now wait until one is actually
  // present before deciding.
  const signal = await raceNewHireVsRehireSignal(page, frame, { timeoutMs: 15_000 });
  log.step(`Person-search outcome signal: ${signal}`);
  const decision = classifyPersonSearchSignal(signal);
  const found = decision.found;

  if (decision.ambiguous) {
    // Neither definitive signal resolved in the window. Falling back to a
    // one-shot legacy dialog probe here is the exact race this function was
    // rewritten to avoid: a slow-rendering rehire results grid can still read
    // as "no dialog" and get misclassified as a new hire — creating a
    // DUPLICATE PERSON record. Fail loud instead of guessing.
    await debugScreenshot(page, "debug-ps-ambiguous-outcome", { fullPage: true });
    throw new Error(
      `Cannot determine new-hire-vs-rehire for "${firstName} ${lastName}" in UCPath `
      + `person search: neither the results grid nor the "no matching person" dialog `
      + `appeared within the search window. Proceeding on a guess risks creating a `
      + `DUPLICATE PERSON record. Re-run the search or verify manually in UCPath.`,
    );
  } else if (signal === "duplicate-dialog") {
    // Confirmed new hire → dismiss the confirmation dialog before returning.
    await dismissPeopleSoftDialog(page);
    await page.waitForTimeout(1_000);
  }
  await debugScreenshot(page, "debug-ps-search-result", { fullPage: true });

  if (!found) {
    log.step("No duplicate found — person is a new hire");
    return { found: false };
  }

  // Results grid present → rehire
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
