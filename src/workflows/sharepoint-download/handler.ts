import { mkdirSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { errorMessage } from "../../utils/errors.js";
import { log } from "../../utils/log.js";
import {
  emitWorkflowStart,
  emitWorkflowEnd,
  emitItemStart,
  generateInstanceName,
} from "../../tracker/session-events.js";
import { downloadSharePointFile } from "./download.js";
import {
  SHAREPOINT_DOWNLOADS,
  getDownloadSpec,
  listDownloadIds,
  type SharePointDownloadSpec,
} from "./registry.js";

/**
 * HTTP response shape for the dashboard's roster-download endpoint.
 *
 * Kept narrow (status + body) so the handler stays framework-agnostic —
 * `src/tracker/dashboard.ts` plugs it into the native Node HTTP server,
 * but any caller (tests, future RPC transport) can reuse the shape as-is.
 */
export interface RosterDownloadResponse {
  status: 200 | 400 | 404 | 409 | 500;
  body:
    | { ok: true; id: string; label: string; path: string; filename: string }
    | { ok: false; error: string };
}

export interface RosterDownloadHandlerOptions {
  /** Default root directory for downloads, overridable per-spec via `spec.outDir`. Default: `<cwd>/src/data`. */
  outDir?: string;
  /** Injected for tests. Defaults to the real SharePoint helper. */
  downloader?: typeof downloadSharePointFile;
  /** Injected for tests. Defaults to `(name) => process.env[name]`. */
  getEnv?: (name: string) => string | undefined;
}

/**
 * Shape returned by `buildSharePointListHandler`. One entry per registry
 * spec, enriched with `configured` so the frontend can render unconfigured
 * targets as disabled dropdown items (with an actionable tooltip) instead of
 * hiding them entirely.
 */
export interface SharePointDownloadListItem {
  id: string;
  label: string;
  description?: string;
  envVar: string;
  /** True iff `process.env[envVar]` is set to a non-empty value. */
  configured: boolean;
}

/**
 * Module-level in-flight lock. The full download flow is single-threaded
 * anyway (one browser, Duo approval on a phone), so concurrent clicks on
 * ANY dropdown option get a 409 instead of stacking up headed browsers.
 * Intentionally not keyed by id — two different spreadsheets still compete
 * for the same phone-tap resource.
 */
let rosterDownloadInFlight = false;

/** Test-only hook: reset the in-flight lock between test cases. */
export function _resetInFlightForTests(): void {
  rosterDownloadInFlight = false;
}

/** Test-only: peek at the lock state. */
export function isDownloadInFlight(): boolean {
  return rosterDownloadInFlight;
}

/**
 * Factory for `GET /api/sharepoint-download/list`.
 *
 * Returns the full registry (never hides unconfigured items) with a
 * `configured` boolean derived from `process.env`. Frontend decides how to
 * present unconfigured entries (we render them disabled with a tooltip
 * pointing at `.env.example`).
 */
export function buildSharePointListHandler(
  options: { getEnv?: (name: string) => string | undefined } = {},
): () => SharePointDownloadListItem[] {
  const getEnv = options.getEnv ?? ((name: string) => process.env[name]);
  return () =>
    SHAREPOINT_DOWNLOADS.map((spec) => ({
      id: spec.id,
      label: spec.label,
      description: spec.description,
      envVar: spec.envVar,
      configured: Boolean((getEnv(spec.envVar) ?? "").trim()),
    }));
}

/**
 * Resolve the output directory for a given spec. Per-spec `outDir` wins
 * over the handler's default. Both are treated as relative to `process.cwd()`
 * when not absolute.
 */
function resolveOutDir(
  spec: SharePointDownloadSpec,
  handlerDefaultOutDir: string,
): string {
  if (spec.outDir) return resolve(process.cwd(), spec.outDir);
  return handlerDefaultOutDir;
}

/**
 * Factory for `POST /api/sharepoint-download/run`.
 *
 * Expects a JSON body `{ id: "<registry-id>" }`. Looks up the spec, reads
 * `process.env[spec.envVar]`, launches a headed browser via
 * `downloadSharePointFile` (SSO + Duo), saves the resulting file, and
 * returns a JSON result.
 *
 * Response status codes:
 *   200 — download completed
 *   400 — body missing `id`, or env var unset for a known id
 *   404 — unknown id (lists known ids in error)
 *   409 — another download is already in progress
 *   500 — download helper threw
 *
 * A module-level boolean lock prevents concurrent runs across ALL ids.
 * Factored as a pure-ish handler (no req/res coupling) to mirror
 * `buildSelectorWarningsHandler` and stay easy to unit-test.
 */
export function buildSharePointRosterDownloadHandler(
  options: RosterDownloadHandlerOptions = {},
): (input: { id?: string }) => Promise<RosterDownloadResponse> {
  const defaultOutDir = options.outDir ?? resolve(process.cwd(), "src/data");
  const download = options.downloader ?? downloadSharePointFile;
  const getEnv = options.getEnv ?? ((name: string) => process.env[name]);

  return async (input) => {
    const id = input?.id?.trim();
    if (!id) {
      return {
        status: 400,
        body: {
          ok: false,
          error: `Missing "id" in request body. Known ids: ${listDownloadIds().join(", ")}`,
        },
      };
    }

    const spec = getDownloadSpec(id);
    if (!spec) {
      return {
        status: 404,
        body: {
          ok: false,
          error: `Unknown download id "${id}". Known ids: ${listDownloadIds().join(", ")}`,
        },
      };
    }

    const url = (getEnv(spec.envVar) ?? "").trim();
    if (!url) {
      return {
        status: 400,
        body: {
          ok: false,
          error: `${spec.envVar} env var not set. Add it to .env (see .env.example) and restart the dashboard.`,
        },
      };
    }

    if (rosterDownloadInFlight) {
      return {
        status: 409,
        body: { ok: false, error: "A SharePoint download is already in progress" },
      };
    }

    rosterDownloadInFlight = true;
    // Register this run as a dashboard-visible "workflow instance" so the
    // operator sees a box in the Sessions rail identical to kernel workflows
    // (purple border, browser chip, auth-state glow, DONE/FAILED pill).
    // `generateInstanceName("sharepoint-download")` → "SharePoint 1",
    // "SharePoint 2", ... reusing the shared numbering + stale-start
    // self-healing in session-events.ts.
    const instance = generateInstanceName("sharepoint-download");
    emitWorkflowStart(instance);
    // Populate the box's "current item" line with the spec label so the
    // operator knows which spreadsheet this instance is pulling — the same
    // slot kernel workflows use for email / doc-id.
    emitItemStart(instance, spec.label);
    let finalStatus: "done" | "failed" = "failed";
    try {
      const outDir = resolveOutDir(spec, defaultOutDir);
      mkdirSync(outDir, { recursive: true });
      const saved = await download({
        url,
        outDir,
        session: { instance, system: "sharepoint" },
      });
      const relPath = relative(process.cwd(), saved) || saved;
      const filename = saved.split(sep).pop() ?? saved;
      log.success(`SharePoint download complete (${spec.id}): ${relPath}`);
      finalStatus = "done";
      return {
        status: 200,
        body: { ok: true, id: spec.id, label: spec.label, path: relPath, filename },
      };
    } catch (e) {
      const message = errorMessage(e);
      log.error(`SharePoint download failed (${spec.id}): ${message}`);
      return { status: 500, body: { ok: false, error: message } };
    } finally {
      emitWorkflowEnd(instance, finalStatus);
      rosterDownloadInFlight = false;
    }
  };
}
