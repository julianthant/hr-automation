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

function stateFile(name: string): string {
  return path.join(AUTH_DIR, `${name}-state.json`);
}

export async function launchBrowser(
  sessionName: string,
  fresh: boolean = false,
): Promise<{ browser: Browser; context: BrowserContext; page: Page }> {
  log.step(`Launching browser (${sessionName})...`);
  const browser = await chromium.launch({ headless: false });

  const file = stateFile(sessionName);
  const hasState = !fresh && fs.existsSync(file);
  if (hasState) {
    log.step(`Loading saved ${sessionName} session...`);
  }

  const context = await browser.newContext(
    hasState ? { storageState: file } : undefined,
  );
  const page = await context.newPage();

  return { browser, context, page };
}

export async function saveSession(
  context: BrowserContext,
  sessionName: string,
): Promise<void> {
  fs.mkdirSync(AUTH_DIR, { recursive: true });
  await context.storageState({ path: stateFile(sessionName) });
  log.success(`${sessionName} session saved`);
}

export function clearSession(sessionName?: string): void {
  if (sessionName) {
    const file = stateFile(sessionName);
    if (fs.existsSync(file)) {
      fs.unlinkSync(file);
      log.success(`Cleared ${sessionName} session`);
    }
  } else {
    // Clear all sessions
    for (const name of ["ucpath", "actcrm"]) {
      const file = stateFile(name);
      if (fs.existsSync(file)) {
        fs.unlinkSync(file);
      }
    }
    log.success("Cleared all saved sessions");
  }
}
