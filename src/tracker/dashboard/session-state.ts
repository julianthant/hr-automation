import {
  readSessionEvents,
  workflowNameFromInstance,
  type SessionEvent,
} from "../session-events.js";
import type { TrackerEntry } from "../jsonl.js";
import { isIdleRefreshSystem } from "../../domain/idle-refresh.js";
import { resolveRowArchetype } from "../../domain/row-archetype.js";

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

/** First non-empty `data.instance` across the given entries, in order. */
function firstInstanceFromEntries(
  entries: Array<Pick<TrackerEntry, "data">>,
): string | undefined {
  for (const t of entries) {
    const instance = t.data?.instance;
    if (typeof instance === "string" && instance.length > 0) return instance;
  }
  return undefined;
}

export function resolveInstanceForOperationCoordinator(
  trackers: Array<Pick<TrackerEntry, "runId" | "parentRunId" | "data">>,
  coordinatorRunId: string,
): string | undefined {
  const direct = resolveInstanceForRun(trackers, coordinatorRunId);
  if (direct) return direct;
  for (const t of trackers) {
    if (t.parentRunId !== coordinatorRunId) continue;
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
 * `workflowInstance` for its entire lifetime - it processes many items
 * (each a distinct `runId`) under one instance. Without the time window,
 * orphan events from every past or concurrent item in the daemon would
 * bleed into each item's drill-in view. Filtering orphan events to the
 * target run's tracker-entry span fixes the leak without breaking legacy
 * batch shapes (a batch's orphan events all fall inside the batch's span
 * anyway).
 *
 * `runStart` = earliest tracker-entry timestamp for this runId.
 * `runEnd` = max(latest tracker ts for runId, latest direct-event ts for
 * runId, `now` - via `runEndFallback` arg, default `Date.now()`). The
 * `now`/direct-event extension matters for in-progress items where no
 * terminal tracker entry exists yet.
 *
 * Pure: no filesystem access. Clock is injected via `runEndFallback` so
 * tests stay deterministic.
 */
export function filterEventsForRun(
  events: SessionEvent[],
  trackers: Array<Pick<TrackerEntry, "runId" | "parentRunId" | "status" | "data" | "timestamp">>,
  runId: string,
  runEndFallback: number = Date.now(),
): SessionEvent[] {
  const direct = events.filter((e) => e.runId === runId);

  // Single pass over `trackers` to build every bucket this tick needs, instead
  // of the ~9 repeated linear scans (archetype probe, two instance scans, two
  // runEntries filters, the memberRunIds filter, …) that each re-walked the
  // same array — costly for a separations coordinator with ~50 member rows on
  // a 500ms SSE tick. `ownEntries` carry this exact runId (the run / the
  // coordinator row itself); `childEntries` are rows parented to this runId
  // (an operation coordinator's members). `archetypeEntry` is the FIRST own
  // entry, matching the old first-match `rowArchetypeForRun`.
  type Entry = (typeof trackers)[number];
  let archetypeEntry: Entry | undefined;
  const ownEntries: Entry[] = [];
  const childEntries: Entry[] = [];
  for (const t of trackers) {
    if (t.runId === runId) {
      archetypeEntry ??= t;
      ownEntries.push(t);
    }
    if (t.parentRunId === runId) childEntries.push(t);
  }
  const archetype = archetypeEntry ? resolveRowArchetype(archetypeEntry) : undefined;

  // Instance resolution derived from the buckets — no extra scan. Operation
  // coordinator: its own `data.instance` if present, else the first child
  // member's (mirrors `resolveInstanceForOperationCoordinator`). Otherwise the
  // run's own first `data.instance` (mirrors `resolveInstanceForRun`).
  const ownInstance = firstInstanceFromEntries(ownEntries);
  const instance =
    archetype === "operation"
      ? ownInstance ?? firstInstanceFromEntries(childEntries)
      : ownInstance;

  const runEntries =
    archetype === "operation" ? [...ownEntries, ...childEntries] : ownEntries;
  const memberRunIds = new Set(
    childEntries
      .filter((t) => typeof t.runId === "string" && (t.runId as string).length > 0)
      .map((t) => t.runId as string),
  );

  let batchScope: SessionEvent[] = [];
  if (archetype === "operation-member") {
    batchScope = [];
  } else if (instance) {
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
      //
      // For an operation COORDINATOR, the termination signal is the
      // coordinator's OWN row only (`ownEntries`) — NOT its members. The
      // coordinator is a display-only `pending` row that stays open for the
      // whole fan-out; if a single member reaching done/failed/skipped capped
      // the window, daemon-scope events (browser_health / idle_signal) that
      // land after the last member row but before `runEndFallback` would be
      // dropped from the consolidated coordinator timeline.
      const terminationEntries = archetype === "operation" ? ownEntries : runEntries;
      const terminated = terminationEntries.some(
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
        // daemon_log events are machine-scoped (no runId, one daemon spans many
        // runs). Never attribute them to a per-run Events tab — they belong in
        // the terminal drawer's recentDaemonLogs section only.
        if (e.type === "daemon_log") return false;
        if (e.runId) return false;
        if (e.workflowInstance !== instance) return false;
        const ets = new Date(getEventSortKey(e)).getTime();
        if (!Number.isFinite(ets)) return false;
        return ets >= runStart && ets <= runEnd;
      });
    }
  }

  // An operation coordinator is the consolidated "event tracker" for its
  // fanned-out members, so surface each member's `item_start` on the
  // coordinator timeline too. Those events carry the MEMBER's runId, so they
  // are neither `direct` (coordinator runId) nor batch-scope (they HAVE a
  // runId) and would otherwise only appear in each member's own drill-in. We
  // include only `item_start` (the "member began processing" marker the
  // operator asked for) — member completion is already shown by the per-member
  // summary line the coordinator log panel folds in, and pulling every member
  // event here would re-flood the timeline.
  let memberLifecycle: SessionEvent[] = [];
  if (archetype === "operation" && memberRunIds.size > 0) {
    memberLifecycle = events.filter(
      (e) => e.type === "item_start" && typeof e.runId === "string" && memberRunIds.has(e.runId),
    );
  }

  const merged = [...direct, ...batchScope, ...memberLifecycle];
  merged.sort((a, b) => getEventSortKey(a).localeCompare(getEventSortKey(b)));
  return merged;
}

/**
 * How long after a crash-on-launch the dashboard keeps rendering the red
 * "Launch failed" placeholder in the live Sessions rail. Past this window the
 * failed run is considered historical - details still live in
 * dated session snapshot files and the workflow's per-day log, but the Sessions
 * panel (which is a "live / currently happening" view) stops pinning it.
 */
const CRASH_ON_LAUNCH_WINDOW_MS = 15 * 60 * 1000;

// -- Session state rebuilding from JSONL events ----------

export interface BrowserState {
  browserId: string;
  system: string;
  authState: "idle" | "authenticating" | "authed" | "duo_waiting" | "failed";
  /**
   * Per-browser health, orthogonal to `authState` — bound to THIS browser by
   * `browserId`, so the tile reflects its own browser's state regardless of
   * tile order. Undefined until the first `browser_health` event (the tile then
   * shows auth state alone). `refreshing` = an auto/operator reload is in
   * flight; `failed` = a hard fault (a refresh can't heal it — see `lastError`).
   */
  health?: "healthy" | "unhealthy" | "refreshing" | "failed";
  /** Reason for the latest `unhealthy`/`failed` health transition, if any. */
  lastError?: string;
  /** The browser's current page URL (from the latest health event) — lets the
   * operator see where each browser is (e.g. stuck on the SSO login page). */
  url?: string;
  /** Recent health TRANSITIONS (oldest→newest, capped), so the operator can see
   * a flapping browser's recovery trail. Consecutive duplicates are collapsed. */
  healthHistory?: Array<{ at: string; status: NonNullable<BrowserState["health"]>; reason?: string }>;
  /** Operator paused AUTO-recovery for this browser (manual controls still work;
   * the monitor won't refresh/reopen it). */
  autoRecoveryPaused?: boolean;
}

/** Cap on `BrowserState.healthHistory` length (keeps the SSE payload bounded). */
const HEALTH_HISTORY_CAP = 6;

export interface SessionInfo {
  sessionId: string;
  browsers: BrowserState[];
}

export interface WorkflowInstanceState {
  instance: string;
  /** Kebab-case workflow name resolved from the instance label (e.g. "Separation 1" -> "separations"). null when unrecognised. */
  workflow: string | null;
  /** ISO-8601 timestamp of the latest workflow_start event for this instance.
   * Surfaced to the dashboard's terminal drawer so cards can render a live
   * elapsed counter. Re-runs under the same instance overwrite this. */
  startedAt?: string;
  active: boolean;
  /** True while the spawning Node process (and therefore its Playwright browsers) is still alive. */
  pidAlive: boolean;
  /**
   * OS pid of the spawning Node process, from the latest `workflow_start`
   * event. Lets the client-side `hasReassignablePeer` check match the backend's
   * authoritative pid-based peer detection (`alive.some(d => d.pid !== pid)` in
   * worker-control.ts) instead of relying on the instance label alone.
   */
  pid?: number;
  /**
   * True when workflow_end (finalStatus=failed) fired but no browser_launch event
   * was ever emitted for this instance - i.e. the workflow crashed before
   * Playwright launched a browser. Used by the dashboard to render a
   * "Launch failed" placeholder in place of the usual session/browser chips.
   */
  crashedOnLaunch?: boolean;
  currentItemId: string | null;
  /**
   * Frozen `data.__traceId` of the current (or most-recent) in-flight item's
   * run — the same id its queue row shows. Set on `item_start` and, like
   * `currentItemId`, intentionally NOT cleared on `item_complete` so the card
   * keeps showing the last run's trace id between items. `null` for a daemon
   * that hasn't processed an item yet.
   */
  currentTraceId: string | null;
  /** True between item_start and item_complete - i.e. a real item is currently being processed. */
  itemInFlight: boolean;
  currentStep: string | null;
  finalStatus: "done" | "failed" | null;
  sessions: SessionInfo[];
  /**
   * Populated from `daemon_phase` session events (daemon mode only).
   * Refines the session-drawer subline between queued items.
   */
  daemonPhase?: "idle" | "keepalive";
  /**
   * Recent daemon log lines (session-log `daemon_log` events) for this
   * instance, oldest→newest, capped to the last 30. Machine-scoped: shown
   * in the terminal drawer, never attributed to a per-run Events tab.
   */
  recentDaemonLogs?: Array<{ ts: string; level: string; message: string }>;
  /**
   * Idle-refresh observability (`idle_signal` events), keyed by system id.
   * Drives the countdown ring on each idle-refresh browser chip (ucpath, i9).
   */
  idleBySystem?: Record<string, { lastTouchAt: string; refreshing: boolean }>;
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
        pid: e.pid,
        active: true,
        pidAlive: true,
        currentItemId: null,
        currentTraceId: null,
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
    // Per-browser health — bound by browserId (NEVER by array position). An
    // event without a browserId is dropped, never applied positionally, so a
    // tile can't pick up a sibling's state.
    if (e.type === "browser_health" && e.browserId) {
      const b = findBrowser(wfMap, inst, e.browserId);
      const status = e.data?.status as BrowserState["health"] | undefined;
      if (b && status) {
        b.health = status;
        if (e.data?.url) b.url = e.data.url;
        if (e.data?.paused !== undefined) b.autoRecoveryPaused = e.data.paused === "true";
        if (status === "unhealthy" || status === "failed") {
          if (e.data?.reason) b.lastError = e.data.reason;
        } else {
          // healthy / refreshing → clear a stale error
          delete b.lastError;
        }
        // Recovery trail — append only on an actual status CHANGE (so repeated
        // Check clicks / steady-state probes don't pad it), capped.
        const hist = (b.healthHistory ??= []);
        const last = hist[hist.length - 1];
        if (!last || last.status !== status) {
          hist.push({ at: e.timestamp, status, ...(e.data?.reason ? { reason: e.data.reason } : {}) });
          if (hist.length > HEALTH_HISTORY_CAP) hist.splice(0, hist.length - HEALTH_HISTORY_CAP);
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
      const sys = e.system ?? b?.system;
      if (sys && isIdleRefreshSystem(sys)) {
        const wf = wfMap.get(inst);
        if (wf) {
          const ts = e.timestamp;
          const map = (wf.idleBySystem ??= {});
          const cur = map[sys];
          const refreshing = cur?.refreshing ?? false;
          if (!cur?.lastTouchAt || ts.localeCompare(cur.lastTouchAt) >= 0) {
            map[sys] = { lastTouchAt: ts, refreshing };
          }
        }
      }
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
        if (e.traceId) wf.currentTraceId = e.traceId;
        wf.itemInFlight = true;
      }
    }
    if (e.type === "item_complete") {
      const wf = wfMap.get(inst);
      if (wf) wf.itemInFlight = false;
    }
    if (e.type === "daemon_phase" && e.data?.phase) {
      const wf = wfMap.get(inst);
      const p = e.data.phase;
      if (wf && (p === "idle" || p === "keepalive")) wf.daemonPhase = p;
    }
    if (e.type === "daemon_log" && e.data?.message) {
      const wf = wfMap.get(inst);
      if (wf) {
        (wf.recentDaemonLogs ??= []).push({
          ts: getEventSortKey(e),
          level: e.data.level ?? "step",
          message: e.data.message,
        });
        if (wf.recentDaemonLogs.length > 30) {
          wf.recentDaemonLogs = wf.recentDaemonLogs.slice(-30);
        }
      }
    }
    if (e.type === "idle_signal") {
      const wf = wfMap.get(inst);
      if (!wf) continue;
      const sys = e.system;
      if (!sys) continue;
      const kind = e.data?.kind;
      const map = (wf.idleBySystem ??= {});
      if (kind === "touch" || kind === "refresh_end") {
        map[sys] = { lastTouchAt: e.timestamp, refreshing: false };
      } else if (kind === "refresh_start") {
        const prevTouch = map[sys]?.lastTouchAt ?? e.timestamp;
        map[sys] = { lastTouchAt: prevTouch, refreshing: true };
      }
    }
    // Intentionally do NOT clear currentItemId on item_complete - the dashboard
    // keeps the last item visible after the workflow ends so users can see which
    // employee/record the session was for, even after it's done.
  }

  // Flag workflows that crashed before any browser could launch. A workflow that
  // ended in failed status but never emitted a browser_launch is indistinguishable
  // from normal "no-active-sessions" in the dashboard UI - this flag lets
  // session drawer render a dedicated "Launch failed" placeholder so the user
  // knows the run crashed early and where to look for details.
  //
  // Age gate: the session drawer keeps crashedOnLaunch entries visible even after
  // pidAlive flips false (that's the point of the placeholder - the Node
  // process that crashed is already gone). But session snapshot files are append-only
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
  // The session drawer uses `pidAlive` to remove a workflow once its session is closed,
  // while `active` stays authoritative for the DONE/FAILED pill in the brief window
  // between workflow_end firing and the Node process exiting.
  //
  // In-process (fire-and-forget) workflows: when a workflow runs INSIDE the
  // dashboard server process (e.g. the `sharepoint-download` HTTP handler
  // fires `runWorkflow()` without awaiting), the recorded pid equals the
  // dashboard's own pid - so `process.kill(pid, 0)` always succeeds while
  // the dashboard is up, pinning the workflow box to the session drawer
  // forever even after it has completed or failed. Treat an in-process run
  // as "session ended" the moment `workflow_end` fires, matching the behavior
  // of spawned-child workflows whose process exits shortly after end. This
  // keeps the session drawer consistent across both execution models.
  const ownPid = process.pid;
  for (const wf of workflows) {
    // Pick the LATEST workflow_start for this instance - when a workflow is re-run
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

export function filterLiveSessionState(state: SessionState): SessionState {
  const liveInstances = new Set<string>();
  const workflows = state.workflows.filter((workflow) => {
    const visible = (workflow.active && workflow.pidAlive) || workflow.crashedOnLaunch === true;
    if (visible) liveInstances.add(workflow.instance);
    return visible;
  });
  return {
    workflows,
    duoQueue: state.duoQueue.filter((entry) => liveInstances.has(entry.instance)),
  };
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
