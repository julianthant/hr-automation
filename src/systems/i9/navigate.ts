import type { Page } from "playwright";

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
