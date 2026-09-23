import type { Locator, Page } from "playwright";
import { log } from "../../utils/log.js";
import { classifyPlaywrightError } from "../../utils/errors.js";
import { I9_APP_URL } from "../../config.js";
import { dismissTrainingNotification } from "./login.js";

/**
 * Force-close every visible Kendo UI window modal on the page. Idempotent.
 * Clicks all known close-button selectors inside .k-window, then presses
 * Escape as a fallback for modals that don't render an explicit close.
 *
 * I9's New Employee flow accumulates Kendo windows across the search-then-create
 * path; titles like "titlebar-newUI-4" in today's logs suggest multiple modals
 * were stacked when a click was blocked. Always call this before clicking
 * interactive elements on the dashboard after a dialog interaction.
 */
export async function closeAllKendoWindows(page: Page): Promise<void> {
  await page.evaluate(() => {
    const closers = Array.from(
      document.querySelectorAll<HTMLElement>(
        ".k-window .k-window-action, .k-window .k-i-close, .k-window [aria-label='Close']", // allow-inline-selector
      ),
    );
    closers.forEach((el) => el.click());
  }).catch(() => {});
  await page.keyboard.press("Escape").catch(() => {});
  await page.waitForTimeout(250);
}

/**
 * HARD-reset the I-9 page between items.
 *
 * The daemon reuses one long-lived I-9 browser across every queued person, and
 * the app's Kendo windows are never fully torn down: after a few items the page
 * carries a pile of stale hidden dialogs ("Session Time Out Warning",
 * "Create I-9 Wizard", "Worksite Required", "Duplicate Employee Record", …).
 * Their overlays still intercept pointer events, so the next item's
 * "Search Options" click is blocked and every remaining item on that worker
 * fails with an opaque timeout (live 2026-08-20: k-windows=15, five hires lost
 * this way).
 *
 * `closeAllKendoWindows` cannot fix this — it clicks close buttons, which
 * hidden windows do not reliably expose. A navigation destroys the DOM outright,
 * which is the only reliable reset.
 *
 * Cheap (one page load) and idempotent. Throws if the dashboard does not come
 * back, because continuing on a poisoned page just produces the same opaque
 * failure one step later.
 *
 * verified 2026-08-20
 */
export async function resetI9Page(page: Page): Promise<void> {
  await page.goto(I9_APP_URL, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
  await dismissTrainingNotification(page);
  const stale = await page.evaluate(() => document.querySelectorAll(".k-window").length).catch(() => -1);
  if (stale > 0) {
    log.warn(`[I9] ${stale} Kendo window(s) still present after reset navigation`);
  }
  log.step("[I9] page reset for this item (stale dialogs cleared)");
}

/**
 * Return a one-line summary of every visible Kendo k-window on the page.
 * Used diagnostically before clicks known to be blocked by stale modals
 * (e.g. "Create New I-9" on the dashboard after a search dialog).
 *
 * Example output: "k-windows=3 [1:'Search Employees',2:'',3:'Options']"
 * With a hidden window: "k-windows=2 [1:'Search Employees',2:'Options'-hidden]"
 */
export async function snapshotKendoWindows(page: Page): Promise<string> {
  return page.evaluate(() => {
    const windows = Array.from(document.querySelectorAll<HTMLElement>(".k-window")); // allow-inline-selector
    if (windows.length === 0) return "k-windows=0";
    const summaries = windows.map((w, i) => {
      const title = w.querySelector(".k-window-title")?.textContent?.trim().slice(0, 30) ?? ""; // allow-inline-selector
      const maybe = w as HTMLElement & { checkVisibility?: () => boolean };
      const visible = typeof maybe.checkVisibility === "function"
        ? maybe.checkVisibility()
        : w.offsetWidth > 0 && w.offsetHeight > 0 && getComputedStyle(w).visibility !== "hidden";
      return `${i + 1}:'${title}'${visible ? "" : "-hidden"}`;
    });
    return `k-windows=${windows.length} [${summaries.join(",")}]`;
  }).catch(() => "k-windows=<evaluate-failed>");
}

export async function clickWithKendoRecovery(
  page: Page,
  locator: Locator,
  label: string,
  timeout = 10_000,
): Promise<void> {
  try {
    await locator.click({ timeout });
  } catch (err) {
    const classified = classifyPlaywrightError(err);
    log.warn(
      `I9 ${label} click blocked (${classified.kind}: ${classified.summary}) — state: ${await snapshotKendoWindows(page)}`,
    );
    await closeAllKendoWindows(page);
    await locator.click({ timeout });
  }
}
