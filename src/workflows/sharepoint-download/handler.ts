import { mkdirSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { errorMessage } from "../../utils/errors.js";
import { log } from "../../utils/log.js";
import { downloadSharePointFile } from "./download.js";

/**
 * HTTP response shape for the dashboard's roster-download endpoint.
 *
 * Kept narrow (status + body) so the handler stays framework-agnostic —
 * `src/tracker/dashboard.ts` plugs it into the native Node HTTP server,
 * but any caller (tests, future RPC transport) can reuse the shape as-is.
 */
export interface RosterDownloadResponse {
  status: 200 | 400 | 409 | 500;
  body:
    | { ok: true; path: string; filename: string }
    | { ok: false; error: string };
}

export interface RosterDownloadHandlerOptions {
  /** Where to save the downloaded xlsx. Default: `<cwd>/src/data`. */
  outDir?: string;
  /** Injected for tests. Defaults to the real SharePoint helper. */
  downloader?: typeof downloadSharePointFile;
  /** Injected for tests. Defaults to `process.env.ONBOARDING_ROSTER_URL`. */
  getUrl?: () => string | undefined;
}

/**
 * Module-level in-flight lock. The full download flow is single-threaded
 * anyway (one browser, Duo approval on a phone), so concurrent clicks on
 * the dashboard button get a 409 instead of stacking up headed browsers.
 */
let rosterDownloadInFlight = false;

/**
 * Test-only hook: reset the in-flight lock between test cases. Never call
 * from production code.
 */
export function _resetInFlightForTests(): void {
  rosterDownloadInFlight = false;
}

/** Test-only: peek at the lock state. */
export function isDownloadInFlight(): boolean {
  return rosterDownloadInFlight;
}

/**
 * Factory for the `POST /api/sharepoint-download/run` handler.
 *
 * Launches a headed browser via `downloadSharePointFile` (SSO + Duo), saves
 * the resulting file into `outDir`, and returns a JSON result. A module-level
 * boolean lock prevents concurrent runs. Missing env var → 400, not 500, so
 * the dashboard can show a useful setup-time toast.
 *
 * Factored as a pure-ish handler (no req/res coupling) to match the
 * `buildSelectorWarningsHandler` style in `src/tracker/dashboard.ts` and
 * to make future unit tests trivial.
 */
export function buildSharePointRosterDownloadHandler(
  options: RosterDownloadHandlerOptions = {},
): () => Promise<RosterDownloadResponse> {
  const outDir = options.outDir ?? resolve(process.cwd(), "src/data");
  const download = options.downloader ?? downloadSharePointFile;
  const getUrl = options.getUrl ?? (() => process.env.ONBOARDING_ROSTER_URL);

  return async () => {
    const url = getUrl();
    if (!url || !url.trim()) {
      return {
        status: 400,
        body: {
          ok: false,
          error:
            "ONBOARDING_ROSTER_URL env var not set. Add it to .env (see .env.example) and restart the dashboard.",
        },
      };
    }
    if (rosterDownloadInFlight) {
      return {
        status: 409,
        body: { ok: false, error: "A roster download is already in progress" },
      };
    }
    rosterDownloadInFlight = true;
    try {
      mkdirSync(outDir, { recursive: true });
      const saved = await download({ url: url.trim(), outDir });
      const relPath = relative(process.cwd(), saved) || saved;
      const filename = saved.split(sep).pop() ?? saved;
      log.success(`Roster download complete: ${relPath}`);
      return {
        status: 200,
        body: { ok: true, path: relPath, filename },
      };
    } catch (e) {
      const message = errorMessage(e);
      log.error(`Roster download failed: ${message}`);
      return { status: 500, body: { ok: false, error: message } };
    } finally {
      rosterDownloadInFlight = false;
    }
  };
}
