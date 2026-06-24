import { existsSync, readFileSync, readdirSync } from "fs";
import { request as httpRequest } from "http";
import { join } from "path";
import {
  findAliveDaemons,
  spawnDaemon,
  daemonsDir,
  invalidateAliveDaemonsCache,
} from "../../core/daemon/registry.js";
import { queueFilePath, markItemFailed } from "../../core/daemon/queue.js";
import { stopDaemons, stopDaemon } from "../../core/daemon/client.js";
import type { Daemon } from "../../core/daemon/types.js";
import type { BrowserProcessRow, WorkerRow } from "../../core/daemon/worker-store.js";
import {
  readSessionEvents,
  emitWorkflowEnd,
  workflowNameFromInstance,
  type SessionEvent,
} from "../../tracker/session-events.js";
import { log } from "../../utils/log.js";
import { errorMessage } from "../../utils/errors.js";
import { openControlStores } from "./shared.js";
import { emitInheritedRow } from "./emit-inherited.js";

export interface WorkerCommandRequest {
  workerId: string;
}

export interface DaemonInfo {
  workflow: string;
  workerId: string;
  pid: number;
  port: number | null;
  instanceId: string | null;
  startedAt: string;
  uptimeMs: number;
  itemsProcessed: number;
  currentItem: string | null;
  currentRunId: string | null;
  currentTaskId: string | null;
  currentAttemptId: string | null;
  phase: string;
  status: string;
  heartbeatAgeMs: number | null;
  browserProcesses: Array<{
    browserProcessId: string;
    systemId: string;
    pid: number;
    status: string;
  }>;
  lockfileAlive: boolean;
}

export interface SpawnDaemonRequest {
  workflow: string;
  count?: number;
}

export interface StopDaemonsRequest {
  workflow?: string;
  force?: boolean;
}

export interface StopDaemonInstanceRequest {
  workflow: string;
  /** Session-drawer instance label of the daemon to stop (e.g. "Person Lookup 2"). */
  instance: string;
  force?: boolean;
}

export interface StopDaemonInstanceResult {
  ok: boolean;
  workflow: string;
  instance: string;
  /** True if we sent /stop to a live daemon or killed its pid. */
  daemonStopped: boolean;
  /** Orphaned chromium PIDs SIGKILL'd for this instance. */
  browsersKilled: number;
  /** True if at least one OTHER daemon remains to absorb a reassigned item. */
  reassignable: boolean;
  error?: string;
}

async function requestDaemonStopWorker(worker: WorkerRow | null): Promise<boolean> {
  if (!worker?.port) return false;
  // Manual AbortController + clearTimeout (not AbortSignal.timeout) so the
  // timer can't fire after the response completes — see "abort race" lesson.
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 5_000);
  try {
    const res = await fetch(`http://127.0.0.1:${worker.port}/stop`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ force: true }),
      signal: ctrl.signal,
    });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function enqueueWorkerLifecycleCommand(
  dir: string,
  workerId: string,
  commandType: "drain_worker" | "stop_worker",
): Promise<{ ok: true; commandId: string } | { ok: false; error: string; status?: number }> {
  if (!workerId) return { ok: false, error: "workerId is required", status: 400 };
  const stores = openControlStores(dir);
  const worker = stores.workerStore.getWorker(workerId);
  if (!worker) return { ok: false, error: "worker not found", status: 404 };
  const commandId = stores.workerStore.enqueueWorkerCommand({
    commandType,
    workflow: worker.workflow,
    targetWorkerId: worker.workerId,
    payload: { pid: worker.pid, instanceId: worker.instanceId },
  });
  if (commandType === "stop_worker") {
    void requestDaemonStopWorker(worker);
  }
  return { ok: true, commandId };
}

export function buildDrainWorkerHandler(dir: string) {
  return async (
    req: WorkerCommandRequest,
  ): Promise<{ ok: true; commandId: string } | { ok: false; error: string; status?: number }> =>
    enqueueWorkerLifecycleCommand(dir, req.workerId, "drain_worker");
}

export function buildStopWorkerHandler(dir: string) {
  return async (
    req: WorkerCommandRequest,
  ): Promise<{ ok: true; commandId: string } | { ok: false; error: string; status?: number }> =>
    enqueueWorkerLifecycleCommand(dir, req.workerId, "stop_worker");
}

/** Probe a single daemon's /status endpoint with a short timeout. */
async function probeDaemonStatus(
  daemon: Daemon,
  timeoutMs = 1000,
): Promise<{ phase?: string; currentItem?: string | null; currentRunId?: string | null }> {
  return new Promise((resolve) => {
    const reqHttp = httpRequest(
      {
        host: "127.0.0.1",
        port: daemon.port,
        path: "/status",
        method: "GET",
        timeout: timeoutMs,
      },
      (resHttp) => {
        let body = "";
        resHttp.on("data", (chunk) => (body += chunk));
        resHttp.on("end", () => {
          try {
            const parsed = JSON.parse(body) as {
              phase?: string;
              inFlight?: string | { id?: string } | null;
              inFlightRunId?: string | null;
            };
            const currentItem =
              typeof parsed.inFlight === "string"
                ? parsed.inFlight
                : parsed.inFlight?.id ?? null;
            resolve({
              phase: parsed.phase,
              currentItem,
              currentRunId: parsed.inFlightRunId ?? null,
            });
          } catch {
            resolve({});
          }
        });
      },
    );
    reqHttp.on("error", () => resolve({}));
    reqHttp.on("timeout", () => {
      reqHttp.destroy();
      resolve({});
    });
    reqHttp.end();
  });
}

/** Count `done` + `failed` queue events whose `claimedBy === instanceId`. */
function countItemsProcessed(instanceId: string, queueLines: string[]): number {
  let count = 0;
  // We track which runIds were claimed by this instance, then count
  // terminal events for those runIds — `done` / `failed` events carry
  // `runId` but not `claimedBy`.
  const runIdsForInstance = new Set<string>();
  for (const line of queueLines) {
    if (!line.trim()) continue;
    let ev: import("../../core/daemon/types.js").QueueEvent;
    try {
      ev = JSON.parse(line) as import("../../core/daemon/types.js").QueueEvent;
    } catch {
      continue;
    }
    if (ev.type === "claim" && ev.claimedBy === instanceId) {
      runIdsForInstance.add(ev.runId);
    } else if ((ev.type === "done" || ev.type === "failed") && runIdsForInstance.has(ev.runId)) {
      count++;
    }
  }
  return count;
}

function discoverLockfileWorkflows(dir: string): string[] {
  const d = daemonsDir(dir);
  if (!existsSync(d)) return [];
  const names = new Set<string>();
  for (const file of readdirSync(d)) {
    if (!file.endsWith(".lock.json") || file.includes(".lock.json.tmp")) continue;
    try {
      const lock = JSON.parse(readFileSync(join(d, file), "utf-8")) as { workflow?: string };
      if (typeof lock.workflow === "string") names.add(lock.workflow);
    } catch { /* ignore unreadable / malformed */ }
  }
  return [...names];
}

function workerToDaemonInfo(args: {
  worker: WorkerRow;
  matchingLock?: Daemon;
  currentItem: string | null;
  currentRunId: string | null;
  itemsProcessed: number;
  browserProcesses: BrowserProcessRow[];
}): DaemonInfo {
  const { worker, matchingLock, browserProcesses } = args;
  const startedMs = Date.parse(worker.startedAt);
  const heartbeatMs = worker.lastHeartbeatAt ? Date.parse(worker.lastHeartbeatAt) : NaN;
  return {
    workflow: worker.workflow ?? "",
    workerId: worker.workerId,
    pid: worker.pid,
    port: worker.port ?? matchingLock?.port ?? null,
    instanceId: worker.instanceId ?? matchingLock?.instanceId ?? null,
    startedAt: worker.startedAt,
    uptimeMs: Number.isFinite(startedMs) ? Date.now() - startedMs : 0,
    itemsProcessed: args.itemsProcessed,
    currentItem: args.currentItem,
    currentRunId: args.currentRunId,
    currentTaskId: worker.currentTaskId ?? null,
    currentAttemptId: worker.currentAttemptId ?? null,
    phase: worker.phase,
    status: worker.status,
    heartbeatAgeMs: Number.isFinite(heartbeatMs) ? Date.now() - heartbeatMs : null,
    browserProcesses: browserProcesses.map((browser) => ({
      browserProcessId: browser.browserProcessId,
      systemId: browser.systemId,
      pid: browser.pid,
      status: browser.status,
    })),
    lockfileAlive: Boolean(matchingLock),
  };
}

/**
 * List alive daemons across one or all workflows, enriched with per-daemon
 * runtime stats (uptime, itemsProcessed, current item, phase).
 */
export function buildDaemonsListHandler(dir: string) {
  return async (workflow?: string): Promise<DaemonInfo[]> => {
    const stores = openControlStores(dir);
    const lockfileWorkflows = discoverLockfileWorkflows(dir);
    for (const stale of stores.workerStore.listStaleWorkers({})) {
      if (workflow && stale.workflow !== workflow) continue;
      stores.workerStore.markWorkerStatus({
        workerId: stale.workerId,
        status: "stale",
        phase: stale.phase,
      });
    }
    const workers = stores.workerStore
      .listWorkers(workflow)
      .filter((worker) => worker.kind === "daemon" && (!workflow || worker.workflow === workflow));
    const workerWorkflows = new Set(workers.map((worker) => worker.workflow).filter(Boolean) as string[]);
    const workflows = workflow ? [workflow] : [...new Set([...lockfileWorkflows, ...workerWorkflows])];
    const out: DaemonInfo[] = [];
    const aliveByWorkflow = new Map<string, Daemon[]>();
    // Parallelize findAliveDaemons across workflows — each probe is independent.
    const aliveResults = await Promise.all(
      workflows.map(async (wf) => [wf, await findAliveDaemons(wf, dir)] as const),
    );
    for (const [wf, alive] of aliveResults) aliveByWorkflow.set(wf, alive);

    // Hoist queue JSONL reads: one read per workflow instead of one per daemon.
    const queueLinesByWorkflow = new Map<string, string[]>();
    for (const wf of workflows) {
      try {
        const text = readFileSync(queueFilePath(wf, dir), "utf-8");
        queueLinesByWorkflow.set(wf, text.split("\n").filter(Boolean));
      } catch {
        queueLinesByWorkflow.set(wf, []);
      }
    }

    for (const worker of workers) {
        const wf = worker.workflow ?? "";
        const alive = aliveByWorkflow.get(wf) ?? [];
        const matchingLock = alive.find((d) =>
          (worker.instanceId && d.instanceId === worker.instanceId) || d.pid === worker.pid
        );
        const terminalWithoutLiveLock =
          (worker.status === "dead" || worker.status === "stopped" || worker.status === "stale")
          && !matchingLock
          && !worker.currentTaskId
          && !worker.currentAttemptId;
        if (terminalWithoutLiveLock) continue;
        const currentTask = worker.currentTaskId ? stores.taskStore.getTask(worker.currentTaskId) : null;
        const currentAttempt = worker.currentAttemptId ? stores.taskStore.getAttempt(worker.currentAttemptId) : null;
        const browserProcesses = stores.workerStore.listBrowserProcessesForWorker(worker.workerId);
        out.push(workerToDaemonInfo({
          worker,
          matchingLock,
          currentItem: currentTask?.itemId ?? null,
          currentRunId: currentAttempt?.runId ?? currentTask?.currentRunId ?? currentTask?.runId ?? null,
          itemsProcessed: worker.instanceId
            ? countItemsProcessed(worker.instanceId, queueLinesByWorkflow.get(wf) ?? [])
            : 0,
          browserProcesses,
        }));
    }

    // Collect lockfile-only daemons (no SQLite worker row) then probe all in parallel.
    const lockfileOnlyDaemons: Array<{ wf: string; d: Daemon }> = [];
    for (const wf of workflows) {
      for (const d of aliveByWorkflow.get(wf) ?? []) {
        if (workers.some((worker) => worker.instanceId === d.instanceId || worker.pid === d.pid)) continue;
        lockfileOnlyDaemons.push({ wf, d });
      }
    }
    const statuses = await Promise.all(lockfileOnlyDaemons.map(({ d }) => probeDaemonStatus(d)));
    for (let i = 0; i < lockfileOnlyDaemons.length; i++) {
      const { wf, d } = lockfileOnlyDaemons[i];
      const status = statuses[i];
      out.push({
        workflow: d.workflow,
        workerId: d.instanceId,
        pid: d.pid,
        port: d.port,
        instanceId: d.instanceId,
        startedAt: d.startedAt,
        uptimeMs: Date.now() - new Date(d.startedAt).getTime(),
        itemsProcessed: countItemsProcessed(d.instanceId, queueLinesByWorkflow.get(wf) ?? []),
        currentItem: status.currentItem ?? null,
        currentRunId: status.currentRunId ?? null,
        currentTaskId: null,
        currentAttemptId: null,
        phase: status.phase ?? "unknown",
        status: "alive",
        heartbeatAgeMs: null,
        browserProcesses: [],
        lockfileAlive: true,
      });
    }
    return out;
  };
}

/**
 * Spawn N additional daemons for a workflow. Sequential — Duo isn't
 * parallelizable. `count` defaults to 1 (max 4 to prevent runaway spawns).
 */
export function buildDaemonsSpawnHandler(dir: string) {
  return async (
    req: SpawnDaemonRequest,
  ): Promise<{ ok: true; spawned: number } | { ok: false; error: string }> => {
    if (!req.workflow) return { ok: false, error: "workflow is required" };
    const count = Math.max(1, Math.min(4, req.count ?? 1));
    let spawned = 0;
    for (let i = 0; i < count; i++) {
      try {
        await spawnDaemon(req.workflow, dir);
        spawned++;
      } catch (err) {
        return {
          ok: false,
          error: `spawned ${spawned} of ${count} before failure: ${
            err instanceof Error ? err.message : String(err)
          }`,
        };
      }
    }
    return { ok: true, spawned };
  };
}

/**
 * Stop daemons. With `workflow`, stops all daemons for that workflow.
 * Without, attempts to stop every alive daemon across every workflow.
 */
export function buildDaemonsStopHandler(dir: string) {
  return async (
    req: StopDaemonsRequest,
  ): Promise<{ ok: true; stopped: number } | { ok: false; error: string }> => {
    const force = req.force === true;
    if (req.workflow) {
      const stopped = await stopDaemons(req.workflow, force, dir);
      return { ok: true, stopped };
    }
    // No workflow scoped — discover every workflow with alive daemons.
    const d = daemonsDir(dir);
    if (!existsSync(d)) return { ok: true, stopped: 0 };
    const names = new Set<string>();
    for (const file of readdirSync(d)) {
      const m = /^([^-]+(?:-[^-]+)*)-([a-f0-9]+)\.lock\.json$/.exec(file);
      if (m) names.add(m[1]);
    }
    let total = 0;
    for (const wf of names) {
      const stopped = await stopDaemons(wf, force, dir);
      total += stopped;
    }
    return { ok: true, stopped: total };
  };
}

/**
 * Stop ONE daemon by its session-drawer instance label (e.g. "Person Lookup
 * 2"), leaving the workflow's other daemons running. Sends the daemon a
 * `/stop` with `reassign: true`, so the daemon's own shutdown cleanup hands
 * its in-flight item to a surviving peer when one exists, or fails the item
 * when it's the last daemon (see `runDaemonShutdownCleanup`). This is the
 * dashboard session-card per-instance stop — distinct from the workflow-scoped
 * `stopDaemons` (StopAllButton), which tears down every daemon and fails
 * in-flight work.
 *
 * The instance → daemon mapping goes through session events: the instance's
 * `workflow_start.pid` identifies the daemon process; we match it to a live
 * lockfile to reach its port for a graceful `/stop`, falling back to a direct
 * signal if the lockfile is already gone. The session card is closed
 * immediately via a synthesized `workflow_end` (the daemon's own end event can
 * lag behind its teardown).
 */
/**
 * Direct-kill fallback cleanup: when a per-instance stop can't reach the
 * daemon through a live lockfile (`target` undefined) and falls back to a raw
 * `process.kill`, the daemon never runs its graceful reassign/fail cleanup —
 * so its in-flight claim would normally sit orphaned until a peer's dead-worker
 * recovery sweep re-queues it (an unbounded wait the operator can't see).
 *
 * Mirroring the daemon's own fail-loud path (and the standing "fail loud over
 * auto-correct" preference), this reads the killed daemon's in-flight claim
 * from the worker store (matched by pid) and fails it immediately so the
 * operator gets a terminal row right away instead of a silent wait.
 *
 * Best-effort throughout: if no claim is found, or the prior tracker row is
 * missing, it no-ops (the direct kill already happened; nothing to fail).
 * Returns the failed item id when it terminated a claim, else null.
 */
async function failDirectKilledInstanceClaim(
  dir: string,
  workflow: string,
  pid: number,
): Promise<string | null> {
  let stores: ReturnType<typeof openControlStores> | undefined;
  try {
    stores = openControlStores(dir);
    const { taskStore, workerStore } = stores;
    const worker = workerStore
      .listWorkers(workflow)
      .find((w) => w.pid === pid && w.currentTaskId);
    const taskId = worker?.currentTaskId;
    if (!taskId) return null;
    const task = taskStore.getTask(taskId);
    if (!task || !task.currentRunId) return null;
    // Only terminalize a claim that is still in-flight — never overwrite a row
    // that already reached a terminal state in the kill→cleanup window.
    if (task.state === "done" || task.state === "failed" || task.state === "cancelled") {
      return null;
    }
    const runId = task.currentRunId;
    const failReason =
      "Daemon was stopped (direct kill — lockfile already gone); its in-flight item was failed.";
    try {
      await markItemFailed(workflow, task.itemId, failReason, runId, dir);
    } catch {
      /* best-effort — the tracker row below is the user-visible signal */
    }
    if (task.currentAttemptId) {
      try {
        taskStore.markTaskFailed({
          taskId: task.taskId,
          attemptId: task.currentAttemptId,
          error: failReason,
        });
      } catch {
        /* best-effort */
      }
    }
    try {
      emitInheritedRow({
        workflow,
        trackerDir: dir,
        id: task.itemId,
        runId,
        status: "failed",
        error: failReason,
        ...(task.parentRunId ? { parentRunId: task.parentRunId } : {}),
        db: taskStore.db,
      });
    } catch {
      // PriorTrackerRowNotFoundError (no row to inherit from) — nothing to
      // emit; the queue-audit fail above is still the authoritative signal.
    }
    return task.itemId;
  } catch (err) {
    log.warn(
      `[stop-instance] failed to fail in-flight claim after direct kill of pid=${pid} for '${workflow}': ${errorMessage(err)}`,
    );
    return null;
  } finally {
    // taskStore + workerStore share one underlying control DB (openControlStores
    // opens it once), so closing either closes both — close once.
    try {
      stores?.taskStore.close();
    } catch {
      /* best-effort */
    }
  }
}

/**
 * Grace window for a gracefully-stopped daemon to emit its OWN `workflow_end`
 * before the per-instance stop synthesizes a fallback one. The daemon emits its
 * end a few tens of ms after acknowledging `/stop` (observed ~64ms), but its
 * teardown can lag — poll across this window so the common case returns fast and
 * a genuine lag still suppresses the synthesis.
 */
const DAEMON_OWN_END_GRACE_MS = 1_000;
const DAEMON_OWN_END_POLL_MS = 50;

/**
 * Decide whether a per-instance stop must SYNTHESIZE a `workflow_end(failed)` to
 * close the session card, or whether the daemon's OWN `workflow_end` will (or
 * already did) close it (ISS-004).
 *
 * - **Already ended** — the card is closed; never synthesize.
 * - **Graceful `/stop` path** (`daemonWillEmitOwnEnd`) — the daemon emits its own
 *   `workflow_end(done)` shortly after acknowledging `/stop`. Poll for it within
 *   the grace window and DON'T synthesize if it lands: the stop was clean +
 *   reassigned, so the daemon's `done` is the CORRECT event and a synthesized
 *   `failed` was a spurious, conflicting second end. Only synthesize as a
 *   fallback when the daemon's own end never arrives (crashed teardown / lag).
 * - **Direct-kill / unreachable** — the daemon can't emit its own end; synthesize
 *   immediately (the phantom-card guard the synthesis exists for).
 *
 * Pure but for the injected `hasInstanceEnded` (re-reads session events) and
 * `sleep`, so the branch logic is unit-testable without a live daemon.
 */
export async function shouldSynthesizeStopInstanceEnd(opts: {
  alreadyEnded: boolean;
  daemonWillEmitOwnEnd: boolean;
  hasInstanceEnded: () => boolean;
  graceMs?: number;
  pollMs?: number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<boolean> {
  const {
    alreadyEnded,
    daemonWillEmitOwnEnd,
    hasInstanceEnded,
    graceMs = DAEMON_OWN_END_GRACE_MS,
    pollMs = DAEMON_OWN_END_POLL_MS,
    sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
  } = opts;

  if (alreadyEnded) return false;
  if (!daemonWillEmitOwnEnd) return true;

  // Graceful path — wait briefly for the daemon's own end before falling back.
  if (hasInstanceEnded()) return false;
  let waited = 0;
  while (waited < graceMs) {
    await sleep(pollMs);
    waited += pollMs;
    if (hasInstanceEnded()) return false;
  }
  return true;
}

export function buildStopDaemonInstanceHandler(dir: string) {
  return async (req: StopDaemonInstanceRequest): Promise<StopDaemonInstanceResult> => {
    const workflow = req.workflow?.trim();
    const instance = req.instance?.trim();
    // Per-instance session-card stops default to forceful teardown;
    // workflow-scoped stop remains graceful by default.
    const force = req.force ?? true;
    const fail = (error: string): StopDaemonInstanceResult => ({
      ok: false,
      workflow: workflow ?? "",
      instance: instance ?? "",
      daemonStopped: false,
      browsersKilled: 0,
      reassignable: false,
      error,
    });
    if (!workflow) return fail("workflow is required");
    if (!instance) return fail("instance is required");

    // Resolve the instance's daemon pid + tracked browser pids from session
    // events, and whether the card was already closed.
    const events = readSessionEvents(dir);
    let startEvent: SessionEvent | undefined;
    let alreadyEnded = false;
    const browserPids = new Set<number>();
    for (const event of events) {
      if (event.workflowInstance !== instance) continue;
      if (workflowNameFromInstance(event.workflowInstance) !== workflow) continue;
      if (event.type === "workflow_start") startEvent = event;
      if (event.type === "workflow_end") alreadyEnded = true;
      if (event.type === "browser_launch" && typeof event.chromiumPid === "number") {
        browserPids.add(event.chromiumPid);
      }
    }
    const pid = startEvent?.pid;

    const alive = await findAliveDaemons(workflow, dir);
    const target = pid ? alive.find((d) => d.pid === pid) : undefined;
    // Whether another daemon will survive to absorb a reassigned item — best-
    // effort hint for the operator toast; the daemon makes the real decision.
    const reassignable = pid != null && alive.some((d) => d.pid !== pid);

    let daemonStopped = false;
    if (target) {
      // Graceful: the daemon's own cleanup reassigns or fails its in-flight
      // item. `reassign: true` is what flips it from the fail-on-stop default.
      await stopDaemon(target, force, true);
      daemonStopped = true;
    } else if (pid && pid !== process.pid) {
      // No live lockfile match (race, or lockfile already unlinked) — fall back
      // to a direct signal. This skips the daemon's graceful reassign/fail
      // cleanup, so we explicitly fail the daemon's in-flight claim (read from
      // the worker store) right here — otherwise it would sit orphaned until a
      // peer's dead-worker recovery sweep re-queues it, an unbounded wait the
      // operator can't see (fail-loud over eventual-recovery).
      try {
        process.kill(pid, force ? "SIGKILL" : "SIGTERM");
        daemonStopped = true;
      } catch {
        /* already dead */
      }
      const failedItemId = await failDirectKilledInstanceClaim(dir, workflow, pid);
      if (failedItemId) {
        log.step(
          `[stop-instance] direct kill of '${instance}' (pid=${pid}) — failed orphaned in-flight item '${failedItemId}'`,
        );
      }
    }

    // SIGKILL the instance's tracked chromium processes (best-effort).
    let browsersKilled = 0;
    if (force) {
      for (const bpid of browserPids) {
        try {
          process.kill(bpid, 0);
        } catch {
          continue;
        }
        try {
          process.kill(bpid, "SIGKILL");
          browsersKilled += 1;
        } catch (err) {
          log.warn(
            `[stop-instance] failed to SIGKILL chromium pid=${bpid} for '${instance}': ${errorMessage(err)}`,
          );
        }
      }
    }

    // Close the session card. In the graceful path the daemon emits its OWN
    // workflow_end(done) shortly after acknowledging /stop — wait briefly for it
    // and DON'T synthesize a conflicting workflow_end(failed) if it arrives
    // (ISS-004: the stop was clean + reassigned, so the daemon's `done` is the
    // correct event; the synthesized `failed` was a spurious second end ~64ms
    // earlier). Synthesize only as a fallback when the daemon's own end never
    // lands (direct-kill, crashed teardown, or lag) — the phantom-card guard.
    const daemonWillEmitOwnEnd = Boolean(target);
    const hasInstanceEnded = (): boolean =>
      readSessionEvents(dir).some(
        (event) =>
          event.type === "workflow_end" &&
          event.workflowInstance === instance &&
          workflowNameFromInstance(event.workflowInstance) === workflow,
      );
    if (await shouldSynthesizeStopInstanceEnd({ alreadyEnded, daemonWillEmitOwnEnd, hasInstanceEnded })) {
      try {
        emitWorkflowEnd(instance, "failed", dir);
      } catch (err) {
        log.warn(
          `[stop-instance] failed to synthesize workflow_end for '${instance}': ${errorMessage(err)}`,
        );
      }
    }

    invalidateAliveDaemonsCache(workflow, dir);
    return { ok: true, workflow, instance, daemonStopped, browsersKilled, reassignable };
  };
}
