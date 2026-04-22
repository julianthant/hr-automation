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
 * pre-flight roster verification. It does not emit workflow-tracker entries,
 * so it stays out of the workflow dropdown. When the optional `session`
 * option is passed (dashboard path) it DOES emit dashboard session-panel
 * events (workflow_start/end at the handler layer; browser_launch,
 * auth_start/complete, duo_request/complete, step_change here) so the
 * operator can see the run live in the Sessions rail just like a kernel
 * workflow. Standalone CLI + preflight paths pass no `session` → silent.
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
import {
  emitSessionCreate,
  emitSessionClose,
  emitBrowserLaunch,
  emitBrowserClose,
  emitAuthStart,
  emitAuthComplete,
  emitStepChange,
  emitSessionEvent,
} from "../../tracker/session-events.js";

/**
 * Optional callback hook invoked at every phase transition of the download
 * flow. When non-null, `downloadSharePointFile` mirrors its progress into the
 * dashboard's Sessions rail (browser chip + auth state + current step) via
 * the tracker's session-events JSONL. Omit (or pass `undefined`) for the
 * standalone-CLI / emergency-contact-preflight paths, which either don't need
 * UI surfacing or are already inside a kernel workflow with its own events.
 */
export interface DownloadSharePointSession {
  /**
   * Workflow instance label, typically generated via
   * `generateInstanceName("sharepoint-download")` → "SharePoint 1". Must
   * match the same instance the caller emitted `workflow_start` with, or the
   * Session panel won't correlate the two event streams.
   */
  instance: string;
  /**
   * Browser chip label. Defaults to `"sharepoint"` — the convention matching
   * other systems (`ucpath`, `kuali`, etc.).
   */
  system?: string;
  /**
   * Tracker directory. Defaults to `DEFAULT_DIR` (`.tracker/`). Passed through
   * so tests can point at a tmp dir without polluting the real SSE stream.
   */
  dir?: string;
}

export interface DownloadSharePointOptions {
  /** URL of the SharePoint file to open (e.g. a shared Excel Online link) */
  url: string;
  /** Directory to save the downloaded file into. Created if missing. */
  outDir: string;
  /** Max seconds to wait for the download event after click. Default 300 (5 min). */
  downloadTimeoutSeconds?: number;
  /** Max seconds to wait for Duo approval. Default 180. */
  duoTimeoutSeconds?: number;
  /** Optional — when provided, emit dashboard Session-panel lifecycle events (see `DownloadSharePointSession`). */
  session?: DownloadSharePointSession;
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
  const { url, outDir, downloadTimeoutSeconds = 300, duoTimeoutSeconds = 180, session } = options;

  fs.mkdirSync(outDir, { recursive: true });

  // Session-panel bookkeeping — only emits when the caller opted into it.
  // Unique ids are suffixed with `process.pid + Date.now()` so concurrent runs
  // (blocked at the HTTP layer today, but defensive) never collide.
  const systemLabel = session?.system ?? "sharepoint";
  const sessionId = session ? `sp-session-${process.pid}-${Date.now()}` : "";
  const browserId = session ? `sp-browser-${process.pid}-${Date.now()}` : "";
  const step = session
    ? (name: string) => emitStepChange(session.instance, name, session.dir)
    : () => {};

  const { browser, context, page } = await launchBrowser({ acceptDownloads: true });

  if (session) {
    emitSessionCreate(session.instance, sessionId, session.dir);
    emitBrowserLaunch(session.instance, sessionId, browserId, systemLabel, session.dir);
  }

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
    step("navigate");
    log.step(`Navigating to SharePoint: ${url.slice(0, 80)}...`);
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.waitForTimeout(3_000);

    await handleMicrosoftEmailStep(page);

    const onSso = page.url().includes("a5.ucsd.edu") ||
      (await page.locator('input[name="j_username"]').count()) > 0;

    if (onSso) {
      step("sso");
      if (session) {
        emitAuthStart(session.instance, browserId, systemLabel, session.dir);
      }
      log.step("UCSD SSO detected — filling credentials...");
      await fillSsoCredentials(page);
      await clickSsoSubmit(page);

      // Duo — emit request/complete so the browser chip flips to the
      // duo_waiting (yellow/glow) state for the duration of the phone tap.
      // Request-id only has to be unique within the `.tracker/sessions.jsonl`
      // file; instance + timestamp is plenty.
      const duoRequestId = session
        ? `${session.instance}-${systemLabel}-${Date.now()}`
        : "";
      if (session) {
        step("duo");
        emitSessionEvent(
          {
            type: "duo_request",
            workflowInstance: session.instance,
            system: systemLabel,
            browserId,
            duoRequestId,
          },
          session.dir,
        );
      }

      try {
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
      } finally {
        // Always emit duo_complete — even on the throw path above, this
        // resolves the duo_request so the session-panel chip doesn't stay
        // stuck in duo_waiting after the workflow ends.
        if (session) {
          emitSessionEvent(
            {
              type: "duo_complete",
              workflowInstance: session.instance,
              system: systemLabel,
              browserId,
              duoRequestId,
            },
            session.dir,
          );
        }
      }

      if (session) {
        emitAuthComplete(session.instance, browserId, systemLabel, session.dir);
      }
    } else {
      log.step("No SSO redirect — possibly already authenticated via cached cookies");
      // Cached-cookie path: fake the auth lifecycle so the chip still
      // transitions idle → authed instead of looking stuck.
      if (session) {
        emitAuthStart(session.instance, browserId, systemLabel, session.dir);
        emitAuthComplete(session.instance, browserId, systemLabel, session.dir);
      }
    }

    await page.waitForTimeout(3_000);
    await dismissStaySignedIn(page);

    step("download");
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
    if (session) {
      emitBrowserClose(session.instance, browserId, systemLabel, session.dir);
      emitSessionClose(session.instance, sessionId, session.dir);
    }
  }
}
