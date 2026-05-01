/**
 * HTTP-layer handlers for the dashboard's SharePoint download dropdown.
 *
 *   GET  /api/sharepoint-download/list  → `buildSharePointListHandler`
 *   POST /api/sharepoint-download/run   → `buildSharePointRosterDownloadHandler`
 *
 * The `/run` handler fires the kernel workflow
 * (`sharepointDownloadWorkflow`) **fire-and-forget**: it returns 202
 * immediately with `{ok, id, label, status: "launched"}` and lets the
 * dashboard surface progress via the Session panel + LogPanel + Queue row.
 * The alternative (blocking until download completes) would hold the HTTP
 * socket open for 2-3 minutes including Duo tap, which is worse UX.
 *
 * A module-level boolean `rosterDownloadInFlight` prevents concurrent runs
 * across ALL ids — two different spreadsheets still compete for the same
 * phone-tap resource, so 409 is returned rather than stacking headed
 * browsers.
 */
import { resolve } from "node:path";
import { errorMessage } from "../../utils/errors.js";
import { log } from "../../utils/log.js";
import { runWorkflow } from "../../core/index.js";
import {
  sharepointDownloadWorkflow,
  _setPendingLandingUrl,
  _takeLastDownloadResult,
} from "./workflow.js";
import {
  SHAREPOINT_DOWNLOADS,
  getDownloadSpec,
  listDownloadIds,
  type SharePointDownloadSpec,
} from "./registry.js";

/**
 * HTTP response shape for the dashboard's roster-download endpoint.
 *
 * With fire-and-forget semantics, the 202 body no longer includes `path` or
 * `filename` — those land on the tracker row instead (watch the Queue panel
 * for the finished record).
 */
export interface RosterDownloadResponse {
  status: 202 | 400 | 404 | 409 | 500;
  body:
    | { ok: true; id: string; label: string; status: "launched" }
    | { ok: false; error: string };
}

export interface RosterDownloadHandlerOptions {
  /** Default root directory for downloads, overridable per-spec via `spec.outDir`. Default: `<cwd>/src/data`. */
  outDir?: string;
  /**
   * Injected for tests — fires the kernel workflow. Defaults to the real
   * `runWorkflow`. Tests can swap in a promise-returning stub to assert the
   * handler's pre-launch side effects (pending-url set, lock flipped, etc.)
   * without actually spinning up a browser.
   */
  runWorkflowFn?: typeof runWorkflow;
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
let inFlightId: string | null = null;
let lastCompletion:
  | {
      id: string;
      ts: string;
      ok: boolean;
      path?: string;
      filename?: string;
      error?: string;
    }
  | null = null;

/** Test-only hook: reset the in-flight lock between test cases. */
export function _resetInFlightForTests(): void {
  rosterDownloadInFlight = false;
  inFlightId = null;
  lastCompletion = null;
  _setPendingLandingUrl(null);
  // Drain any stale download result the workflow may have left behind.
  _takeLastDownloadResult();
}

/** Test-only: peek at the lock state. */
export function isDownloadInFlight(): boolean {
  return rosterDownloadInFlight;
}

/**
 * Snapshot of the current download state for poll-while-uploading
 * consumers (e.g. `RunModal`'s "Download new from SharePoint" radio).
 *
 * `inFlight` flips on click and back off in the run promise's `finally`
 * block. `lastCompletion` records the most recent done/failed run with
 * its id, ISO timestamp, and an `ok` flag — callers that started a
 * specific id can match `lastCompletion.id === <my id>` to detect their
 * own run finishing.
 */
export function getSharePointDownloadStatus(): {
  inFlight: boolean;
  inFlightId: string | null;
  lastCompletion: {
    id: string;
    ts: string;
    ok: boolean;
    path?: string;
    filename?: string;
    error?: string;
  } | null;
} {
  return { inFlight: rosterDownloadInFlight, inFlightId, lastCompletion };
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
 * `process.env[spec.envVar]`, and fires `runWorkflow(sharepointDownloadWorkflow, ...)`
 * WITHOUT awaiting it. Returns 202 immediately so the operator isn't
 * blocked for 2-3 min waiting on a Duo tap. Progress is visible via the
 * Session panel (live box + Duo chip) and the LogPanel / Queue row once the
 * kernel writes its tracker entries.
 *
 * Response status codes:
 *   202 — workflow launched (download still in progress)
 *   400 — body missing `id`, or env var unset for a known id
 *   404 — unknown id (lists known ids in error)
 *   409 — another download is already in progress
 *   500 — synchronous pre-launch failure (validation / env lookup)
 *
 * Post-launch failures (auth timeout, Duo timeout, Excel click failure)
 * surface as FAILED on the tracker row — they don't hit this HTTP response
 * because the client is already gone.
 */
export function buildSharePointRosterDownloadHandler(
  options: RosterDownloadHandlerOptions = {},
): (input: { id?: string; parentRunId?: string }) => Promise<RosterDownloadResponse> {
  const defaultOutDir = options.outDir ?? resolve(process.cwd(), "src/data");
  const runWorkflowImpl = options.runWorkflowFn ?? runWorkflow;
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

    // Commit: we're launching. Flip the lock + seed the landing URL that
    // `systems[].login` will read. Both cleared in the fire-and-forget
    // promise's `.finally()` regardless of outcome.
    rosterDownloadInFlight = true;
    inFlightId = spec.id;
    const outDir = resolveOutDir(spec, defaultOutDir);
    _setPendingLandingUrl(url);

    const runPromise = (async () => {
      try {
        await runWorkflowImpl(sharepointDownloadWorkflow, {
          id: spec.id,
          label: spec.label,
          url,
          outDir,
          ...(input.parentRunId ? { parentRunId: input.parentRunId } : {}),
        });
        log.success(`SharePoint download complete (${spec.id})`);
        // Pick up the saved path/filename the workflow stashed in its
        // module-level slot (see workflow.ts `_takeLastDownloadResult`).
        // `take` clears the slot so a future failed run can't surface a
        // stale path.
        const downloadResult = _takeLastDownloadResult();
        lastCompletion = {
          id: spec.id,
          ts: new Date().toISOString(),
          ok: true,
          path: downloadResult?.path,
          filename: downloadResult?.filename,
        };
      } catch (e) {
        const err = errorMessage(e);
        log.error(`SharePoint download failed (${spec.id}): ${err}`);
        // Drain the slot even on failure — a partial run might still have
        // written a path before throwing.
        _takeLastDownloadResult();
        lastCompletion = {
          id: spec.id,
          ts: new Date().toISOString(),
          ok: false,
          error: err,
        };
      } finally {
        _setPendingLandingUrl(null);
        rosterDownloadInFlight = false;
        inFlightId = null;
      }
    })();
    // Detach — fire-and-forget. The catch above should handle all errors,
    // but this guard defends against any async throw that escapes it.
    runPromise.catch(() => {});

    return {
      status: 202,
      body: { ok: true, id: spec.id, label: spec.label, status: "launched" },
    };
  };
}
