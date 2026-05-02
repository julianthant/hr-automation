/**
 * Kernel definition for the `sharepoint-download` workflow.
 *
 * What this gets us automatically (vs. the pre-2026-04-22 non-kernel shape):
 *   - Appears in the TopBar workflow dropdown (via `register()` called from
 *     `defineWorkflow`; dashboard picks it up from `/api/workflow-definitions`).
 *   - Per-run tracker row in the Queue panel (name = spec label, id = spec id).
 *   - Per-run log lines in the LogPanel via kernel's log-context wrapper.
 *   - Live box in the Session panel via `Session.launch` observers
 *     (`auth_start` / `auth_complete` wrapping `systems[].login`; Duo queue
 *     entry via `requestDuoApproval` inside `loginToSharePoint`).
 *   - DONE / FAILED pill + automatic cleanup on SIGINT (withTrackedWorkflow
 *     owns the signal handler).
 *
 * Runs one file per invocation. Concurrency is blocked at the HTTP handler
 * level (`rosterDownloadInFlight` module-level lock in handler.ts) because
 * two headed browsers would fight over the same phone-tap Duo resource.
 *
 * Input-URL injection: `systems[].login` doesn't receive workflow input, so
 * the login function reads `pendingLandingUrl` — a module-level mutable the
 * handler sets via `_setPendingLandingUrl(url)` immediately before firing
 * `runWorkflow`, and clears in `finally`. Safe because the HTTP-level lock
 * serializes all runs. This is the ONLY place in the repo using this
 * pattern; other workflows have hardcoded auth URLs.
 */
import type { Page } from "playwright";
import {
  defineWorkflow,
  runWorkflow,
  type RegisteredWorkflow,
} from "../../core/index.js";
import { log } from "../../utils/log.js";
import { errorMessage } from "../../utils/errors.js";
import {
  loginToSharePoint,
  captureExcelDownload,
} from "./download.js";
import {
  SharePointDownloadInputSchema,
  type SharePointDownloadInput,
} from "./schema.js";

const sharepointDownloadSteps = ["navigate", "download"] as const;

/**
 * Module-level landing URL for the current run. Set by the HTTP handler
 * before `runWorkflow` fires, cleared in the handler's `finally` block.
 * The systems login function reads this; it can't receive `input` directly
 * because the kernel's `SystemConfig.login` signature is fixed at
 * `(page, instance?) => Promise<void>`.
 *
 * Exported test hook `_setPendingLandingUrl` lets unit tests exercise the
 * workflow end-to-end without going through the HTTP handler.
 */
let pendingLandingUrl: string | null = null;
export function _setPendingLandingUrl(url: string | null): void {
  pendingLandingUrl = url;
}

/**
 * Module-level "last completed download" result. Set by the handler step
 * after `saveAs` succeeds; consumed by the HTTP handler's `.finally` block
 * via `_takeLastDownloadResult()` so the status endpoint can surface the
 * actual saved path to polling clients (e.g. `useSharePointDownload`).
 *
 * Single-slot is safe under the same in-flight lock (`rosterDownloadInFlight`
 * in handler.ts) that protects `pendingLandingUrl`. The `take`-style read
 * clears the slot so a stale path can't leak across runs if a future
 * caller forgets to set it.
 */
let lastDownloadResult: { path: string; filename: string } | null = null;
export function _takeLastDownloadResult(): {
  path: string;
  filename: string;
} | null {
  const result = lastDownloadResult;
  lastDownloadResult = null;
  return result;
}

async function sharepointLogin(page: Page, instance?: string): Promise<void> {
  if (!pendingLandingUrl) {
    throw new Error(
      "sharepoint-download: systems[].login called without a pending URL — " +
        "handler.ts must call _setPendingLandingUrl() before runWorkflow",
    );
  }
  await loginToSharePoint(page, pendingLandingUrl, { instance });
}

/**
 * Kernel workflow. Single-item, single-browser.
 *
 * Steps (after the auto-prefixed `auth:sharepoint`):
 *   - `navigate` — ensures the page lands on the Excel viewer. Today this
 *     is implicit (the login already did `goto(url)`), but the step exists
 *     so the timeline has a hook for any future post-auth navigation (e.g.
 *     switching files mid-run).
 *   - `download` — clicks the File → Create a Copy → Download a Copy chain
 *     inside the WAC iframe and saves the file to `outDir`.
 */
export const sharepointDownloadWorkflow: RegisteredWorkflow<
  SharePointDownloadInput,
  typeof sharepointDownloadSteps
> = defineWorkflow({
  name: "sharepoint-download",
  label: "SharePoint Download",
  category: "Utils",
  iconName: "Download",
  systems: [
    {
      id: "sharepoint",
      login: sharepointLogin,
      acceptDownloads: true,
    },
  ],
  authSteps: true,
  steps: sharepointDownloadSteps,
  schema: SharePointDownloadInputSchema,
  authChain: "sequential",
  detailFields: [
    { key: "label", label: "Spreadsheet" },
    { key: "filename", label: "File" },
    { key: "path", label: "Saved to" },
  ],
  getName: (d) => d.label ?? "",
  getId: (d) => d.id ?? "",
  handler: async (ctx, input) => {
    // Seed the dashboard row with the human-readable label immediately so
    // the queue doesn't flash a blank name while auth runs. `path` and
    // `filename` are filled in below after `saveAs`.
    ctx.updateData({
      id: input.id,
      label: input.label,
      ...(input.parentRunId ? { parentRunId: input.parentRunId } : {}),
    });

    const page = await ctx.page("sharepoint");

    // navigate — auth already navigated to the file URL; we just announce
    // the phase for the dashboard timeline. Kept as a distinct step so the
    // `download` step's duration doesn't include any future reload logic.
    await ctx.step("navigate", async () => {
      const current = page.url();
      if (!current.includes("sharepoint.com") && !current.includes("office.com")) {
        throw new Error(
          `Expected SharePoint/Office URL after login, got: ${current.slice(0, 120)}`,
        );
      }
    });

    // download — File → Create a Copy (hover) → Download a Copy, capture
    // the Download event, saveAs into outDir.
    await ctx.step("download", async () => {
      const outDir = input.outDir ?? "src/data";
      const { path: saved, filename } = await captureExcelDownload(page, outDir);
      ctx.updateData({ filename, path: saved });
      // Stash the result for the HTTP handler to pick up (see
      // _takeLastDownloadResult docs above).
      lastDownloadResult = { path: saved, filename };
    });
  },
});

/**
 * CLI adapter. Currently unused — the only caller is the dashboard HTTP
 * handler (`buildSharePointRosterDownloadHandler` in handler.ts). Kept
 * exported for consistency with the other kernel workflows and for any
 * future `src/cli.ts` subcommand.
 *
 * Callers MUST set the landing URL via `_setPendingLandingUrl` before
 * invoking (or rely on the handler to do it).
 */
export async function runSharePointDownload(
  input: SharePointDownloadInput,
): Promise<void> {
  _setPendingLandingUrl(input.url);
  try {
    await runWorkflow(sharepointDownloadWorkflow, input);
    log.success(`SharePoint download complete (${input.id})`);
  } catch (err) {
    log.error(`SharePoint download failed (${input.id}): ${errorMessage(err)}`);
    throw err;
  } finally {
    _setPendingLandingUrl(null);
  }
}
