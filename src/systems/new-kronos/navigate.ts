import type { Page, Locator } from "playwright";
import { log } from "../../utils/log.js";
import { debugScreenshot } from "../../utils/screenshot.js";
import {
  searchFrame,
  loadingOverlay,
  navbar,
  search as searchSelectors,
  goToMenu,
  timecard,
  type SearchRoot,
} from "./selectors.js";
import { clickIfPresent, safeClick, safeFill } from "../common/index.js";
import {
  formatTimecardDate,
  runTimecardCheck,
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
 * Races the first-result checkbox (→ found) against the "no items" sentinel
 * (→ not found). If NEITHER surfaces within the timeout (both waiters reject),
 * the search is treated as **NOT FOUND** rather than thrown (ISS-B04). New Kronos
 * is a BEST-EFFORT source for the separations Last Day Worked — the handler falls
 * back to the Kuali LDW when New Kronos returns no punch — so a slow/empty grid
 * must not raise a fatal-looking `✗` and burn the run; a `log.warn` keeps it
 * visible without masquerading as a failure. (Genuinely cutting the timeout wait
 * needs the live no-results sentinel re-mapped if it has drifted — that's why a
 * no-record employee currently waits the full timeout before this returns false.)
 *
 * Exported for unit testing: it takes the two `waitFor` promises directly, so the
 * race + timeout-as-not-found contract is pinnable without a live page.
 */
export async function resolveSearchResult(
  checkboxVisible: Promise<unknown>,
  noResultsVisible: Promise<unknown>,
  employeeId: string,
): Promise<boolean> {
  const foundP = checkboxVisible.then(() => true);
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

  const checkbox = searchSelectors.firstResultCheckbox(root);
  const noResults = searchSelectors.noResultsText(root);
  const searchResultTimeout = 15_000;

  const found = await resolveSearchResult(
    checkbox.first().waitFor({ state: "visible", timeout: searchResultTimeout }),
    noResults.waitFor({ state: "visible", timeout: searchResultTimeout }),
    employeeId,
  );

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
 * Click Go To dropdown and select Timecard.
 * Go To may be on the main page or inside the search iframe.
 */
export async function clickGoToTimecard(page: Page): Promise<boolean> {
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

  await gotoButton.click({ timeout: 5_000 });
  await page.waitForTimeout(2_000);

  // Click Timecard/Timecards in the dropdown menu (6-deep fallback)
  const timecardItem = goToMenu.timecardItem(page);

  if (await clickIfPresent(timecardItem, { timeout: 5_000, label: "new kronos timecard menu item" })) {
    // Wait for the Timecard view to render (reduced from 5s).
    await page.waitForTimeout(2_500);
    log.success("[New Kronos] Navigated to Timecard");
    return true;
  }

  log.error("[New Kronos] Timecard option not found in Go To menu");
  return false;
}

/**
 * Switch the pay period dropdown to previous pay period.
 */
export async function switchToPreviousPayPeriod(page: Page): Promise<boolean> {
  log.step("[New Kronos] Switching to previous pay period...");

  // Use payPeriodTriggerButton (regex-based) so it matches regardless of whether
  // the button shows "Current Pay Period" or a date range after setDateRange runs.
  const periodBtn = timecard.payPeriodTriggerButton(page);
  if (await clickIfPresent(periodBtn, { timeout: 5_000, label: "new kronos pay period trigger button" })) {
    await page.waitForTimeout(2_000);

    const prevOption = timecard.previousPayPeriodOption(page);
    if (await clickIfPresent(prevOption, { timeout: 5_000, label: "new kronos previous pay period option" })) {
      await page.waitForTimeout(5_000);
      log.step("[New Kronos] Switched to Previous Pay Period");
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
export async function checkTimecardDates(page: Page): Promise<string | null> {
  await selectEmployeeResult(page);

  const driver: TimecardDriver = {
    goToTimecard: (p) => clickGoToTimecard(p),
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
      const dt = dRows[i] ? dRows[i].textContent!.replace(/\s+/g, " ").trim() : "";
      const m = dt.match(/([A-Za-z]{3})\s+(\d+)\/(\d+)/);
      if (m) cur = { mon: +m[2], day: +m[3] };
      const cells = xRows[i]
        ? [...xRows[i].querySelectorAll("[role=gridcell]")].map((c) =>
            c.textContent!.replace(/\s+/g, " ").trim(),
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

/**
 * The 8 calendar digits (MMDDYYYY) of a date string, normalized so padding
 * never matters: "05/10/2026", "5/10/2026", and a readback of "6/05/2026" all
 * resolve to a comparable 8-digit string.
 *
 * WFD's masked date inputs auto-insert the "/" separators themselves AND display
 * the month without a leading zero, so keystroke entry is driven and VERIFIED on
 * this normalized digit string rather than the formatted string. A well-formed
 * MM/DD/YYYY is zero-padded per component; anything else falls back to a plain
 * digit strip (a partial/placeholder readback then simply won't match → retry).
 */
export function dateDigits(dateStr: string): string {
  const parts = dateStr.trim().split("/");
  if (parts.length === 3) {
    const [m, d, y] = parts;
    const padded = `${m.trim().padStart(2, "0")}${d.trim().padStart(2, "0")}${y.trim().padStart(4, "0")}`;
    if (/^\d{8}$/.test(padded)) return padded;
  }
  return dateStr.replace(/\D/g, "");
}

/**
 * Progressive per-keystroke digit prefixes for a masked date: "05112026" →
 * ["0","05","051","0511","05112","051120","0511202","05112026"].
 *
 * `typeMaskedDate` types ONE digit then waits for the field's stripped digits to
 * equal the next prefix before sending the next keystroke (see below). Pure +
 * pinned by `tests/unit/systems/new-kronos/navigate.test.ts`.
 */
export function maskedDigitPrefixes(want: string): string[] {
  return Array.from(want, (_char, i) => want.slice(0, i + 1));
}

const MASKED_DATE_POLL_MS = 25;
const MASKED_DATE_SETTLE_MS = 1_500;

/**
 * Poll the masked input until its stripped digits equal `wantDigits`. Returns
 * true on match; false on timeout OR overflow (the field already holds MORE
 * digits than wanted — the mask can only have scrambled, so there is nothing to
 * wait out; bail fast and let the caller re-clear + retry).
 */
async function waitForMaskedDigits(
  loc: Locator,
  wantDigits: string,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const current = dateDigits(await loc.inputValue());
    if (current === wantDigits) return true;
    if (current.length > wantDigits.length) return false; // overflowed → retry
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, MASKED_DATE_POLL_MS));
  }
}

/**
 * Empty a masked date input, VERIFYING it clear by readback. select-all +
 * Delete first, then Backspace until no digits remain — the mask may keep its
 * separators or repopulate today's date, so a single Delete is not trusted.
 */
async function clearMaskedInput(loc: Locator): Promise<void> {
  await loc.press("ControlOrMeta+a");
  await loc.press("Delete");
  for (let i = 0; i < 16; i++) {
    if (dateDigits(await loc.inputValue()) === "") return;
    await loc.press("Backspace");
  }
}

/**
 * Type each digit, waiting for the field to reflect the running prefix before
 * the next keystroke. Returns false the instant a digit fails to settle (the
 * mask raced or overflowed) so the caller re-clears and retries the whole entry.
 */
async function typeMaskedDigits(loc: Locator, wantDigits: string): Promise<boolean> {
  for (const prefix of maskedDigitPrefixes(wantDigits)) {
    await loc.press(prefix[prefix.length - 1]);
    if (!(await waitForMaskedDigits(loc, prefix, MASKED_DATE_SETTLE_MS))) return false;
  }
  return true;
}

/**
 * Type a date into one of WFD's masked "Select range" inputs and VERIFY it.
 *
 * These are JS-masked `<input type=text>` controls that (a) silently reject
 * Playwright `fill()` — the value reverts to today (OBS-006) — and (b)
 * auto-insert the "/" separators as digits are typed, on an ASYNC React-
 * controlled re-render. A FIXED inter-key delay races that re-render under load
 * and SCRAMBLES the value: on the live 8-worker parallel separations batch,
 * wanting "05/11/2026" the field landed on "11/20/260622" (10 digits — the year
 * segment overflowed, interleaving today's "0622"), which WFD rejected with
 * "WFP-00889 The date is outside of the valid range of dates" (ISS-B05). The
 * first fix (`pressSequentially(want, { delay: 60 })` + readback) made it fail
 * LOUD but did not remove the race, so dates still never landed.
 *
 * So we drive it CONDITION-BASED, not on a guessed delay: clear the field
 * (verified empty), then type DIGITS ONLY one at a time, waiting after each
 * keystroke for the field to reflect the running prefix before sending the next.
 * The next key is never sent until the mask has committed the current one, so
 * there is no race to lose. Retry the whole entry a few times, then throw loud
 * rather than apply a garbage range.
 */
async function typeMaskedDate(
  loc: Locator,
  dateStr: string,
  label: string,
): Promise<void> {
  const want = dateDigits(dateStr);
  let last = "";
  for (let attempt = 1; attempt <= 4; attempt++) {
    await loc.click({ timeout: 5_000 });
    await clearMaskedInput(loc);
    const settled = await typeMaskedDigits(loc, want);
    last = dateDigits(await loc.inputValue());
    if (settled && last === want) return;
    log.warn(
      `[New Kronos] ${label} date readback mismatch (attempt ${attempt}/4): `
      + `wanted ${want}, got ${last || "<empty>"}`,
    );
  }
  throw new Error(
    `[New Kronos] Could not set ${label} date to ${dateStr} — the masked input `
    + `scrambled the keystrokes (last readback digits: ${last || "<empty>"}). `
    + `Aborting before applying a wrong timecard range (WFP-00889).`,
  );
}

/**
 * Set a custom date range on the New Kronos timecard view.
 * Must be called after navigating to the Timecards page.
 *
 * Mapped via playwright-cli 2026-04-06; digits-only keystroke + readback-verify
 * rework 2026-06-22 (ISS-B05):
 *   1. Click "Current Pay Period" button → opens timeframe dropdown
 *   2. Click "Select range" button → opens date range inputs
 *   3. Type "Start date" and "End date" via `typeMaskedDate` — digits only,
 *      one keystroke at a time, waiting for the field to reflect each digit
 *      (condition-based, NOT a fixed delay: these controls reject fill() AND
 *      race a fixed-delay multi-key type under load; see `typeMaskedDate`).
 *   4. Click "Apply" button
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

  // Step 3 & 4: Type + verify each date (digits only, one settled keystroke at a
  // time — the mask owns the "/" and races a fixed-delay multi-key type).
  await typeMaskedDate(timecard.startDateInput(page), startDate, "start");
  await typeMaskedDate(timecard.endDateInput(page), endDate, "end");

  // Step 5: Click Apply
  await safeClick(timecard.applyButton(page), {
    timeout: 5_000,
    label: "new kronos date range apply button",
  });
  // Wait for WFD to reload the timecard grid with the new range (reduced from 5s).
  await page.waitForTimeout(2_500);
  log.step("[New Kronos] Date range applied");
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
