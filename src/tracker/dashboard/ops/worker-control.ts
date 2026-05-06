import { existsSync, readFileSync, readdirSync } from "fs";
import { request as httpRequest } from "http";
import { join } from "path";
import {
  findAliveDaemons,
  spawnDaemon,
  daemonsDir,
} from "../../../core/daemon/registry.js";
import { queueFilePath } from "../../../core/daemon/queue.js";
import { stopDaemons } from "../../../core/daemon/client.js";
import type { Daemon } from "../../../core/daemon/types.js";
import type { BrowserProcessRow, WorkerRow } from "../../../core/daemon/worker-store.js";
import { openControlStores } from "./shared.js";

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

async function requestDaemonStopWorker(worker: WorkerRow | null): Promise<boolean> {
  if (!worker?.port) return false;
  try {
    const res = await fetch(`http://127.0.0.1:${worker.port}/stop`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ force: true }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function enqueueWorkerLifecycleCommand(
  dir: string,
  workerId: string,
  commandType: "drain_worker" | "stop_worker",
): Promise<{ ok: true; commandId: string } | { ok: false; error: string; status?: number }> {
  if (!workerId) return { ok: false, error: "workerId is required", status: 400 };
  const stores = openControlStores(dir);
  try {
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
  } finally {
    stores.close();
  }
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
function countItemsProcessed(workflow: string, instanceId: string, dir: string): number {
  const path = queueFilePath(workflow, dir);
  if (!existsSync(path)) return 0;
  const text = readFileSync(path, "utf8");
  let count = 0;
  // We track which runIds were claimed by this instance, then count
  // terminal events for those runIds — `done` / `failed` events carry
  // `runId` but not `claimedBy`.
  const runIdsForInstance = new Set<string>();
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let ev: import("../../../core/daemon/types.js").QueueEvent;
    try {
      ev = JSON.parse(line) as import("../../../core/daemon/types.js").QueueEvent;
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
    try {
      for (const wf of workflows) {
        aliveByWorkflow.set(wf, await findAliveDaemons(wf, dir));
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
          itemsProcessed: worker.instanceId ? countItemsProcessed(wf, worker.instanceId, dir) : 0,
          browserProcesses,
        }));
      }

      for (const wf of workflows) {
        const daemons = aliveByWorkflow.get(wf) ?? [];
        for (const d of daemons) {
          if (workers.some((worker) => worker.instanceId === d.instanceId || worker.pid === d.pid)) continue;
          const status = await probeDaemonStatus(d);
          out.push({
            workflow: d.workflow,
            workerId: d.instanceId,
            pid: d.pid,
            port: d.port,
            instanceId: d.instanceId,
            startedAt: d.startedAt,
            uptimeMs: Date.now() - new Date(d.startedAt).getTime(),
            itemsProcessed: countItemsProcessed(d.workflow, d.instanceId, dir),
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
      }
    } finally {
      stores.close();
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
