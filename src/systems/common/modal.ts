import type { Page } from "playwright";

/**
 * Hide PeopleSoft's `#pt_modalMask` overlay.
 *
 * PeopleSoft leaves this transparent mask visible between tab switches and
 * after some interactions, intercepting every click with "subtree intercepts
 * pointer events" and making Playwright retry forever. Hide it via JS before
 * any click that targets the iframe content.
 *
 * This is UCPath-specific (and the emergency-contact flow which uses UCPath's
 * HR Tasks page), but landed in `common/` because two call sites in
 * `src/systems/ucpath/` already duplicate this function. One home is better
 * than two.
 */
export async function dismissPeopleSoftModalMask(page: Page): Promise<void> {
  await page
    .evaluate(() => {
      const mask = document.getElementById("pt_modalMask");
      if (mask) mask.style.display = "none";
    })
    .catch(() => {});
}
