import { mkdirSync } from "fs";
import type { Page } from "playwright";
import { PATHS } from "../config.js";
import { log } from "./log.js";

export async function debugScreenshot(
  page: Page,
  label: string,
  options?: { fullPage?: boolean; dir?: string },
): Promise<void> {
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
