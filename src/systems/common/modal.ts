import type { Page } from "playwright";

/**
 * Hide PeopleSoft modal mask overlays (`#pt_modalMask` and `.ptModalMask`).
 *
 * PeopleSoft leaves these transparent masks visible between tab switches and
 * after some interactions, intercepting every click with "subtree intercepts
 * pointer events" and making Playwright retry forever. Hide them via JS before
 * any click that targets the iframe content.
 *
 * Shared by UCPath and the emergency-contact flow (HR Tasks page).
 */
export async function dismissPeopleSoftModalMask(page: Page): Promise<void> {
  await page
    .evaluate(() => {
      document.querySelectorAll("#pt_modalMask, .ptModalMask").forEach((el) => {
        (el as HTMLElement).style.display = "none";
      });
    })
    .catch(() => {});
}
