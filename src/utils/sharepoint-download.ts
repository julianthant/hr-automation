/**
 * Download a file from UCSD SharePoint (Excel Online / OneDrive).
 *
 * Handles the Microsoft email prefill step, UCSD Shibboleth SSO via `fillSsoCredentials`,
 * Duo approval via `pollDuoApproval`, and the post-Duo "Stay signed in?" prompt.
 *
 * Attempts to auto-click Download; falls back to waiting for a manual click.
 * Either way, captures the download via Playwright's download event.
 */
import path from "node:path";
import fs from "node:fs";
import type { Download, Page } from "playwright";
import { launchBrowser } from "../browser/launch.js";
import { fillSsoCredentials, clickSsoSubmit } from "../auth/sso-fields.js";
import { pollDuoApproval } from "../auth/duo-poll.js";
import { validateEnv } from "./env.js";
import { log } from "./log.js";

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
  const emailField = page.locator('input[type="email"], input[name="loginfmt"]');
  if ((await emailField.count()) === 0) return;

  log.step("Microsoft login step — entering UCSD email...");
  await emailField.first().fill(`${userId}@ucsd.edu`, { timeout: 5_000 });
  const nextBtn = page
    .getByRole("button", { name: /^next$/i })
    .or(page.locator('input[type="submit"][value*="Next" i]'))
    .or(page.locator('input[type="submit"]'));
  await nextBtn.first().click({ timeout: 5_000 });
  await page.waitForTimeout(3_000);
}

async function dismissStaySignedIn(page: Page): Promise<void> {
  const noBtn = page
    .getByRole("button", { name: /^no$/i })
    .or(page.locator('input[type="button"][value="No"]'))
    .or(page.locator('input[type="submit"][value="No"]'));
  if ((await noBtn.count()) > 0) {
    log.step('Dismissing "Stay signed in?" prompt (No)...');
    await noBtn.first().click({ timeout: 3_000 }).catch(() => {});
    await page.waitForTimeout(2_000);
  }
}

async function tryClickDownload(page: Page): Promise<boolean> {
  const directButtons = [
    page.getByRole("button", { name: /^download$/i }),
    page.locator('button[aria-label*="Download" i]'),
    page.locator('[data-automation-id*="download" i]'),
  ];
  for (const btn of directButtons) {
    if ((await btn.count()) > 0) {
      try {
        await btn.first().click({ timeout: 3_000 });
        return true;
      } catch {
        // Try next
      }
    }
  }

  // File menu -> Download a Copy
  try {
    const fileMenu = page
      .getByRole("menuitem", { name: /^file$/i })
      .or(page.getByRole("button", { name: /^file$/i }));
    if ((await fileMenu.count()) > 0) {
      await fileMenu.first().click({ timeout: 3_000 });
      await page.waitForTimeout(1_000);
      const downloadItem = page
        .getByRole("menuitem", { name: /download a copy|download as/i })
        .or(page.getByText(/download a copy/i));
      if ((await downloadItem.count()) > 0) {
        await downloadItem.first().click({ timeout: 3_000 });
        return true;
      }
    }
  } catch {
    // Menu path failed
  }

  return false;
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
        successUrlMatch: (u) =>
          u.includes("sharepoint.com") ||
          u.includes("office.com") ||
          u.includes("login.microsoftonline.com/kmsi"),
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
        `Could not auto-click Download — please click Download in the browser (waiting up to ${downloadTimeoutSeconds}s)...`,
      );
    }

    const download = await Promise.race([
      downloadPromise,
      new Promise<null>((resolve) =>
        setTimeout(() => resolve(null), downloadTimeoutSeconds * 1000),
      ),
    ]);

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
