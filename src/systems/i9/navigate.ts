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
