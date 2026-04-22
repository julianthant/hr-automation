/**
 * SharePoint / Excel Online download primitives.
 *
 * Two low-level helpers exported for reuse:
 *   - `loginToSharePoint(page, landingUrl)` — navigates to a SharePoint URL
 *     and completes the Microsoft AAD → UCSD Shibboleth → Duo → KMSI auth
 *     chain. Used by the kernel workflow's `systems[].login`.
 *   - `clickExcelDownload(page)` — clicks through the File menu inside the
 *     WAC iframe (File → Create a Copy hover → Download a Copy) and returns
 *     the captured Playwright `Download` object. Used by the kernel
 *     workflow's `download` step.
 *
 * One coarse helper retained for non-kernel callers (emergency-contact
 * pre-flight + CLI):
 *   - `downloadSharePointFile(options)` — end-to-end wrapper: launches a
 *     browser, calls both helpers, saves the file, closes the browser, and
 *     returns the absolute saved path. Silent (no session events) — the
 *     kernel path handles all UI surfacing via `Session.launch` observers.
 *
 * End-to-end auth flow (each step documented in `src/systems/sharepoint/CLAUDE.md`):
 *   1. Navigate to the SharePoint URL.
 *   2. Microsoft AAD email prefill (`microsoft.*` selectors).
 *   3. UCSD Shibboleth SSO (`fillSsoCredentials` + `clickSsoSubmit`).
 *   4. Duo MFA (`pollDuoApproval({ systemLabel: "SharePoint" })`).
 *   5. "Stay signed in?" / KMSI (`kmsi.noButton`).
 *   6. Excel Online viewer settles.
 *
 * Then the download flow: File → Create a Copy (hover) → Download a Copy
 * (all scoped to `iframe[name="WacFrame_Excel_0"]` via `getExcelFrame`).
 */
import path from "node:path";
import fs from "node:fs";
import type { Download, Page } from "playwright";
import { launchBrowser } from "../../browser/launch.js";
import { fillSsoCredentials, clickSsoSubmit } from "../../auth/sso-fields.js";
import { pollDuoApproval } from "../../auth/duo-poll.js";
import { requestDuoApproval } from "../../tracker/duo-queue.js";
import { validateEnv } from "../../utils/env.js";
import { log } from "../../utils/log.js";
import {
  microsoft,
  adfs,
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
 * Fill the UCSD ADFS federation login form and click Sign in. Unlike the
 * Shibboleth IdP used by UCPath / CRM / Kuali, SharePoint / OneDrive routes
 * through `ad-wfs-aws.ucsd.edu/adfs/ls/` — a visually simpler form with
 * `name="UserName"` + `name="Password"` + `#submitButton`. The password is
 * pulled from the same `UCPATH_PASSWORD` env var (it's the same UCSD SSO
 * password). The username field is usually pre-populated via the `?username=`
 * URL parameter Microsoft passes along, but we re-fill defensively.
 */
async function handleAdfsLogin(page: Page): Promise<void> {
  const { password } = validateEnv();

  log.step("UCSD ADFS detected — filling password...");

  // Only refill username if empty — Microsoft usually populates it via URL.
  const usernameField = adfs.usernameInput(page).first();
  const currentUser = await usernameField.inputValue().catch(() => "");
  if (!currentUser) {
    const { userId } = validateEnv();
    await usernameField.fill(`${userId}@ucsd.edu`, { timeout: 5_000 });
  }

  await adfs.passwordInput(page).first().fill(password, { timeout: 5_000 });
  await page.waitForTimeout(300);
  await adfs.submitButton(page).first().click({ timeout: 5_000 });
  log.step("ADFS submit clicked");
}

/**
 * Navigate to a SharePoint URL and complete the full Microsoft AAD +
 * UCSD Shibboleth + Duo + KMSI auth flow. Returns when the page has
 * stabilized on a SharePoint/Office domain.
 *
 * Designed to be called from a kernel workflow's `systems[].login` — when
 * used there, Session.launch's observer fires `auth_start` / `auth_complete`
 * around this call, and `pollDuoApproval`'s internal
 * `requestDuoApproval` emits `duo_request` / `duo_complete` on the shared
 * Duo queue. Both surface in the Sessions rail automatically.
 *
 * Throws if Duo approval times out or the auth redirect chain stalls.
 */
export async function loginToSharePoint(
  page: Page,
  landingUrl: string,
  opts: { duoTimeoutSeconds?: number; instance?: string } = {},
): Promise<void> {
  const duoTimeoutSeconds = opts.duoTimeoutSeconds ?? 180;

  log.step(`Navigating to SharePoint: ${landingUrl.slice(0, 80)}...`);
  await page.goto(landingUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await page.waitForTimeout(3_000);

  await handleMicrosoftEmailStep(page);

  // UCSD federates Microsoft AAD through two different SSO front-ends
  // depending on the target service:
  //   - `a5.ucsd.edu` (Shibboleth IdP) for UCPath / CRM / Kuali / Kronos.
  //   - `ad-wfs-aws.ucsd.edu/adfs/ls/` (ADFS) for SharePoint / OneDrive.
  // The ADFS form has different field names (`UserName` / `Password`), so
  // the Shibboleth `fillSsoCredentials` helper can't cover it. Detect both.
  const currentUrl = page.url();
  const onShibboleth =
    currentUrl.includes("a5.ucsd.edu") ||
    (await page.locator('input[name="j_username"]').count()) > 0;
  const onAdfs =
    currentUrl.includes("ad-wfs-aws.ucsd.edu") ||
    currentUrl.includes("/adfs/ls") ||
    (await page.locator('input[name="UserName"]').count()) > 0;

  const needsSso = onShibboleth || onAdfs;

  if (needsSso) {
    if (onShibboleth) {
      log.step("UCSD Shibboleth SSO detected — filling credentials...");
      await fillSsoCredentials(page);
      await clickSsoSubmit(page);
    } else {
      await handleAdfsLogin(page);
    }

    // When called from a kernel workflow we have an `instance` and route
    // through the Duo queue so the Sessions rail's Duo chip lights up and
    // the operator sees a row in the Duo tray. Without an instance (CLI
    // preflight / standalone script) fall back to the plain poll — no
    // dashboard to surface into anyway.
    const duoOptions = {
      systemLabel: "SharePoint",
      successUrlMatch: (u: string) =>
        u.includes("sharepoint.com") ||
        u.includes("office.com") ||
        u.includes("login.microsoftonline.com/kmsi") ||
        u.includes("login.microsoftonline.com/login.srf"),
      timeoutSeconds: duoTimeoutSeconds,
    };
    const approved = opts.instance
      ? await requestDuoApproval(page, {
          ...duoOptions,
          system: "SharePoint",
          instance: opts.instance,
        })
      : await pollDuoApproval(page, duoOptions);

    if (!approved) {
      throw new Error("Duo approval timed out during SharePoint login");
    }
  } else {
    log.step("No SSO redirect — possibly already authenticated via cached cookies");
  }

  await page.waitForTimeout(3_000);
  await dismissStaySignedIn(page);
}

/**
 * Auto-click the Excel Online Download path: File → Create a Copy (hover) →
 * Download a Copy (click). All three targets live inside the WAC iframe.
 * Returns true if the click chain succeeded, false if any step's locator
 * couldn't be found within its timeout (caller falls back to manual click).
 *
 * CRITICAL: "Create a Copy" must be hovered, not clicked — clicking fires
 * "Create a copy online" (the default flyout action), which navigates away.
 */
export async function clickExcelDownloadMenu(page: Page): Promise<boolean> {
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
 * Wait for the Excel viewer to settle, fire the download click chain, and
 * capture the resulting `Download`. Returns the saved absolute path.
 *
 * Assumes `page` is already at the file URL and authenticated. Designed to
 * run inside a kernel workflow step — throws on timeout / manual browser
 * close so the kernel marks the step failed.
 */
export async function captureExcelDownload(
  page: Page,
  outDir: string,
  opts: { downloadTimeoutSeconds?: number } = {},
): Promise<{ path: string; filename: string }> {
  const downloadTimeoutSeconds = opts.downloadTimeoutSeconds ?? 300;

  fs.mkdirSync(outDir, { recursive: true });

  const downloadPromise = new Promise<Download>((resolve) => {
    page.once("download", resolve);
  });
  const closedPromise = new Promise<"closed">((resolve) => {
    page.once("close", () => resolve("closed"));
    page.context().once("close", () => resolve("closed"));
  });

  log.step("Waiting for Excel Online viewer to settle...");
  await page.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => {});
  await page.waitForTimeout(5_000);

  const clicked = await clickExcelDownloadMenu(page);
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
  if (!result) {
    throw new Error(`No download captured within ${downloadTimeoutSeconds}s`);
  }

  const suggested = result.suggestedFilename();
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const filename = `${stamp}-${suggested}`;
  const outPath = path.resolve(outDir, filename);
  await result.saveAs(outPath);
  log.success(`Saved: ${outPath}`);
  return { path: outPath, filename };
}

/**
 * End-to-end SharePoint file download: launches a headed browser, auths,
 * triggers the Excel Online download, saves the file, closes the browser.
 *
 * This is the NON-kernel entry point. Kept for:
 *   - `src/workflows/emergency-contact/workflow.ts` pre-flight roster
 *     verification (runs inside a batch and doesn't want a nested kernel
 *     workflow).
 *   - `src/workflows/emergency-contact/scripts/download-roster.ts` standalone
 *     CLI (no dashboard context).
 *
 * The dashboard button path goes through the kernel
 * (`sharepointDownloadWorkflow` in `workflow.ts`) instead, which gets
 * automatic session events + logs + queue rows.
 *
 * Emits nothing to `.tracker/sessions.jsonl` — preflight / CLI should be
 * silent.
 */
export async function downloadSharePointFile(
  options: DownloadSharePointOptions,
): Promise<string> {
  const { url, outDir, downloadTimeoutSeconds = 300, duoTimeoutSeconds = 180 } = options;

  fs.mkdirSync(outDir, { recursive: true });

  const { browser, context, page } = await launchBrowser({ acceptDownloads: true });
  void context; // context reference kept for acceptDownloads wiring; not used here

  const closeBrowser = async () => {
    if (browser) await browser.close();
    else await context.close();
  };

  try {
    await loginToSharePoint(page, url, { duoTimeoutSeconds });
    const { path: saved } = await captureExcelDownload(page, outDir, {
      downloadTimeoutSeconds,
    });
    return saved;
  } finally {
    await closeBrowser();
  }
}
