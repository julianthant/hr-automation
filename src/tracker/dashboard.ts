import { createServer, type Server } from "http";
import { readFileSync, existsSync, unlinkSync, statSync, readdirSync, createReadStream, watchFile, unwatchFile } from "fs";
import { readFile as readFileAsync, stat as statAsync } from "fs/promises";
import { join, resolve, sep } from "path";
import {
  readEntries,
  readLogEntries,
  listWorkflows,
  listDatesForWorkflow,
  readEntriesForDate,
  readLogEntriesForDate,
  readRunsForId,
  cleanOldTrackerFiles,
  cleanOldScreenshots,
  trackEvent,
  dateLocal,
  DEFAULT_DIR,
  type TrackerEntry,
} from "./jsonl.js";
import { log } from "../utils/log.js";
import { errorMessage } from "../utils/errors.js";
import {
  readSessionEvents,
  getSessionsFilePath,
  workflowNameFromInstance,
  emitWorkflowEnd,
  type SessionEvent,
} from "./session-events.js";
import { getAll as getAllRegisteredWorkflows } from "../core/registry.js";
import type { WorkflowMetadata } from "../core/types.js";
import { PATHS } from "../config.js";
import { stopDaemons } from "../core/daemon-client.js";
import { findAliveDaemons } from "../core/daemon-registry.js";
import { readQueueState, markItemFailed } from "../core/daemon-queue.js";
import {
  enqueueFromHttp,
  validateEnqueueRequest,
  buildTrackerDataForInput,
} from "../core/enqueue-dispatch.js";
import {
  buildRetryHandler,
  buildRetryBulkHandler,
  buildFindPriorByKeyHandler,
  buildRunWithDataHandler,
  buildSaveDataHandler,
  buildCancelQueuedHandler,
  buildQueueBumpHandler,
  buildDaemonsListHandler,
  buildDaemonsSpawnHandler,
  buildDaemonsStopHandler,
  resolveDaemonLogPath,
  readQueueDepth,
} from "./dashboard-ops.js";
import { detectFailurePattern } from "./failure-detector.js";
import { notify } from "./notify.js";
import {
  buildSharePointRosterDownloadHandler,
  buildSharePointListHandler,
  getSharePointDownloadStatus,
} from "../workflows/sharepoint-download/index.js";
import { sweepOrphanUploadDirs } from "../scripts/ops/clean-tracker.js";
import { readMultipart } from "./multipart-helper.js";
import {
  buildOcrFormsHandler,
  buildOcrPrepareHandler,
  buildOcrApproveHandler,
  buildOcrDiscardHandler,
  buildOcrForceResearchHandler,
  buildOcrRetryPageHandler,
  buildOcrReocrWholePdfHandler,
  sweepStuckOcrRows,
} from "./ocr-http.js";
import {
  buildOathUploadDuplicateCheckHandler,
  buildOathUploadStartHandler,
  buildOathUploadCancelHandler,
  sweepStuckOathUploadRows,
  saveUploadedPdf,
} from "./oath-upload-http.js";
import {
  createSessionStore,
  handleStart as handleCaptureStart,
  handleManifest as handleCaptureManifest,
  handleUpload as handleCaptureUpload,
  handleDeletePhoto as handleCaptureDeletePhoto,
  handleReplacePhoto as handleCaptureReplacePhoto,
  handleReorder as handleCaptureReorder,
  handleExtend as handleCaptureExtend,
  handleValidate as handleCaptureValidate,
  handleFinalize as handleCaptureFinalize,
  handleDiscard as handleCaptureDiscard,
  pickLanIp,
  type CaptureSessionEvent,
  type CaptureSessionStore,
  type CapturedPhoto,
} from "../capture/index.js";

/**
 * Canonical sort key for a session event. Events emitted by
 * emitScreenshotEvent use numeric `ts` (ms since epoch) while other
 * event emitters use ISO `timestamp`. Normalize both into an ISO string
 * so localeCompare sorts correctly.
 */
export function getEventSortKey(e: { timestamp?: string; ts?: number }): string {
  if (typeof e.timestamp === "string" && e.timestamp.length > 0) return e.timestamp;
  if (typeof e.ts === "number" && Number.isFinite(e.ts)) return new Date(e.ts).toISOString();
  return "";
}

/**
 * Resolve a runId to its batch's workflowInstance by looking up the tracker
 * entry that carries that runId. Returns the first matching `data.instance`
 * string, or `undefined` if no entry is found or the entry lacks the field.
 *
 * Pre-2026-04-21 entries may not have `data.instance`; those degrade to
 * `undefined` and the caller's batch-scope fallback becomes a no-op.
 */
export function resolveInstanceForRun(
  trackers: Array<Pick<TrackerEntry, "runId" | "data">>,
  runId: string,
): string | undefined {
  if (!runId) return undefined;
  for (const t of trackers) {
    if (t.runId !== runId) continue;
    const instance = t.data?.instance;
    if (typeof instance === "string" && instance.length > 0) return instance;
  }
  return undefined;
}

/**
 * Filter session events down to those that belong to a single run. Used by
 * the `/events/run-events` SSE handler.
 *
 * Two matching paths:
 *
 * 1. **Direct:** events carrying the exact requested `runId`.
 * 2. **Batch-scope fallback:** events emitted outside any per-item
 *    `withLogContext` (so they have no `runId`), attributed to this run via
 *    matching `workflowInstance` AND falling within the run's
 *    `[runStart, runEnd]` time window. `Session.launch` emits `auth_start` /
 *    `auth_complete` / `browser_launch` at batch scope without a runId.
 *
 * **Time-window in daemon mode.** A batch workflow (sequential/pool/
 * shared-context-pool) assigns one `workflowInstance` per batch, so
 * `workflowInstance` alone isolates each batch. A **daemon** keeps the same
 * `workflowInstance` for its entire lifetime — it processes many items
 * (each a distinct `runId`) under one instance. Without the time window,
 * orphan events from every past or concurrent item in the daemon would
 * bleed into each item's drill-in view. Filtering orphan events to the
 * target run's tracker-entry span fixes the leak without breaking legacy
 * batch shapes (a batch's orphan events all fall inside the batch's span
 * anyway).
 *
 * `runStart` = earliest tracker-entry timestamp for this runId.
 * `runEnd` = max(latest tracker ts for runId, latest direct-event ts for
 * runId, `now` — via `runEndFallback` arg, default `Date.now()`). The
 * `now`/direct-event extension matters for in-progress items where no
 * terminal tracker entry exists yet.
 *
 * Pure: no filesystem access. Clock is injected via `runEndFallback` so
 * tests stay deterministic.
 */
export function filterEventsForRun(
  events: SessionEvent[],
  trackers: Array<Pick<TrackerEntry, "runId" | "status" | "data" | "timestamp">>,
  runId: string,
  runEndFallback: number = Date.now(),
): SessionEvent[] {
  const direct = events.filter((e) => e.runId === runId);
  const instance = resolveInstanceForRun(trackers, runId);

  let batchScope: SessionEvent[] = [];
  if (instance) {
    const runEntries = trackers.filter((t) => t.runId === runId);
    if (runEntries.length === 0) {
      // Degenerate: instance resolved but no tracker entries to build a
      // window from. Skip the fallback rather than over-include.
      batchScope = [];
    } else {
      const trackerTimes = runEntries
        .map((t) => new Date(t.timestamp).getTime())
        .filter((n) => Number.isFinite(n));
      const directTimes = direct
        .map((e) => new Date(getEventSortKey(e)).getTime())
        .filter((n) => Number.isFinite(n));
      const runStart = Math.min(...trackerTimes);
      // If this run reached a terminal status (done / failed / skipped),
      // cap runEnd at the last tracker timestamp. Without this check, the
      // default `runEndFallback = Date.now()` stretched the window all the
      // way to "now", pulling in orphan events from later items that the
      // same daemon processed on the same `workflowInstance`.
      const terminated = runEntries.some(
        (t) => t.status === "done" || t.status === "failed" || t.status === "skipped",
      );
      const lastTrackerTs = Math.max(...trackerTimes);
      const runEnd = terminated
        ? Math.max(lastTrackerTs, ...(directTimes.length > 0 ? directTimes : []))
        : Math.max(
            lastTrackerTs,
            ...(directTimes.length > 0 ? directTimes : []),
            runEndFallback,
          );
      batchScope = events.filter((e) => {
        if (e.runId) return false;
        if (e.workflowInstance !== instance) return false;
        const ets = new Date(getEventSortKey(e)).getTime();
        if (!Number.isFinite(ets)) return false;
        return ets >= runStart && ets <= runEnd;
      });
    }
  }

  const merged = [...direct, ...batchScope];
  merged.sort((a, b) => getEventSortKey(a).localeCompare(getEventSortKey(b)));
  return merged;
}

/**
 * How long after a crash-on-launch the dashboard keeps rendering the red
 * "Launch failed" placeholder in the live Sessions rail. Past this window the
 * failed run is considered historical — details still live in
 * `.tracker/sessions.jsonl` and the workflow's per-day log, but the Sessions
 * panel (which is a "live / currently happening" view) stops pinning it.
 */
const CRASH_ON_LAUNCH_WINDOW_MS = 15 * 60 * 1000;

// Resolve path to built dashboard HTML (vite-plugin-singlefile output)
const DASHBOARD_HTML_PATH = join(
  import.meta.dirname ?? ".",
  "../../dist/dashboard/index.html"
);
let cachedDashboardHtml: string | null = null;

function getDashboardHtml(): string {
  if (cachedDashboardHtml) return cachedDashboardHtml;
  if (existsSync(DASHBOARD_HTML_PATH)) {
    cachedDashboardHtml = readFileSync(DASHBOARD_HTML_PATH, "utf-8");
    return cachedDashboardHtml;
  }
  return "<html><body><h1>Dashboard not built</h1><p>Run: npm run build:dashboard</p></body></html>";
}

// ── Session state rebuilding from JSONL events ──────────

export interface BrowserState {
  browserId: string;
  system: string;
  authState: "idle" | "authenticating" | "authed" | "duo_waiting" | "failed";
}

export interface SessionInfo {
  sessionId: string;
  browsers: BrowserState[];
}

export interface WorkflowInstanceState {
  instance: string;
  /** Kebab-case workflow name resolved from the instance label (e.g. "Separation 1" → "separations"). null when unrecognised. */
  workflow: string | null;
  /** ISO-8601 timestamp of the latest workflow_start event for this instance.
   * Surfaced to the dashboard's terminal drawer so cards can render a live
   * elapsed counter. Re-runs under the same instance overwrite this. */
  startedAt?: string;
  active: boolean;
  /** True while the spawning Node process (and therefore its Playwright browsers) is still alive. */
  pidAlive: boolean;
  /**
   * True when workflow_end (finalStatus=failed) fired but no browser_launch event
   * was ever emitted for this instance — i.e. the workflow crashed before
   * Playwright launched a browser. Used by the dashboard to render a
   * "Launch failed" placeholder in place of the usual session/browser chips.
   */
  crashedOnLaunch?: boolean;
  currentItemId: string | null;
  /** True between item_start and item_complete — i.e. a real item is currently being processed. */
  itemInFlight: boolean;
  currentStep: string | null;
  finalStatus: "done" | "failed" | null;
  sessions: SessionInfo[];
}

export interface DuoQueueEntry {
  position: number;
  requestId: string;
  system: string;
  instance: string;
  state: "waiting" | "active";
}

export interface SessionState {
  workflows: WorkflowInstanceState[];
  duoQueue: DuoQueueEntry[];
}

export function rebuildSessionState(dir?: string): SessionState {
  const events = dir ? readSessionEvents(dir) : readSessionEvents();

  // Build workflow states
  const wfMap = new Map<string, WorkflowInstanceState>();
  for (const e of events) {
    const inst = e.workflowInstance;
    if (!inst) continue;

    if (e.type === "workflow_start") {
      wfMap.set(inst, {
        instance: inst,
        workflow: workflowNameFromInstance(inst),
        startedAt: e.timestamp,
        active: true,
        pidAlive: true,
        currentItemId: null,
        itemInFlight: false,
        currentStep: null,
        finalStatus: null,
        sessions: [],
      });
    }
    if (e.type === "workflow_end") {
      const wf = wfMap.get(inst);
      if (wf) {
        wf.active = false;
        wf.finalStatus = e.finalStatus ?? null;
      }
    }
    if (e.type === "step_change" && e.currentStep) {
      const wf = wfMap.get(inst);
      if (wf) wf.currentStep = e.currentStep!;
    }
    if (e.type === "session_create" && e.sessionId) {
      const wf = wfMap.get(inst);
      if (wf && !wf.sessions.find((s) => s.sessionId === e.sessionId)) {
        wf.sessions.push({ sessionId: e.sessionId!, browsers: [] });
      }
    }
    if (e.type === "browser_launch" && e.sessionId && e.browserId && e.system) {
      const wf = wfMap.get(inst);
      const sess = wf?.sessions.find((s) => s.sessionId === e.sessionId);
      if (sess && !sess.browsers.find((b) => b.browserId === e.browserId)) {
        sess.browsers.push({ browserId: e.browserId!, system: e.system!, authState: "idle" });
      }
    }
    if (e.type === "browser_close" && e.browserId) {
      const wf = wfMap.get(inst);
      if (wf) {
        for (const sess of wf.sessions) {
          sess.browsers = sess.browsers.filter((b) => b.browserId !== e.browserId);
        }
      }
    }
    if (e.type === "auth_start" && e.browserId) {
      const b = findBrowser(wfMap, inst, e.browserId);
      if (b) b.authState = "authenticating";
    }
    if (e.type === "auth_complete" && e.browserId) {
      const b = findBrowser(wfMap, inst, e.browserId);
      if (b) b.authState = "authed";
    }
    if (e.type === "auth_failed" && e.browserId) {
      const b = findBrowser(wfMap, inst, e.browserId);
      if (b) b.authState = "failed";
    }
    if (e.type === "duo_request" && e.browserId) {
      const b = findBrowser(wfMap, inst, e.browserId);
      if (b) b.authState = "duo_waiting";
    }
    if (e.type === "duo_complete" && e.browserId) {
      const b = findBrowser(wfMap, inst, e.browserId);
      if (b && b.authState === "duo_waiting") b.authState = "authed";
    }
    if (e.type === "item_start" && e.currentItemId) {
      const wf = wfMap.get(inst);
      if (wf) {
        wf.currentItemId = e.currentItemId!;
        wf.itemInFlight = true;
      }
    }
    if (e.type === "item_complete") {
      const wf = wfMap.get(inst);
      if (wf) wf.itemInFlight = false;
    }
    // Intentionally do NOT clear currentItemId on item_complete — the dashboard
    // keeps the last item visible after the workflow ends so users can see which
    // employee/record the session was for, even after it's done.
  }

  // Flag workflows that crashed before any browser could launch. A workflow that
  // ended in failed status but never emitted a browser_launch is indistinguishable
  // from normal "no-active-sessions" in the dashboard UI — this flag lets
  // SessionPanel render a dedicated "Launch failed" placeholder so the user
  // knows the run crashed early and where to look for details.
  //
  // Age gate: SessionPanel keeps crashedOnLaunch entries visible even after
  // pidAlive flips false (that's the point of the placeholder — the Node
  // process that crashed is already gone). But sessions.jsonl is append-only
  // across orchestrator sessions, so without a time cutoff a crash from days
  // ago would permanently pin itself to the live Sessions rail. Only flag
  // crashes whose workflow_end is within CRASH_ON_LAUNCH_WINDOW_MS.
  const instancesWithBrowserLaunch = new Set<string>();
  const workflowEndTimestamps = new Map<string, string>();
  for (const e of events) {
    if (e.type === "browser_launch" && e.workflowInstance) {
      instancesWithBrowserLaunch.add(e.workflowInstance);
    }
    if (e.type === "workflow_end" && e.workflowInstance && e.timestamp) {
      workflowEndTimestamps.set(e.workflowInstance, e.timestamp);
    }
  }
  const now = Date.now();
  for (const wf of wfMap.values()) {
    if (wf.finalStatus !== "failed") continue;
    if (instancesWithBrowserLaunch.has(wf.instance)) continue;
    const endTs = workflowEndTimestamps.get(wf.instance);
    if (!endTs) continue;
    const ageMs = now - Date.parse(endTs);
    if (Number.isFinite(ageMs) && ageMs <= CRASH_ON_LAUNCH_WINDOW_MS) {
      wf.crashedOnLaunch = true;
    }
  }

  // Build Duo queue (unresolved requests only)
  const resolved = new Set<string>();
  for (const e of events) {
    if ((e.type === "duo_complete" || e.type === "duo_timeout") && e.duoRequestId) {
      resolved.add(e.duoRequestId);
    }
  }
  const duoQueue: DuoQueueEntry[] = [];
  let pos = 1;
  for (const e of events) {
    if (e.type === "duo_request" && e.duoRequestId && !resolved.has(e.duoRequestId)) {
      const started = events.some(
        (s) => s.type === "duo_start" && s.duoRequestId === e.duoRequestId,
      );
      duoQueue.push({
        position: pos++,
        requestId: e.duoRequestId,
        system: e.system || "",
        instance: e.workflowInstance,
        state: started ? "active" : "waiting",
      });
    }
  }

  // Overlay duo_waiting state: if a browser's system has a pending Duo request
  // for the same workflow instance, show it as duo_waiting instead of authenticating
  const workflows = [...wfMap.values()];
  for (const wf of workflows) {
    for (const sess of wf.sessions) {
      for (const b of sess.browsers) {
        const hasPendingDuo = duoQueue.some(
          (d) => d.instance === wf.instance && d.system === b.system,
        );
        if (hasPendingDuo && (b.authState === "authenticating" || b.authState === "idle")) {
          b.authState = "duo_waiting";
        }
      }
    }
  }

  // Check liveness of each workflow's spawning process. We split this from `active`:
  //   - `active`  = the workflow_start/end lifecycle (emitted by withTrackedWorkflow)
  //   - `pidAlive`= whether the Node process is still running (and therefore its browsers)
  // SessionPanel uses `pidAlive` to remove a workflow once its session is closed,
  // while `active` stays authoritative for the DONE/FAILED pill in the brief window
  // between workflow_end firing and the Node process exiting.
  //
  // In-process (fire-and-forget) workflows: when a workflow runs INSIDE the
  // dashboard server process (e.g. the `sharepoint-download` HTTP handler
  // fires `runWorkflow()` without awaiting), the recorded pid equals the
  // dashboard's own pid — so `process.kill(pid, 0)` always succeeds while
  // the dashboard is up, pinning the workflow box to the Sessions rail
  // forever even after it has completed or failed. Treat an in-process run
  // as "session ended" the moment `workflow_end` fires, matching the behavior
  // of spawned-child workflows whose process exits shortly after end. This
  // keeps the Sessions rail consistent across both execution models.
  const ownPid = process.pid;
  for (const wf of workflows) {
    // Pick the LATEST workflow_start for this instance — when a workflow is re-run
    // under the same instance name, earlier starts reference dead pids. findLast
    // would be cleaner but target is ES2022; slice+reverse works without a lib bump.
    const starts = events.filter(
      (e: SessionEvent) => e.type === "workflow_start" && e.workflowInstance === wf.instance,
    );
    const startEv = starts[starts.length - 1];
    if (!startEv) { wf.pidAlive = false; continue; }
    if (startEv.pid === ownPid && wf.finalStatus !== null) {
      wf.pidAlive = false;
      continue;
    }
    try { process.kill(startEv.pid, 0); wf.pidAlive = true; }
    catch { wf.pidAlive = false; }
  }

  return { workflows, duoQueue };
}

function findBrowser(
  wfMap: Map<string, WorkflowInstanceState>,
  instance: string,
  browserId: string,
): BrowserState | undefined {
  const wf = wfMap.get(instance);
  if (!wf) return undefined;
  for (const sess of wf.sessions) {
    const b = sess.browsers.find((b) => b.browserId === browserId);
    if (b) return b;
  }
  return undefined;
}

let server: Server | null = null;

/**
 * Cooldown map for failure-pattern alerts. Module-level so it survives the
 * lifetime of the dashboard process — keyed by `${workflow}:${error}`, value
 * is the last-alerted ms timestamp. Exposed via `__resetFailureAlertCooldown`
 * for test isolation.
 */
const failureAlertCooldown = new Map<string, number>();

// ─── Capture module wiring ──────────────────────────────────
//
// One in-memory session store per dashboard process. mobile.html is read
// once at module load and served as plain text for every /capture/:token
// request — the token only matters to the JS inside the page, which
// extracts it from location.pathname and uses it to call the API
// endpoints.

const captureStore: CaptureSessionStore = createSessionStore();
const CAPTURE_PHOTOS_DIR = ".tracker/captures";
const CAPTURE_UPLOADS_DIR = ".tracker/uploads";
const captureMobileHtmlPath = join(
  import.meta.dirname ?? ".",
  "../capture/mobile.html",
);
let captureMobileHtmlCache: string | undefined;
function getCaptureMobileHtml(): string {
  if (captureMobileHtmlCache !== undefined) return captureMobileHtmlCache;
  try {
    captureMobileHtmlCache = readFileSync(captureMobileHtmlPath, "utf-8");
  } catch {
    captureMobileHtmlCache = "<!DOCTYPE html><html><body>capture mobile UI not built</body></html>";
  }
  return captureMobileHtmlCache;
}

// Phone-side HEIC → JPEG polyfill, served from the project's
// node_modules/heic2any rather than a CDN so the LAN works air-gapped.
// `npm install heic2any` populates this; if it's missing the route
// 502s and the phone's `script.onerror` shows "Couldn't load HEIC
// converter" — same failure mode the CDN had on offline networks.
const heic2anyAssetPath = join(
  import.meta.dirname ?? ".",
  "../../node_modules/heic2any/dist/heic2any.min.js",
);
let heic2anyAssetCache: Buffer | undefined;
function getHeic2anyAsset(): Buffer | undefined {
  if (heic2anyAssetCache !== undefined) return heic2anyAssetCache;
  try {
    heic2anyAssetCache = readFileSync(heic2anyAssetPath);
  } catch {
    return undefined;
  }
  return heic2anyAssetCache;
}

/**
 * Workflow → capture metadata. The frontend's TopBarCaptureButton hides
 * itself when its workflow isn't here; finalize dispatch still happens
 * inside `makeCaptureFinalize` (the registry refactor that moves the
 * finalize handler in here is a follow-up).
 */
const captureRegistrations: Record<
  string,
  { label: string; contextHints?: string[] }
> = {
  "oath-signature": { label: "Capture paper roster" },
};

// ─── Capture SSE channel ────────────────────────────────────
//
// A single subscription on `captureStore` fans every mutation out to
// every open dashboard tab. Modal-side `useCaptureSession` opens an
// EventSource against `/api/capture/sessions/stream` only while the
// dialog is open, so the channel is cheap when no operator is looking.

interface CaptureSseClient {
  id: number;
  res: import("http").ServerResponse;
}
let nextCaptureSseClientId = 0;
const captureSseClients = new Set<CaptureSseClient>();

/**
 * Strip secrets + non-serializable fields out of a session for the
 * SSE / list endpoints. **Never** include `token` — it leaves the
 * server only in the response to `/api/capture/start` per the spec's
 * "Token never echoed in SSE" invariant.
 */
function serializeCaptureSession(
  s: import("../capture/sessions.js").CaptureSession,
): {
  sessionId: string;
  workflow: string;
  contextHint?: string;
  state: import("../capture/sessions.js").CaptureSessionState;
  createdAt: number;
  expiresAt: number;
  phoneConnectedAt: number | null;
  photos: CapturedPhoto[];
  pdfPath?: string;
} {
  return {
    sessionId: s.sessionId,
    workflow: s.workflow,
    contextHint: s.contextHint,
    state: s.state,
    createdAt: s.createdAt,
    expiresAt: s.expiresAt,
    phoneConnectedAt: s.phoneConnectedAt ?? null,
    photos: s.photos,
    ...(s.pdfPath ? { pdfPath: s.pdfPath } : {}),
  };
}

function captureSseFanOut(eventName: string, data: unknown): void {
  const payload = `event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of [...captureSseClients]) {
    try {
      client.res.write(payload);
    } catch {
      captureSseClients.delete(client);
    }
  }
}

captureStore.subscribe((event: CaptureSessionEvent) => {
  captureSseFanOut("session-event", event);
});

// 15s heartbeat keeps NAT/proxy connections alive and lets the client
// notice a silent disconnect within one window.
const captureHeartbeatInterval = setInterval(() => {
  captureSseFanOut("heartbeat", { ts: Date.now() });
}, 15_000);
captureHeartbeatInterval.unref?.();

/**
 * Per-workflow finalize dispatcher. Once the capture module bundles the
 * PDF and sets `session.pdfPath`, route the finalized session to the
 * right downstream pipeline based on `session.workflow`. Unknown
 * workflows log a warn and otherwise no-op.
 *
 * Adding a new consumer: import its prepare function, add a case here,
 * and update `src/capture/CLAUDE.md`.
 */
function makeCaptureFinalize(trackerDir: string) {
  return async (session: import("../capture/sessions.js").CaptureSession): Promise<void> => {
    if (!session.pdfPath) {
      log.warn(`[capture] finalize fired without a pdfPath (sessionId=${session.sessionId})`);
      return;
    }

    let formType: string;
    if (session.workflow === "oath-signature") {
      formType = "oath";
    } else if (session.workflow === "emergency-contact") {
      formType = "emergency-contact";
    } else if (session.workflow === "ocr" && session.formType) {
      formType = session.formType;
    } else {
      log.warn(
        `[capture] no finalize handler for workflow="${session.workflow}" — PDF saved at ${session.pdfPath}`,
      );
      return;
    }

    // POST to /api/ocr/prepare — same multipart shape RunModal uses.
    const { buildOcrPrepareHandler } = await import("./ocr-http.js");
    const handler = buildOcrPrepareHandler({ trackerDir });
    const rosterDirs = [
      resolve(process.cwd(), ".tracker/rosters"),
      resolve(process.cwd(), "src/data"),
    ];
    const rosterDir = rosterDirs.find((d) => existsSync(d)) ?? rosterDirs[0];
    // Find the first xlsx roster file.
    let rosterPath: string | undefined;
    try {
      const { readdirSync } = await import("node:fs");
      const files = readdirSync(rosterDir).filter((f) => f.endsWith(".xlsx"));
      if (files.length > 0) {
        rosterPath = resolve(rosterDir, files.sort().at(-1)!);
      }
    } catch { /* tolerate */ }

    const pdfOriginalName = `capture-${session.sessionId.slice(0, 8)}.pdf`;
    const result = await handler({
      pdfPath: session.pdfPath,
      pdfOriginalName,
      formType,
      rosterMode: rosterPath ? "existing" : "download",
      rosterPath,
      sessionId: session.sessionId,
    });
    if (result.status !== 202) {
      log.warn(`[capture] ocr prepare failed (status ${result.status}): ${JSON.stringify(result.body)}`);
    }
  };
}

/**
 * Test helper — clears the cooldown map so tests can re-run scans without
 * state bleed. Not part of the public API.
 */
export function __resetFailureAlertCooldown(): void {
  failureAlertCooldown.clear();
}

/**
 * Scan the current day's tracker entries across all known workflows for
 * repeated-failure patterns. Fires macOS notifications + log.warn for any
 * pattern that crosses the threshold and isn't in cooldown. Best-effort —
 * a notification failure never stalls the SSE poll cycle.
 *
 * Pulled out of the `/events` handler so it can be smoke-tested in isolation.
 */
export async function scanFailurePatterns(): Promise<void> {
  try {
    const workflows = listWorkflows();
    // Read today's entries for every workflow — concat and scan in one go.
    // The detector groups by (workflow, error) so cross-workflow mixing is fine.
    const all = workflows.flatMap((w) => readEntries(w));
    const patterns = detectFailurePattern(all, {
      cooldownState: failureAlertCooldown,
    });
    for (const p of patterns) {
      const windowMin = Math.round((Date.parse(p.lastTs) - Date.parse(p.firstTs)) / 60_000) || 1;
      const msg = `${p.workflow}: ${p.count}x ${p.error} in ${windowMin}m`;
      log.warn(`failure pattern detected — ${msg}`);
      // Don't block the poll cycle waiting for osascript — fire-and-forget.
      void notify("HR automation: failures", msg);
    }
  } catch (err) {
    // Best-effort — never crash the poll cycle.
    log.warn(`scanFailurePatterns skipped: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Grace period before treating a queued-with-no-alive-daemons item as truly
 * orphaned. As of 2026-04-28 (Cluster A spec), the grace is **0 ms**.
 *
 * Rationale: `ensureDaemonsAndEnqueue` was reordered so the queue file is
 * only appended AFTER `spawnDaemon` returns (lockfile registered). Therefore
 * every item in the queue file has a registered daemon by construction;
 * "queue file has items + 0 alive daemons" can only happen if that daemon
 * died after writing. Failing the items immediately matches the user's
 * "if the daemon dies, fail all queued ones" rule.
 *
 * Pre-2026-04-28 the grace was 5 minutes to cover the spawn-to-lockfile
 * window; with the new ordering that window is closed. Legacy queue items
 * left over from earlier runs (where a daemon died without exit cleanup)
 * are correctly treated as orphaned and failed on first poll.
 */
const ORPHAN_QUEUE_GRACE_MS = 0;

/**
 * Safety net: detect queued items whose workflow has zero alive daemons,
 * mark them failed in both the queue and the tracker so the dashboard's
 * pending rows don't stick when the daemon's own teardown cleanup didn't run
 * (force-kill, OS crash, daemon process killed without graceful exit).
 *
 * Runs alongside `scanFailurePatterns` from the `/events` SSE poll. Cheap:
 * one `readQueueState` + one `findAliveDaemons` per workflow with non-empty
 * queue. Idempotent — once an item is marked failed, the next pass sees
 * `state.queued.length === 0` for that id.
 *
 * **Grace = 0 (2026-04-28)**: with the spawn-then-enqueue reorder in
 * `ensureDaemonsAndEnqueue`, the queue file is only appended after a daemon
 * lockfile is registered. Any item present in queue + 0 alive daemons is a
 * genuine orphan, not a spawn-in-flight race. Failing immediately matches
 * the "daemon dies → fail queued" rule. The legacy 5-minute grace was
 * removed because the spawn-to-lockfile window is now closed by ordering.
 *
 * Does NOT touch claimed items: those are owned by a daemon (alive or
 * recently dead). The daemon's own `recoverOrphanedClaims` keepalive sweep
 * handles dead-daemon claim recovery; this sweep handles "queued, no one to
 * pick up" specifically.
 */
export async function scanOrphanedQueueItems(dir = DEFAULT_DIR): Promise<void> {
  try {
    const workflows = listWorkflows(dir);
    const nowMs = Date.now();
    for (const wf of workflows) {
      const state = await readQueueState(wf, dir);
      if (state.queued.length === 0) continue;
      // Filter to items that have aged past the grace window. If everything
      // queued is fresh, skip the alive-daemon probe entirely.
      const stale = state.queued.filter((item) => {
        const enqMs = Date.parse(item.enqueuedAt);
        if (!Number.isFinite(enqMs)) return true; // unparseable → treat as old
        return nowMs - enqMs >= ORPHAN_QUEUE_GRACE_MS;
      });
      if (stale.length === 0) continue;
      const alive = await findAliveDaemons(wf, dir);
      if (alive.length > 0) continue;
      log.warn(
        `[orphan-sweep] ${wf}: ${stale.length} queued item(s) past grace with 0 alive daemons; marking failed`,
      );
      const nowIso = new Date().toISOString();
      const failError =
        "No alive daemon available to process this item. Start a daemon and retry.";
      for (const item of stale) {
        const runId = item.runId ?? `${item.id}#1`;
        try {
          await markItemFailed(wf, item.id, failError, runId, dir);
        } catch {
          /* best-effort */
        }
        try {
          // Same shape as the pending row from `onPreEmitPending` so
          // prefilledData (edit-and-resume) lands as flat top-level keys.
          // Otherwise the failed row's barer `data` overrides the pending
          // row in the dashboard's latest-per-id dedupe and the user's
          // edits disappear from the detail grid.
          const data = buildTrackerDataForInput(item.input);
          trackEvent(
            {
              workflow: wf,
              timestamp: nowIso,
              id: item.id,
              runId,
              status: "failed",
              data,
              error: failError,
            },
            dir,
          );
        } catch {
          /* best-effort */
        }
      }
    }
  } catch (err) {
    log.warn(`scanOrphanedQueueItems skipped: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Returns a handler that serves the registered workflow metadata as JSON. */
export function buildWorkflowsHandler(): () => WorkflowMetadata[] {
  return () => getAllRegisteredWorkflows();
}

/** Default root dir for kernel failure screenshots. Matches `screenshotAll`. */
export const SCREENSHOTS_DIR = PATHS.screenshotDir;

export interface ScreenshotListEntry {
  filename: string;
  ts: string; // ISO-8601
  sizeBytes: number;
  step: string;
}

/**
 * Grouped screenshot entry — one per screenshot tracker event (or one
 * synthetic entry for all "legacy" files that have no matching event).
 * Returned by the `{ dir, screenshotsDir }` overload of
 * `buildScreenshotsHandler`.
 */
export interface ScreenshotGroupedEntry {
  ts: number;
  kind: "form" | "error" | "manual";
  label: string;
  step: string | null;
  files: Array<{ system: string; path: string; url: string }>;
}

/**
 * Build a handler that lists PNGs in `.screenshots/` whose filename matches
 * `<workflow>-<itemId>-*`. Injectable root dir so tests can point at a
 * temp fixture dir. Returns `[]` when the dir doesn't exist or the prefix
 * matches nothing. Filenames produced by `Session.screenshotAll` have shape
 * `<workflow>-<itemId>-<step>-<systemId>-<timestamp>.png`; we parse `step` +
 * `ts` heuristically so the UI can show useful captions.
 *
 * Overloaded: when called with `{ dir, screenshotsDir }` it returns an async
 * handler that reads `sessions.jsonl` and groups files by screenshot events,
 * surfacing unmatched / legacy files under a synthetic `kind=error label=legacy`
 * entry. When called with a string (or no args) it returns the legacy sync
 * flat-list handler — this overload is retained for backward compat with the
 * SSE enrichment loop.
 */
export function buildScreenshotsHandler(
  rootDir?: string,
): (workflow: string, itemId: string) => ScreenshotListEntry[];
export function buildScreenshotsHandler(deps: {
  dir: string;
  screenshotsDir: string;
}): (query: { workflow: string; itemId: string }) => Promise<ScreenshotGroupedEntry[]>;
export function buildScreenshotsHandler(
  arg: string | { dir: string; screenshotsDir: string } | undefined = SCREENSHOTS_DIR,
): unknown {
  // ── New grouped overload ────────────────────────────────────────────────────
  if (arg !== null && typeof arg === "object") {
    const { dir, screenshotsDir } = arg;
    return async function groupedHandler(
      query: { workflow: string; itemId: string },
    ): Promise<ScreenshotGroupedEntry[]> {
      const { workflow, itemId } = query;
      const prefix = `${workflow}-${itemId}-`;

      // 1. Read sessions.jsonl and collect screenshot events whose files
      //    touch the requested workflow/itemId.
      const sessPath = getSessionsFilePath(dir);
      const events: import("./session-events.js").ScreenshotSessionEvent[] = [];
      if (existsSync(sessPath)) {
        const raw = readFileSync(sessPath, "utf-8");
        for (const line of raw.split("\n")) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          let parsed: unknown;
          try {
            parsed = JSON.parse(trimmed);
          } catch {
            continue;
          }
          if (
            parsed !== null &&
            typeof parsed === "object" &&
            "type" in parsed &&
            (parsed as Record<string, unknown>)["type"] === "screenshot" &&
            "files" in parsed
          ) {
            const ev = parsed as import("./session-events.js").ScreenshotSessionEvent;
            // Include this event if ANY of its files belong to this workflow+itemId.
            const matches = ev.files.some((f) => {
              const base = f.path.split(/[/\\]/).pop() ?? "";
              return base.startsWith(prefix);
            });
            if (matches) events.push(ev);
          }
        }
      }

      // 2. Build grouped entries from events. Track which file paths are covered.
      //    Only include files that still exist on disk — sessions.jsonl persists
      //    across cleanup cycles so stale references are common.
      const coveredPaths = new Set<string>();
      const grouped: ScreenshotGroupedEntry[] = [];
      for (const ev of events) {
        const files: ScreenshotGroupedEntry["files"] = [];
        for (const f of ev.files) {
          if (!existsSync(f.path)) continue;
          coveredPaths.add(f.path);
          files.push({
            system: f.system,
            path: f.path,
            url: `/screenshots/${encodeURIComponent(f.path.split(/[/\\]/).pop() ?? "")}`,
          });
        }
        // Skip the entire entry if none of its files survived cleanup.
        if (files.length === 0) continue;
        grouped.push({
          ts: ev.ts,
          kind: ev.kind,
          label: ev.label,
          step: ev.step,
          files,
        });
      }

      // 3. Enumerate files in screenshotsDir; any not already covered become
      //    synthetic legacy entries (grouped all under one label="legacy").
      const legacyFiles: ScreenshotGroupedEntry["files"] = [];
      let legacyTs = 0;
      if (existsSync(screenshotsDir)) {
        for (const f of readdirSync(screenshotsDir)) {
          if (!f.endsWith(".png")) continue;
          if (!f.startsWith(prefix)) continue;
          const fullPath = join(screenshotsDir, f);
          if (coveredPaths.has(fullPath)) continue;

          // Parse TS from trailing numeric segment before .png
          const tsMatch = f.match(/-(\d+)\.png$/);
          const fileTsNum = tsMatch ? Number(tsMatch[1]) : 0;

          // Determine system: second-to-last dash-segment before the ts
          const stripped = f.slice(prefix.length, -".png".length);
          const segs = stripped.split("-");
          let system = "unknown";
          if (segs.length >= 2) {
            system = segs[segs.length - 2];
          }

          if (fileTsNum > legacyTs) legacyTs = fileTsNum;
          legacyFiles.push({
            system,
            path: fullPath,
            url: `/screenshots/${encodeURIComponent(f)}`,
          });
        }
      }
      if (legacyFiles.length > 0) {
        grouped.push({
          ts: legacyTs,
          kind: "error",
          label: "legacy",
          step: null,
          files: legacyFiles,
        });
      }

      // 4. Sort newest-first.
      grouped.sort((a, b) => b.ts - a.ts);
      return grouped;
    };
  }

  // ── Legacy flat-list overload (backward compat) ─────────────────────────────
  const rootDir: string = typeof arg === "string" ? arg : SCREENSHOTS_DIR;
  return (workflow: string, itemId: string): ScreenshotListEntry[] => {
    if (!existsSync(rootDir)) return [];
    const prefix = `${workflow}-${itemId}-`;
    const out: ScreenshotListEntry[] = [];
    for (const f of readdirSync(rootDir)) {
      if (!f.endsWith(".png")) continue;
      if (!f.startsWith(prefix)) continue;
      const full = join(rootDir, f);
      let sizeBytes = 0;
      try {
        sizeBytes = statSync(full).size;
      } catch {
        continue;
      }
      // Parse step + ts from the tail. Filename shape:
      //   <workflow>-<itemId>-<step>-<systemId>-<ts>.png
      // We can't split blindly because step names themselves can contain
      // dashes (e.g. "crm-auth"). Strategy: strip prefix, strip `.png`, split
      // by "-", take the trailing two segments as systemId + ts, the rest is
      // step. If the remainder is empty (malformed), leave step="".
      const stripped = f.slice(prefix.length, -".png".length);
      const segs = stripped.split("-");
      let step = "";
      let tsRaw = "";
      if (segs.length >= 3) {
        tsRaw = segs[segs.length - 1];
        // segs[segs.length - 2] is systemId — discarded in the UI caption
        step = segs.slice(0, segs.length - 2).join("-");
      } else if (segs.length === 2) {
        // Legacy: no step in the filename. Keep step empty.
        tsRaw = segs[1];
      }
      const tsNum = Number(tsRaw);
      const iso = Number.isFinite(tsNum) && tsNum > 0 ? new Date(tsNum).toISOString() : "";
      out.push({ filename: f, ts: iso, sizeBytes, step });
    }
    // Newest first — the UI scrolls horizontally, so latest on the left.
    out.sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0));
    return out;
  };
}

/**
 * Path-traversal-safe resolver. Accepts a screenshot filename (no path
 * separators) and returns the absolute path inside `rootDir`, or null if the
 * filename is malicious or the file doesn't exist inside the root.
 */
export function resolveScreenshotPath(
  filename: string,
  rootDir: string = SCREENSHOTS_DIR,
): string | null {
  // Cheap guard — no separators allowed, no "..".
  if (!filename || filename.includes("/") || filename.includes("\\") || filename.includes("..")) {
    return null;
  }
  const rootAbs = resolve(rootDir);
  const fileAbs = resolve(rootDir, filename);
  // Defense in depth — ensure the resolved path is inside rootDir.
  const normalized = fileAbs + (fileAbs.endsWith(sep) ? "" : "");
  if (!normalized.startsWith(rootAbs + sep) && normalized !== rootAbs) {
    return null;
  }
  if (!existsSync(fileAbs)) return null;
  return fileAbs;
}

/**
 * A single aggregated selector-fallback warning row. `label` is the text
 * captured from `safeClick`/`safeFill`'s `log.warn("selector fallback
 * triggered: <label>")` message. `count` is total occurrences across the
 * scanned window; `firstTs`/`lastTs` bracket that activity; `workflows`
 * is the distinct set of workflow names that emitted the warn.
 */
export interface SelectorWarningRow {
  label: string;
  count: number;
  firstTs: string;
  lastTs: string;
  workflows: string[];
}

/**
 * Regex that extracts the selector label from a `safeClick`/`safeFill`
 * instrumentation log line. Keep in sync with the format in
 * `src/systems/common/safe.ts`.
 *
 * Matches all three shapes that share the `selector fallback triggered:`
 * anchor:
 *   - legacy (pre-timing) : `selector fallback triggered: <label>`
 *   - slow-success (warn) : `selector fallback triggered: <label> (click took Nms — ...)`
 *   - failure (error)     : `selector fallback triggered: <label> (click failed after Nms — ...)`
 *
 * The lazy `[^(]+?` capture stops at the first `(` of the timing suffix (if
 * present) so every variant aggregates under the same `<label>` key.
 */
const SELECTOR_FALLBACK_RE = /selector fallback triggered:\s*([^(]+?)\s*(?:\(.*)?$/;

/**
 * Build a handler that scans log JSONL files in `dir` across the current day
 * plus `days - 1` prior days, keeps entries whose `level` is `warn` (slow
 * success) or `error` (failure) and whose message matches
 * `selector fallback triggered: <label>` (optionally followed by a timing
 * suffix), and returns one aggregated `SelectorWarningRow` per distinct
 * label (sorted by count desc, tie-broken by most recent `lastTs`).
 *
 * Factored out of the HTTP handler so it can be unit-tested against a temp
 * directory without booting the SSE server.
 */
export function buildSelectorWarningsHandler(
  dir: string = ".tracker",
): (days: number) => SelectorWarningRow[] {
  return (days: number) => {
    if (!existsSync(dir)) return [];
    const daysNormalized = Math.max(1, Math.floor(days));
    const today = new Date();
    // Collect the list of YYYY-MM-DD dates to scan (today + prior days).
    const dates: string[] = [];
    for (let i = 0; i < daysNormalized; i++) {
      const d = new Date(today);
      d.setDate(d.getDate() - i);
      dates.push(dateLocal(d));
    }

    // Aggregate by label. Track distinct workflow set per label.
    const aggregated = new Map<
      string,
      { count: number; firstTs: string; lastTs: string; workflows: Set<string> }
    >();

    for (const f of readdirSync(dir)) {
      if (!f.endsWith("-logs.jsonl")) continue;
      // Match the date and workflow out of the filename: `<wf>-<YYYY-MM-DD>-logs.jsonl`
      const m = f.match(/^(.+)-(\d{4}-\d{2}-\d{2})-logs\.jsonl$/);
      if (!m) continue;
      const date = m[2];
      if (!dates.includes(date)) continue;

      let raw: string;
      try {
        raw = readFileSync(join(dir, f), "utf-8");
      } catch {
        continue;
      }
      for (const line of raw.split("\n")) {
        if (!line) continue;
        let entry: { workflow?: string; level?: string; message?: string; ts?: string };
        try {
          entry = JSON.parse(line);
        } catch {
          continue;
        }
        // Accept both warn (slow-success) and error (failure) — they share
        // the `selector fallback triggered:` marker. See safe.ts for shapes.
        if (
          (entry.level !== "warn" && entry.level !== "error") ||
          typeof entry.message !== "string"
        )
          continue;
        const match = entry.message.match(SELECTOR_FALLBACK_RE);
        if (!match) continue;
        const label = match[1].trim();
        if (!label) continue;
        const ts = typeof entry.ts === "string" ? entry.ts : "";
        const workflow = typeof entry.workflow === "string" ? entry.workflow : "";
        const prev = aggregated.get(label);
        if (prev) {
          prev.count += 1;
          if (ts && (!prev.firstTs || ts < prev.firstTs)) prev.firstTs = ts;
          if (ts && (!prev.lastTs || ts > prev.lastTs)) prev.lastTs = ts;
          if (workflow) prev.workflows.add(workflow);
        } else {
          aggregated.set(label, {
            count: 1,
            firstTs: ts,
            lastTs: ts,
            workflows: new Set(workflow ? [workflow] : []),
          });
        }
      }
    }

    // Emit rows, sorted by count desc then lastTs desc.
    return [...aggregated.entries()]
      .map(([label, agg]) => ({
        label,
        count: agg.count,
        firstTs: agg.firstTs,
        lastTs: agg.lastTs,
        workflows: [...agg.workflows].sort(),
      }))
      .sort((a, b) =>
        b.count - a.count || (a.lastTs < b.lastTs ? 1 : a.lastTs > b.lastTs ? -1 : 0),
      );
  };
}

// ── SharePoint roster download trigger ─────────────────────────────────────
//
// Factory + in-flight lock live in `src/workflows/sharepoint-download/` now;
// the dashboard just wires the factory into the HTTP route below. Routes are
// namespaced under /api/sharepoint-download/ to reflect that the button is
// workflow-agnostic (see `src/workflows/sharepoint-download/CLAUDE.md`).
export { isDownloadInFlight as isRosterDownloadInFlight } from "../workflows/sharepoint-download/index.js";
export type {
  RosterDownloadResponse,
  RosterDownloadHandlerOptions,
} from "../workflows/sharepoint-download/index.js";

/**
 * Minimal TrackerEntry shape needed for step-duration computation. Kept
 * narrow (timestamp + status + step) so the function works against both
 * today's JSONL records and any shimmed test fixtures.
 */
interface StepDurationEntry {
  timestamp: string;
  status: "pending" | "running" | "done" | "failed" | "skipped";
  step?: string;
}

/**
 * One hit in the cross-date search. Keeps the shape thin so the frontend
 * dropdown can render quickly without needing another round-trip.
 */
export interface SearchResultRow {
  workflow: string;
  id: string;
  runId: string;
  status: "pending" | "running" | "done" | "failed" | "skipped";
  /** Latest timestamp seen for this (workflow, id, runId). */
  lastTs: string;
  /** Date bucket (YYYY-MM-DD) the match lives in — used by the UI to deep-link. */
  date: string;
  /** Compact one-line summary (name / doc id / email). Never empty. */
  summary: string;
}

/** One row in the navbar approval inbox. See frontend types.ts for the full JSDoc. */
export interface PreviewInboxRow {
  workflow: string;
  id: string;
  runId: string;
  /** Display name — typically the original PDF filename. */
  summary: string;
  /** ISO timestamp of the latest tracker entry for this row. */
  ts: string;
  /** Tracker date (YYYY-MM-DD) so the dashboard can deep-link. */
  date: string;
  /** Optional record-count hint (emergency-contact prep parent rows have it). */
  recordCount?: number;
}

/** One row in the failure-bell popover. Returned by GET /api/failures. */
export interface FailureRow {
  workflow: string;
  id: string;
  runId: string;
  summary: string;
  error: string;
  ts: string;
  date: string;
}

/**
 * Narrow reader-bundle shape the search handler depends on. Lets tests inject
 * in-memory fixtures instead of touching disk — matches the factory style used
 * by `buildScreenshotsHandler` / `buildSelectorWarningsHandler`.
 */
export interface SearchDeps {
  /** List workflows that have JSONL data (filters to known files). */
  listWorkflows: () => string[];
  /** List YYYY-MM-DD dates with entries for `wf`, newest first. */
  listDates: (wf: string) => string[];
  /** Read entries for a specific (wf, date) bucket. */
  readEntriesForDate: (wf: string, date: string) => TrackerEntry[];
}

/**
 * Fields on `data` the search matches against, in priority order. Priority
 * governs which value gets used for the result's summary string when multiple
 * match — emplId / docId outrank names because the operator can recognize a
 * record by its id even without a name.
 */
const SEARCH_FIELDS = [
  "emplId",
  "docId",
  "email",
  "firstName",
  "lastName",
  "name",
] as const;

/**
 * Build the `summary` cell for a search row. Prefers a human-readable name
 * (first + last or name), falls back to docId / email / emplId / id. Kept as a
 * pure helper so the unit test can exercise the precedence order without
 * going through the handler.
 */
export function buildSearchSummary(entry: TrackerEntry): string {
  const d = entry.data ?? {};
  const name = (d.__name || d.name || "").trim()
    || `${(d.firstName || "").trim()} ${(d.lastName || "").trim()}`.trim();
  if (name) return name;
  if (d.docId) return d.docId;
  if (d.email) return d.email;
  if (d.emplId) return d.emplId;
  return entry.id;
}

/**
 * Factory for the cross-date search handler. Scans `days` calendar days
 * (default 30) across either a single workflow or all workflows, filters
 * entries where {id, runId, or any of SEARCH_FIELDS on `data`} contain `q`
 * case-insensitively, and returns the top `limit` matches sorted by lastTs
 * desc.
 *
 * Entries are aggregated per (workflow, id) — only the latest entry across
 * all runs for that id survives into the result list. The result row's
 * `runId` and `status` reflect the most recent run, so the dropdown shows
 * one row per doc/email/emplId pointing at the last attempt.
 *
 * Deps are injected so unit tests can feed in-memory JSONL fixtures without
 * hitting disk.
 */
export function buildSearchHandler(deps: SearchDeps) {
  return (
    q: string,
    opts: { workflow?: string; limit?: number; days?: number } = {},
  ): SearchResultRow[] => {
    const query = q.trim().toLowerCase();
    if (!query) return [];
    const limit = opts.limit && opts.limit > 0 ? Math.floor(opts.limit) : 50;
    const days = opts.days && opts.days > 0 ? Math.floor(opts.days) : 30;

    // Target workflow list: single (if scoped) or every known workflow.
    const targetWorkflows = opts.workflow
      ? [opts.workflow]
      : deps.listWorkflows();

    // Cut-off date (YYYY-MM-DD). Strings compare lexicographically for
    // ISO dates, which is what we want here.
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - (days - 1));
    const cutoffStr = dateLocal(cutoff);

    // Latest-per-id aggregation. Key: `${workflow}::${id}`. Multiple runs
    // for the same id collapse into one row whose runId/status reflect
    // the most recent attempt. We carry the underlying entry so we can
    // post-filter resolved prep rows after the fold (they shouldn't show
    // up as recent results — the operator already approved or discarded
    // them).
    const byId = new Map<
      string,
      { row: SearchResultRow; ts: string; entry: TrackerEntry }
    >();

    const matches = (entry: TrackerEntry): boolean => {
      if (entry.id.toLowerCase().includes(query)) return true;
      if (entry.runId && entry.runId.toLowerCase().includes(query)) return true;
      const d = entry.data ?? {};
      for (const field of SEARCH_FIELDS) {
        const v = d[field];
        if (v && v.toLowerCase().includes(query)) return true;
      }
      // Also match the server-computed __name which carries first+last.
      if (d.__name && d.__name.toLowerCase().includes(query)) return true;
      return false;
    };

    for (const wf of targetWorkflows) {
      const dates = deps.listDates(wf);
      for (const date of dates) {
        if (date < cutoffStr) continue;
        const entries = deps.readEntriesForDate(wf, date);
        for (const e of entries) {
          if (!matches(e)) continue;
          const runId = e.runId || `${e.id}#1`;
          const key = `${wf}::${e.id}`;
          const prev = byId.get(key);
          // Keep the latest entry for this id across all runs. Ties by
          // timestamp break toward the first-seen — append-only JSONL
          // guarantees later entries reflect the newest state.
          if (!prev || e.timestamp >= prev.ts) {
            byId.set(key, {
              ts: e.timestamp,
              entry: e,
              row: {
                workflow: wf,
                id: e.id,
                runId,
                status: e.status,
                lastTs: e.timestamp,
                date,
                summary: buildSearchSummary(e),
              },
            });
          }
        }
      }
    }

    // Resolved prep rows (operator approved or discarded) shouldn't surface
    // in search — they're audit-only at that point. Mirrors the frontend's
    // `isResolvedPrepRow` predicate in QueuePanel via `isResolvedPrepEntry`
    // (defined further down in this file).
    return [...byId.values()]
      .filter((x) => !isResolvedPrepEntry(x.entry))
      .sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0))
      .slice(0, limit)
      .map((x) => x.row);
  };
}

export interface PreviewInboxDeps {
  listWorkflows: () => string[];
  listDates: (workflow: string) => string[];
  readEntriesForDate: (workflow: string, date: string) => TrackerEntry[];
}

const PREVIEW_INBOX_DAYS = 7;

/**
 * Cross-workflow approval-inbox handler. Surfaces preview-row tracker
 * entries (`data.mode === "prepare"`) whose latest entry has reached
 * `done` status without being approved or discarded.
 *
 * Discriminator (universal — any workflow that adopts the `data.mode === "prepare"`
 * parent-row pattern is automatically picked up):
 *   - `data.mode === "prepare"` (any entry in the run carries this)
 *   - latest entry's `status === "done"`
 *   - latest entry's `step !== "approved"` AND `step !== "discarded"`
 *
 * Scans the last 7 days. Sorts newest first.
 */
export function buildPreviewInboxHandler(deps: PreviewInboxDeps) {
  return (): PreviewInboxRow[] => {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - (PREVIEW_INBOX_DAYS - 1));
    const cutoffStr = dateLocal(cutoff);

    // Aggregate by (workflow, id, runId). Keep the latest entry per key.
    type Bucket = { latest: TrackerEntry; date: string };
    const byRun = new Map<string, Bucket>();

    for (const wf of deps.listWorkflows()) {
      for (const date of deps.listDates(wf)) {
        if (date < cutoffStr) continue;
        for (const e of deps.readEntriesForDate(wf, date)) {
          if (!isPrepEntry(e)) continue;
          const runId = e.runId || `${e.id}#1`;
          const key = `${wf}::${e.id}::${runId}`;
          const prev = byRun.get(key);
          if (!prev || e.timestamp >= prev.latest.timestamp) {
            byRun.set(key, { latest: e, date });
          }
        }
      }
    }

    const rows: PreviewInboxRow[] = [];
    for (const { latest, date } of byRun.values()) {
      if (!isReadyForReview(latest)) continue;
      rows.push({
        workflow: latest.workflow,
        id: latest.id,
        runId: latest.runId || `${latest.id}#1`,
        summary: previewSummary(latest),
        ts: latest.timestamp,
        date,
        recordCount: countRecords(latest),
      });
    }

    rows.sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0));
    return rows;
  };
}

export interface FailuresDeps {
  listWorkflows: () => string[];
  readEntriesForDate: (workflow: string, date: string) => TrackerEntry[];
}

const FAILURES_LIMIT = 50;

/**
 * Returns failed tracker entries for a given date across all workflows.
 * Latest run per id wins (so a retry that succeeded won't appear in the
 * failure list). Sorted newest first, capped at FAILURES_LIMIT rows.
 */
export function buildFailuresHandler(deps: FailuresDeps) {
  return (opts: { date: string; limit?: number }): FailureRow[] => {
    const limit = opts.limit && opts.limit > 0 ? Math.floor(opts.limit) : FAILURES_LIMIT;
    const failures: FailureRow[] = [];
    for (const wf of deps.listWorkflows()) {
      const all = deps.readEntriesForDate(wf, opts.date);
      // Aggregate by (id, runId) → latest entry per run.
      const latestPerRun = new Map<string, TrackerEntry>();
      for (const e of all) {
        const runId = e.runId || `${e.id}#1`;
        const key = `${e.id}::${runId}`;
        const prev = latestPerRun.get(key);
        if (!prev || e.timestamp >= prev.timestamp) latestPerRun.set(key, e);
      }
      // Per id, keep the latest run.
      const latestRunPerId = new Map<string, TrackerEntry>();
      for (const e of latestPerRun.values()) {
        const prev = latestRunPerId.get(e.id);
        if (!prev || e.timestamp >= prev.timestamp) latestRunPerId.set(e.id, e);
      }
      for (const e of latestRunPerId.values()) {
        if (e.status !== "failed") continue;
        // Resolved prep rows (operator-discarded) shouldn't surface as
        // failures — they're audit-only at that point. Mirrors the
        // QueuePanel's `isResolvedPrepRow` predicate.
        if (isResolvedPrepEntry(e)) continue;
        failures.push({
          workflow: wf,
          id: e.id,
          runId: e.runId || `${e.id}#1`,
          summary: buildSearchSummary(e),
          error: e.error || "Unknown error",
          ts: e.timestamp,
          date: opts.date,
        });
      }
    }
    failures.sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0));
    return failures.slice(0, limit);
  };
}

function isPrepEntry(e: TrackerEntry): boolean {
  // Legacy EC/oath-signature prep rows (data.mode === "prepare").
  if (e.data?.mode === "prepare") return true;
  // New OCR workflow rows (workflow === "ocr").
  if (e.workflow === "ocr") return true;
  return false;
}

/**
 * Mirrors `isResolvedPrepRow` in `src/dashboard/components/QueuePanel.tsx`.
 * A prep row in its terminal-resolved state — operator approved or
 * discarded — should not surface in any cross-workflow aggregator (search,
 * failure bell, queue counts).
 */
function isResolvedPrepEntry(e: TrackerEntry): boolean {
  if (!isPrepEntry(e)) return false;
  if (e.status === "done" && e.step === "approved") return true;
  if (e.status === "failed" && e.step === "discarded") return true;
  return false;
}

function isReadyForReview(latest: TrackerEntry): boolean {
  // OCR workflow: ready when done + step=awaiting-approval.
  if (latest.workflow === "ocr") {
    return latest.status === "done" && latest.step === "awaiting-approval";
  }
  // Legacy EC/oath-signature prep rows.
  if (latest.status !== "done") return false;
  if (latest.step === "approved" || latest.step === "discarded") return false;
  return true;
}

function previewSummary(e: TrackerEntry): string {
  return e.data?.pdfOriginalName || e.id;
}

function countRecords(e: TrackerEntry): number | undefined {
  const raw = e.data?.records;
  if (!raw) return undefined;
  try {
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    return Array.isArray(parsed) ? parsed.length : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Compute per-step durations (ms) for a single (itemId, runId) pair.
 *
 * Input: entries for one run, in any order. Sorted internally by timestamp.
 * Output: `{ [stepName]: durationMs }`. Only steps with a computed duration
 * are included. The last step is closed out by a subsequent `done` / `failed`
 * event; a still-running final step yields no duration for that step (yet).
 *
 * The first step's start is anchored at the earliest valid timestamp in the
 * run (typically the `pending` event), NOT at its own `running` event. This
 * way the pre-first-step gap — browser launch, session setup, any time
 * between workflow start and the first emitted step — is absorbed into
 * step 1's duration instead of being silently lost. The upshot:
 * `sum(stepDurations)` tiles the full elapsed time shown by the global
 * `useElapsed` counter (pending → done/failed), so the timeline matches the
 * dashboard's top-level timer.
 *
 * Why pull this out of `/events`? It's pure data-over-data — easily unit
 * testable, easily reusable if we later want to expose durations through
 * another endpoint.
 */
export function computeStepDurations(
  entries: StepDurationEntry[],
): Record<string, number> {
  if (entries.length === 0) return {};

  // Defensive copy + sort by timestamp; input arrays are usually already in
  // order (JSONL is append-only) but test fixtures may not be.
  const sorted = [...entries].sort((a, b) =>
    a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0,
  );

  const durations: Record<string, number> = {};
  let currentStep: string | null = null;
  let currentStepStartMs: number | null = null;
  // Anchor step 1 at the first non-`pending` event. The `pending` row is
  // written at enqueue time in daemon / pre-emit batch mode (potentially
  // minutes/hours before the item starts actual work), so using it would
  // bleed the full queue-wait duration into step 1's duration. The first
  // `running` event is the "work started here" moment; that's what the
  // step pipeline should measure.
  let workflowStartMs: number | null = null;
  let firstStepSeen = false;

  for (const e of sorted) {
    const tsMs = Date.parse(e.timestamp);
    if (Number.isNaN(tsMs)) continue;

    if (workflowStartMs === null && e.status !== "pending") workflowStartMs = tsMs;

    const isTerminal = e.status === "done" || e.status === "failed" || e.status === "skipped";
    const nextStep = isTerminal ? null : e.step ?? null;

    // When the active step changes (or we reach a terminal event), close out
    // the previous step's duration.
    if (currentStep && currentStep !== nextStep && currentStepStartMs !== null) {
      const delta = tsMs - currentStepStartMs;
      if (delta >= 0) {
        // Sum durations if a step re-appears (it won't normally, but be tolerant)
        durations[currentStep] = (durations[currentStep] ?? 0) + delta;
      }
    }

    if (nextStep !== currentStep) {
      currentStep = nextStep;
      if (nextStep && !firstStepSeen) {
        // Anchor step 1 at the workflow's earliest timestamp so the
        // pre-first-step gap is absorbed. workflowStartMs is guaranteed
        // non-null here because we set it above on the first valid ts.
        currentStepStartMs = workflowStartMs ?? tsMs;
        firstStepSeen = true;
      } else {
        currentStepStartMs = nextStep ? tsMs : null;
      }
    }
  }

  return durations;
}

/**
 * Count distinct ids whose latest run's latest entry is `failed`.
 * Pure helper so the navbar failure-bell badge can be unit-tested
 * independent of the SSE handler.
 */
export function computeFailureCounts(entries: TrackerEntry[]): number {
  // Aggregate by (id, runId) → latest entry per run.
  const latestPerRun = new Map<string, TrackerEntry>();
  for (const e of entries) {
    const runId = e.runId || `${e.id}#1`;
    const key = `${e.id}::${runId}`;
    const prev = latestPerRun.get(key);
    if (!prev || e.timestamp >= prev.timestamp) latestPerRun.set(key, e);
  }
  // For each id, find the latest run.
  const latestRunPerId = new Map<string, TrackerEntry>();
  for (const e of latestPerRun.values()) {
    const prev = latestRunPerId.get(e.id);
    if (!prev || e.timestamp >= prev.timestamp) latestRunPerId.set(e.id, e);
  }
  let count = 0;
  for (const e of latestRunPerId.values()) {
    if (e.status !== "failed") continue;
    // Discarded prep rows (`failed`+`discarded`) are operator-resolved and
    // shouldn't inflate the navbar failure-bell badge.
    if (isResolvedPrepEntry(e)) continue;
    count++;
  }
  return count;
}

/**
 * Summary of a run's timeline derived from its tracker JSONL history.
 * `earliestTrackerTs` is the single source of truth for "when did this run
 * start" — it matches the anchor `computeStepDurations` uses, so the header
 * Elapsed timer, the step pipeline durations, and the queue-row elapsed all
 * reference the same t=0. For batch items that means the synthetic auth
 * `running` entries at `onAuthStart` timestamps (injected by `runOneItem` —
 * see src/core/workflow.ts) are what anchor the run.
 */
export interface RunTimeline {
  /** 1-indexed chronological position among runs for the same itemId. */
  ordinal: number;
  /** Earliest tracker-entry ts for this run. */
  earliestTrackerTs: string;
  /** Latest tracker-entry ts for this run. */
  latestTrackerTs: string;
}

/** Return the earlier of two ISO timestamps, ignoring undefined inputs. */
function pickEarlier(a: string | undefined, b: string | undefined): string | undefined {
  if (!a) return b;
  if (!b) return a;
  return a < b ? a : b;
}

/** Return the later of two ISO timestamps, ignoring undefined inputs. */
function pickLater(a: string | undefined, b: string | undefined): string | undefined {
  if (!a) return b;
  if (!b) return a;
  return a > b ? a : b;
}

/**
 * Build a `runId → RunTimeline` map for all runs of a single itemId.
 *
 * Runs are ordered (and ordinals assigned) by each run's earliest tracker
 * entry timestamp, NOT by parsing the trailing `#N` off the runId. This
 * means the two coexisting runId shapes — legacy `{id}#N` and the UUID
 * format emitted by batch/pool runners — are numbered consistently:
 * "run #1" is always the chronologically first run for that item.
 *
 * Exported so both the SSE `/events` enrichment and `/api/runs` can use the
 * same assignment rule — the ordinal a queue row shows MUST match the
 * ordinal the RunSelector dropdown shows for the same runId.
 */
export function buildRunTimelines(
  entries: Array<{ runId?: string; id: string; timestamp: string; status?: string }>,
): Map<string, RunTimeline> {
  // `earliestTs` anchors the run's timer (header Elapsed, queue-row elapsed,
  // step pipeline widths). We prefer the first non-`pending` event — in
  // daemon mode and pre-emitted batch mode, the `pending` row is written
  // at enqueue time (potentially minutes/hours before the item claims a
  // worker), so using it would attribute the full queue-wait duration to
  // the item's elapsed timer. The first `running` / `done` / `failed` /
  // `skipped` event is the real "work started here" anchor. Items that
  // are still queued (only a `pending` row exists) fall back to the
  // pending timestamp so the queue row still has a sortable timestamp.
  const spans = new Map<
    string,
    { earliestWorkTs: string | null; earliestAnyTs: string; latestTs: string }
  >();
  for (const e of entries) {
    const rid = e.runId || `${e.id}#1`;
    const isWork = e.status !== "pending";
    const prev = spans.get(rid);
    if (!prev) {
      spans.set(rid, {
        earliestWorkTs: isWork ? e.timestamp : null,
        earliestAnyTs: e.timestamp,
        latestTs: e.timestamp,
      });
    } else {
      if (isWork && (prev.earliestWorkTs === null || e.timestamp < prev.earliestWorkTs)) {
        prev.earliestWorkTs = e.timestamp;
      }
      if (e.timestamp < prev.earliestAnyTs) prev.earliestAnyTs = e.timestamp;
      if (e.timestamp > prev.latestTs) prev.latestTs = e.timestamp;
    }
  }
  // Flatten: earliestTs = earliestWorkTs ?? earliestAnyTs (pending-only
  // queued runs fall back to the pending timestamp for sort stability).
  const spansFlat = new Map<string, { earliestTs: string; latestTs: string }>();
  for (const [rid, s] of spans) {
    spansFlat.set(rid, {
      earliestTs: s.earliestWorkTs ?? s.earliestAnyTs,
      latestTs: s.latestTs,
    });
  }
  // Secondary sort by runId keeps the assignment deterministic if two runs
  // share the same earliest timestamp (realistic for synthetic fixtures;
  // production tracker writes are microsecond-distinct).
  const sorted = [...spansFlat.entries()].sort(([ra, sa], [rb, sb]) =>
    sa.earliestTs < sb.earliestTs ? -1 :
    sa.earliestTs > sb.earliestTs ? 1 :
    ra.localeCompare(rb),
  );
  const out = new Map<string, RunTimeline>();
  sorted.forEach(([rid, span], i) => {
    out.set(rid, {
      ordinal: i + 1,
      earliestTrackerTs: span.earliestTs,
      latestTrackerTs: span.latestTs,
    });
  });
  return out;
}

/** Start the live monitoring dashboard. Call once at workflow start. */
export interface StartDashboardOptions {
  /** Skip the one-time startup prune of old tracker files. */
  noClean?: boolean;
  /** Max age (days) for the startup prune. Defaults to 30 — conservative. */
  cleanMaxAgeDays?: number;
  /** Override tracker dir — mainly for test isolation. Defaults to DEFAULT_DIR. */
  dir?: string;
}

/**
 * Options for the lower-level `createDashboardServer` factory. Returns a live
 * `http.Server` bound to the requested port (0 = random, useful in tests).
 * Does NOT use the module-level singleton.
 */
export interface CreateDashboardServerOptions {
  workflow?: string;
  port?: number;
  dir?: string;
  noClean?: boolean;
  cleanMaxAgeDays?: number;
}

export function startDashboard(
  workflow: string,
  port: number = 3838,
  opts: StartDashboardOptions = {}
): void {
  if (server) return;
  server = createDashboardServer({
    workflow,
    port,
    dir: opts.dir,
    noClean: opts.noClean,
    cleanMaxAgeDays: opts.cleanMaxAgeDays,
  });
}

/**
 * Factory for an isolated dashboard `http.Server` instance. Unlike
 * `startDashboard`, this bypasses the module-level singleton and returns the
 * live `Server` object so tests can spin up per-test servers on random ports
 * (port 0) with per-test tracker directories.
 *
 * Production callers should continue to use `startDashboard`, which
 * preserves the singleton-guard + :3838 default binding behavior.
 */
export function createDashboardServer(opts: CreateDashboardServerOptions = {}): Server {
  const workflow = opts.workflow ?? "onboarding";
  const port = opts.port ?? 3838;
  const dir = opts.dir ?? DEFAULT_DIR;

  // One-time startup prune — long retention by default (30 days) so the
  // dashboard boots with a clean working set without surprising the user.
  // Per-request /api/preflight still runs a 7-day prune for ongoing cleanup.
  if (!opts.noClean) {
    try {
      const maxAge = opts.cleanMaxAgeDays ?? 30;
      const deleted = cleanOldTrackerFiles(maxAge);
      if (deleted > 0) {
        log.step(`Pruned ${deleted} tracker file${deleted === 1 ? "" : "s"} older than ${maxAge} days`);
      }
    } catch (err) {
      // Don't fail startup if the tracker dir is missing or unreadable
      log.step(`Tracker startup prune skipped: ${err instanceof Error ? err.message : String(err)}`);
    }
    try {
      const maxAge = opts.cleanMaxAgeDays ?? 30;
      const deletedShots = cleanOldScreenshots(maxAge);
      if (deletedShots > 0) {
        log.step(`Pruned ${deletedShots} screenshot${deletedShots === 1 ? "" : "s"} older than ${maxAge} days`);
      }
    } catch (err) {
      log.step(`Screenshot startup prune skipped: ${err instanceof Error ? err.message : String(err)}`);
    }
    try {
      sweepStuckOcrRows(dir);
    } catch (err) {
      log.step(`OCR sweep skipped: ${err instanceof Error ? err.message : String(err)}`);
    }
    try {
      sweepStuckOathUploadRows(dir);
    } catch (err) {
      log.step(`oath-upload sweep skipped: ${err instanceof Error ? err.message : String(err)}`);
    }
    try {
      const removed = sweepOrphanUploadDirs(dir);
      if (removed > 0) {
        log.step(`Removed ${removed} orphan upload dir${removed === 1 ? "" : "s"} from ${dir}/uploads`);
      }
    } catch (err) {
      log.step(`Orphan upload-dir sweep skipped: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ─── OCR handler instances (created once with dir) ──────────
  const ocrFormsHandler         = buildOcrFormsHandler();
  const ocrPrepareHandler       = buildOcrPrepareHandler({ trackerDir: dir });
  const ocrApproveHandler       = buildOcrApproveHandler({ trackerDir: dir });
  const ocrDiscardHandler       = buildOcrDiscardHandler({ trackerDir: dir });
  const ocrForceResearchHandler = buildOcrForceResearchHandler({ trackerDir: dir });
  const ocrRetryPageHandler     = buildOcrRetryPageHandler({ trackerDir: dir });
  const ocrReocrWholePdfHandler = buildOcrReocrWholePdfHandler({ trackerDir: dir });

  // ─── Oath-upload handler instances (created once with dir) ──────────
  const oathUploadDupCheckHandler = buildOathUploadDuplicateCheckHandler({ trackerDir: dir });
  const oathUploadStartHandler    = buildOathUploadStartHandler({ trackerDir: dir });
  const oathUploadCancelHandler   = buildOathUploadCancelHandler({ trackerDir: dir });

  /** Standard JSON response helper. */
  const sendJson = (res: import("http").ServerResponse, status: number, body: unknown): void => {
    res.writeHead(status, {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    });
    res.end(JSON.stringify(body));
  };

  const localServer: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://localhost:${port}`);

    // CORS preflight — kept for any future POST endpoints.
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      });
      res.end();
      return;
    }

    if (url.pathname === "/api/workflows") {
      res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify(listWorkflows(dir)));
      return;
    }

    if (url.pathname === "/api/workflow-definitions") {
      res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify(buildWorkflowsHandler()()));
      return;
    }

    if (url.pathname === "/api/dates") {
      const wf = url.searchParams.get("workflow") ?? workflow;
      res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify(listDatesForWorkflow(wf, dir)));
      return;
    }

    if (url.pathname === "/api/entries") {
      const wf = url.searchParams.get("workflow") ?? workflow;
      res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify(readEntries(wf, dir)));
      return;
    }

    if (url.pathname === "/api/entry-data") {
      // Returns the richest tracker `data` map for a given (workflow, id,
      // runId) — used by EditDataTab's "Refresh from logs" button to refill
      // the form from whatever the latest run extracted. Falls back to the
      // richest data across runs of this id if the requested runId has nothing.
      const wf = url.searchParams.get("workflow") ?? workflow;
      const id = url.searchParams.get("id") ?? "";
      const runId = url.searchParams.get("runId") ?? "";
      const date = url.searchParams.get("date");
      if (!wf || !id) {
        res.writeHead(400, {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        });
        res.end(JSON.stringify({ ok: false, error: "workflow and id are required" }));
        return;
      }
      const entries = (date ? readEntriesForDate(wf, date, dir) : readEntries(wf, dir))
        .filter((e) => e.id === id);
      // Pick the richest (most non-empty fields) entry for the runId. The
      // last-running tracker row usually has the fullest `data` (kernel
      // updates merge into ctx.data, written on every step transition).
      // If the runId match is empty (e.g. user views run #2 which never
      // emitted any data because it was cancelled), fall back to richest
      // across all runs of this id.
      const richness = (e: TrackerEntry): number =>
        Object.values(e.data ?? {}).filter((v) => v != null && String(v).trim() !== "").length;
      const sorted = [...entries].sort((a, b) => {
        const r = richness(b) - richness(a);
        if (r !== 0) return r;
        return (b.timestamp ?? "").localeCompare(a.timestamp ?? "");
      });
      const sameRun = runId ? sorted.find((e) => e.runId === runId) : undefined;
      const fallback = sorted[0];
      const chosen = (sameRun && richness(sameRun) > 0) ? sameRun : fallback;
      res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify({
        ok: true,
        runId: chosen?.runId ?? null,
        timestamp: chosen?.timestamp ?? null,
        data: chosen?.data ?? {},
        source: chosen ? (chosen.runId === runId ? "active-run" : "fallback") : "none",
      }));
      return;
    }

    if (url.pathname === "/api/logs") {
      const wf = url.searchParams.get("workflow") ?? workflow;
      const id = url.searchParams.get("id") ?? "";
      const runId = url.searchParams.get("runId") ?? "";
      res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      let logs = readLogEntries(wf, id || undefined, dir);
      // Logs without runId belong to run #1 only
      if (runId) logs = logs.filter((l) => l.runId ? l.runId === runId : runId.endsWith("#1"));
      res.end(JSON.stringify(logs));
      return;
    }

    if (url.pathname === "/events/logs") {
      const wf = url.searchParams.get("workflow") ?? workflow;
      const id = url.searchParams.get("id") ?? "";
      const runId = url.searchParams.get("runId") ?? "";
      const date = url.searchParams.get("date") ?? "";
      const today = dateLocal();
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "Access-Control-Allow-Origin": "*",
      });
      let sentCount = 0;
      let firstTick = true;
      const send = () => {
        let entries = (date && date !== today)
          ? readLogEntriesForDate(wf, id || undefined, date, dir)
          : readLogEntries(wf, id || undefined, dir);
        // Logs without runId belong to run #1 only
        if (runId) entries = entries.filter((l) => l.runId ? l.runId === runId : runId.endsWith("#1"));

        if (firstTick) {
          // First tick: ALWAYS send — even an empty array. The frontend's
          // useLogs hook transitions from "loading skeleton" to "loaded"
          // on its first message; skipping the write for an empty dataset
          // leaves the UI stuck on skeleton forever (e.g. for a runId that
          // has a pending/failed tracker row but never produced any logs).
          res.write(`data: ${JSON.stringify(entries)}\n\n`);
          sentCount = entries.length;
          firstTick = false;
        } else if (entries.length > sentCount) {
          // Subsequent ticks: send only new logs
          res.write(`data: ${JSON.stringify(entries.slice(sentCount))}\n\n`);
          sentCount = entries.length;
        }
      };
      send();
      const interval = setInterval(send, 500);
      req.on("close", () => clearInterval(interval));
      return;
    }

    if (url.pathname === "/events/run-events") {
      const wf = url.searchParams.get("workflow") ?? workflow;
      const requestedRunId = url.searchParams.get("runId") ?? "";
      const date = url.searchParams.get("date") ?? "";
      const today = dateLocal();
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "Access-Control-Allow-Origin": "*",
      });

      // Batch / pool / daemon workflows call `Session.launch` at batch scope
      // (outside per-item `withLogContext`), so their `auth_*` and
      // `browser_launch` session events carry a `workflowInstance` but no
      // `runId`. `filterEventsForRun` resolves `runId -> tracker entry ->
      // data.instance` and pulls in those batch-scope events by matching
      // instance. See `filterEventsForRun` jsdoc for the full contract.

      let sentCount = 0;
      let firstTick = true;

      const send = async () => {
        // Read session events tolerantly — skip malformed lines instead of
        // letting a bad JSON line break the whole poll cycle. `readSessionEvents`
        // does a strict JSON.parse, so we inline a best-effort reader here.
        const sessionsPath = getSessionsFilePath(dir);
        const allEvents: SessionEvent[] = [];
        try {
          const raw = await readFileAsync(sessionsPath, "utf-8");
          for (const line of raw.split("\n")) {
            if (!line) continue;
            try {
              allEvents.push(JSON.parse(line) as SessionEvent);
            } catch {
              // Skip unparseable JSONL lines without derailing the stream.
            }
          }
        } catch {
          // ENOENT or other read failure → empty list; next tick may recover.
        }

        let trackerEntries: TrackerEntry[] = [];
        try {
          trackerEntries = (date && date !== today)
            ? readEntriesForDate(wf, date, dir)
            : readEntries(wf, dir);
        } catch {
          // Tracker read failure → instance fallback becomes a no-op for this tick.
        }

        const filtered = filterEventsForRun(allEvents, trackerEntries, requestedRunId);

        if (firstTick) {
          // First tick: ALWAYS send — matching /events/logs. Empty-array
          // sends are how useRunEvents learns "full history has been
          // delivered (and there's none)", dismissing its skeleton.
          res.write(`data: ${JSON.stringify(filtered)}\n\n`);
          sentCount = filtered.length;
          firstTick = false;
        } else if (filtered.length > sentCount) {
          res.write(`data: ${JSON.stringify(filtered.slice(sentCount))}\n\n`);
          sentCount = filtered.length;
        }
      };

      void send();
      const interval = setInterval(() => void send(), 500);
      req.on("close", () => clearInterval(interval));
      return;
    }

    // ─── Telegram-sent SSE ────────────────────────────────
    //
    // Streams every `telegram_sent` session event (delta semantics — first
    // tick replays history, subsequent ticks send only new entries) so the
    // frontend can toast each notification. Cross-workflow / no filter:
    // any operator running any workflow on this dashboard's machine sees
    // the same toasts, which matches the expected single-operator setup.
    if (url.pathname === "/events/telegram") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "Access-Control-Allow-Origin": "*",
      });
      let sentCount = 0;
      let firstTick = true;
      const send = async () => {
        const sessionsPath = getSessionsFilePath(dir);
        const events: SessionEvent[] = [];
        try {
          const raw = await readFileAsync(sessionsPath, "utf-8");
          for (const line of raw.split("\n")) {
            if (!line) continue;
            try {
              const ev = JSON.parse(line) as SessionEvent;
              if (ev.type === "telegram_sent") events.push(ev);
            } catch {
              // skip
            }
          }
        } catch {
          // ENOENT or other read failure → empty list; next tick recovers.
        }
        if (firstTick) {
          res.write(`data: ${JSON.stringify(events)}\n\n`);
          sentCount = events.length;
          firstTick = false;
        } else if (events.length > sentCount) {
          res.write(`data: ${JSON.stringify(events.slice(sentCount))}\n\n`);
          sentCount = events.length;
        }
      };
      void send();
      const interval = setInterval(() => void send(), 1_000);
      req.on("close", () => clearInterval(interval));
      return;
    }

    if (url.pathname === "/events/sessions") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "Access-Control-Allow-Origin": "*",
      });
      const send = () => {
        const state = rebuildSessionState(dir);
        res.write(`data: ${JSON.stringify(state)}\n\n`);
      };
      send();
      const interval = setInterval(send, 1_000);
      req.on("close", () => clearInterval(interval));
      return;
    }

    if (url.pathname === "/events") {
      const wf = url.searchParams.get("workflow") ?? workflow;
      const date = url.searchParams.get("date") ?? "";
      const today = dateLocal();
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "Access-Control-Allow-Origin": "*",
      });
      const send = () => {
        // `raw` holds every JSONL record for this workflow/date, including the
        // pending/running/done/failed chain per (itemId, runId). We need the
        // full chain for stepDurations; useEntries dedupes to the latest per id
        // on the frontend.
        const raw = (date && date !== today)
          ? readEntriesForDate(wf, date, dir)
          : readEntries(wf, dir);
        const entries = raw;

        // Enrich entries with per-run log-derived timestamps for accurate elapsed
        const logs = (date && date !== today)
          ? readLogEntriesForDate(wf, undefined, date, dir)
          : readLogEntries(wf, undefined, dir);
        // Key: "itemId::runId" — logs without runId are assigned to run #1
        const logFirst = new Map<string, string>();
        const logLast = new Map<string, string>();
        const logLastMsg = new Map<string, string>();
        for (const l of logs) {
          const rid = l.runId || `${l.itemId}#1`;
          const key = `${l.itemId}::${rid}`;
          if (!logFirst.has(key)) logFirst.set(key, l.ts);
          logLast.set(key, l.ts);
          logLastMsg.set(key, l.message);
        }

        // Compute step durations per (itemId, runId) from the full JSONL
        // history, not the deduped view. Each entry in `entries` inherits
        // the durations for its own run.
        const runHistory = new Map<string, StepDurationEntry[]>();
        for (const e of entries) {
          const rid = e.runId || `${e.id}#1`;
          const key = `${e.id}::${rid}`;
          const bucket = runHistory.get(key);
          const slim: StepDurationEntry = { timestamp: e.timestamp, status: e.status, step: e.step };
          if (bucket) bucket.push(slim);
          else runHistory.set(key, [slim]);
        }
        const stepDurationsByRun = new Map<string, Record<string, number>>();
        for (const [key, rows] of runHistory) {
          stepDurationsByRun.set(key, computeStepDurations(rows));
        }

        // Per-item run timelines: ordinal + tracker-span. Enrichment below
        // folds `earliestTrackerTs` into firstLogTs and `latestTrackerTs`
        // into lastLogTs so the header Elapsed timer and queue-row elapsed
        // both anchor at the run's REAL start (which for batch items is
        // the synthetic auth running entry, pre-handler). This makes the
        // step pipeline tile elapsed exactly — sum(stepDurations) ≡
        // (lastLogTs - firstLogTs). See RunTimeline JSDoc for why.
        const entriesByItem = new Map<string, TrackerEntry[]>();
        for (const e of entries) {
          const arr = entriesByItem.get(e.id) ?? [];
          arr.push(e);
          entriesByItem.set(e.id, arr);
        }
        const timelinesByItem = new Map<string, Map<string, RunTimeline>>();
        for (const [itemId, rows] of entriesByItem) {
          timelinesByItem.set(itemId, buildRunTimelines(rows));
        }

        // Screenshot count for failed entries — counted once per (wf, itemId)
        // pair so repeat lookups in the loop don't hit the FS N times.
        const screenshotCountByItem = new Map<string, number>();
        const screenshotsHandler = buildScreenshotsHandler();

        const enriched = entries.map((e) => {
          const rid = e.runId || `${e.id}#1`;
          const key = `${e.id}::${rid}`;
          let screenshotCount: number | undefined;
          if (e.status === "failed") {
            const sKey = `${e.workflow}::${e.id}`;
            let c = screenshotCountByItem.get(sKey);
            if (c === undefined) {
              try {
                c = screenshotsHandler(e.workflow, e.id).length;
              } catch {
                c = 0;
              }
              screenshotCountByItem.set(sKey, c);
            }
            screenshotCount = c;
          }
          // Fold the tracker-span into firstLogTs/lastLogTs so the frontend
          // reads a single "run start → now" window that includes the
          // synthetic auth entries (batch mode) or the pending entry (single
          // mode). Min/max across both sources keeps legacy log-only runs
          // behaving the same.
          const timeline = timelinesByItem.get(e.id)?.get(rid);
          const logFirstTs = logFirst.get(key);
          const logLastTs = logLast.get(key);
          const trackerFirstTs = timeline?.earliestTrackerTs;
          const trackerLastTs = timeline?.latestTrackerTs;
          const spanFirstTs = pickEarlier(logFirstTs, trackerFirstTs);
          const spanLastTs = pickLater(logLastTs, trackerLastTs);

          return {
            ...e,
            firstLogTs: spanFirstTs,
            lastLogTs: spanLastTs,
            lastLogMessage: logLastMsg.get(key),
            stepDurations: stepDurationsByRun.get(key) ?? {},
            ...(timeline ? { runOrdinal: timeline.ordinal } : {}),
            ...(screenshotCount !== undefined ? { screenshotCount } : {}),
          };
        });

        const workflows = listWorkflows(dir);
        // Count unique items per workflow for dropdown badges, scoped to the
        // selected date. Dedupe by `id` so multiple runs of the same item
        // (retries) collapse into one — the operator wants "how many distinct
        // subjects on this date," not "how many attempts." Using readEntries(w)
        // — which only reads today's file — would show 0 when viewing a past
        // date, even if that date had real activity.
        const wfCounts: Record<string, number> = {};
        const failureCounts: Record<string, number> = {};
        const targetDate = date || today;
        for (const w of workflows) {
          const all = readEntriesForDate(w, targetDate, dir);
          // Dedupe by id and exclude resolved prep rows (operator-approved
          // or operator-discarded) so the sidebar badge stays in sync with
          // QueuePanel's visible-entries filter.
          const latestById = new Map<string, TrackerEntry>();
          for (const e of all) {
            const prev = latestById.get(e.id);
            if (!prev || prev.timestamp <= e.timestamp) latestById.set(e.id, e);
          }
          let count = 0;
          for (const e of latestById.values()) {
            if (isResolvedPrepEntry(e)) continue;
            count++;
          }
          wfCounts[w] = count;
          const n = computeFailureCounts(all);
          if (n > 0) failureCounts[w] = n;
        }
        res.write(`data: ${JSON.stringify({ entries: enriched, workflows, wfCounts, failureCounts })}\n\n`);

        // After each poll, scan for repeated-failure patterns. Fire-and-forget
        // — the SSE response doesn't wait on it, and scanFailurePatterns
        // swallows its own errors so a notification glitch can't derail the
        // cycle.
        void scanFailurePatterns();
        // Safety net for queued items whose daemon died without running its
        // own orphan-queue cleanup (force-kill, OS crash). Marks them failed
        // so pending rows don't stick. Idempotent + cheap when queues are
        // empty.
        void scanOrphanedQueueItems(dir);
      };
      send();
      const interval = setInterval(send, 1_000);
      req.on("close", () => clearInterval(interval));
      return;
    }

    if (url.pathname === "/api/runs") {
      const wf = url.searchParams.get("workflow") ?? workflow;
      const id = url.searchParams.get("id") ?? "";
      const date = url.searchParams.get("date") ?? undefined;
      res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });

      // Attach per-run step durations, a single timeline span (covers both
      // the synthetic auth tracker entries and the handler's log lines), and
      // a chronological ordinal so the UI labels runs consistently even for
      // UUID-format runIds. Both shapes ({id}#N, UUID) share the SAME
      // ordinal-assignment rule — see `buildRunTimelines`.
      const runs = readRunsForId(wf, id, date, dir);

      const allForItem = date
        ? readEntriesForDate(wf, date, dir).filter((e) => e.id === id)
        : readEntries(wf, dir).filter((e) => e.id === id);
      const historyByRun = new Map<string, StepDurationEntry[]>();
      for (const e of allForItem) {
        const rid = e.runId || `${e.id}#1`;
        const bucket = historyByRun.get(rid);
        const slim: StepDurationEntry = { timestamp: e.timestamp, status: e.status, step: e.step };
        if (bucket) bucket.push(slim);
        else historyByRun.set(rid, [slim]);
      }

      const timelines = buildRunTimelines(allForItem);

      const allLogs = date
        ? readLogEntriesForDate(wf, id, date, dir)
        : readLogEntries(wf, id, dir);
      const logFirst = new Map<string, string>();
      const logLast = new Map<string, string>();
      for (const l of allLogs) {
        const rid = l.runId || `${l.itemId}#1`;
        if (!logFirst.has(rid)) logFirst.set(rid, l.ts);
        logLast.set(rid, l.ts);
      }

      const enrichedRuns = runs.map((r) => {
        const timeline = timelines.get(r.runId);
        return {
          ...r,
          stepDurations: computeStepDurations(historyByRun.get(r.runId) ?? []),
          firstLogTs: pickEarlier(logFirst.get(r.runId), timeline?.earliestTrackerTs),
          lastLogTs: pickLater(logLast.get(r.runId), timeline?.latestTrackerTs),
          ...(timeline ? { runOrdinal: timeline.ordinal } : {}),
        };
      });
      res.end(JSON.stringify(enrichedRuns));
      return;
    }

    if (url.pathname === "/api/screenshots") {
      const wf = url.searchParams.get("workflow") ?? workflow;
      const id = url.searchParams.get("itemId") ?? url.searchParams.get("id") ?? "";
      res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      if (!wf || !id) {
        res.end(JSON.stringify([]));
        return;
      }
      try {
        const groupedHandler = buildScreenshotsHandler({ dir, screenshotsDir: SCREENSHOTS_DIR });
        const list = await groupedHandler({ workflow: wf, itemId: id });
        res.end(JSON.stringify(list));
      } catch {
        res.end(JSON.stringify([]));
      }
      return;
    }

    if (url.pathname === "/api/search") {
      const q = url.searchParams.get("q") ?? "";
      const wf = url.searchParams.get("workflow") ?? undefined;
      const limitRaw = url.searchParams.get("limit");
      const daysRaw = url.searchParams.get("days");
      const parsedLimit = limitRaw ? Number.parseInt(limitRaw, 10) : NaN;
      const parsedDays = daysRaw ? Number.parseInt(daysRaw, 10) : NaN;
      const limit = Number.isFinite(parsedLimit) && parsedLimit > 0 ? parsedLimit : 50;
      const days = Number.isFinite(parsedDays) && parsedDays > 0 ? parsedDays : 30;
      res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      try {
        const handler = buildSearchHandler({
          listWorkflows,
          listDates: listDatesForWorkflow,
          readEntriesForDate,
        });
        const rows = handler(q, { workflow: wf, limit, days });
        res.end(JSON.stringify(rows));
      } catch {
        res.end(JSON.stringify([]));
      }
      return;
    }

    if (url.pathname === "/api/preview-inbox") {
      res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      try {
        const handler = buildPreviewInboxHandler({
          listWorkflows: () => listWorkflows(dir),
          listDates: (wf) => listDatesForWorkflow(wf, dir),
          readEntriesForDate: (wf, date) => readEntriesForDate(wf, date, dir),
        });
        const rows = handler();
        res.end(JSON.stringify(rows));
      } catch {
        res.end(JSON.stringify([]));
      }
      return;
    }

    if (url.pathname === "/api/failures") {
      const dateParam = url.searchParams.get("date");
      if (!dateParam || !/^\d{4}-\d{2}-\d{2}$/.test(dateParam)) {
        res.writeHead(400, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
        res.end(JSON.stringify({ error: "Missing or invalid `date` query param (expected YYYY-MM-DD)" }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      try {
        const handler = buildFailuresHandler({
          listWorkflows: () => listWorkflows(dir),
          readEntriesForDate: (wf, date) => readEntriesForDate(wf, date, dir),
        });
        const rows = handler({ date: dateParam });
        res.end(JSON.stringify(rows));
      } catch {
        res.end(JSON.stringify([]));
      }
      return;
    }

    if (url.pathname === "/api/selector-warnings") {
      const daysParam = url.searchParams.get("days");
      const parsed = daysParam ? Number.parseInt(daysParam, 10) : 7;
      const days = Number.isFinite(parsed) && parsed > 0 ? parsed : 7;
      res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      try {
        const rows = buildSelectorWarningsHandler()(days);
        res.end(JSON.stringify(rows));
      } catch {
        res.end(JSON.stringify([]));
      }
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/prep/pdf-page") {
      const wf = url.searchParams.get("workflow") ?? "";
      const parentRunId = url.searchParams.get("parentRunId") ?? "";
      const page = parseInt(url.searchParams.get("page") ?? "0", 10);

      if (!/^[a-z0-9-]+$/.test(wf) || wf.length > 64) {
        res.writeHead(400, { "Access-Control-Allow-Origin": "*" });
        res.end("invalid workflow");
        return;
      }
      if (!/^[A-Za-z0-9._@#-]+$/.test(parentRunId) || parentRunId.length > 256) {
        res.writeHead(400, { "Access-Control-Allow-Origin": "*" });
        res.end("invalid parentRunId");
        return;
      }
      if (!Number.isFinite(page) || page < 1 || page > 9999) {
        res.writeHead(400, { "Access-Control-Allow-Origin": "*" });
        res.end("invalid page");
        return;
      }

      const filename = `page-${String(page).padStart(2, "0")}.png`;
      const safeBase = resolve(process.cwd(), ".tracker", "uploads", parentRunId);
      const safePath = resolve(safeBase, filename);
      if (!safePath.startsWith(safeBase + sep)) {
        res.writeHead(400, { "Access-Control-Allow-Origin": "*" });
        res.end("path traversal");
        return;
      }
      try {
        const stat = await statAsync(safePath);
        res.writeHead(200, {
          "Content-Type": "image/png",
          "Content-Length": stat.size,
          "Cache-Control": "public, max-age=86400",
          "Access-Control-Allow-Origin": "*",
        });
        createReadStream(safePath).pipe(res);
      } catch {
        res.writeHead(404, { "Access-Control-Allow-Origin": "*" });
        res.end("not found");
      }
      return;
    }

    if (url.pathname.startsWith("/screenshots/")) {
      const filename = decodeURIComponent(url.pathname.slice("/screenshots/".length));
      const resolved = resolveScreenshotPath(filename);
      if (!resolved) {
        res.writeHead(404, { "Access-Control-Allow-Origin": "*" });
        res.end("Not found");
        return;
      }
      try {
        const size = (await statAsync(resolved)).size;
        res.writeHead(200, {
          "Content-Type": "image/png",
          "Content-Length": size,
          "Cache-Control": "no-cache",
          "Access-Control-Allow-Origin": "*",
        });
        createReadStream(resolved).pipe(res);
      } catch {
        res.writeHead(500, { "Access-Control-Allow-Origin": "*" });
        res.end("Error reading file");
      }
      return;
    }

    if (
      req.method === "GET" &&
      url.pathname === "/api/sharepoint-download/list"
    ) {
      const list = buildSharePointListHandler()();
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      });
      res.end(JSON.stringify(list));
      return;
    }

    if (
      req.method === "GET" &&
      url.pathname === "/api/sharepoint-download/status"
    ) {
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      });
      res.end(JSON.stringify(getSharePointDownloadStatus()));
      return;
    }

    if (
      req.method === "POST" &&
      url.pathname === "/api/sharepoint-download/run"
    ) {
      const handler = buildSharePointRosterDownloadHandler();
      try {
        // Inline body parse — the only POST route on this server that takes
        // a JSON body. A full body-parser middleware would be overkill.
        const chunks: Buffer[] = [];
        for await (const chunk of req) {
          chunks.push(chunk as Buffer);
          if (Buffer.concat(chunks).byteLength > 4096) {
            throw new Error("Request body too large");
          }
        }
        const raw = Buffer.concat(chunks).toString("utf8").trim();
        let input: { id?: string } = {};
        if (raw) {
          try {
            input = JSON.parse(raw) as { id?: string };
          } catch {
            res.writeHead(400, {
              "Content-Type": "application/json",
              "Access-Control-Allow-Origin": "*",
            });
            res.end(JSON.stringify({ ok: false, error: "Invalid JSON body" }));
            return;
          }
        }
        const { status, body } = await handler(input);
        res.writeHead(status, {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        });
        res.end(JSON.stringify(body));
      } catch (e) {
        res.writeHead(500, {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        });
        res.end(JSON.stringify({ ok: false, error: errorMessage(e) }));
      }
      return;
    }

    if (
      req.method === "POST" &&
      url.pathname === "/api/enqueue"
    ) {
      // Generic enqueue-to-daemon-queue endpoint for the dashboard Run
      // panel. Body: { workflow: string, inputs: object[] } — each input
      // is a typed workflow-input (e.g. {docId} for separations). Spawns
      // one daemon if none are alive (Duo prompt in operator's browser);
      // otherwise just appends to the shared queue and wakes alive
      // daemons. Returns 202 with {ok, workflow, enqueued}.
      try {
        const chunks: Buffer[] = [];
        for await (const chunk of req) {
          chunks.push(chunk as Buffer);
          // 64 KB cap — an enqueue body is just the workflow name + a
          // list of small input objects; anything larger is almost
          // certainly a bug or abuse.
          if (Buffer.concat(chunks).byteLength > 65_536) {
            throw new Error("Request body too large");
          }
        }
        const raw = Buffer.concat(chunks).toString("utf8").trim();
        let input: { workflow?: string; inputs?: unknown[] } = {};
        if (raw) {
          try {
            input = JSON.parse(raw) as { workflow?: string; inputs?: unknown[] };
          } catch {
            res.writeHead(400, {
              "Content-Type": "application/json",
              "Access-Control-Allow-Origin": "*",
            });
            res.end(JSON.stringify({ ok: false, error: "Invalid JSON body" }));
            return;
          }
        }
        const workflow = input.workflow?.trim();
        if (!workflow) {
          res.writeHead(400, {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          });
          res.end(JSON.stringify({ ok: false, error: "workflow is required" }));
          return;
        }
        if (!Array.isArray(input.inputs) || input.inputs.length === 0) {
          res.writeHead(400, {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          });
          res.end(JSON.stringify({ ok: false, error: "inputs must be a non-empty array" }));
          return;
        }
        // Pre-validate synchronously so schema / unknown-workflow errors
        // surface as 400s. After that, fire-and-forget the actual
        // enqueue+spawn — first-invocation spawn can wait up to 5min for
        // Duo auth, and we don't want the HTTP connection open that long
        // (matches the sharepoint-download/run fire-and-forget pattern).
        const validation = await validateEnqueueRequest(workflow, input.inputs);
        if (!validation.ok) {
          res.writeHead(400, {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          });
          res.end(JSON.stringify({ ok: false, workflow, enqueued: 0, error: validation.error }));
          return;
        }
        const enqueueInputs = input.inputs;
        void enqueueFromHttp(workflow, enqueueInputs, dir).catch((err) => {
          // Background task — log only. Pending tracker rows will already
          // be on disk by this point (onPreEmitPending fires after the
          // fast enqueueItems step); only the subsequent spawn/wake can
          // realistically fail here.
          // eslint-disable-next-line no-console
          console.error(`[POST /api/enqueue] background task failed: ${errorMessage(err)}`);
        });
        res.writeHead(202, {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        });
        res.end(JSON.stringify({
          ok: true,
          workflow,
          enqueued: enqueueInputs.length,
        }));
      } catch (e) {
        res.writeHead(500, {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        });
        res.end(JSON.stringify({ ok: false, error: errorMessage(e) }));
      }
      return;
    }

    if (
      req.method === "POST" &&
      url.pathname === "/api/daemon/stop"
    ) {
      // Stop everything we can identify as "this workflow":
      //   1. Alive daemons → POST /stop (soft drain, or hard exit if force).
      //   2. Non-daemon Node processes whose `workflow_start` is still
      //      active+pidAlive (legacy `:direct` runs, or daemons whose
      //      lockfile was unlinked but whose process is still wedged in
      //      auth) → SIGTERM (soft) or SIGKILL (force).
      // Daemon pids are excluded from the signal pass so we don't double-hit
      // them after the HTTP /stop is already in flight. SIGKILL won't reap
      // orphaned Chromium children — the OS will eventually, but a stale
      // browser window may need a manual close.
      try {
        const chunks: Buffer[] = [];
        for await (const chunk of req) {
          chunks.push(chunk as Buffer);
          if (Buffer.concat(chunks).byteLength > 4096) {
            throw new Error("Request body too large");
          }
        }
        const raw = Buffer.concat(chunks).toString("utf8").trim();
        let input: { workflow?: string; force?: boolean } = {};
        if (raw) {
          try {
            input = JSON.parse(raw) as { workflow?: string; force?: boolean };
          } catch {
            res.writeHead(400, {
              "Content-Type": "application/json",
              "Access-Control-Allow-Origin": "*",
            });
            res.end(JSON.stringify({ ok: false, error: "Invalid JSON body" }));
            return;
          }
        }
        const workflow = input.workflow?.trim();
        if (!workflow) {
          res.writeHead(400, {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          });
          res.end(JSON.stringify({ ok: false, error: "workflow is required" }));
          return;
        }
        const force = input.force === true;

        const aliveDaemons = await findAliveDaemons(workflow, dir);
        const daemonPids = new Set(aliveDaemons.map((d) => d.pid));
        const daemonsStopped = await stopDaemons(workflow, force, dir);

        const events = dir ? readSessionEvents(dir) : readSessionEvents();
        const startsByInstance = new Map<string, SessionEvent>();
        const endedInstances = new Set<string>();
        // Active browser_launch chromiumPids per instance — killed alongside
        // the parent so we don't leak Chromium windows. macOS doesn't reap
        // orphans from SIGKILL'd Node parents the way Linux's prctl path does.
        const browserPidsByInstance = new Map<string, Set<number>>();
        for (const e of events) {
          if (!e.workflowInstance) continue;
          if (workflowNameFromInstance(e.workflowInstance) !== workflow) continue;
          if (e.type === "workflow_start") startsByInstance.set(e.workflowInstance, e);
          if (e.type === "workflow_end") endedInstances.add(e.workflowInstance);
          if (e.type === "browser_launch" && typeof e.chromiumPid === "number") {
            const set = browserPidsByInstance.get(e.workflowInstance) ?? new Set<number>();
            set.add(e.chromiumPid);
            browserPidsByInstance.set(e.workflowInstance, set);
          }
          if (e.type === "browser_close" && e.workflowInstance) {
            // No chromiumPid on close events today, but the instance's
            // browser_close means the browser is gone — drop everything for
            // that instance to avoid signalling an already-recycled pid.
            // Soft heuristic: only drop on unambiguous full-close (no system).
            // Per-system close events still leave us erring on the side of
            // signalling, which on a stale pid is a no-op.
          }
        }
        const ownPid = process.pid;
        const signal: NodeJS.Signals = force ? "SIGKILL" : "SIGTERM";
        let processesKilled = 0;
        let browsersKilled = 0;
        const killedInstances: string[] = [];

        // Pid set we're about to signal at the Node-parent level. Used to
        // skip browser kills for instances whose parent we DIDN'T touch
        // (those are presumed alive and managing their own browser lifetime).
        const targetedInstances = new Set<string>();
        for (const [instance, startEv] of startsByInstance) {
          if (endedInstances.has(instance)) continue;
          const pid = startEv.pid;
          if (!pid || pid === ownPid) continue;
          if (daemonPids.has(pid)) {
            // Daemons handle their own teardown via /stop. We still want
            // their orphaned Chromium killed on force, so include the
            // instance in targetedInstances below.
            if (force) targetedInstances.add(instance);
            continue;
          }
          try { process.kill(pid, 0); } catch { continue; }
          try {
            process.kill(pid, signal);
            processesKilled += 1;
            killedInstances.push(instance);
            targetedInstances.add(instance);
          } catch (e) {
            log.warn(
              `[/api/daemon/stop] failed to ${signal} pid=${pid} instance='${instance}': ${errorMessage(e)}`,
            );
          }
        }

        // Force-kill orphaned Chromium for every targeted instance. Soft
        // stop assumes the parent will close its own browsers during drain.
        if (force) {
          for (const instance of targetedInstances) {
            const pids = browserPidsByInstance.get(instance);
            if (!pids) continue;
            for (const cPid of pids) {
              try { process.kill(cPid, 0); } catch { continue; }
              try {
                process.kill(cPid, "SIGKILL");
                browsersKilled += 1;
              } catch (e) {
                log.warn(
                  `[/api/daemon/stop] failed to SIGKILL chromium pid=${cPid} instance='${instance}': ${errorMessage(e)}`,
                );
              }
            }
          }
        }

        if (processesKilled > 0) {
          log.step(
            `[/api/daemon/stop] ${signal} sent to ${processesKilled} non-daemon ${workflow} process(es): ${killedInstances.join(", ")}`,
          );
        }
        if (browsersKilled > 0) {
          log.step(
            `[/api/daemon/stop] SIGKILL'd ${browsersKilled} orphaned Chromium process(es) for ${workflow}`,
          );
        }

        // Phantom-instance cleanup: any `workflow_start` whose pid is dead
        // AND has no matching `workflow_end` is an orphaned SessionPanel
        // box the user can't otherwise dismiss (the daemon was force-killed
        // / OS-crashed before its withBatchLifecycle could emit
        // `workflow_end`). Synthesize a `workflow_end(failed)` per phantom
        // so the SessionPanel filters them out on the next /events tick.
        // This runs unconditionally on every stop click — when the user
        // hits X they want it gone, regardless of whether a real process
        // was found to kill.
        let phantomsCleared = 0;
        for (const [instance, startEv] of startsByInstance) {
          if (endedInstances.has(instance)) continue;
          const pid = startEv.pid;
          // Skip dashboard's own pid — those are in-process workflows
          // (e.g. sharepoint-download) tracked via `finalStatus` instead.
          if (!pid || pid === ownPid) continue;
          // If the process is alive, leave it alone. The signal pass above
          // already targeted it; emitting a fake workflow_end here would
          // race the daemon's real workflow_end during graceful drain.
          let alive = false;
          try { process.kill(pid, 0); alive = true; } catch { /* dead */ }
          if (alive) continue;
          try {
            emitWorkflowEnd(instance, "failed", dir);
            phantomsCleared += 1;
          } catch (e) {
            log.warn(
              `[/api/daemon/stop] failed to synthesize workflow_end for phantom '${instance}': ${errorMessage(e)}`,
            );
          }
        }
        if (phantomsCleared > 0) {
          log.step(
            `[/api/daemon/stop] cleared ${phantomsCleared} phantom ${workflow} instance(s) from SessionPanel`,
          );
        }

        // Force-stop also clears the queue: with daemons killed, queued items
        // would otherwise sit forever (or get picked up by a future daemon
        // unexpectedly). Soft stop preserves the queue so a draining daemon
        // can keep working it. Cancel reuses the same per-id handler that the
        // dashboard's X button uses — appends a `failed` queue event + emits
        // a `failed` tracker row with `step: "cancelled"`.
        let queuedCancelled = 0;
        if (force) {
          try {
            const state = await readQueueState(workflow, dir);
            const cancelHandler = buildCancelQueuedHandler(dir);
            for (const item of state.queued) {
              const result = await cancelHandler({ workflow, id: item.id });
              if (result.ok) queuedCancelled += 1;
            }
            if (queuedCancelled > 0) {
              log.step(
                `[/api/daemon/stop] cancelled ${queuedCancelled} queued ${workflow} item(s) on force-stop`,
              );
            }
          } catch (e) {
            log.warn(
              `[/api/daemon/stop] failed to cancel queued items: ${errorMessage(e)}`,
            );
          }
        }

        res.writeHead(200, {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        });
        res.end(JSON.stringify({
          ok: true,
          workflow,
          force,
          stopped: daemonsStopped + processesKilled,
          daemonsStopped,
          processesKilled,
          browsersKilled,
          queuedCancelled,
          phantomsCleared,
        }));
      } catch (e) {
        res.writeHead(500, {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        });
        res.end(JSON.stringify({ ok: false, error: errorMessage(e) }));
      }
      return;
    }

    // ============================================================
    // Dashboard ops endpoints — retry, edit-and-resume, queue
    // mutations, daemon ops. All workflow-agnostic; each takes
    // `workflow` in the body / query and operates on tracker / queue
    // / daemon-registry files keyed by that workflow.
    // ============================================================

    /**
     * Read & parse a JSON body off the request, with a hard size cap to
     * keep the SSE server from being swamped by an unbounded POST. Used
     * by every operations endpoint below.
     */
    const readJsonBody = async (
      maxBytes = 64_536,
    ): Promise<{ ok: true; body: Record<string, unknown> } | { ok: false; error: string }> => {
      try {
        const chunks: Buffer[] = [];
        for await (const chunk of req) {
          chunks.push(chunk as Buffer);
          if (Buffer.concat(chunks).byteLength > maxBytes) {
            return { ok: false, error: "Request body too large" };
          }
        }
        const raw = Buffer.concat(chunks).toString("utf8").trim();
        if (!raw) return { ok: true, body: {} };
        return { ok: true, body: JSON.parse(raw) as Record<string, unknown> };
      } catch {
        return { ok: false, error: "Invalid JSON body" };
      }
    };

    const writeJson = (statusCode: number, body: unknown): void => {
      res.writeHead(statusCode, {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      });
      res.end(JSON.stringify(body));
    };

    // ─── OCR endpoints ─────────────────────────────────────────
    //   GET  /api/ocr/forms           → form-type registry listing
    //   POST /api/ocr/prepare         → multipart PDF upload, kicks off OCR
    //   POST /api/ocr/reupload        → same as prepare but marks previous run superseded
    //   POST /api/ocr/approve-batch   → fan out reviewed records to downstream daemons
    //   POST /api/ocr/discard-prepare → cancel a pending OCR row
    //   POST /api/ocr/force-research  → re-run eid-lookup for selected records
    //   POST /api/ocr/retry-page      → re-OCR a single failed page
    //   POST /api/ocr/reocr-whole-pdf → re-OCR the entire PDF for a session

    if (req.method === "GET" && url.pathname === "/api/ocr/forms") {
      try {
        writeJson(200, ocrFormsHandler());
      } catch (e) {
        writeJson(500, { ok: false, error: errorMessage(e) });
      }
      return;
    }

    if (req.method === "POST" && (url.pathname === "/api/ocr/prepare" || url.pathname === "/api/ocr/reupload")) {
      const isReupload = url.pathname === "/api/ocr/reupload";
      const mp = await readMultipart(req, 50 * 1024 * 1024);
      if (!mp.ok) return writeJson(400, { ok: false, error: mp.error });
      const file = mp.parsed.files["pdf"];
      if (!file) return writeJson(400, { ok: false, error: "missing 'pdf' file part" });

      // Save PDF to uploads dir.
      const { mkdirSync, writeFileSync } = await import("node:fs");
      const { join: pathJoin } = await import("node:path");
      const { randomUUID } = await import("node:crypto");
      const uploadsDir = pathJoin(dir, "uploads");
      mkdirSync(uploadsDir, { recursive: true });
      const pdfFilename = `${randomUUID()}.pdf`;
      const pdfPath = pathJoin(uploadsDir, pdfFilename);
      writeFileSync(pdfPath, file.data);

      const fields = mp.parsed.fields;
      const formType = fields["formType"]?.trim() ?? "";
      const rosterMode = (fields["rosterMode"]?.trim() ?? "existing") as "existing" | "download";
      const rosterPath = fields["rosterPath"]?.trim() || undefined;
      const sessionId = fields["sessionId"]?.trim() || undefined;
      const previousRunId = fields["previousRunId"]?.trim() || undefined;

      const result = await ocrPrepareHandler({
        pdfPath,
        pdfOriginalName: file.filename ?? pdfFilename,
        formType,
        rosterMode,
        rosterPath,
        sessionId,
        previousRunId,
        isReupload,
      });
      writeJson(result.status, result.body);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/ocr/approve-batch") {
      const parsedBody = await readJsonBody(1024 * 1024);
      if (!parsedBody.ok) return writeJson(400, { ok: false, error: parsedBody.error });
      const result = await ocrApproveHandler({
        sessionId: String(parsedBody.body.sessionId ?? ""),
        runId: String(parsedBody.body.runId ?? ""),
        records: Array.isArray(parsedBody.body.records) ? parsedBody.body.records : [],
      });
      writeJson(result.status, result.body);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/ocr/discard-prepare") {
      const parsedBody = await readJsonBody(4096);
      if (!parsedBody.ok) return writeJson(400, { ok: false, error: parsedBody.error });
      const result = await ocrDiscardHandler({
        sessionId: String(parsedBody.body.sessionId ?? ""),
        runId: String(parsedBody.body.runId ?? ""),
        reason: parsedBody.body.reason ? String(parsedBody.body.reason) : undefined,
      });
      writeJson(result.status, result.body);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/ocr/force-research") {
      const parsedBody = await readJsonBody(4096);
      if (!parsedBody.ok) return writeJson(400, { ok: false, error: parsedBody.error });
      const result = await ocrForceResearchHandler({
        sessionId: String(parsedBody.body.sessionId ?? ""),
        runId: String(parsedBody.body.runId ?? ""),
        recordIndices: Array.isArray(parsedBody.body.recordIndices)
          ? parsedBody.body.recordIndices.map(Number)
          : [],
      });
      writeJson(result.status, result.body);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/ocr/retry-page") {
      const parsedBody = await readJsonBody(4096);
      if (!parsedBody.ok) return writeJson(400, { ok: false, error: parsedBody.error });
      const result = await ocrRetryPageHandler({
        sessionId: String(parsedBody.body.sessionId ?? ""),
        runId: String(parsedBody.body.runId ?? ""),
        pageNum: Number(parsedBody.body.pageNum ?? 0),
      });
      writeJson(result.status, result.body);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/ocr/reocr-whole-pdf") {
      const parsedBody = await readJsonBody(4096);
      if (!parsedBody.ok) return writeJson(400, { ok: false, error: parsedBody.error });
      const result = await ocrReocrWholePdfHandler({
        sessionId: String(parsedBody.body.sessionId ?? ""),
        runId: String(parsedBody.body.runId ?? ""),
      });
      writeJson(result.status, result.body);
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/oath-upload/check-duplicate") {
      const hash = url.searchParams.get("hash") ?? "";
      const lookbackDays = url.searchParams.get("lookbackDays")
        ? Number(url.searchParams.get("lookbackDays"))
        : undefined;
      const r = await oathUploadDupCheckHandler({ hash, lookbackDays });
      writeJson(r.status, r.body);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/oath-upload/cancel") {
      const parsed = await readJsonBody(4096);
      if (!parsed.ok) return writeJson(400, { ok: false, error: parsed.error });
      const r = await oathUploadCancelHandler({
        sessionId: String(parsed.body.sessionId ?? ""),
        runId: parsed.body.runId ? String(parsed.body.runId) : undefined,
        reason: parsed.body.reason ? String(parsed.body.reason) : undefined,
      });
      writeJson(r.status, r.body);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/oath-upload/start") {
      const mp = await readMultipart(req, 50 * 1024 * 1024);
      if (!mp.ok) return writeJson(400, { ok: false, error: mp.error });
      const file = mp.parsed.files["pdf"];
      if (!file) return writeJson(400, { ok: false, error: "missing 'pdf' file part" });

      const pdfPath = await saveUploadedPdf(file.data, file.filename ?? "upload.pdf", dir);
      const { createHash } = await import("node:crypto");
      const pdfHash = createHash("sha256").update(file.data).digest("hex");
      const sessionId = mp.parsed.fields["sessionId"]?.trim() || undefined;

      // Roster: modal sends `rosterMode`; if "existing", resolve the latest
      // xlsx on disk to a `rosterPath` (same lookup as the capture flow).
      const rosterMode = (mp.parsed.fields["rosterMode"]?.trim() ?? "download") as "existing" | "download";
      let rosterPath: string | undefined;
      if (rosterMode === "existing") {
        const rosterDirs = [
          resolve(process.cwd(), ".tracker/rosters"),
          resolve(process.cwd(), "src/data"),
        ];
        const rosterDir = rosterDirs.find((d) => existsSync(d)) ?? rosterDirs[0];
        try {
          const { readdirSync } = await import("node:fs");
          const files = readdirSync(rosterDir).filter((f) => f.endsWith(".xlsx"));
          if (files.length > 0) {
            rosterPath = resolve(rosterDir, files.sort().at(-1)!);
          }
        } catch { /* tolerate */ }
      }

      const r = await oathUploadStartHandler({
        pdfPath,
        pdfOriginalName: file.filename ?? "upload.pdf",
        pdfHash,
        sessionId,
        rosterMode,
        rosterPath,
      });
      writeJson(r.status, r.body);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/retry") {
      const parsed = await readJsonBody();
      if (!parsed.ok) return writeJson(400, { ok: false, error: parsed.error });
      const result = await buildRetryHandler(dir)({
        workflow: String(parsed.body.workflow ?? ""),
        id: String(parsed.body.id ?? ""),
        runId: parsed.body.runId ? String(parsed.body.runId) : undefined,
      });
      writeJson(result.ok ? 202 : 400, result);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/retry-bulk") {
      const parsed = await readJsonBody();
      if (!parsed.ok) return writeJson(400, { ok: false, error: parsed.error });
      const ids = Array.isArray(parsed.body.ids)
        ? (parsed.body.ids as unknown[]).map(String)
        : [];
      const result = await buildRetryBulkHandler(dir)({
        workflow: String(parsed.body.workflow ?? ""),
        ids,
      });
      writeJson(202, result);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/run-with-data") {
      const parsed = await readJsonBody();
      if (!parsed.ok) return writeJson(400, { ok: false, error: parsed.error });
      const data =
        parsed.body.data && typeof parsed.body.data === "object"
          ? (parsed.body.data as Record<string, unknown>)
          : {};
      const result = await buildRunWithDataHandler(dir)({
        workflow: String(parsed.body.workflow ?? ""),
        id: String(parsed.body.id ?? ""),
        runId: parsed.body.runId ? String(parsed.body.runId) : undefined,
        data,
      });
      writeJson(result.ok ? 202 : 400, result);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/save-data") {
      const parsed = await readJsonBody();
      if (!parsed.ok) return writeJson(400, { ok: false, error: parsed.error });
      const data =
        parsed.body.data && typeof parsed.body.data === "object"
          ? (parsed.body.data as Record<string, unknown>)
          : {};
      const result = await buildSaveDataHandler(dir)({
        workflow: String(parsed.body.workflow ?? ""),
        id: String(parsed.body.id ?? ""),
        data,
      });
      writeJson(result.ok ? 200 : 400, result);
      return;
    }

    // ─── EditDataTab "Copy from prior run" lookup ─────────────
    // Returns prior tracker entries for `workflow` whose `data[keyField]`
    // matches `keyValue` (e.g. same EID across two separation doc IDs),
    // sorted newest first. The dashboard's EditDataTab uses this to offer
    // the operator a "copy these values" affordance when filling out a
    // new run for an employee who's been processed before.
    if (req.method === "GET" && url.pathname === "/api/find-prior-by-key") {
      const wf = url.searchParams.get("workflow") ?? "";
      const keyField = url.searchParams.get("keyField") ?? "";
      const keyValue = url.searchParams.get("keyValue") ?? "";
      const excludeId = url.searchParams.get("excludeId") ?? undefined;
      const days = Number.parseInt(url.searchParams.get("days") ?? "", 10);
      const result = buildFindPriorByKeyHandler(dir)({
        workflow: wf,
        keyField,
        keyValue,
        excludeId,
        days: Number.isFinite(days) ? days : undefined,
      });
      writeJson(result.ok ? 200 : 400, result);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/cancel-queued") {
      const parsed = await readJsonBody();
      if (!parsed.ok) return writeJson(400, { ok: false, error: parsed.error });
      const result = await buildCancelQueuedHandler(dir)({
        workflow: String(parsed.body.workflow ?? ""),
        id: String(parsed.body.id ?? ""),
      });
      const status = result.ok ? 200 : (result.status ?? 400);
      writeJson(status, result);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/cancel-running") {
      // Cancel-running: route to the daemon currently processing the
      // named item. Read the queue state, find the latest claim event
      // for the item, look up that daemon's port via findAliveDaemons,
      // then proxy a POST /cancel-current. Returns:
      //   200 — daemon accepted (cancel will materialize at next step)
      //   409 — itemId/runId mismatch on the daemon (claim rotated)
      //   410 — no claim event for this item, or claiming daemon dead
      const parsed = await readJsonBody();
      if (!parsed.ok) return writeJson(400, { ok: false, error: parsed.error });
      const workflow = String(parsed.body.workflow ?? "");
      const itemId = String(parsed.body.id ?? "");
      const runId = String(parsed.body.runId ?? "");
      if (!workflow || !itemId || !runId) {
        return writeJson(400, {
          ok: false,
          error: "workflow, id, runId are required",
        });
      }
      try {
        const state = await readQueueState(workflow, dir);
        const claimed = state.claimed.find((q) => q.id === itemId);
        if (!claimed || claimed.claimedBy === undefined) {
          return writeJson(410, {
            ok: false,
            error:
              "item not currently claimed by any daemon — likely already finished or never claimed",
          });
        }
        const aliveDaemons = await findAliveDaemons(workflow, dir);
        const owner = aliveDaemons.find((d) => d.instanceId === claimed.claimedBy);
        if (!owner) {
          return writeJson(410, {
            ok: false,
            error: `claiming daemon (${claimed.claimedBy}) is no longer alive`,
          });
        }
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 5_000);
        try {
          const upstream = await fetch(`http://127.0.0.1:${owner.port}/cancel-current`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ itemId, runId }),
            signal: ctrl.signal,
          });
          clearTimeout(t);
          const text = await upstream.text();
          let body: Record<string, unknown> = {};
          try {
            body = text ? JSON.parse(text) : {};
          } catch {
            body = { ok: false, error: text || "malformed daemon response" };
          }
          writeJson(upstream.status, body);
        } finally {
          clearTimeout(t);
        }
      } catch (err) {
        writeJson(502, {
          ok: false,
          error: `cancel-current proxy failed: ${errorMessage(err)}`,
        });
      }
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/queue/bump") {
      const parsed = await readJsonBody();
      if (!parsed.ok) return writeJson(400, { ok: false, error: parsed.error });
      const result = await buildQueueBumpHandler(dir)({
        workflow: String(parsed.body.workflow ?? ""),
        id: String(parsed.body.id ?? ""),
      });
      const status = result.ok ? 200 : (result.status ?? 400);
      writeJson(status, result);
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/daemons") {
      const workflow = url.searchParams.get("workflow") ?? undefined;
      const list = await buildDaemonsListHandler(dir)(workflow ?? undefined);
      writeJson(200, list);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/daemons/spawn") {
      const parsed = await readJsonBody();
      if (!parsed.ok) return writeJson(400, { ok: false, error: parsed.error });
      const count = typeof parsed.body.count === "number" ? parsed.body.count : 1;
      // Spawn is fire-and-forget — Duo can take up to 5min and we don't want
      // to hold an HTTP connection open for that long. Frontend re-polls
      // /api/daemons to discover the new daemon as it comes online.
      const handler = buildDaemonsSpawnHandler(dir);
      void handler({
        workflow: String(parsed.body.workflow ?? ""),
        count,
      }).catch((err) => {
        log.error(`[POST /api/daemons/spawn] background spawn failed: ${errorMessage(err)}`);
      });
      writeJson(202, { ok: true, queued: count });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/daemons/stop") {
      const parsed = await readJsonBody();
      if (!parsed.ok) return writeJson(400, { ok: false, error: parsed.error });
      const result = await buildDaemonsStopHandler(dir)({
        workflow: parsed.body.workflow ? String(parsed.body.workflow) : undefined,
        force: parsed.body.force === true,
      });
      writeJson(200, result);
      return;
    }

    if (req.method === "GET" && url.pathname === "/events/daemon-log") {
      const pidStr = url.searchParams.get("pid") ?? "";
      const pid = Number.parseInt(pidStr, 10);
      if (!Number.isFinite(pid) || pid <= 0) {
        return writeJson(400, { ok: false, error: "valid pid query param required" });
      }
      const path = await resolveDaemonLogPath(pid, dir);
      if (!path) {
        return writeJson(404, { ok: false, error: "no log file for that pid" });
      }
      // SSE stream of log lines. Read existing tail (last 4KB) immediately,
      // then watchFile() for appends.
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "Access-Control-Allow-Origin": "*",
      });
      let bytesSent = 0;
      try {
        const stat = statSync(path);
        const tailBytes = Math.min(stat.size, 4096);
        const startAt = Math.max(0, stat.size - tailBytes);
        const stream = createReadStream(path, { start: startAt, end: stat.size });
        for await (const chunk of stream) {
          for (const line of String(chunk).split("\n")) {
            if (!line) continue;
            res.write(`data: ${JSON.stringify({ line, ts: new Date().toISOString() })}\n\n`);
          }
        }
        bytesSent = stat.size;
      } catch {
        /* ignore — file may be empty */
      }
      const onChange = (curr: { size: number }): void => {
        if (curr.size <= bytesSent) return;
        try {
          const stream = createReadStream(path, { start: bytesSent, end: curr.size });
          let buffered = "";
          stream.on("data", (chunk) => {
            buffered += String(chunk);
          });
          stream.on("end", () => {
            for (const line of buffered.split("\n")) {
              if (!line) continue;
              res.write(`data: ${JSON.stringify({ line, ts: new Date().toISOString() })}\n\n`);
            }
            bytesSent = curr.size;
          });
        } catch {
          /* ignore */
        }
      };
      watchFile(path, { interval: 500 }, onChange);
      req.on("close", () => {
        unwatchFile(path, onChange);
        res.end();
      });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/queue-depth") {
      // Per-workflow queue depth. Used by TopBar's queue-depth pill.
      // Returns: { [workflow]: number }
      const workflows = listWorkflows(dir);
      const result: Record<string, number> = {};
      for (const wf of workflows) {
        result[wf] = readQueueDepth(wf, dir);
      }
      writeJson(200, result);
      return;
    }

    if (url.pathname === "/api/preflight") {
      // 30-day floor so the operator always has at least the last month
      // of workflow history + screenshots available for retro investigation.
      const deleted = cleanOldTrackerFiles(30, dir);
      const deletedShots = cleanOldScreenshots(30);

      // Only delete sessions.jsonl if it hasn't been touched for >24h (truly stale).
      // Stale workflows from crashed processes are handled by rebuildSessionState
      // which marks dead-PID workflows as inactive at read time — no file mutation needed.
      let sessionsCleaned = false;
      const sessPath = getSessionsFilePath(dir);
      if (existsSync(sessPath)) {
        const ageMs = Date.now() - statSync(sessPath).mtimeMs;
        if (ageMs > 24 * 60 * 60 * 1000) {
          unlinkSync(sessPath);
          sessionsCleaned = true;
        }
      }

      const checks = [
        { name: "Dashboard connected", passed: true, detail: "SSE server running" },
        { name: "Old logs cleaned", passed: true, detail: `${deleted} file${deleted !== 1 ? "s" : ""} removed (> 30 days)` },
        { name: "Old screenshots cleaned", passed: true, detail: `${deletedShots} screenshot${deletedShots !== 1 ? "s" : ""} removed (> 30 days)` },
        { name: "Session state", passed: true, detail: sessionsCleaned ? "Stale session file cleaned" : "OK" },
      ];
      res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify({ checks }));
      return;
    }

    // ─── Capture routes ──────────────────────────────────────
    //
    //   POST /api/capture/start            → JSON { workflow, contextHint? }
    //   GET  /capture/:token               → static mobile.html
    //   GET  /api/capture/manifest/:token  → JSON manifest for the phone
    //   POST /api/capture/upload?token=…   → multipart file
    //   POST /api/capture/delete-photo     → JSON { token, index }
    //   POST /api/capture/finalize         → JSON { token }
    //   POST /api/capture/discard          → JSON { sessionId, reason? }
    //   GET  /api/capture/sessions         → JSON list (operator side)
    //
    // Photos persist under .tracker/captures/<sessionId>/; bundled PDFs
    // land in .tracker/uploads/<sessionId>.pdf — same dir emergency-contact's
    // prepare flow uses, so downstream OCR consumers find both.

    if (req.method === "POST" && url.pathname === "/api/capture/start") {
      const parsed = await readJsonBody(4096);
      if (!parsed.ok) return writeJson(400, { ok: false, error: parsed.error });
      const result = await handleCaptureStart(
        {
          workflow: String(parsed.body.workflow ?? ""),
          contextHint: parsed.body.contextHint
            ? String(parsed.body.contextHint)
            : undefined,
        },
        {
          store: captureStore,
          lanIp: pickLanIp(),
          port,
          // Phone can't always reach the laptop's LAN IP (Tailscale-only,
          // CGNAT, separate WiFi). Set CAPTURE_PUBLIC_URL to a tunnel
          // origin (cloudflared / ngrok) to override the QR target.
          publicUrl: process.env.CAPTURE_PUBLIC_URL || undefined,
          onFinalize: makeCaptureFinalize(dir),
        },
      );
      writeJson(result.status, result.body);
      return;
    }

    if (req.method === "GET" && url.pathname.startsWith("/capture/")) {
      // Strip the token from the path; the JS inside the page reads it from
      // location.pathname so we don't need to substitute server-side.
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-cache",
      });
      res.end(getCaptureMobileHtml());
      return;
    }

    if (
      req.method === "GET" &&
      url.pathname.startsWith("/api/capture/manifest/")
    ) {
      const token = url.pathname.slice("/api/capture/manifest/".length);
      // First manifest hit doubles as "phone connected" — capture the
      // UA + IP so an audit consumer can attribute photos to a device.
      const ua = req.headers["user-agent"];
      const fwd = req.headers["x-forwarded-for"];
      const remoteIp =
        (typeof fwd === "string" ? fwd.split(",")[0]?.trim() : undefined) ||
        req.socket?.remoteAddress ||
        undefined;
      const result = handleCaptureManifest(token, {
        store: captureStore,
        phoneInfo: {
          userAgent: typeof ua === "string" ? ua : undefined,
          ip: remoteIp,
        },
      });
      writeJson(result.status, result.body);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/capture/upload") {
      const token = url.searchParams.get("token") ?? "";
      // 11 MB cap leaves a 1MB margin over the per-photo 10MB enforced by
      // handleCaptureUpload — multipart envelope overhead.
      const mp = await readMultipart(req, 11 * 1024 * 1024);
      if (!mp.ok) return writeJson(400, { ok: false, error: mp.error });
      const file = mp.parsed.files["file"];
      if (!file) {
        return writeJson(400, { ok: false, error: "missing 'file' part" });
      }
      const result = await handleCaptureUpload(
        { token, bytes: file.data, originalName: file.filename },
        { store: captureStore, photosDir: CAPTURE_PHOTOS_DIR },
      );
      writeJson(result.status, result.body);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/capture/delete-photo") {
      const parsed = await readJsonBody(4096);
      if (!parsed.ok) return writeJson(400, { ok: false, error: parsed.error });
      const result = await handleCaptureDeletePhoto(
        {
          token: String(parsed.body.token ?? ""),
          index: Number(parsed.body.index),
        },
        { store: captureStore, photosDir: CAPTURE_PHOTOS_DIR },
      );
      writeJson(result.status, result.body);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/capture/finalize") {
      const parsed = await readJsonBody(4096);
      if (!parsed.ok) return writeJson(400, { ok: false, error: parsed.error });
      const result = await handleCaptureFinalize(
        { token: String(parsed.body.token ?? "") },
        {
          store: captureStore,
          photosDir: CAPTURE_PHOTOS_DIR,
          uploadsDir: CAPTURE_UPLOADS_DIR,
        },
      );
      writeJson(result.status, result.body);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/capture/discard") {
      const parsed = await readJsonBody(4096);
      if (!parsed.ok) return writeJson(400, { ok: false, error: parsed.error });
      const result = handleCaptureDiscard(
        {
          sessionId: String(parsed.body.sessionId ?? ""),
          reason: parsed.body.reason ? String(parsed.body.reason) : undefined,
        },
        { store: captureStore, photosDir: CAPTURE_PHOTOS_DIR },
      );
      writeJson(result.status, result.body);
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/capture/sessions") {
      // Legacy poll endpoint — kept one release for backcompat per the
      // spec's migration plan §4. Modal uses SSE now. `serializeCaptureSession`
      // omits `token` to align with the SSE invariant.
      writeJson(200, captureStore.listAll().map(serializeCaptureSession));
      return;
    }

    // ─── Capture: photo serving (path-traversal guarded) ──────
    if (
      req.method === "GET" &&
      url.pathname.startsWith("/api/capture/photos/")
    ) {
      const rest = url.pathname.slice("/api/capture/photos/".length);
      const slash = rest.indexOf("/");
      if (slash < 0) {
        res.writeHead(404);
        res.end();
        return;
      }
      const sessionIdRaw = decodeURIComponent(rest.slice(0, slash));
      const indexStr = rest.slice(slash + 1);
      // The store's sessionIds are randomUUID() (8-4-4-4-12 hex+dashes).
      // Anything else is a path-traversal probe — reject without
      // distinguishing causes.
      if (!/^[a-f0-9-]{8,80}$/i.test(sessionIdRaw)) {
        res.writeHead(404);
        res.end();
        return;
      }
      const idx = Number(indexStr);
      if (!Number.isInteger(idx) || idx < 0) {
        res.writeHead(404);
        res.end();
        return;
      }
      const session = captureStore.getById(sessionIdRaw);
      if (!session) {
        res.writeHead(404);
        res.end();
        return;
      }
      const photo = session.photos.find((p) => p.index === idx);
      if (!photo) {
        res.writeHead(404);
        res.end();
        return;
      }
      // photo.filename is server-generated — we never accept user-supplied
      // names that could contain `..`. The store-resolved lookup is the
      // authoritative source.
      const filePath = join(CAPTURE_PHOTOS_DIR, sessionIdRaw, photo.filename);
      let photoStat;
      try {
        photoStat = await statAsync(filePath);
      } catch {
        res.writeHead(404);
        res.end();
        return;
      }
      res.writeHead(200, {
        "Content-Type": photo.mime,
        "Cache-Control": "no-cache, must-revalidate",
        "Content-Length": String(photoStat.size),
      });
      createReadStream(filePath).pipe(res);
      return;
    }

    // ─── Capture: replace photo (multipart {token, index, file}) ─
    if (req.method === "POST" && url.pathname === "/api/capture/replace-photo") {
      const mp = await readMultipart(req, 11 * 1024 * 1024);
      if (!mp.ok) return writeJson(400, { ok: false, error: mp.error });
      const file = mp.parsed.files["file"];
      if (!file) {
        return writeJson(400, { ok: false, error: "missing 'file' part" });
      }
      const token = mp.parsed.fields["token"] ?? "";
      const indexStr = mp.parsed.fields["index"];
      if (!token) {
        return writeJson(400, { ok: false, error: "missing 'token' field" });
      }
      if (indexStr === undefined) {
        return writeJson(400, { ok: false, error: "missing 'index' field" });
      }
      const idx = Number(indexStr);
      if (!Number.isInteger(idx) || idx < 0) {
        return writeJson(400, {
          ok: false,
          error: "'index' must be a non-negative integer",
        });
      }
      const blurField = mp.parsed.fields["blurScore"];
      const blurScore =
        blurField !== undefined && blurField !== ""
          ? Number(blurField)
          : undefined;
      const result = await handleCaptureReplacePhoto(
        {
          token,
          index: idx,
          bytes: file.data,
          originalName: file.filename,
          ...(typeof blurScore === "number" && Number.isFinite(blurScore)
            ? { blurScore }
            : {}),
        },
        { store: captureStore, photosDir: CAPTURE_PHOTOS_DIR },
      );
      writeJson(result.status, result.body);
      return;
    }

    // ─── Capture: reorder photos (positional) ─────────────────
    if (req.method === "POST" && url.pathname === "/api/capture/reorder") {
      const parsed = await readJsonBody(4096);
      if (!parsed.ok) return writeJson(400, { ok: false, error: parsed.error });
      const result = handleCaptureReorder(
        {
          token: String(parsed.body.token ?? ""),
          fromIndex: Number(parsed.body.fromIndex),
          toIndex: Number(parsed.body.toIndex),
        },
        { store: captureStore },
      );
      writeJson(result.status, result.body);
      return;
    }

    // ─── Capture: extend session ──────────────────────────────
    if (req.method === "POST" && url.pathname === "/api/capture/extend") {
      const parsed = await readJsonBody(4096);
      if (!parsed.ok) return writeJson(400, { ok: false, error: parsed.error });
      const byMsRaw = parsed.body.byMs;
      const byMs =
        typeof byMsRaw === "number" && Number.isFinite(byMsRaw)
          ? byMsRaw
          : undefined;
      const result = handleCaptureExtend(
        {
          sessionId: String(parsed.body.sessionId ?? ""),
          ...(byMs !== undefined ? { byMs } : {}),
        },
        { store: captureStore },
      );
      writeJson(result.status, result.body);
      return;
    }

    // ─── Capture: validate (gates Finalize CTA) ───────────────
    if (req.method === "POST" && url.pathname === "/api/capture/validate") {
      const parsed = await readJsonBody(4096);
      if (!parsed.ok) return writeJson(400, { ok: false, error: parsed.error });
      const result = handleCaptureValidate(
        { sessionId: String(parsed.body.sessionId ?? "") },
        { store: captureStore },
      );
      writeJson(result.status, result.body);
      return;
    }

    // ─── Capture: registry (TopBar gate) ──────────────────────
    if (req.method === "GET" && url.pathname === "/api/capture/registry") {
      writeJson(200, captureRegistrations);
      return;
    }

    // ─── Capture: SSE stream (modal uses while open) ──────────
    if (
      req.method === "GET" &&
      url.pathname === "/api/capture/sessions/stream"
    ) {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      const sessions = captureStore.listAll().map(serializeCaptureSession);
      res.write(
        `event: session-list\ndata: ${JSON.stringify({ sessions })}\n\n`,
      );
      const id = ++nextCaptureSseClientId;
      const client: CaptureSseClient = { id, res };
      captureSseClients.add(client);
      req.on("close", () => {
        captureSseClients.delete(client);
      });
      return;
    }

    // ─── Capture: heic2any polyfill (gap 6 — local serving) ───
    if (
      req.method === "GET" &&
      url.pathname === "/capture-assets/heic2any.min.js"
    ) {
      const buf = getHeic2anyAsset();
      if (!buf) {
        res.writeHead(502, { "Content-Type": "text/plain; charset=utf-8" });
        res.end(
          "heic2any not installed on dashboard host — run `npm install heic2any`",
        );
        return;
      }
      res.writeHead(200, {
        "Content-Type": "text/javascript; charset=utf-8",
        "Cache-Control": "public, max-age=86400",
        "Content-Length": String(buf.length),
      });
      res.end(buf);
      return;
    }

    // No HTML served — use Vite dev server (port 5173) for the UI
    res.writeHead(404);
    res.end();
  });

  localServer.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      log.step(`Dashboard port ${port} in use — skipping (another instance may be running)`);
      // If this server was installed as the module-level singleton, clear it.
      if (server === localServer) server = null;
    }
  });

  localServer.listen(port, () => {
    const addr = localServer.address();
    const boundPort = typeof addr === "object" && addr ? addr.port : port;
    // Skip the startup log when port=0 (test fixture). Otherwise announce.
    if (port !== 0) {
      log.step(`Live dashboard: http://localhost:${boundPort}`);
    }
  });

  return localServer;
}

/** Stop the dashboard server. Call at workflow end. */
export function stopDashboard(): void {
  if (server) {
    server.close();
    server = null;
  }
}
