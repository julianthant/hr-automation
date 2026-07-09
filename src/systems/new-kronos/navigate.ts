import { mkdirSync, writeFileSync } from "fs";
import type { Page, Locator } from "playwright";
import { PATHS } from "../../config.js";
import { log } from "../../utils/log.js";
import { debugScreenshot } from "../../utils/screenshot.js";
import {
  searchFrame,
  loadingOverlay,
  navbar,
  search as searchSelectors,
  goToMenu,
  timecard,
  people,
  peopleFrame,
  resolvePeopleRoot,
  type SearchRoot,
  type PeopleRoot,
} from "./selectors.js";
import { clickIfPresent, safeClick, safeFill, checkDisplayedIdentity } from "../common/index.js";
import { gotoWithRetry } from "../../infra/browser/launch.js";
import {
  formatTimecardDate,
  runTimecardCheck,
  didPeriodLabelSwitch,
  type TimecardDriver,
} from "../../services/timecard/index.js";

export const NEW_KRONOS_URL = "https://ucsd-sso.prd.mykronos.com/wfd/home";

/**
 * The WFD Employee Search sidebar renders its input/results either INSIDE the
 * portal-frame iframe (fresh page load) or TOP-LEVEL on the page (e.g. when
 * reached after a timecard navigation). Probe the iframe first; fall back to
 * the top-level page so search works in BOTH contexts. (2026-06-18: the
 * iframe-only assumption caused `locator.fill: Timeout` on the top-level
 * variant — EID 10602099.)
 */
async function resolveSearchRoot(page: Page): Promise<SearchRoot> {
  const frame = searchFrame(page);
  try {
    await searchSelectors.searchInput(frame).waitFor({ state: "visible", timeout: 4_000 });
    return frame;
  } catch {
    // Not in the iframe — fall back to the top-level page. Best-effort wait so
    // the caller's safeFill gets a present element (or surfaces a clear error).
    try {
      await searchSelectors.searchInput(page).waitFor({ state: "visible", timeout: 4_000 });
    } catch {
      /* Neither context shows it yet — return the page; safeFill will report. */
    }
    return page;
  }
}

/**
 * Resolve a New Kronos employee search into found / not-found.
 *
 * Races a "result present" waiter (→ found) against the "no items" sentinel
 * (→ not found). The found waiter is built by the caller as a robust signal —
 * the result checkbox ATTACHED **or** the result slat visible — because the
 * "Select Item" checkbox is visually hidden and waiting on its visibility never
 * resolves (see `searchEmployee`). If NEITHER surfaces within the timeout (both
 * waiters reject), the search is treated as **NOT FOUND** rather than thrown
 * (ISS-B04). New Kronos is a BEST-EFFORT source for the separations Last Day
 * Worked — the handler falls back to the Kuali LDW when New Kronos returns no
 * punch — so a slow/empty grid must not raise a fatal-looking `✗` and burn the
 * run; a `log.warn` keeps it visible without masquerading as a failure.
 * (Genuinely cutting the timeout wait needs the live no-results sentinel
 * re-mapped if it has drifted — that's why a no-record employee currently waits
 * the full timeout before this returns false.)
 *
 * Exported for unit testing: it takes the two waiter promises directly, so the
 * race + timeout-as-not-found contract is pinnable without a live page.
 */
/**
 * Pure outcome for one poll tick of the employee-search sidebar. When WFD is
 * loading results it can briefly show BOTH the "no items to display" sentinel
 * AND the result checkbox/slat — found must win (live 2026-07-06, EID
 * 10714794: at t+100ms noResults=true while checkbox count=1, so a naive
 * Promise.race mis-resolved NOT FOUND in ~1s).
 */
export function resolveSearchPresence(
  hasResult: boolean,
  noResults: boolean,
): "found" | "not-found" | "pending" {
  if (hasResult) return "found";
  if (noResults) return "not-found";
  return "pending";
}

/** True when the given search root shows at least one employee result. */
export async function searchResultPresentInRoot(
  root: SearchRoot,
  employeeId: string,
): Promise<boolean> {
  if ((await searchSelectors.firstResultCheckbox(root).count()) > 0) return true;
  if (await searchSelectors.firstResultSlat(root).isVisible().catch(() => false)) return true;
  if (await searchSelectors.resultEmployeeId(root, employeeId).isVisible().catch(() => false)) {
    return true;
  }
  return false;
}

/**
 * Poll BOTH search contexts (portal-frame iframe + top-level page) until an
 * employee result appears, a genuine no-results state settles, or timeout.
 * Found signals always beat the no-results sentinel so a transient overlap
 * during grid load cannot false-negative a present employee.
 */
async function waitForEmployeeSearchOutcome(
  page: Page,
  employeeId: string,
  timeoutMs: number,
): Promise<boolean> {
  const contexts: SearchRoot[] = [searchFrame(page), page];
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    let hasResult = false;
    for (const root of contexts) {
      if (await searchResultPresentInRoot(root, employeeId)) {
        hasResult = true;
        break;
      }
    }

    let noResults = false;
    for (const root of contexts) {
      if (await searchSelectors.noResultsText(root).isVisible().catch(() => false)) {
        noResults = true;
        break;
      }
    }

    const outcome = resolveSearchPresence(hasResult, noResults);
    if (outcome === "found") return true;
    if (outcome === "not-found") return false;

    await page.waitForTimeout(200);
  }

  log.warn(
    `[New Kronos] No search results surfaced for ${employeeId} within the timeout — ` +
    `treating as NOT FOUND (best-effort; Kuali Last Day Worked will be used).`,
  );
  return false;
}

export async function resolveSearchResult(
  resultPresent: Promise<unknown>,
  noResultsVisible: Promise<unknown>,
  employeeId: string,
): Promise<boolean> {
  const foundP = resultPresent.then(() => true);
  const notFoundP = noResultsVisible.then(() => false);
  // Handle the losing waiter's eventual rejection so it doesn't surface as an
  // unhandled rejection; the race below still observes the winner's settlement.
  foundP.catch(() => {});
  notFoundP.catch(() => {});
  try {
    return await Promise.race([foundP, notFoundP]);
  } catch {
    log.warn(
      `[New Kronos] No search results surfaced for ${employeeId} within the timeout — ` +
      `treating as NOT FOUND (best-effort; Kuali Last Day Worked will be used).`,
    );
    return false;
  }
}

/**
 * Search for an employee by ID in the new Kronos (WFD) system.
 * Clicks the "Employee Search" button in the navbar, fills the search input,
 * and checks if results are found.
 *
 * The search sidebar is inside an iframe named "portal-frame-*".
 *
 * @param page - Playwright page (already authenticated to new Kronos)
 * @param employeeId - Employee ID to search for
 * @returns true if employee was found, false if "There are no items to display"
 */
export async function searchEmployee(
  page: Page,
  employeeId: string,
): Promise<boolean> {
  log.step(`[New Kronos] Searching for employee ${employeeId}...`);

  // Close any existing search sidebar first (prevents "2 elements" error between docs)
  await closeEmployeeSearch(page);
  await page.waitForTimeout(1_000);

  // Wait for the WFD loading overlay to clear before clicking Employee Search.
  // When the overlay is present it intercepts pointer events and the click fails
  // with "Another element intercepted the click (modal/overlay)" (2026-06-17).
  // The selector is best-effort and NEEDS LIVE RE-VERIFY — if none of the CSS
  // classes match the live Dayforce build the waitFor resolves immediately via
  // the hidden/detached check in the catch, which is safe.
  try {
    await loadingOverlay.overlay(page).waitFor({ state: "hidden", timeout: 5_000 });
  } catch {
    // Overlay absent or selector doesn't match — proceed without waiting.
  }

  // Click the Employee Search button in the navbar
  log.step("[New Kronos] Opening Employee Search sidebar...");
  await safeClick(navbar.employeeSearchButton(page), {
    timeout: 10_000,
    label: "new kronos employee search button",
  });
  await page.waitForTimeout(2_000);

  // Resolve whether the search sidebar rendered inside the portal-frame iframe
  // or top-level on the page, then target that context for fill/submit/results.
  const root = await resolveSearchRoot(page);

  // Fill the search input
  log.step(`[New Kronos] Filling search: ${employeeId}`);
  await safeFill(searchSelectors.searchInput(root), employeeId, {
    timeout: 5_000,
    label: "new kronos employee search input",
  });
  await page.waitForTimeout(500);

  // Click the Search button
  log.step("[New Kronos] Clicking Search...");
  await safeClick(searchSelectors.searchSubmitButton(root), {
    timeout: 5_000,
    label: "new kronos search submit button",
  });

  // "Somebody showed up" must be detected ROBUSTLY: we go to the timecard for
  // every employee who appears — the ONLY skips are a genuine no-results search
  // ("nobody shows up") and the upstream identity-check ("the eid is incorrect").
  //
  // The found-signal used to wait for the "Select Item" checkbox to be VISIBLE,
  // but that control is custom-styled — its backing native <input type=checkbox>
  // is zero-size/visually hidden, so `waitFor({ state: "visible" })` NEVER
  // resolves even when a result is present. A found employee (EID 10629763,
  // "Total [1]" / "Argumedo, Zaira N") therefore raced two never-resolving
  // waiters, timed out, and was mis-resolved as NOT FOUND — so the timecard step
  // was skipped entirely AND the best-effort "no results surfaced" warning fired
  // (the two symptoms are the same root cause). (2026-06-22)
  //
  // Poll BOTH contexts (iframe + top-level) and let found signals beat the
  // no-results sentinel. WFD can show BOTH briefly while the grid loads (live
  // 2026-07-06: t+100ms noResults=true AND checkbox count=1) — a Promise.race
  // between those waiters mis-resolved a found employee as NOT FOUND in ~1s.
  const searchResultTimeout = 15_000;
  const found = await waitForEmployeeSearchOutcome(page, employeeId, searchResultTimeout);

  if (found) {
    log.success(`[New Kronos] Employee ${employeeId} found`);
  } else {
    log.step(`[New Kronos] Employee ${employeeId} NOT found`);
  }

  return found;
}

/**
 * Click the checkbox on the first employee search result to select them.
 */
export async function selectEmployeeResult(page: Page): Promise<boolean> {
  log.step("[New Kronos] Selecting employee from search results...");

  // The results render in the portal-frame iframe OR top-level. After a search
  // the search INPUT collapses to "Show Search", so `resolveSearchRoot` (which
  // probes the input) can mis-detect the context here — try the result CHECKBOX
  // directly in BOTH contexts. Checking the "Select Item" checkbox is what
  // registers the slat selection that ENABLES the Go To button. (2026-06-18: the
  // daemon resolved to the wrong context and left Selected[0] / Go To disabled.)
  const contexts: SearchRoot[] = [searchFrame(page), page];
  for (const root of contexts) {
    const checkbox = searchSelectors.firstResultCheckbox(root);
    try {
      if ((await checkbox.count()) > 0) {
        await checkbox.check({ timeout: 5_000 });
        await page.waitForTimeout(1_000);
        log.step("[New Kronos] Employee checkbox checked");
        return true;
      }
    } catch {
      log.warn("[New Kronos] Result checkbox present but not checkable in this context — trying the next");
    }
  }

  // Fallback: click the result row (the `menuitemradio`) directly, in either context.
  for (const root of contexts) {
    const resultRow = searchSelectors.firstResultRow(root);
    if (await clickIfPresent(resultRow, { timeout: 3_000, label: "new kronos search result row" })) {
      await page.waitForTimeout(1_000);
      log.step("[New Kronos] Employee row clicked");
      return true;
    }
  }

  log.error("[New Kronos] Could not select employee from results");
  return false;
}

/**
 * Probe top-level page text for the searched EID on the open timecard.
 * Pure + unit-pinned — the live evaluate wrapper passes `document.body.innerText`.
 */
export function probeEidInTimecardText(
  text: string,
  searchedEid: string,
): { match: boolean; otherEid: string | null } {
  // Delegates to the shared identity primitive (`checkDisplayedIdentity`):
  // word-boundary match on the searched EID, and any competing 8-digit id on the
  // timecard reported as a positive wrong-person signal.
  const r = checkDisplayedIdentity(searchedEid, text);
  return { match: r.ok, otherEid: r.shown };
}

/**
 * Poll the open timecard until the searched EID appears in the header/text.
 * NEEDS LIVE RE-VERIFY 2026-06-29: confirm the searched EID renders as visible
 * text in the WFD timecard employee header (basis of this check).
 */
async function waitForTimecardEmployee(
  page: Page,
  eid: string,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    // TODO(live-verify): scope this to a pinpoint WFD timecard employee-header
    // selector once one can be live-mapped (needs a found employee's open
    // timecard). document.body.innerText EXCLUDES <input> values, so the searched
    // EID cannot leak from the search box. Compare/throw is routed through the
    // shared identity primitive via `probeEidInTimecardText`.
    const bodyText = await page
      .evaluate(() => document.body?.innerText ?? "")
      .catch(() => null);
    if (bodyText !== null && probeEidInTimecardText(bodyText, eid).match) return true;
    await page.waitForTimeout(500);
  }
  return false;
}

/**
 * Click Go To dropdown and select Timecard.
 * Go To may be on the main page or inside the search iframe.
 *
 * After clicking the Timecards option, polls the timecard header for the
 * searched EID — Go To can leave the PREVIOUS employee's timecard on screen
 * (live: search 10864213 but header still showed 10851756, 2026-06-29).
 * Returns false when the timecard does not switch within the timeout so the
 * caller can fail loud; `verifyTimecardEmployee` remains the downstream backstop.
 */
export async function clickGoToTimecard(page: Page, eid: string): Promise<boolean> {
  log.step("[New Kronos] Clicking Go To → Timecard...");

  const frame = searchFrame(page);
  // Go To may render in the search frame OR top-level. The button is
  // `ng-disabled` until an employee is selected, so clicking it while disabled
  // just times out — poll for whichever context's button is visible AND ENABLED
  // (up to 15s for the Angular selection from selectEmployeeResult to land).
  const candidates = [
    goToMenu.goToButtonInFrame(frame).first(),
    goToMenu.goToButtonOnPage(page).first(),
  ];
  let gotoButton: Locator | null = null;
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline && !gotoButton) {
    for (const loc of candidates) {
      try {
        if ((await loc.isVisible()) && (await loc.isEnabled())) {
          gotoButton = loc;
          break;
        }
      } catch {
        // Not present in this context — try the next candidate.
      }
    }
    if (!gotoButton) await page.waitForTimeout(500);
  }

  if (!gotoButton) {
    log.error(
      "[New Kronos] Go To button never became enabled — the employee selection " +
      "did not register (no slat selected), so the timecard cannot be opened",
    );
    return false;
  }

  // Open the dropdown, then WAIT for the Timecard option to actually render
  // before clicking — do NOT sleep a fixed 2s and check once. The old fixed
  // `waitForTimeout(2000)` + one-shot `clickIfPresent` raced the Angular
  // dropdown render: the FIRST found employee in a session rendered within 2s
  // (worked), but every SUBSEQUENT employee in a batch — heavier, already-loaded
  // WFD session — rendered the option slower, so `timecardItem.count()` was 0 at
  // the fixed checkpoint, `clickIfPresent` returned false in ~0.1s, and the run
  // silently fell back to the Kuali dates with the dropdown left open over the
  // PREVIOUS employee's timecard (2026-06-24). Condition-based waiting + one
  // dropdown re-open (the open click can be swallowed mid-render) fixes it.
  const timecardItem = goToMenu.timecardItem(page);
  await gotoButton.click({ timeout: 5_000 });

  const totalDeadline = Date.now() + 15_000;
  let reopened = false;
  while (Date.now() < totalDeadline) {
    try {
      // Wait for the option to be present AND visible (not just attached) so we
      // never click a stale/hidden element. First window is generous; if it
      // elapses with no option, re-open the dropdown once and wait longer.
      await timecardItem
        .first()
        .waitFor({ state: "visible", timeout: reopened ? 6_000 : 5_000 });
    } catch {
      if (!reopened) {
        log.warn("[New Kronos] Timecard option not visible yet — re-opening the Go To dropdown");
        reopened = true;
        try {
          await gotoButton.click({ timeout: 5_000 });
        } catch {
          // best-effort re-open; the next waitFor decides success/failure
        }
        await page.waitForTimeout(500);
        continue;
      }
      break;
    }

    // Option is rendered — click it. A failure here is real (not a missing
    // element), so fall through to the error return rather than spin.
    try {
      await safeClick(timecardItem.first(), {
        timeout: 5_000,
        label: "new kronos timecard menu item",
      });
    } catch {
      break;
    }

    // Post-click EID confirmation: the Timecards menu item can be clicked while
    // the grid still shows the PREVIOUS employee (live bug, 2026-06-29). Poll the
    // timecard header/text for the searched EID instead of a fixed sleep.
    // NEEDS LIVE RE-VERIFY 2026-06-29 — selector/header mapping not re-run here.
    try {
      await loadingOverlay.overlay(page).waitFor({ state: "hidden", timeout: 5_000 });
    } catch {
      // Overlay absent or selector drift — proceed without waiting.
    }

    const switched = await waitForTimecardEmployee(page, eid, 10_000);
    if (switched) {
      log.success(`[New Kronos] Navigated to Timecard for EID ${eid}`);
      return true;
    }

    log.error(
      `[New Kronos] Go To → Timecard clicked but the open timecard did not switch to EID ${eid} within the timeout`,
    );
    return false;
  }

  log.error(
    "[New Kronos] Timecard option never rendered in the Go To menu — could not open the timecard",
  );
  return false;
}

/** Result of confirming the open timecard belongs to the searched employee. */
export interface TimecardEmployeeCheck {
  /** True when the searched EID is shown on the open timecard header. */
  ok: boolean;
  /** A DIFFERENT 8-digit id visible on the timecard when `ok` is false (else null). */
  shownEid: string | null;
}

/**
 * Confirm the OPEN timecard belongs to the searched employee.
 *
 * The WFD timecard header shows the selected employee's EID (e.g. "10832819"
 * next to the name dropdown). When Go To → Timecard doesn't actually switch
 * employees, the PREVIOUS employee's timecard stays on screen — the live bug
 * where a search for 10603110 (Lua-Sandoval) left Yang / 10832819 displayed
 * (2026-06-24). Reading that stale grid would attribute the wrong person's
 * punches/sick/holiday to this separation.
 *
 * The search slide-out is closed FIRST so its "Results for <eid>" text can't
 * false-pass the check, then the top-level timecard text is polled for the
 * searched EID (the grid + header render top-level — `getSeparationTimecardData`
 * reads them via `page.evaluate`, not the iframe). On a miss it reports any other
 * 8-digit id found (the wrong employee) so the caller can fail loud with detail.
 *
 * NEEDS LIVE VERIFY: confirm the searched EID renders as visible text in the WFD
 * timecard employee header (the basis of this check).
 */
export async function verifyTimecardEmployee(
  page: Page,
  eid: string,
): Promise<TimecardEmployeeCheck> {
  await closeEmployeeSearch(page);
  await page.waitForTimeout(500);
  const deadline = Date.now() + 8_000;
  let shownEid: string | null = null;
  while (Date.now() < deadline) {
    // TODO(live-verify): scope this to a pinpoint WFD timecard employee-header
    // selector once one can be live-mapped (needs a found employee's open
    // timecard). document.body.innerText EXCLUDES <input> values and the search
    // slide-out is closed above, so the searched EID cannot linger from the
    // global Employee Search box. The compare/throw is routed through the shared
    // identity primitive via `probeEidInTimecardText` (word-boundary + competing
    // 8-digit id capture).
    //
    // Fail SAFE, not open: a probe EXCEPTION must NOT confirm the employee. This
    // gate stops a stale/wrong employee's timecard from being read into a
    // separation — a thrown probe means "could not verify" (keep polling, then
    // the caller throws).
    const bodyText = await page
      .evaluate(() => document.body?.innerText ?? "")
      .catch(() => null);
    if (bodyText !== null) {
      const probe = probeEidInTimecardText(bodyText, eid);
      if (probe.match) return { ok: true, shownEid: eid };
      shownEid = probe.otherEid;
    }
    await page.waitForTimeout(500);
  }
  return { ok: false, shownEid };
}

/**
 * Switch the pay period dropdown to previous pay period.
 */
export async function switchToPreviousPayPeriod(page: Page): Promise<boolean> {
  log.step("[New Kronos] Switching to previous pay period...");

  // Use payPeriodTriggerButton (regex-based) so it matches regardless of whether
  // the button shows "Current Pay Period" or a date range after setDateRange runs.
  const periodBtn = timecard.payPeriodTriggerButton(page);
  // Positive-assert baseline: the trigger button always displays the active
  // period ("Current Pay Period" / "Previous Pay Period" / a date range), so
  // its text before the switch is the comparison point for the post-switch
  // readback below.
  const beforeLabel = (await periodBtn.textContent().catch(() => null))?.trim() ?? "";
  if (await clickIfPresent(periodBtn, { timeout: 5_000, label: "new kronos pay period trigger button" })) {
    await page.waitForTimeout(2_000);

    const prevOption = timecard.previousPayPeriodOption(page);
    if (await clickIfPresent(prevOption, { timeout: 5_000, label: "new kronos previous pay period option" })) {
      // Wait for the period dropdown option to close (detach/hide) as a
      // signal the switch was accepted, instead of a blind pause.
      await prevOption.waitFor({ state: "hidden", timeout: 10_000 }).catch(() => {});

      // Positive assert: the option closing only proves the click registered —
      // it does NOT prove the timecard grid actually switched periods. Re-read
      // the SAME trigger-button selector and fail loud if it still shows the
      // pre-switch label (or is still literally "Current Pay Period"), instead
      // of letting the caller read the grid believing the switch landed.
      const afterLabel = (await timecard.payPeriodTriggerButton(page).textContent().catch(() => null))?.trim() ?? "";
      if (!didPeriodLabelSwitch(beforeLabel, afterLabel, /current pay period/i)) {
        throw new Error(
          `[New Kronos] Previous Pay Period option closed but the pay-period trigger button did not switch ` +
          `(before="${beforeLabel}", after="${afterLabel}") — refusing to read the grid as though the ` +
          `previous period is displayed`,
        );
      }

      log.step(`[New Kronos] Switched to Previous Pay Period (now showing "${afterLabel}")`);
      return true;
    }
  }

  log.error("[New Kronos] Could not find pay period controls");
  return false;
}

/**
 * Check if the current timecard view has any time entries.
 * Returns the latest date with time, or null if no time found.
 */
export async function getTimecardLastDate(page: Page): Promise<string | null> {
  log.step("[New Kronos] Checking timecard for time entries...");

  // New Kronos (WFD) uses a split grid:
  // - ui-grid-pinned-container has date rows ("Mon 3/16")
  // - ui-grid-viewport (last one) has data rows (In/Out/Daily values)
  // Rows are aligned by index. Check if data row has AM/PM timestamps (In/Out punches).
  const result = await page.evaluate(() => {
    const viewports = document.querySelectorAll(".ui-grid-viewport");
    if (viewports.length < 2) return null;

    // First viewport is the left pinned column (dates)
    // Last viewport is the right scrollable data column (punches)
    const dateVp = viewports[0];
    const dataVp = viewports[viewports.length - 1];

    const dateRows: string[] = [];
    let lastSeenDate = "";
    dateVp.querySelectorAll("[role='row']").forEach((r) => {
      const t = r.textContent?.trim().replace(/[^\w\s/]/g, "").trim() ?? "";
      if (/^[A-Z][a-z]{2}\s+\d+\/\d+$/.test(t)) {
        lastSeenDate = t;
      }
      dateRows.push(lastSeenDate);
    });

    const dataRows = dataVp.querySelectorAll("[role='row']");

    // Find last date with In/Out punches (AM/PM timestamps)
    let lastParsed: { month: number; day: number } | null = null;
    for (let i = 0; i < dateRows.length && i < dataRows.length; i++) {
      const cells = dataRows[i].querySelectorAll("[role='gridcell']");
      const hasInOut = Array.from(cells).some((c) =>
        /\d+:\d+\s*(AM|PM)/.test(c.textContent?.trim() ?? ""),
      );
      if (hasInOut) {
        const match = dateRows[i].match(/(\d+)\/(\d+)/);
        if (match) {
          lastParsed = { month: parseInt(match[1], 10), day: parseInt(match[2], 10) };
        }
      }
    }

    return lastParsed;
  });

  if (result) {
    const formatted = formatTimecardDate(result.month, result.day);
    log.step(`[New Kronos] Latest timecard date with In/Out: ${formatted}`);
    return formatted;
  } else {
    log.step("[New Kronos] No In/Out entries found in current pay period");
  }

  return null;
}

/**
 * Scroll the New Kronos timecard grid so the row for `targetDate`
 * (MM/DD/YYYY) is CENTERED in the view. Used to position the browser
 * before an audit screenshot so the human can verify:
 *   (a) the workflow picked the correct last day (centered = easy to read), and
 *   (b) whether any later dates exist below it (visible above and below center).
 *
 * `block: "center"` keeps surrounding rows in frame on both sides; when the
 * target is near the top/bottom of the loaded rows the browser's native scroll
 * clamps at the edge, which is fine — the operator still sees the target row
 * plus its neighbors.
 *
 * Best-effort: a missing row logs + returns without throwing. Callers
 * wrap screenshots around this; a scroll failure must not mask the
 * real error the screenshot is being taken to capture.
 */
export async function scrollTimecardToDate(page: Page, targetDate: string): Promise<void> {
  const match = targetDate.match(/^(\d{2})\/(\d{2})\/\d{4}$/);
  if (!match) return;
  // Kronos date cells render as "Mon 3/23" — month + day without
  // leading zeros. Convert "03/23/2026" → "3/23" for a substring match
  // against the row text.
  const md = `${parseInt(match[1], 10)}/${parseInt(match[2], 10)}`;

  const scrolled = await page.evaluate((wantMd: string) => {
    const viewports = document.querySelectorAll(".ui-grid-viewport");
    if (viewports.length === 0) return false;
    // Column 0 is the pinned date column; both viewports scroll in
    // lockstep because ui-grid syncs them on scroll events.
    const dateVp = viewports[0];
    const rows = dateVp.querySelectorAll("[role='row']");
    for (const row of Array.from(rows)) {
      const text = (row.textContent ?? "").replace(/\s+/g, " ").trim();
      // Match the "/" form ("Mon 3/23" contains "3/23") to avoid
      // false-positive matches like "3/23" inside a different cell.
      if (text.includes(` ${wantMd}`) || text.endsWith(wantMd)) {
        (row as HTMLElement).scrollIntoView({ block: "center", behavior: "instant" as ScrollBehavior });
        return true;
      }
    }
    return false;
  }, md).catch(() => false);

  if (scrolled) {
    log.step(`[New Kronos] Scrolled timecard to ${targetDate} centered in view`);
  } else {
    log.warn(`[New Kronos] Could not locate ${targetDate} row in timecard — screenshot scroll unchanged`);
  }
  // Let the grid repaint before the caller captures a screenshot.
  await page.waitForTimeout(500);
}

/**
 * Full timecard check: select employee, Go To → Timecard, check current then previous period.
 * Returns the latest date with time entries, or null if nothing found.
 */
export async function checkTimecardDates(page: Page, eid: string): Promise<string | null> {
  await selectEmployeeResult(page);

  const driver: TimecardDriver = {
    goToTimecard: (p) => clickGoToTimecard(p, eid),
    afterGoTo: async (p) => {
      await debugScreenshot(p, "new-kronos-timecard-01-current");
    },
    switchPeriod: (p) => switchToPreviousPayPeriod(p),
    afterSwitch: async (p) => {
      await debugScreenshot(p, "new-kronos-timecard-02-previous");
    },
    readLastDate: (p) => getTimecardLastDate(p),
  };
  return runTimecardCheck(page, driver);
}

/**
 * Timecard data extracted for use during separations: the last punch date,
 * any days with a Sick pay code, and any days with a Holiday pay code.
 */
export interface SeparationTimecardData {
  /** MM/DD/YYYY — latest day with an In/Out punch (the "Last Day Worked"), or null if none found. */
  lastPunchDate: string | null;
  /** MM/DD/YYYY[], chronological — days with a Sick pay code (e.g. "Sick - Hourly"). */
  sickDates: string[];
  /** MM/DD/YYYY[], chronological — days with a Holiday pay code (e.g. "Holiday - Hourly"). */
  holidayDates: string[];
}

/**
 * Parse the New Kronos (WFD) timecard grid to extract:
 * - last day with an In/Out punch
 * - all days with a Sick pay code (matches /sick/i, e.g. "Sick - Hourly")
 * - all days with a Holiday pay code (matches /holiday/i, e.g. "Holiday - Hourly")
 *
 * Grid structure: `document.querySelectorAll(".ui-grid-viewport")` →
 *   [0] = pinned date column (rows like "Thu 4/23")
 *   [last] = data column; per-row cell indices:
 *     [0]=Schedule [1]=In [2]=Out [3]=Transfer [4]=Pay code [5]=Amount
 *     [6]=Shift [7]=Daily [8]=Period [9]=Absence
 *
 * Verified live 2026-06-18 against EIDs 10776990 (holiday) and 10776013 (sick).
 * Multiple data rows can share one date; the date column shows the date once,
 * so the last-seen date is carried forward across rows.
 *
 * NOTE: keep `getTimecardLastDate` as-is — it is still used by `checkTimecardDates`.
 */
export async function getSeparationTimecardData(
  page: Page,
): Promise<SeparationTimecardData> {
  log.step("[New Kronos] Parsing timecard for separation data (last punch, sick, holiday)...");

  const raw = await page.evaluate(() => {
    const vps = document.querySelectorAll(".ui-grid-viewport");
    if (vps.length < 2) return { lastPunch: null, sick: [] as { mon: number; day: number }[], holiday: [] as { mon: number; day: number }[] };
    const dateVp = vps[0];
    const dataVp = vps[vps.length - 1];
    const dRows = [...dateVp.querySelectorAll("[role=row]")];
    const xRows = [...dataVp.querySelectorAll("[role=row]")];
    let cur: { mon: number; day: number } | null = null;
    let lastPunch: { mon: number; day: number } | null = null;
    const sick: { mon: number; day: number }[] = [];
    const holiday: { mon: number; day: number }[] = [];
    for (let i = 0; i < Math.max(dRows.length, xRows.length); i++) {
      const dt = dRows[i] ? dRows[i].textContent.replace(/\s+/g, " ").trim() : "";
      const m = dt.match(/([A-Za-z]{3})\s+(\d+)\/(\d+)/);
      if (m) cur = { mon: +m[2], day: +m[3] };
      const cells = xRows[i]
        ? [...xRows[i].querySelectorAll("[role=gridcell]")].map((c) =>
            c.textContent.replace(/\s+/g, " ").trim(),
          )
        : [];
      const inOut = (cells[1] ?? "") + " " + (cells[2] ?? "");
      if (cur && /\d+:\d+\s*(AM|PM)/.test(inOut)) lastPunch = cur;
      const pay = cells[4] ?? "";
      if (cur && /sick/i.test(pay)) sick.push(cur);
      if (cur && /holiday/i.test(pay)) holiday.push(cur);
    }
    return { lastPunch, sick, holiday };
  });

  const lastPunchDate = raw.lastPunch
    ? formatTimecardDate(raw.lastPunch.mon, raw.lastPunch.day)
    : null;
  const sickDates = raw.sick.map((d) => formatTimecardDate(d.mon, d.day));
  const holidayDates = raw.holiday.map((d) => formatTimecardDate(d.mon, d.day));

  log.step(
    `[New Kronos] Timecard parse: lastPunch=${lastPunchDate ?? "none"}, sick=${sickDates.length}, holiday=${holidayDates.length}`,
  );

  return { lastPunchDate, sickDates, holidayDates };
}

const MONTH_NAMES_FULL = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
const MONTH_NAMES_ABBR = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/** Parsed `M/D/YYYY` components (month is 0-based to match `Date`/calendar math). */
export interface ParsedDate {
  year: number;
  monthIndex: number;
  day: number;
}

/**
 * Parse an `M/D/YYYY` (or zero-padded `MM/DD/YYYY`) date into numeric parts.
 * Throws on a malformed string so a bad upstream date fails loud here instead
 * of silently applying a wrong timecard window. Pure + unit-pinned.
 */
export function parseMmddyyyy(dateStr: string): ParsedDate {
  const m = dateStr.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) throw new Error(`[New Kronos] malformed date "${dateStr}" (expected M/D/YYYY)`);
  const monthIndex = Number(m[1]) - 1;
  const day = Number(m[2]);
  const year = Number(m[3]);
  if (monthIndex < 0 || monthIndex > 11 || day < 1 || day > 31) {
    throw new Error(`[New Kronos] out-of-range date "${dateStr}"`);
  }
  return { year, monthIndex, day };
}

/** `M/D/YYYY` → ISO `YYYY-MM-DD`, the ONLY value a native `<input type=date>` accepts. */
export function toIsoDate(dateStr: string): string {
  const { year, monthIndex, day } = parseMmddyyyy(dateStr);
  return `${year}-${String(monthIndex + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/**
 * The calendar day cell's accessible name (its `aria-label`) is the full date
 * with weekday, e.g. "Monday, June 11, 2026". We match on a weekday-agnostic
 * fragment (`June 11, 2026`) anchored so "June 1, 2026" can't match "June 11".
 * Pure + unit-pinned.
 */
export function calendarDayLabelPattern(d: ParsedDate): RegExp {
  return new RegExp(`\\b${MONTH_NAMES_FULL[d.monthIndex]} ${d.day}, ${d.year}\\b`);
}

/** Absolute month ordinal (year*12+month) for monotonic prev/next stepping. */
function monthOrdinal(year: number, monthIndex: number): number {
  return year * 12 + monthIndex;
}

/**
 * Parse the moment-picker header text ("Jun 2026") to a month ordinal so the
 * navigator knows which way (and how far) to step. Returns null on an
 * unparseable header (caller stops navigating and lets the verify fail loud).
 * Pure + unit-pinned.
 */
export function parseCalendarHeaderOrdinal(headerText: string): number | null {
  const m = headerText.trim().match(/^([A-Za-z]{3,})\s+(\d{4})$/);
  if (!m) return null;
  const idx = MONTH_NAMES_ABBR.findIndex((a) => a.toLowerCase() === m[1].slice(0, 3).toLowerCase());
  if (idx < 0) return null;
  return monthOrdinal(Number(m[2]), idx);
}

/**
 * One-shot DOM inventory of the open "Select range" date picker, written to
 * `PATHS.screenshotDir/wfd-date-picker-<ts>.json` (+ a screenshot) so the grid
 * selectors (day cell, prev/next month, month/year header) can be authored from
 * the REAL accessibility tree instead of a screenshot. Gated behind
 * `DEBUG_SCREENSHOTS=1`; best-effort and never throws. Remove once the
 * grid-pick selectors are mapped + verified.
 */
async function dumpDatePickerStructure(page: Page, label: string): Promise<void> {
  if (process.env.DEBUG_SCREENSHOTS !== "1") return;
  try {
    const inventory = await page.evaluate(() => {
      const interesting = Array.from(
        document.querySelectorAll(
          "button, [role='button'], [role='gridcell'], [role='option'], "
            + "td, th, input, [aria-label], [class*='calendar'], [class*='datepicker'], "
            + "[class*='date-picker'], [class*='month'], [class*='day']",
        ),
      ).slice(0, 600);
      return interesting.map((el) => {
        const e = el as HTMLElement;
        return {
          tag: e.tagName.toLowerCase(),
          type: e.getAttribute("type"),
          role: e.getAttribute("role"),
          ariaLabel: e.getAttribute("aria-label"),
          ariaSelected: e.getAttribute("aria-selected"),
          ariaDisabled: e.getAttribute("aria-disabled"),
          title: e.getAttribute("title"),
          name: e.getAttribute("name"),
          id: e.id || null,
          className: typeof e.className === "string" ? e.className : null,
          text: (e.textContent || "").trim().slice(0, 40),
          value: (e as HTMLInputElement).value ?? null,
          dataset: { ...e.dataset },
        };
      });
    });
    mkdirSync(PATHS.screenshotDir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const path = `${PATHS.screenshotDir}/wfd-date-picker-${label}-${ts}.json`;
    writeFileSync(path, JSON.stringify(inventory, null, 2), "utf8");
    log.step(`[New Kronos] date-picker DOM inventory: ${path} (${inventory.length} els)`);
    await debugScreenshot(page, `wfd-date-picker-${label}`, { fullPage: true });
  } catch (err) {
    log.warn(`[New Kronos] date-picker dump failed (best-effort): ${String(err)}`);
  }
}

/**
 * Step the moment-picker calendar to `target`'s month/year by clicking the
 * Previous/Next-month arrows, re-reading the header each step so it converges
 * even if a click is dropped. Bounded (24 steps) so a stuck header can't spin
 * forever. Best-effort: a failure here is caught by the day-cell click + the
 * caller's readback verify.
 */
async function navigateCalendarToMonth(page: Page, target: ParsedDate): Promise<void> {
  const want = monthOrdinal(target.year, target.monthIndex);
  for (let i = 0; i < 24; i++) {
    const headerText = ((await timecard.calendarMonthHeader(page).textContent()) ?? "").trim();
    const current = parseCalendarHeaderOrdinal(headerText);
    if (current === want) return;
    if (current === null) {
      if (i < 3) { await page.waitForTimeout(300); continue; } // header not rendered yet
      return; // genuinely unparseable — let the readback verify fail loud
    }
    const arrow = want < current
      ? timecard.calendarPrevMonth(page)
      : timecard.calendarNextMonth(page);
    await arrow.click({ timeout: 5_000 });
    await page.waitForTimeout(300);
  }
}

/**
 * Fallback for `setRangeDate`: drive the visible moment-picker calendar instead
 * of the native input. Focuses the field (binds the shared calendar to it),
 * steps to the target month, then clicks the day cell by its full-date
 * aria-label (weekday-agnostic, `:not(.out-of-month)` so an adjacent-month
 * trailing day can't be hit). No readback here — the caller verifies.
 */
async function pickRangeDateViaCalendar(
  page: Page,
  input: Locator,
  target: ParsedDate,
): Promise<void> {
  await input.click({ timeout: 5_000 });
  await page.waitForTimeout(400);
  await navigateCalendarToMonth(page, target);
  await timecard
    .calendarDayCell(page, calendarDayLabelPattern(target))
    .first()
    .click({ timeout: 5_000 });
  await page.waitForTimeout(300);
}

/**
 * Set ONE of WFD's "Select range" date fields and VERIFY the readback.
 *
 * These are NATIVE `<input type=date>` controls (`#startDateTimeInput` /
 * `#endDateTimeInput`, value held as ISO `YYYY-MM-DD`) — NOT the JS-masked text
 * inputs the old code assumed. Every prior fix fed them `MM/DD/YYYY`, which a
 * native date input silently rejects (it keeps today's value → OBS-006's "fill
 * reverts to today", and per-key typing scrambled the segmented mask →
 * WFP-00889 / ISS-B05). The fix is to speak the input's own language:
 *
 *   1. FAST PATH — `fill()` the ISO string. Playwright sets a native date
 *      input's value directly (no segment race), and the inputValue reads back
 *      as ISO, so the verify is exact.
 *   2. FALLBACK — if the model didn't accept the programmatic fill, click
 *      through the visible moment-picker calendar (`pickRangeDateViaCalendar`).
 *   3. Re-read and FAIL LOUD if the field still doesn't equal the wanted ISO,
 *      rather than applying a wrong timecard window.
 */
async function setRangeDate(page: Page, input: Locator, dateStr: string, label: string): Promise<void> {
  const target = parseMmddyyyy(dateStr);
  const wantIso = `${target.year}-${String(target.monthIndex + 1).padStart(2, "0")}-${String(target.day).padStart(2, "0")}`;

  try {
    await input.fill(wantIso, { timeout: 5_000 });
  } catch {
    // Native fill rejected outright — fall through to the calendar.
  }
  if ((await input.inputValue().catch(() => "")) === wantIso) return;

  log.warn(`[New Kronos] ${label} date fill did not stick — picking ${dateStr} via the calendar grid`);
  await pickRangeDateViaCalendar(page, input, target);

  const after = await input.inputValue().catch(() => "");
  if (after === wantIso) return;
  throw new Error(
    `[New Kronos] Could not set ${label} date to ${dateStr} — the field reads `
    + `"${after || "<empty>"}" (wanted ISO ${wantIso}). Aborting before applying `
    + `a wrong timecard range (WFP-00889).`,
  );
}

/**
 * Set a custom date range on the New Kronos timecard view.
 * Must be called after navigating to the Timecards page.
 *
 * Mapped via playwright-cli 2026-04-06; native-date-input rework 2026-06-22
 * (ISS-B05, after a live DOM dump proved the fields are `<input type=date>`):
 *   1. Click "Current Pay Period" button → opens the timeframe dropdown
 *   2. Click "Select range" → reveals the native Start/End date inputs + calendar
 *   3. `setRangeDate` each field: native ISO `fill()` (fast path) → calendar
 *      grid click (fallback) → readback verify (fail loud), see `setRangeDate`
 *   4. Click "Apply"
 *
 * After applying, the button text changes from "Current Pay Period"
 * to the date range string (e.g., "3/01/2026 - 4/15/2026").
 */
export async function setDateRange(
  page: Page,
  startDate: string,
  endDate: string,
): Promise<void> {
  log.step(`[New Kronos] Setting date range: ${startDate} – ${endDate}`);

  // Positive-assert baseline (read BEFORE any interaction): the trigger
  // button always displays the active period, so its text now is the
  // comparison point for the post-Apply readback below.
  const beforeLabel = (await timecard.payPeriodTriggerButton(page).textContent().catch(() => null))?.trim() ?? "";

  // Step 1: Click the timeframe button to open the dropdown
  // The button text varies: "Current Pay Period", "Previous Pay Period", or a date range string
  await safeClick(timecard.payPeriodTriggerButton(page), {
    timeout: 10_000,
    label: "new kronos pay period trigger button",
  });
  await page.waitForTimeout(2_000);

  // Step 2: Click "Select range" to switch to custom date range mode
  await safeClick(timecard.selectRangeButton(page), {
    timeout: 5_000,
    label: "new kronos select range button",
  });
  await page.waitForTimeout(1_000);

  // DEBUG (DEBUG_SCREENSHOTS=1): capture the open picker's DOM (kept while the
  // native-input + calendar-grid path is verified live; remove once stable).
  await dumpDatePickerStructure(page, "open");

  // Step 3: Set + verify each native date input (ISO fill → calendar fallback).
  await setRangeDate(page, timecard.startDateInput(page), startDate, "start");
  await setRangeDate(page, timecard.endDateInput(page), endDate, "end");

  // Step 4: Click Apply
  await safeClick(timecard.applyButton(page), {
    timeout: 5_000,
    label: "new kronos date range apply button",
  });
  // Wait for WFD to reload the timecard grid with the new range (reduced from 5s).
  await page.waitForTimeout(2_500);

  // Positive assert: `setRangeDate`'s readback above only proves the DIALOG
  // fields accepted the ISO dates — it does not prove the underlying timecard
  // grid actually switched to that range before a caller (e.g.
  // `getSeparationTimecardData`) reads it. Re-read the same trigger-button
  // selector used to open the dropdown (it always displays the active
  // period) and fail loud if it still shows the PRE-switch label, so a grid
  // that silently stayed on the OLD period is never read as though the
  // requested range is active.
  const afterLabel = (await timecard.payPeriodTriggerButton(page).textContent().catch(() => null))?.trim() ?? "";
  if (!didPeriodLabelSwitch(beforeLabel, afterLabel)) {
    throw new Error(
      `[New Kronos] Date range Apply did not update the displayed period ` +
      `(before="${beforeLabel}", after="${afterLabel}") for ${startDate}–${endDate} — ` +
      `refusing to read the timecard grid as though the new range is active`,
    );
  }

  log.step(`[New Kronos] Date range applied (now showing "${afterLabel}")`);
}

/**
 * Close the Employee Search sidebar if it's open.
 */
export async function closeEmployeeSearch(page: Page): Promise<void> {
  // The sidebar may be in the portal-frame iframe OR top-level — try both
  // close buttons (best-effort; the sidebar may simply not be open).
  for (const root of [searchFrame(page), page] as SearchRoot[]) {
    try {
      const closeBtn = searchSelectors.closeButton(root);
      if (await clickIfPresent(closeBtn, { timeout: 2_000, label: "new kronos search sidebar close button" })) {
        log.step("[New Kronos] Search sidebar closed");
        return;
      }
    } catch {
      // Not in this context — try the next.
    }
  }
}

// ─── People page navigation (Pay Rule editing) ───────────────────────────
//
// Used by the Kronos Pay Rule workflow to navigate an employee to the People
// page, expand the Timekeeper section, add/modify their pay rule, and save.
// Follows the same selector + condition-based waiting patterns as the
// timecard navigation above.

/**
 * True when the People editor's loaded-employee header (`.empName`, title
 * "<Name> <EID>") shows the searched EID. Whole-page text is NOT a valid signal
 * — the searched EID lingers in the global Employee Search box/results, so a
 * `document.body` check false-positived while the editor still displayed the
 * PREVIOUS employee (live 2026-07-02: batch item 2 for EID 10416352 reported
 * "already open" while `#empNav`/`.empName` still showed KentHodge 10604376, so
 * the pay rule was re-added to the previous person). Word-boundary match so an
 * 8-digit EID can't partially match a longer number. Exported for unit tests.
 */
export function peopleHeaderShowsEid(headerText: string, eid: string): boolean {
  // Word-boundary match via the shared identity primitive so an 8-digit EID
  // can't partially match a longer number.
  return checkDisplayedIdentity(eid, headerText).ok;
}

/**
 * One pass over the People editor's `.empName` headers: does any show `eid`?
 * Also captures the 8-digit id actually shown when it does NOT match, so a
 * caller can fail loud naming the wrong person. Shared by
 * {@link waitForPeopleEmployee} and {@link verifyPeopleEmployee} so the
 * header-reading logic lives in one place.
 */
async function scanPeopleHeaders(
  root: PeopleRoot,
  eid: string,
): Promise<{ matched: boolean; shownEid: string | null }> {
  const headers = people.loadedEmployeeName(root);
  const count = await headers.count().catch(() => 0);
  let shownEid: string | null = null;
  for (let i = 0; i < count; i++) {
    const cell = headers.nth(i);
    const title = (await cell.getAttribute("title").catch(() => null)) ?? "";
    const text = (await cell.textContent().catch(() => null)) ?? "";
    const combined = `${title} ${text}`;
    if (peopleHeaderShowsEid(combined, eid)) return { matched: true, shownEid: eid };
    const m = combined.match(/\b\d{8}\b/);
    if (m) shownEid = m[0];
  }
  return { matched: false, shownEid };
}

/**
 * Poll until the People editor (managePeople route) actually DISPLAYS the
 * searched employee — checked against the editor's OWN `.empName` header, not
 * whole-page text (see {@link peopleHeaderShowsEid}). When a batch reuses the
 * same browser session the previous employee's editor stays open, so
 * `resolvePeopleRoot` truthiness alone is not enough — the header EID must match.
 */
async function waitForPeopleEmployee(
  page: Page,
  eid: string,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const root = resolvePeopleRoot(page);
    if (root && (await scanPeopleHeaders(root, eid)).matched) return true;
    await page.waitForTimeout(500);
  }
  return false;
}

/**
 * Confirm the OPEN People editor is displaying the searched employee before we
 * add a pay rule — a fail-loud identity gate (mirrors `verifyTimecardEmployee`).
 * Reads the editor's `.empName` header (title "<Name> <EID>"), NOT whole-page
 * text, so a searched EID lingering in the global Employee Search box can't
 * false-pass. Returns the 8-digit id actually shown when it does NOT match, so
 * the caller can fail loud naming the wrong person.
 */
export async function verifyPeopleEmployee(
  page: Page,
  eid: string,
): Promise<TimecardEmployeeCheck> {
  await closeEmployeeSearch(page);
  const root = resolvePeopleRoot(page);
  if (!root) return { ok: false, shownEid: null };
  const deadline = Date.now() + 8_000;
  let shownEid: string | null = null;
  while (Date.now() < deadline) {
    const scan = await scanPeopleHeaders(root, eid);
    if (scan.matched) return { ok: true, shownEid: eid };
    if (scan.shownEid) shownEid = scan.shownEid;
    await page.waitForTimeout(500);
  }
  return { ok: false, shownEid };
}

/**
 * Click Go To dropdown and select People.
 * Mirrors `clickGoToTimecard` but targets the People option. After clicking,
 * waits for the People editor to show the searched EID — not merely for the
 * managePeople route to exist (batch reuse can leave the route open).
 */
export async function clickGoToPeople(page: Page, eid: string): Promise<boolean> {
  log.step("[New Kronos] Clicking Go To → People...");

  const frame = searchFrame(page);
  // Go To may render in the search frame OR top-level — poll for whichever
  // context's button is visible AND ENABLED.
  const candidates = [
    goToMenu.goToButtonInFrame(frame).first(),
    goToMenu.goToButtonOnPage(page).first(),
  ];
  let gotoButton: Locator | null = null;
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline && !gotoButton) {
    for (const loc of candidates) {
      try {
        if ((await loc.isVisible()) && (await loc.isEnabled())) {
          gotoButton = loc;
          break;
        }
      } catch {
        // Not present in this context — try the next candidate.
      }
    }
    if (!gotoButton) await page.waitForTimeout(500);
  }

  if (!gotoButton) {
    log.error(
      "[New Kronos] Go To button never became enabled — the employee selection " +
      "did not register (no slat selected), so the People page cannot be opened",
    );
    return false;
  }

  if (await waitForPeopleEmployee(page, eid, 3_000)) {
    log.success(
      `[New Kronos] People editor already open for EID ${eid} — slat selection refreshed the page`,
    );
    await closeEmployeeSearch(page);
    return true;
  }

  // Open the dropdown, then WAIT for the People option to render before clicking.
  const peopleItem = goToMenu.peopleItem(page);
  await gotoButton.click({ timeout: 5_000 });

  const totalDeadline = Date.now() + 30_000;
  let reopened = false;
  while (Date.now() < totalDeadline) {
    try {
      await peopleItem
        .first()
        .waitFor({ state: "visible", timeout: reopened ? 6_000 : 5_000 });
    } catch {
      if (!reopened) {
        log.warn("[New Kronos] People option not visible yet — re-opening the Go To dropdown");
        reopened = true;
        try {
          await gotoButton.click({ timeout: 5_000 });
        } catch {
          // best-effort re-open
        }
        await page.waitForTimeout(500);
        continue;
      }
      if (await waitForPeopleEmployee(page, eid, 5_000)) {
        log.success(
          `[New Kronos] People editor switched to EID ${eid} without Go To → People menu item`,
        );
        await closeEmployeeSearch(page);
        return true;
      }
      break;
    }

    try {
      await safeClick(peopleItem.first(), {
        timeout: 5_000,
        label: "new kronos people menu item",
      });
    } catch {
      continue;
    }

    try {
      await loadingOverlay.overlay(page).waitFor({ state: "hidden", timeout: 5_000 });
    } catch {
      // Overlay absent or selector drift — proceed.
    }

    if (await waitForPeopleEmployee(page, eid, 15_000)) {
      log.success(`[New Kronos] Navigated to People page for EID ${eid}`);
      await closeEmployeeSearch(page);
      return true;
    }

    log.warn(
      `[New Kronos] Go To → People clicked but the editor did not switch to EID ${eid} — retrying`,
    );
    try {
      await gotoButton.click({ timeout: 5_000 });
    } catch {
      // best-effort re-open for another attempt
    }
    await page.waitForTimeout(500);
  }

  if (await waitForPeopleEmployee(page, eid, 3_000)) {
    log.success(`[New Kronos] People editor confirmed for EID ${eid} after menu retries`);
    await closeEmployeeSearch(page);
    return true;
  }

  log.error(
    `[New Kronos] Could not open the People editor for EID ${eid} ` +
    `(Go To → People menu or managePeople load did not show the searched employee)`,
  );
  return false;
}

/**
 * Return New Kronos to the home dashboard so the NEXT batch employee starts from
 * a known-clean state.
 *
 * In a batch the previous employee's People editor stays open after Save, and
 * once a People editor is open the global Employee Search **Go To → People**
 * dropdown no longer offers a "People" option — so a stale editor cannot be
 * switched in place, and the old code false-passed the switch and re-edited the
 * PREVIOUS person (live 2026-07-02: EID 10416352 kept re-opening while the editor
 * still showed KentHodge 10604376). Navigating home first makes every item run
 * the same proven fresh-employee flow (search → select → Go To → People);
 * live-verified 2026-07-02 (10604376 → 10416352 switched cleanly). Retries
 * transient navigation failures via {@link gotoWithRetry}.
 */
export async function resetNewKronosToHome(page: Page): Promise<void> {
  log.step("[New Kronos] Returning to home dashboard before next employee...");
  await gotoWithRetry(page, NEW_KRONOS_URL, undefined, undefined, 30_000);
  await page.waitForTimeout(1_000);
}

/**
 * Expand the Timekeeper section on the People page if it's collapsed.
 * The Timekeeper header is a clickable accordion that toggles the Pay Rule /
 * Employment Terms tables. Click it if the Pay Rule table is not visible.
 */
export async function expandTimekeeperSection(page: Page): Promise<void> {
  log.step("[New Kronos] Expanding Timekeeper section...");

  const root = peopleFrame(page);
  const timekeeperHeader = people.timekeeperSection(root);
  try {
    await timekeeperHeader.waitFor({ state: "visible", timeout: 45_000 });

    const payRuleVisible = await people
      .payRuleColumnHeader(root)
      .isVisible()
      .catch(() => false);

    if (payRuleVisible) {
      log.step("[New Kronos] Timekeeper section already expanded");
      return;
    }

    await safeClick(timekeeperHeader, {
      timeout: 5_000,
      label: "new kronos timekeeper section header",
    });
    await people.payRuleColumnHeader(root).waitFor({ state: "visible", timeout: 15_000 });
    log.step("[New Kronos] Timekeeper section expanded");
  } catch (err) {
    throw new Error(
      `[New Kronos] Timekeeper section did not load on People page: ${String(err)}`,
    );
  }
}

const PAY_RULE_MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

function parseUsEffectiveDate(effectiveDate: string): {
  month: number;
  day: number;
  year: number;
  calendarTitle: string;
} {
  const [mm, dd, yyyy] = effectiveDate.split("/").map((part) => Number(part));
  if (!mm || !dd || !yyyy) {
    throw new Error(
      `[New Kronos] Invalid pay-rule effective date "${effectiveDate}" — expected MM/DD/YYYY`,
    );
  }
  return {
    month: mm,
    day: dd,
    year: yyyy,
    calendarTitle: `${PAY_RULE_MONTH_NAMES[mm - 1]} ${yyyy}`,
  };
}

function parseCalendarTitle(title: string): { month: number; year: number } | null {
  const match = title.trim().match(/^([A-Za-z]+)\s+(\d{4})$/);
  if (!match) return null;
  const monthIndex = PAY_RULE_MONTH_NAMES.findIndex(
    (name) => name.toLowerCase() === match[1].toLowerCase(),
  );
  if (monthIndex < 0) return null;
  return { month: monthIndex + 1, year: Number(match[2]) };
}

/** True when the pay-rule grid cell text matches MM/DD/YYYY (leading zeros optional). */
function effectiveDateCommittedInCell(cellText: string, effectiveDate: string): boolean {
  const { month, day, year } = parseUsEffectiveDate(effectiveDate);
  const re = new RegExp(`\\b0?${month}\\/0?${day}\\/${year}\\b`);
  return re.test(cellText.trim());
}

/**
 * True when the row1 Pay Rule grid cell now shows the chosen code — the real
 * signal that the lookup modal's OK committed the selection. Case-insensitive
 * and whitespace-tolerant because jqx renders the code inside nested spans.
 * Exported for unit tests (no live page needed).
 */
export function payRuleCodeCommittedInCell(cellText: string, payRuleCode: string): boolean {
  return cellText.trim().toLowerCase().includes(payRuleCode.trim().toLowerCase());
}

/**
 * Click `trigger`, then wait for `target` to appear. jqx inline editors
 * intermittently swallow the FIRST activation click (the cell/icon is hit but
 * the editor/popup never renders), which otherwise turns a transient miss into
 * a hard 10s `waitFor` timeout and fails the whole run. Re-click the SAME
 * trigger up to `attempts` times (re-running the same operation — allowed under
 * the fail-loud rule; NOT a substitute selector) before throwing a legible
 * error. Each attempt waits `perAttemptMs` for the target.
 */
async function clickToReveal(
  trigger: Locator,
  target: Locator,
  opts: { label: string; attempts?: number; perAttemptMs?: number },
): Promise<void> {
  const { label, attempts = 3, perAttemptMs = 6_000 } = opts;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    await safeClick(trigger, { timeout: 10_000, label });
    try {
      await target.waitFor({ state: "visible", timeout: perAttemptMs });
      return;
    } catch {
      if (attempt < attempts) {
        log.warn(
          `[New Kronos] ${label}: target not visible after click (attempt ${attempt}/${attempts}) — retrying`,
        );
        continue;
      }
      throw new Error(
        `[New Kronos] ${label}: element did not appear after ${attempts} click attempts`,
      );
    }
  }
}

/**
 * Confirm the pay-rule lookup selection: click the matching result row, click
 * OK, and verify the chosen code actually committed to the row1 grid cell.
 *
 * The raw OK affordance is a jqx button clicked via `evaluate(el.click())`
 * (verified 2026-07-02 — a Playwright click on it was unreliable). A single
 * `el.click()` intermittently fails to register, leaving the modal open and the
 * grid cell empty; the previous code then hit a hard 10s modal-hidden timeout
 * with no retry (observed live 2026-07-02, EID 10416352). Here we retry the
 * row-select + OK and gate success on the CODE landing in the grid — not merely
 * on the modal closing — so we never Save an empty/wrong pay rule.
 */
async function confirmPayRuleSelection(
  root: PeopleRoot,
  payRuleCode: string,
): Promise<void> {
  const resultRow = people.payRuleSearchResultRow(root, payRuleCode);
  const codeCell = people.payRuleCodeCell(root);
  const modal = people.payRuleSearchModal(root);

  const attempts = 3;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    // Re-select the row + OK while the lookup is still open (a missed OK leaves
    // the result row visible). Once OK commits, the row disappears and the code
    // poll below carries us out — so a stale row here just means "click again".
    if (await resultRow.isVisible().catch(() => false)) {
      await safeClick(resultRow, {
        timeout: 15_000,
        label: "new kronos pay rule search result row",
      });
      await people.payRuleSearchOk(root).evaluate((el) => (el as HTMLElement).click());
    }

    // Success is the CODE committed to the grid — the actual goal — polled to a
    // short deadline so a missed click retries fast instead of stalling 10s.
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const cellText = await codeCell.innerText().catch(() => "");
      if (payRuleCodeCommittedInCell(cellText, payRuleCode)) {
        // Best-effort: let the modal finish closing before the next step.
        await modal.waitFor({ state: "hidden", timeout: 5_000 }).catch(() => {});
        log.step(`[New Kronos] Pay rule ${payRuleCode} committed to grid`);
        return;
      }
      await root.waitForTimeout(250);
    }

    if (attempt < attempts) {
      log.warn(
        `[New Kronos] Pay rule ${payRuleCode} not committed after OK (attempt ${attempt}/${attempts}) — retrying`,
      );
    }
  }

  const finalCell = (await codeCell.innerText().catch(() => "")).trim();
  throw new Error(
    `[New Kronos] Pay rule ${payRuleCode} did not commit to the grid after ${attempts} OK attempts — ` +
    `cell="${finalCell || "(blank)"}". Aborting before Save so no empty/wrong pay rule is persisted.`,
  );
}

/** Pick an effective date via the inline editor's calendar icon (not typed entry). */
async function setPayRuleEffectiveDateViaCalendar(
  root: PeopleRoot,
  effectiveDate: string,
): Promise<void> {
  const { day, calendarTitle } = parseUsEffectiveDate(effectiveDate);

  // Each jqx open (cell → inline editor, calendar icon → picker) retries the
  // click if the popup doesn't render — a single swallowed click otherwise
  // stalls the full 10s before failing loud.
  await clickToReveal(
    people.effectiveDateCell(root),
    people.effectiveDateEditor(root),
    { label: "new kronos pay rule effective date cell" },
  );
  await clickToReveal(
    people.effectiveDateCalendarButton(root),
    people.payRuleDatePicker(root),
    { label: "new kronos pay rule effective date calendar icon" },
  );

  const titleLoc = people.payRuleDatePickerTitle(root);
  for (let attempt = 0; attempt < 24; attempt++) {
    const current = (await titleLoc.textContent())?.trim() ?? "";
    if (current === calendarTitle) break;

    const currentParts = parseCalendarTitle(current);
    const targetParts = parseCalendarTitle(calendarTitle);
    if (!currentParts || !targetParts) {
      throw new Error(`[New Kronos] Could not parse pay-rule calendar title "${current}"`);
    }

    const currentIndex = currentParts.year * 12 + currentParts.month;
    const targetIndex = targetParts.year * 12 + targetParts.month;
    if (currentIndex === targetIndex) break;

    if (currentIndex > targetIndex) {
      await safeClick(people.payRuleDatePickerPrevMonth(root), {
        timeout: 5_000,
        label: "new kronos pay rule calendar prev month",
      });
    } else {
      await safeClick(people.payRuleDatePickerNextMonth(root), {
        timeout: 5_000,
        label: "new kronos pay rule calendar next month",
      });
    }
  }

  const finalTitle = (await titleLoc.textContent())?.trim() ?? "";
  if (finalTitle !== calendarTitle) {
    throw new Error(
      `[New Kronos] Pay-rule calendar stuck on "${finalTitle}" — expected "${calendarTitle}"`,
    );
  }

  await safeClick(people.payRuleDatePickerDay(root, day), {
    timeout: 10_000,
    label: `new kronos pay rule effective date day ${day}`,
  });

  // jqx keeps the picked date in the inline input until Enter commits it to the grid cell
  // (live 2026-07-02 — day click alone leaves the Effective Date column blank on Save).
  await people.effectiveDateInput(root).press("Enter");

  const commitDeadline = Date.now() + 5_000;
  while (Date.now() < commitDeadline) {
    const cellText = await people.effectiveDateCell(root).innerText();
    if (effectiveDateCommittedInCell(cellText, effectiveDate)) {
      log.step(`[New Kronos] Effective date committed to grid: ${cellText.trim()}`);
      return;
    }
    await root.waitForTimeout(200);
  }

  const cellText = (await people.effectiveDateCell(root).innerText()).trim();
  throw new Error(
    `[New Kronos] Effective date calendar pick did not commit to the pay-rule grid — ` +
    `expected ${effectiveDate}, cell="${cellText || "(blank)"}"`,
  );
}

/**
 * Add a new pay rule entry on the People → Timekeeper page.
 *
 * Flow (from the user's screenshots):
 *   1. Click on the empty row / "+" button below existing pay rules
 *   2. Click the search icon in the pay rule cell
 *   3. Type the pay rule code in the search dialog
 *   4. Click Search, then select the result
 *   5. Set the effective date
 *
 * @param page - Playwright page on the People view
 * @param payRuleCode - The full pay rule code (e.g. "SX-8Hol-8-OT-30")
 * @param effectiveDate - MM/DD/YYYY format (e.g. "07/01/2026")
 */
export async function addPayRule(
  page: Page,
  payRuleCode: string,
  effectiveDate: string,
): Promise<void> {
  log.step(`[New Kronos] Adding pay rule: ${payRuleCode} effective ${effectiveDate}`);

  await closeEmployeeSearch(page);
  const root = peopleFrame(page);

  const emptyCell = people.payRuleEmptyCell(root);
  try {
    await safeClick(emptyCell, {
      timeout: 10_000,
      label: "new kronos pay rule empty cell",
    });
  } catch {
    log.step("[New Kronos] Empty cell not found — clicking '+' to add new pay rule row");
    await safeClick(people.payRuleAddButton(root), {
      timeout: 10_000,
      label: "new kronos pay rule add button",
    });
    await safeClick(people.payRuleEmptyCell(root), {
      timeout: 10_000,
      label: "new kronos pay rule empty cell (after add)",
    });
  }

  await people.payRuleDropdownList(root).waitFor({ state: "attached", timeout: 15_000 });
  // jqx dropdown Search affordance sits in a hidden popup shell — DOM click.
  await people.payRuleSearchOption(root).evaluate((el) => (el as HTMLElement).click());
  await people.payRuleSearchInput(root).waitFor({ state: "visible", timeout: 15_000 });

  await safeFill(people.payRuleSearchInput(root), payRuleCode, {
    timeout: 15_000,
    label: "new kronos pay rule search input",
  });

  const resultRow = people.payRuleSearchResultRow(root, payRuleCode);
  await resultRow.waitFor({ state: "visible", timeout: 15_000 });

  // Select the row + OK, retrying the click and gating on the code committing
  // to the grid (a single OK click intermittently no-ops — see the helper).
  await confirmPayRuleSelection(root, payRuleCode);

  await setPayRuleEffectiveDateViaCalendar(root, effectiveDate);

  log.step(`[New Kronos] Pay rule ${payRuleCode} entered with effective date ${effectiveDate}`);
}

/**
 * Click the Save button on the People page (top right) and VERIFY the save
 * committed before reporting success.
 *
 * The readback contract (live-verified 2026-07-04, EID 10403587, read-only
 * probe `scripts/verify-kronos-save-state.ts`): with no pending edits the Save
 * button carries a native `disabled` attribute; editing enables it. A committed
 * save returns the editor to the no-pending-edits state, so the button must
 * read DISABLED again. If it stays enabled past the deadline (validation error
 * dialog, rejected save, network hang), the edits are still pending — fail loud
 * instead of stamping a payroll row "Updated" for a save that never landed.
 */
export async function savePersonRecord(page: Page): Promise<void> {
  log.step("[New Kronos] Saving person record...");

  const root = peopleFrame(page);
  const saveButton = people.saveButton(root);
  await safeClick(saveButton, {
    timeout: 5_000,
    label: "new kronos save button",
  });

  // Wait for save to complete — the loading overlay should appear then disappear.
  try {
    await loadingOverlay.overlay(page).waitFor({ state: "visible", timeout: 3_000 });
  } catch {
    // Overlay may not appear (fast save) — continue.
  }
  try {
    await loadingOverlay.overlay(page).waitFor({ state: "hidden", timeout: 15_000 });
  } catch {
    // Overlay may have already cleared — continue.
  }

  // Fail-loud commit readback: poll for the Save button returning to its
  // native-`disabled` no-pending-edits state.
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const enabled = await saveButton.isEnabled().catch(() => null);
    if (enabled === false) {
      log.success("[New Kronos] Person record saved (Save button returned to disabled)");
      return;
    }
    await page.waitForTimeout(500);
  }
  throw new Error(
    "[New Kronos] Save button is still enabled 20s after clicking Save — the edits are " +
      "still pending (validation error or rejected save), so the pay rule was NOT persisted. " +
      "Refusing to report the person record as saved.",
  );
}

