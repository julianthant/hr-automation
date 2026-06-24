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
  // Fix: the result is FOUND when EITHER the checkbox is ATTACHED (present in the
  // DOM = a result exists, regardless of its visibility) OR the result slat is
  // visible — `selectEmployeeResult` already keys presence off `count()`, not
  // visibility, for the same reason. Genuine no-results still settles on the
  // "no items to display" sentinel (or the ISS-B04 timeout → NOT FOUND).
  const checkbox = searchSelectors.firstResultCheckbox(root);
  const slat = searchSelectors.firstResultSlat(root);
  const noResults = searchSelectors.noResultsText(root);
  const searchResultTimeout = 15_000;

  const found = await resolveSearchResult(
    Promise.any([
      checkbox.waitFor({ state: "attached", timeout: searchResultTimeout }),
      slat.waitFor({ state: "visible", timeout: searchResultTimeout }),
    ]),
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
    // Wait for the Timecard view to render.
    await page.waitForTimeout(2_500);
    log.success("[New Kronos] Navigated to Timecard");
    return true;
  }

  log.error(
    "[New Kronos] Timecard option never rendered in the Go To menu — could not open the timecard",
  );
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
