import { mkdirSync } from "fs";
import type { Page } from "playwright";
import { log } from "./log.js";

const DEFAULT_DIR = ".auth";

export async function debugScreenshot(
  page: Page,
  name: string,
  options?: { fullPage?: boolean; dir?: string },
): Promise<void> {
  const dir = options?.dir ?? DEFAULT_DIR;
  mkdirSync(dir, { recursive: true });
  const path = `${dir}/${name}.png`;
  await page.screenshot({ path, fullPage: options?.fullPage ?? false });
  log.step(`Screenshot: ${path} (${page.url()})`);
}
