import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
} from "playwright";
import fs from "node:fs";
import path from "node:path";
import { log } from "../utils/log.js";

const AUTH_DIR = path.join(process.cwd(), ".auth");
const STATE_FILE = path.join(AUTH_DIR, "state.json");

export async function launchBrowser(
  fresh: boolean = false,
): Promise<{ browser: Browser; context: BrowserContext; page: Page }> {
  log.step("Launching browser...");
  const browser = await chromium.launch({ headless: false });

  const hasState = !fresh && fs.existsSync(STATE_FILE);
  if (hasState) {
    log.step("Loading saved session...");
  }

  const context = await browser.newContext(
    hasState ? { storageState: STATE_FILE } : undefined,
  );
  const page = await context.newPage();

  return { browser, context, page };
}

export async function saveSession(context: BrowserContext): Promise<void> {
  fs.mkdirSync(AUTH_DIR, { recursive: true });
  await context.storageState({ path: STATE_FILE });
  log.success("Session saved");
}

export function clearSession(): void {
  if (fs.existsSync(STATE_FILE)) {
    fs.unlinkSync(STATE_FILE);
    log.success("Cleared saved session");
  }
}
