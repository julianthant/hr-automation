import { mkdirSync } from "fs";
import type { Page } from "playwright";
import { PATHS } from "../config.js";
import { log } from "./log.js";

/**
 * Capture a debug screenshot to `.screenshots/` — off by default.
 *
 * Gate: only runs when `DEBUG_SCREENSHOTS=1` is set in the environment.
 * This avoids 4+ unnecessary fullPage PNG captures per searchPerson call
 * and similar debug-only captures in hot paths. Operator-audit screenshots
 * (ctx.screenshot with kind='form'/'error') are unaffected.
 *
 * To enable: set `DEBUG_SCREENSHOTS=1` in your `.env` file.
 */
export async function debugScreenshot(
  page: Page,
  label: string,
  options?: { fullPage?: boolean; dir?: string },
): Promise<void> {
  if (process.env.DEBUG_SCREENSHOTS !== "1") return;
  try {
    const dir = options?.dir ?? PATHS.screenshotDir;
    mkdirSync(dir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const path = `${dir}/${label}-${ts}.png`;
    await page.screenshot({ path, fullPage: options?.fullPage ?? false });
    log.step(`Screenshot: ${path} (${page.url()})`);
  } catch {
    /* best-effort */
  }
}
