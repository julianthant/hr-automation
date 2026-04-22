/**
 * Download a file from UCSD SharePoint (Excel Online / OneDrive).
 *
 * End-to-end flow (each step documented in `src/systems/sharepoint/CLAUDE.md`):
 *   1. Navigate to the shared SharePoint URL.
 *   2. Microsoft AAD email prefill (`microsoft.*` selectors).
 *   3. UCSD Shibboleth SSO (`fillSsoCredentials` + `clickSsoSubmit`).
 *   4. Duo MFA (`pollDuoApproval({ systemLabel: "SharePoint" })`).
 *   5. "Stay signed in?" / KMSI (`kmsi.noButton`).
 *   6. Excel Online viewer → File → Create a Copy → Download a Copy
 *      (all scoped to `iframe[name="WacFrame_Excel_0"]` via `getExcelFrame`).
 *
 * Attempts to auto-click Download; falls back to waiting for a manual click.
 * Either way, captures the download via Playwright's `download` event.
 *
 * Note: this helper is intentionally NOT wired through `defineWorkflow()`.
 * It's a one-shot utility invoked either from the dashboard button
 * (`buildSharePointRosterDownloadHandler`) or from emergency-contact's
 * pre-flight roster verification. It produces no tracker JSONL events and
 * therefore doesn't surface in the workflow dropdown.
 */
import path from "node:path";
import fs from "node:fs";
import type { Download, Page } from "playwright";
import { launchBrowser } from "../../browser/launch.js";
import { fillSsoCredentials, clickSsoSubmit } from "../../auth/sso-fields.js";
import { pollDuoApproval } from "../../auth/duo-poll.js";
import { validateEnv } from "../../utils/env.js";
import { log } from "../../utils/log.js";
import {
  microsoft,
  kmsi,
  getExcelFrame,
  excelOnline,
  fileMenu,
} from "../../systems/sharepoint/selectors.js";

export interface DownloadSharePointOptions {
  /** URL of the SharePoint file to open (e.g. a shared Excel Online link) */
  url: string;
  /** Directory to save the downloaded file into. Created if missing. */
  outDir: string;
  /** Max seconds to wait for the download event after click. Default 300 (5 min). */
  downloadTimeoutSeconds?: number;
  /** Max seconds to wait for Duo approval. Default 180. */
  duoTimeoutSeconds?: number;
}

async function handleMicrosoftEmailStep(page: Page): Promise<void> {
  const { userId } = validateEnv();
  const emailField = microsoft.emailInput(page);
  if ((await emailField.count()) === 0) return;

  log.step("Microsoft login step — entering UCSD email...");
  await emailField.first().fill(`${userId}@ucsd.edu`, { timeout: 5_000 });
  await microsoft.nextButton(page).first().click({ timeout: 5_000 });
  await page.waitForTimeout(3_000);
}

async function dismissStaySignedIn(page: Page): Promise<void> {
  const noBtn = kmsi.noButton(page);
  if ((await noBtn.count()) > 0) {
    log.step('Dismissing "Stay signed in?" prompt (No)...');
    await noBtn.first().click({ timeout: 3_000 }).catch(() => {});
    await page.waitForTimeout(2_000);
  }
}

/**
 * Auto-click the Excel Online Download path: File → Create a Copy (hover) →
 * Download a Copy (click). All three targets live inside the WAC iframe.
 * Returns true if the click chain succeeded, false if any step's locator
 * couldn't be found within its timeout (caller falls back to manual click).
 */
async function tryClickDownload(page: Page): Promise<boolean> {
  try {
    const frame = getExcelFrame(page);

    const fileBtn = excelOnline.fileButton(frame);
    if ((await fileBtn.count()) === 0) {
      log.step("Excel File button not found — the WAC iframe may still be hydrating");
      return false;
    }

    log.step("Clicking File (Excel ribbon)...");
    await fileBtn.first().click({ timeout: 5_000 });
    await page.waitForTimeout(1_000);

    const createCopy = fileMenu.createACopy(frame);
    if ((await createCopy.count()) === 0) {
      log.step("'Create a Copy' menuitem not found after File click");
      return false;
    }

    // CRITICAL: hover (don't click) — clicking triggers "Create a copy online"
    // (the default flyout action), which navigates away from the workbook.
    log.step("Hovering 'Create a Copy' to reveal the download flyout...");
    await createCopy.first().hover({ timeout: 3_000 });
    await page.waitForTimeout(800);

    const downloadItem = fileMenu.downloadACopy(frame);
    if ((await downloadItem.count()) === 0) {
      log.step("'Download a Copy' menuitem not visible in the Create a Copy flyout");
      return false;
    }

    log.step("Clicking 'Download a Copy'...");
    await downloadItem.first().click({ timeout: 5_000 });
    return true;
  } catch (e) {
    log.step(
      `Auto-click path threw — falling back to manual: ${e instanceof Error ? e.message : String(e)}`,
    );
    return false;
  }
}

/**
 * Download a file from SharePoint to a local path.
 *
 * Launches a headed browser, handles auth, saves the file, closes the browser,
 * and returns the absolute path to the saved file.
 */
export async function downloadSharePointFile(
  options: DownloadSharePointOptions,
): Promise<string> {
  const { url, outDir, downloadTimeoutSeconds = 300, duoTimeoutSeconds = 180 } = options;

  fs.mkdirSync(outDir, { recursive: true });

  const { browser, context, page } = await launchBrowser({ acceptDownloads: true });

  const downloadPromise = new Promise<Download>((resolve) => {
    page.once("download", resolve);
  });

  // Detect user closing the browser window so we don't hang for the full
  // download timeout. Fires when the page or context is closed externally.
  const closedPromise = new Promise<"closed">((resolve) => {
    page.once("close", () => resolve("closed"));
    context.once("close", () => resolve("closed"));
  });

  const closeBrowser = async () => {
    if (browser) await browser.close();
    else await context.close();
  };

  try {
    log.step(`Navigating to SharePoint: ${url.slice(0, 80)}...`);
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.waitForTimeout(3_000);

    await handleMicrosoftEmailStep(page);

    const onSso = page.url().includes("a5.ucsd.edu") ||
      (await page.locator('input[name="j_username"]').count()) > 0;

    if (onSso) {
      log.step("UCSD SSO detected — filling credentials...");
      await fillSsoCredentials(page);
      await clickSsoSubmit(page);

      const approved = await pollDuoApproval(page, {
        systemLabel: "SharePoint",
        successUrlMatch: (u) =>
          u.includes("sharepoint.com") ||
          u.includes("office.com") ||
          u.includes("login.microsoftonline.com/kmsi") ||
          u.includes("login.microsoftonline.com/login.srf"),
        timeoutSeconds: duoTimeoutSeconds,
      });
      if (!approved) {
        throw new Error("Duo approval timed out during SharePoint login");
      }
    } else {
      log.step("No SSO redirect — possibly already authenticated via cached cookies");
    }

    await page.waitForTimeout(3_000);
    await dismissStaySignedIn(page);

    log.step("Waiting for Excel Online viewer to settle...");
    await page.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => {});
    await page.waitForTimeout(5_000);

    const clicked = await tryClickDownload(page);
    if (clicked) {
      log.step("Auto-clicked Download.");
    } else {
      log.waiting(
        `Could not auto-click Download — please click File → Create a Copy → Download a Copy manually (waiting up to ${downloadTimeoutSeconds}s)...`,
      );
    }

    const result = await Promise.race([
      downloadPromise,
      closedPromise,
      new Promise<null>((resolve) =>
        setTimeout(() => resolve(null), downloadTimeoutSeconds * 1000),
      ),
    ]);

    if (result === "closed") {
      throw new Error("Browser window was closed before the download completed");
    }

    const download = result;

    if (!download) {
      throw new Error(`No download captured within ${downloadTimeoutSeconds}s`);
    }

    const suggested = download.suggestedFilename();
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const outPath = path.resolve(outDir, `${stamp}-${suggested}`);
    await download.saveAs(outPath);
    log.success(`Saved: ${outPath}`);
    return outPath;
  } finally {
    await closeBrowser();
  }
}
