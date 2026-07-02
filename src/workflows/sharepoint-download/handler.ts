/**
 * HTTP-layer handlers for the dashboard's SharePoint download dropdown.
 *
 *   GET  /api/sharepoint-download/list  → `buildSharePointListHandler`
 *   POST /api/sharepoint-download/run   → `buildSharePointRosterDownloadHandler`
 *
 * The `/run` handler fires the kernel workflow
 * (`sharepointDownloadWorkflow`) **fire-and-forget**: it returns 202
 * immediately with `{ok, id, label, status: "launched"|"queued"}` and lets the
 * dashboard surface progress via the Session panel + LogPanel + Queue row.
 * The alternative (blocking until download completes) would hold the HTTP
 * socket open for 2-3 minutes including Duo tap, which is worse UX.
 *
 * A module-level serial queue prevents concurrent browser/Duo runs across ALL
 * ids while still letting callers choose either "wait for the current/queued
 * download" or "queue a fresh download after it".
 */
import { resolve } from "node:path";
import { sharepointDir } from "../../tracker/paths.js";
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
import type { SharePointDownloadInput } from "./schema.js";
import type { SharePointDownloadStatus } from "../../domain/sharepoint-download-status.js";

/**
 * HTTP response shape for the dashboard's roster-download endpoint.
 *
 * With fire-and-forget semantics, the 202 body no longer includes `path` or
 * `filename` — those land on the tracker row instead (watch the Queue panel
 * for the finished record).
 */
export interface RosterDownloadResponse {
  status: 202 | 400 | 404 | 500;
  body:
    | { ok: true; id: string; label: string; status: "launched" | "queued" }
    | { ok: false; error: string };
}

export interface RosterDownloadHandlerOptions {
  /** Default root directory for downloads, overridable per-spec via `spec.outDir`. Default: `<cwd>/.tracker/sharepoint`. */
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
  /** Tracker root used by non-HTTP callers. Defaults to `.tracker`. */
  trackerDir?: string;
}

export interface SharePointDownloadResult {
  id: string;
  label: string;
  path?: string;
  filename?: string;
}

export interface SharePointDownloadRequest {
  id: string;
  /** `fresh` queues a new browser run; `wait` joins the current/last queued one if present. */
  mode: "fresh" | "wait";
  parentRunId?: string;
  rootTracePrefix?: string;
  trackerDir?: string;
  itemId?: string;
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

interface SharePointDownloadJob {
  queueId: string;
  spec: SharePointDownloadSpec;
  url: string;
  outDir: string;
  parentRunId?: string;
  rootTracePrefix?: string;
  trackerDir?: string;
  itemId?: string;
  runWorkflowImpl: typeof runWorkflow;
  state: "queued" | "running";
  createdAt: string;
  promise: Promise<SharePointDownloadResult>;
  resolve: (result: SharePointDownloadResult) => void;
  reject: (error: unknown) => void;
}

/**
 * Module-level serial queue. The full download flow is single-threaded anyway
 * (one browser, Duo approval on a phone), so every fresh request is queued and
 * waiters can join the newest queued/current job.
 */
let rosterDownloadInFlight = false;
let inFlightId: string | null = null;
let currentJob: SharePointDownloadJob | null = null;
const queuedJobs: SharePointDownloadJob[] = [];
let queueSeq = 0;
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
  currentJob = null;
  queuedJobs.splice(0, queuedJobs.length);
  queueSeq = 0;
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
export function getSharePointDownloadStatus(): SharePointDownloadStatus {
  return {
    inFlight: rosterDownloadInFlight,
    inFlightId,
    current: currentJob
      ? {
          queueId: currentJob.queueId,
          id: currentJob.spec.id,
          label: currentJob.spec.label,
          state: "running",
          createdAt: currentJob.createdAt,
        }
      : null,
    queued: queuedJobs.map((job) => ({
      queueId: job.queueId,
      id: job.spec.id,
      label: job.spec.label,
      state: "queued",
      createdAt: job.createdAt,
    })),
    lastCompletion,
  };
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

function newestQueuedOrCurrentJob(): SharePointDownloadJob | null {
  return queuedJobs[queuedJobs.length - 1] ?? currentJob;
}

function startNextQueuedJob(): void {
  if (currentJob || queuedJobs.length === 0) return;
  const next = queuedJobs.shift();
  if (!next) return;
  void startSharePointDownloadJob(next);
}

async function startSharePointDownloadJob(job: SharePointDownloadJob): Promise<void> {
  currentJob = job;
  job.state = "running";
  rosterDownloadInFlight = true;
  inFlightId = job.spec.id;
  _setPendingLandingUrl(job.url);

  try {
    const workflowInput: SharePointDownloadInput & {
      __runtimeOptions?: { rootTracePrefix: string };
    } = {
      id: job.spec.id,
      label: job.spec.label,
      url: job.url,
      outDir: job.outDir,
      ...(job.spec.filenameBase ? { filenameBase: job.spec.filenameBase } : {}),
      ...(job.parentRunId ? { parentRunId: job.parentRunId } : {}),
      ...(job.rootTracePrefix
        ? { __runtimeOptions: { rootTracePrefix: job.rootTracePrefix } }
        : {}),
    };
    await job.runWorkflowImpl(
      sharepointDownloadWorkflow,
      workflowInput,
      {
        ...(job.itemId ? { itemId: job.itemId } : {}),
        ...(job.parentRunId ? { parentRunId: job.parentRunId } : {}),
        ...(job.trackerDir ? { trackerDir: job.trackerDir } : {}),
      },
    );
    log.success(`SharePoint download complete (${job.spec.id})`);
    const downloadResult = _takeLastDownloadResult();
    const result = {
      id: job.spec.id,
      label: job.spec.label,
      path: downloadResult?.path,
      filename: downloadResult?.filename,
    };
    lastCompletion = {
      ...result,
      ts: new Date().toISOString(),
      ok: true,
    };
    job.resolve(result);
  } catch (e) {
    const err = errorMessage(e);
    log.error(`SharePoint download failed (${job.spec.id}): ${err}`);
    _takeLastDownloadResult();
    lastCompletion = {
      id: job.spec.id,
      ts: new Date().toISOString(),
      ok: false,
      error: err,
    };
    job.reject(e);
  } finally {
    if (currentJob === job) {
      currentJob = null;
    }
    _setPendingLandingUrl(null);
    rosterDownloadInFlight = false;
    inFlightId = null;
    startNextQueuedJob();
  }
}

function queueSharePointDownloadJob(
  request: Omit<SharePointDownloadRequest, "mode">,
  options: RosterDownloadHandlerOptions,
): SharePointDownloadJob {
  const spec = getDownloadSpec(request.id);
  if (!spec) {
    throw new Error(`Unknown download id "${request.id}". Known ids: ${listDownloadIds().join(", ")}`);
  }
  const getEnv = options.getEnv ?? ((name: string) => process.env[name]);
  const url = (getEnv(spec.envVar) ?? "").trim();
  if (!url) {
    throw new Error(`${spec.envVar} env var not set. Add it to .env (see .env.example) and restart the dashboard.`);
  }

  // Honor the isolated tracker root so a dashboard booted at an isolated dir
  // (HRAUTO_TRACKER_DIR) doesn't leak roster downloads into the real `.tracker/`.
  // Prefer an explicitly-threaded trackerDir; fall back to the process env — this
  // handler runs in-process in the dashboard, matching config.ts's TRACKER_DIR.
  const effectiveTrackerDir = options.trackerDir ?? process.env.HRAUTO_TRACKER_DIR ?? ".tracker";
  const defaultOutDir = options.outDir ?? resolve(process.cwd(), sharepointDir(effectiveTrackerDir));
  let resolveJob!: (result: SharePointDownloadResult) => void;
  let rejectJob!: (error: unknown) => void;
  const promise = new Promise<SharePointDownloadResult>((resolveJobPromise, rejectJobPromise) => {
    resolveJob = resolveJobPromise;
    rejectJob = rejectJobPromise;
  });
  const job: SharePointDownloadJob = {
    queueId: `spq-${++queueSeq}`,
    spec,
    url,
    outDir: resolveOutDir(spec, defaultOutDir),
    parentRunId: request.parentRunId,
    rootTracePrefix: request.rootTracePrefix,
    trackerDir: request.trackerDir ?? options.trackerDir,
    itemId: request.itemId,
    runWorkflowImpl: options.runWorkflowFn ?? runWorkflow,
    state: currentJob ? "queued" : "running",
    createdAt: new Date().toISOString(),
    promise,
    resolve: resolveJob,
    reject: rejectJob,
  };

  if (currentJob) {
    queuedJobs.push(job);
  } else {
    void startSharePointDownloadJob(job);
  }
  return job;
}

export async function requestSharePointDownload(
  request: SharePointDownloadRequest,
  options: RosterDownloadHandlerOptions = {},
): Promise<SharePointDownloadResult> {
  if (request.mode === "wait") {
    const existing = newestQueuedOrCurrentJob();
    if (existing) return existing.promise;
    if (lastCompletion?.ok && lastCompletion.id === request.id) {
      return {
        id: lastCompletion.id,
        label: getDownloadSpec(lastCompletion.id)?.label ?? lastCompletion.id,
        path: lastCompletion.path,
        filename: lastCompletion.filename,
      };
    }
  }
  return queueSharePointDownloadJob(request, options).promise;
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
 *   202 — workflow launched or queued (download still in progress)
 *   400 — body missing `id`, or env var unset for a known id
 *   404 — unknown id (lists known ids in error)
 *   500 — synchronous pre-launch failure (validation / env lookup)
 *
 * Post-launch failures (auth timeout, Duo timeout, Excel click failure)
 * surface as FAILED on the tracker row — they don't hit this HTTP response
 * because the client is already gone.
 */
export function buildSharePointRosterDownloadHandler(
  options: RosterDownloadHandlerOptions = {},
): (input: { id?: string; parentRunId?: string }) => Promise<RosterDownloadResponse> {
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

    const getEnv = options.getEnv ?? ((name: string) => process.env[name]);
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

    const wasBusy = Boolean(currentJob);
    const job = queueSharePointDownloadJob(
      { id: spec.id, parentRunId: input.parentRunId },
      { ...options, getEnv },
    );
    job.promise.catch(() => {});

    return {
      status: 202,
      body: { ok: true, id: spec.id, label: spec.label, status: wasBusy ? "queued" : "launched" },
    };
  };
}
