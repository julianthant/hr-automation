/**
 * Handler factories for the dashboard's operational endpoints — retry,
 * edit-and-resume, queue mutations, and daemon ops. All workflow-agnostic;
 * each handler takes a `workflow` param and operates on tracker / queue /
 * daemon-registry files keyed by that workflow.
 *
 * Factored out of dashboard.ts so the route bodies in that file stay short
 * and so each handler can be unit-tested with a fake `dir` argument
 * (mirroring `buildSelectorWarningsHandler`, `buildSearchHandler`, etc.).
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from "fs";
import { mkdir, rmdir } from "fs/promises";
import { setTimeout as delay } from "timers/promises";
import { request as httpRequest } from "http";
import { readEntries, trackEvent, type TrackerEntry } from "./jsonl.js";
import {
  findAliveDaemons,
  spawnDaemon,
  daemonsDir,
} from "../core/daemon-registry.js";
import { queueFilePath, queueLockDirPath } from "../core/daemon-queue.js";
import type { QueueEvent, Daemon } from "../core/daemon-types.js";
import { enqueueFromHttp } from "../core/enqueue-dispatch.js";
import { stopDaemons } from "../core/daemon-client.js";
import { join } from "path";

/** Lookup an entry's stored input by (workflow, id, runId?). Latest matching pending row wins. */
export function findEntryInput(
  workflow: string,
  id: string,
  runId: string | undefined,
  dir: string,
): { input: Record<string, unknown> } | { error: string } {
  const entries = readEntries(workflow, dir);
  // Filter to pending rows for the requested id (and runId if specified).
  // input only rides on pending rows by design (see TrackerEntry).
  const candidates = entries.filter((e) => {
    if (e.id !== id) return false;
    if (e.status !== "pending") return false;
    if (runId && e.runId !== runId) return false;
    return Boolean(e.input);
  });
  if (candidates.length === 0) {
    return { error: "no pending row with stored input found for this entry" };
  }
  // Latest pending wins (timestamps are ISO strings — lexicographic sort works).
  candidates.sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1));
  return { input: candidates[0].input as Record<string, unknown> };
}

/**
 * Latest accumulated `data` for an id across all rows (any status).
 * Used by edit-and-resume to seed prefilledData with non-editable fields
 * carried over from the previous run (e.g. separations' rawTerminationType
 * — needed by `mapReasonCode` downstream but not surfaced as an editable
 * field in the dashboard). Excludes kernel-internal keys (`__name`,
 * `__id`, `instance`) so those don't leak into a fresh run.
 */
export function findLatestEntryData(
  workflow: string,
  id: string,
  dir: string,
): Record<string, string> {
  const entries = readEntries(workflow, dir).filter((e) => e.id === id && e.data);
  if (entries.length === 0) return {};
  entries.sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1));
  const data = { ...(entries[0].data ?? {}) };
  delete data.__name;
  delete data.__id;
  delete data.instance;
  return data;
}

export interface RetryRequest {
  workflow: string;
  id: string;
  runId?: string;
}

/**
 * Single-entry retry: look up the original input from the pending row,
 * re-enqueue via the existing daemon dispatch path. The kernel auto-
 * increments runId so the new run shows up as a fresh row in the
 * dashboard's RunSelector.
 */
export function buildRetryHandler(dir: string) {
  return async (req: RetryRequest): Promise<{ ok: true } | { ok: false; error: string }> => {
    if (!req.workflow || !req.id) return { ok: false, error: "workflow and id are required" };
    const lookup = findEntryInput(req.workflow, req.id, req.runId, dir);
    if ("error" in lookup) return { ok: false, error: lookup.error };
    const result = await enqueueFromHttp(req.workflow, [lookup.input], dir);
    if (!result.ok) return { ok: false, error: result.error ?? "enqueue failed" };
    return { ok: true };
  };
}

export interface RetryBulkRequest {
  workflow: string;
  ids: string[];
}

export function buildRetryBulkHandler(dir: string) {
  const retry = buildRetryHandler(dir);
  return async (
    req: RetryBulkRequest,
  ): Promise<{ ok: true; count: number; errors: Array<{ id: string; error: string }> }> => {
    const errors: Array<{ id: string; error: string }> = [];
    let count = 0;
    for (const id of req.ids ?? []) {
      const r = await retry({ workflow: req.workflow, id });
      if (r.ok) count++;
      else errors.push({ id, error: r.error });
    }
    return { ok: true, count, errors };
  };
}

export interface RunWithDataRequest {
  workflow: string;
  id: string;
  data: Record<string, unknown>;
  runId?: string;
}

/**
 * Edit-and-resume: re-enqueue an entry with a `prefilledData` channel
 * attached to the original input. The kernel's splitPrefilled merges
 * those values into ctx.data before the handler runs; handlers that gate
 * their extraction step on data presence then skip extraction.
 */
export function buildRunWithDataHandler(dir: string) {
  return async (
    req: RunWithDataRequest,
  ): Promise<{ ok: true } | { ok: false; error: string }> => {
    if (!req.workflow || !req.id || !req.data || typeof req.data !== "object") {
      return { ok: false, error: "workflow, id, and data are required" };
    }
    const lookup = findEntryInput(req.workflow, req.id, req.runId, dir);
    if ("error" in lookup) return { ok: false, error: lookup.error };
    // Merge the previous run's accumulated data with the user's overrides.
    // The user's edits win on key collision. This carries non-editable
    // fields (e.g. separations' rawTerminationType — used by downstream
    // mapReasonCode but not surfaced as an editable detail field) into
    // the bypass path so the handler's gating check sees the full set
    // of required fields.
    const previousData = findLatestEntryData(req.workflow, req.id, dir);
    const mergedPrefill = { ...previousData, ...req.data };
    const inputWithPrefill = { ...lookup.input, prefilledData: mergedPrefill };
    const result = await enqueueFromHttp(req.workflow, [inputWithPrefill], dir);
    if (!result.ok) return { ok: false, error: result.error ?? "enqueue failed" };
    return { ok: true };
  };
}

/** Wrap a body in a fs.mkdir directory mutex so concurrent queue mutations serialize. */
async function withQueueLock<T>(
  workflow: string,
  dir: string,
  body: () => Promise<T>,
): Promise<T> {
  const lockDir = queueLockDirPath(workflow, dir);
  const start = Date.now();
  // Match the timing characteristics of claimNextItem (10 attempts × 100ms = 1s).
  for (let i = 0; i < 30; i++) {
    try {
      await mkdir(lockDir, { recursive: false });
      try {
        return await body();
      } finally {
        await rmdir(lockDir).catch(() => {});
      }
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EEXIST") {
        if (Date.now() - start > 5_000) {
          throw new Error("queue lock acquisition timed out");
        }
        await delay(100);
        continue;
      }
      throw err;
    }
  }
  throw new Error("queue lock acquisition exhausted");
}

export interface CancelQueuedRequest {
  workflow: string;
  id: string;
}

/**
 * Remove a queued item from the queue file. If the item has already been
 * claimed by a daemon, returns 409-style error. Cancellation appends a
 * synthetic `failed` queue event so `readQueueState` reflects the change,
 * and writes a `failed` tracker row with `step: "cancelled"` so the
 * dashboard's FAILED filter surfaces it (it can be retried like any other
 * failure).
 */
export function buildCancelQueuedHandler(dir: string) {
  return async (
    req: CancelQueuedRequest,
  ): Promise<{ ok: true } | { ok: false; error: string; status?: number }> => {
    if (!req.workflow || !req.id) return { ok: false, error: "workflow and id are required" };
    return withQueueLock(req.workflow, dir, async () => {
      const path = queueFilePath(req.workflow, dir);
      if (!existsSync(path)) return { ok: false as const, error: "queue file does not exist" };
      const text = readFileSync(path, "utf8");
      const lines = text.split("\n").filter((l) => l.trim());
      // Determine current state of the requested id by folding events.
      let state: "queued" | "claimed" | "done" | "failed" | "missing" = "missing";
      let runId: string | undefined;
      for (const line of lines) {
        let ev: QueueEvent;
        try {
          ev = JSON.parse(line) as QueueEvent;
        } catch {
          continue;
        }
        if (!ev || (ev as { id?: string }).id !== req.id) continue;
        if (ev.type === "enqueue") {
          state = "queued";
          runId = ev.runId;
        } else if (ev.type === "claim") {
          state = "claimed";
          runId = ev.runId;
        } else if (ev.type === "unclaim") {
          state = "queued";
        } else if (ev.type === "done") {
          state = "done";
        } else if (ev.type === "failed") {
          state = "failed";
        }
      }
      if (state === "missing") return { ok: false as const, error: "id not found in queue", status: 404 };
      if (state === "claimed") {
        return {
          ok: false as const,
          error: "item already claimed by a daemon — cannot cancel",
          status: 409,
        };
      }
      if (state === "done" || state === "failed") {
        return { ok: false as const, error: `item is already ${state}`, status: 410 };
      }
      // Append a synthetic `failed` queue event so the queue fold sees it
      // as terminal. We use `failed` (not a new `cancel` type) so existing
      // QueueEvent unions stay closed and readers don't need updating.
      const cancelEvent: QueueEvent = {
        type: "failed",
        id: req.id,
        failedAt: new Date().toISOString(),
        runId: runId ?? "",
        error: "cancelled by user from dashboard",
      };
      writeFileSync(path, text.endsWith("\n") || text === "" ? text : text + "\n", { flag: "w" });
      // Use append-style write — the lock guarantees exclusion.
      writeFileSync(path, JSON.stringify(cancelEvent) + "\n", { flag: "a" });

      // Mirror the cancellation onto the tracker so it shows up in the
      // dashboard's FAILED stat pill alongside genuine failures. Use
      // `step: "cancelled"` for clarity.
      trackEvent(
        {
          workflow: req.workflow,
          timestamp: new Date().toISOString(),
          id: req.id,
          runId,
          status: "failed",
          step: "cancelled",
          error: "cancelled by user from dashboard",
        },
        dir,
      );
      return { ok: true as const };
    });
  };
}

export interface QueueBumpRequest {
  workflow: string;
  id: string;
}

/**
 * Move a queued item to the head of the queue. Implemented as a queue-file
 * rewrite: we read the file, rebuild it with the bumped item's `enqueue`
 * event placed first, preserving every other event in original order. Only
 * `queued` items can be bumped.
 */
export function buildQueueBumpHandler(dir: string) {
  return async (
    req: QueueBumpRequest,
  ): Promise<{ ok: true } | { ok: false; error: string; status?: number }> => {
    if (!req.workflow || !req.id) return { ok: false, error: "workflow and id are required" };
    return withQueueLock(req.workflow, dir, async () => {
      const path = queueFilePath(req.workflow, dir);
      if (!existsSync(path)) return { ok: false as const, error: "queue file does not exist" };
      const text = readFileSync(path, "utf8");
      const lines = text.split("\n").filter((l) => l.trim());

      // Walk the events to find the target's enqueue event and confirm
      // the item is still queued (no claim / done / failed afterwards).
      let targetEnqueue: string | null = null;
      let state: "queued" | "claimed" | "done" | "failed" | "missing" = "missing";
      const otherLines: string[] = [];
      for (const line of lines) {
        let ev: QueueEvent;
        try {
          ev = JSON.parse(line) as QueueEvent;
        } catch {
          // Preserve unparseable lines verbatim.
          otherLines.push(line);
          continue;
        }
        if ((ev as { id?: string }).id !== req.id) {
          otherLines.push(line);
          continue;
        }
        if (ev.type === "enqueue") {
          if (targetEnqueue !== null) {
            // Duplicate enqueues for the same id are a queue-file
            // corruption; preserve verbatim and abort the bump.
            otherLines.push(line);
          } else {
            targetEnqueue = line;
            state = "queued";
          }
        } else if (ev.type === "claim") {
          state = "claimed";
          otherLines.push(line);
        } else if (ev.type === "unclaim") {
          state = "queued";
          otherLines.push(line);
        } else if (ev.type === "done") {
          state = "done";
          otherLines.push(line);
        } else if (ev.type === "failed") {
          state = "failed";
          otherLines.push(line);
        } else {
          otherLines.push(line);
        }
      }
      if (state === "missing" || targetEnqueue === null) {
        return { ok: false as const, error: "id not found in queue", status: 404 };
      }
      if (state !== "queued") {
        return {
          ok: false as const,
          error: `cannot bump item in state ${state}`,
          status: 409,
        };
      }
      // Rewrite: target enqueue first, then everything else in original order.
      const newText = [targetEnqueue, ...otherLines].join("\n") + "\n";
      writeFileSync(path, newText);
      return { ok: true as const };
    });
  };
}

export interface DaemonInfo {
  workflow: string;
  pid: number;
  port: number;
  instanceId: string;
  startedAt: string;
  uptimeMs: number;
  itemsProcessed: number;
  currentItem: string | null;
  phase: string;
}

/** Probe a single daemon's /status endpoint with a short timeout. */
async function probeDaemonStatus(
  daemon: Daemon,
  timeoutMs = 1000,
): Promise<{ phase?: string; currentItem?: string | null }> {
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
            const parsed = JSON.parse(body) as { phase?: string; inFlight?: { id?: string } | null };
            resolve({
              phase: parsed.phase,
              currentItem: parsed.inFlight?.id ?? null,
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
    let ev: QueueEvent;
    try {
      ev = JSON.parse(line) as QueueEvent;
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

/**
 * List alive daemons across one or all workflows, enriched with per-daemon
 * runtime stats (uptime, itemsProcessed, current item, phase).
 */
export function buildDaemonsListHandler(dir: string) {
  return async (workflow?: string): Promise<DaemonInfo[]> => {
    const workflows = workflow
      ? [workflow]
      : (() => {
          // Discover every workflow with a daemons/<wf>-*.lock.json by reading the daemons dir.
          const d = daemonsDir(dir);
          if (!existsSync(d)) return [];
          const names = new Set<string>();
          for (const file of readdirSync(d)) {
            const m = /^([^-]+(?:-[^-]+)*)-([a-f0-9]+)\.lock\.json$/.exec(file);
            if (m) names.add(m[1]);
          }
          return [...names];
        })();
    const out: DaemonInfo[] = [];
    for (const wf of workflows) {
      const daemons = await findAliveDaemons(wf, dir);
      for (const d of daemons) {
        const status = await probeDaemonStatus(d);
        out.push({
          workflow: d.workflow,
          pid: d.pid,
          port: d.port,
          instanceId: d.instanceId,
          startedAt: d.startedAt,
          uptimeMs: Date.now() - new Date(d.startedAt).getTime(),
          itemsProcessed: countItemsProcessed(d.workflow, d.instanceId, dir),
          currentItem: status.currentItem ?? null,
          phase: status.phase ?? "unknown",
        });
      }
    }
    return out;
  };
}

export interface SpawnDaemonRequest {
  workflow: string;
  count?: number;
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

export interface StopDaemonsRequest {
  workflow?: string;
  force?: boolean;
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

/** Resolve a daemon log file path from PID, validated against the daemon registry. */
export async function resolveDaemonLogPath(
  pid: number,
  dir: string,
): Promise<string | null> {
  const d = daemonsDir(dir);
  if (!existsSync(d)) return null;
  for (const file of readdirSync(d)) {
    if (!file.endsWith(".lock.json")) continue;
    let lock: { pid?: number; workflow?: string };
    try {
      lock = JSON.parse(readFileSync(join(d, file), "utf8")) as typeof lock;
    } catch {
      continue;
    }
    if (lock.pid === pid && lock.workflow) {
      const logPath = join(d, `${lock.workflow}-${pid}.log`);
      return existsSync(logPath) ? logPath : null;
    }
  }
  return null;
}

/** Per-workflow queue depth — count of `state === "queued"` items. */
export function readQueueDepth(workflow: string, dir: string): number {
  const path = queueFilePath(workflow, dir);
  if (!existsSync(path)) return 0;
  const text = readFileSync(path, "utf8");
  // Quick fold — count enqueues minus claims/dones/faileds for those ids.
  const states = new Map<string, "queued" | "claimed" | "done" | "failed">();
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let ev: QueueEvent;
    try {
      ev = JSON.parse(line) as QueueEvent;
    } catch {
      continue;
    }
    const id = (ev as { id?: string }).id;
    if (!id) continue;
    if (ev.type === "enqueue") states.set(id, "queued");
    else if (ev.type === "claim") states.set(id, "claimed");
    else if (ev.type === "unclaim") states.set(id, "queued");
    else if (ev.type === "done") states.set(id, "done");
    else if (ev.type === "failed") states.set(id, "failed");
  }
  let count = 0;
  for (const s of states.values()) if (s === "queued") count++;
  return count;
}
