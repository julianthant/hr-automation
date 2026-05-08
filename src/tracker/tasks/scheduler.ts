import { transaction } from "../../infra/sqlite/index.js";

import { trackEvent, type TrackerEntry } from "../jsonl.js";
import type { TaskStore } from "./store.js";
import {
  allDependenciesTerminal,
  listPendingDependencies,
  markDependencyTerminal,
  updateAttemptStatus,
  updateTaskStatus,
} from "./store.js";
import {
  applyOcrActiveCheckContinuation,
  applyOcrEidLookupContinuation,
} from "./ocr-continuation.js";

export interface ProjectedRun {
  workflow: string;
  id: string;
  runId?: string;
  parentRunId?: string;
  status: TrackerEntry["status"];
  step?: string;
  data?: Record<string, string>;
  error?: string;
  timestamp: string;
}

export interface DependencyProjectionReader {
  getLatestRun(args: { workflow: string; itemId: string; runId?: string }): Promise<ProjectedRun | null>;
  getLatestParentRun(args: { workflow: string; itemId: string; runId?: string }): Promise<ProjectedRun | null>;
}

export interface DependencySchedulerTickOpts {
  store: TaskStore;
  projection?: DependencyProjectionReader;
  now?: string;
  trackerDir?: string;
  emitTracker?: (entry: TrackerEntry) => void;
  limit?: number;
}

export interface DependencySchedulerTickResult {
  dependenciesScanned: number;
  dependenciesResolved: number;
  continuationsApplied: number;
  errors: string[];
}

export interface DependencySchedulerHandle {
  stop(): void;
}

export function startDependencyScheduler(opts: {
  trackerDir?: string;
  intervalMs?: number;
  onError?: (err: unknown) => void;
} = {}): DependencySchedulerHandle {
  const intervalMs = opts.intervalMs ?? 1000;
  let stopped = false;
  let running = false;

  const tick = async (): Promise<void> => {
    if (stopped || running) return;
    running = true;
    try {
      const result = await runDependencySchedulerTickForTrackerDir(opts.trackerDir);
      if (result.errors.length > 0) {
        throw new Error(result.errors.join("; "));
      }
    } catch (err) {
      opts.onError?.(err);
    } finally {
      running = false;
    }
  };

  const interval = setInterval(() => {
    void tick();
  }, intervalMs);
  void tick();

  return {
    stop() {
      stopped = true;
      clearInterval(interval);
    },
  };
}

export async function runDependencySchedulerTick(
  opts: DependencySchedulerTickOpts,
): Promise<DependencySchedulerTickResult> {
  const now = opts.now ?? new Date().toISOString();
  const projection = opts.projection ?? makePhase1ProjectionReader(opts.store);
  const emitTracker = opts.emitTracker ?? ((entry: TrackerEntry) => trackEvent(entry, opts.trackerDir));
  const pending = listPendingDependencies(opts.store, { limit: opts.limit ?? 100 });
  const result: DependencySchedulerTickResult = {
    dependenciesScanned: pending.length,
    dependenciesResolved: 0,
    continuationsApplied: 0,
    errors: [],
  };

  for (const dep of pending) {
    try {
      const childRun = await projection.getLatestRun({
        workflow: dep.child.workflow,
        itemId: dep.child.itemId,
        runId: dep.child.runId,
      });
      if (!childRun || !isTerminal(childRun.status)) continue;

      const terminalStatus = childRun.status === "done" || childRun.status === "skipped"
        ? "satisfied"
        : "failed";
      const childTaskStatus = childRun.status === "failed" ? "failed" : "done";
      let continuationApplied = false;

      if (dep.kind === "ocr-eid-lookup" || dep.kind === "ocr-active-check") {
        const parentRun = await projection.getLatestParentRun({
          workflow: dep.parent.workflow,
          itemId: dep.parent.itemId,
          runId: dep.parent.runId,
        });
        if (!parentRun) {
          result.errors.push(
            `OCR continuation skipped for dependency ${dep.id}: parent run ${dep.parent.runId ?? dep.parent.itemId} not found in projection`,
          );
          continue;
        }
        const continuation = dep.kind === "ocr-active-check"
          ? await applyOcrActiveCheckContinuation({
            store: opts.store,
            dependency: dep,
            parentRun,
            childRun,
            now,
            emitTracker,
          })
          : await applyOcrEidLookupContinuation({
            store: opts.store,
            dependency: dep,
            parentRun,
            childRun,
            now,
            emitTracker,
          });
        if (!continuation.ok) {
          result.errors.push(`OCR continuation skipped for dependency ${dep.id}: ${continuation.reason}`);
          continue;
        }
        continuationApplied = true;
      }

      transaction(opts.store.db, () => {
        markDependencyTerminal(opts.store, {
          dependencyId: dep.id,
          status: terminalStatus,
          result: {
            workflow: childRun.workflow,
            itemId: childRun.id,
            runId: childRun.runId,
            status: childRun.status,
            data: childRun.data ?? {},
            error: childRun.error,
          },
          now,
        });
        updateTaskStatus(opts.store, {
          taskId: dep.child.id,
          status: childTaskStatus,
          now,
        });
        updateAttemptStatus(opts.store, {
          taskId: dep.child.id,
          runId: dep.child.runId,
          status: childTaskStatus,
          now,
        });
        if (allDependenciesTerminal(opts.store, dep.parent.id)) {
          updateTaskStatus(opts.store, {
            taskId: dep.parent.id,
            status: "awaiting_child_results",
            now,
          });
        }
      });
      result.dependenciesResolved += 1;
      if (continuationApplied) result.continuationsApplied += 1;
    } catch (err) {
      result.errors.push(err instanceof Error ? err.message : String(err));
    }
  }

  return result;
}

export function makePhase1ProjectionReader(store: TaskStore): DependencyProjectionReader {
  return {
    async getLatestRun(args) {
      return readLatestProjectedRun(store, args);
    },
    async getLatestParentRun(args) {
      return readLatestProjectedRun(store, args);
    },
  };
}

export async function runDependencySchedulerTickForTrackerDir(
  trackerDir?: string,
): Promise<DependencySchedulerTickResult> {
  const { openTaskStore } = await import("./store.js");
  return runDependencySchedulerTick({ store: openTaskStore(trackerDir), trackerDir });
}

function readLatestProjectedRun(
  store: TaskStore,
  args: { workflow: string; itemId: string; runId?: string },
): ProjectedRun | null {
  const row = store.db.prepare(`
    SELECT
      workflow,
      item_id,
      run_id,
      parent_run_id,
      latest_status,
      latest_step,
      latest_data_json,
      latest_error,
      latest_tracker_ts
    FROM runs
    WHERE workflow = @workflow
      AND item_id = @itemId
      AND (@runId IS NULL OR run_id = @runId)
    ORDER BY latest_tracker_ts DESC
    LIMIT 1
  `).get({
    workflow: args.workflow,
    itemId: args.itemId,
    runId: args.runId ?? null,
  }) as {
    workflow: string;
    item_id: string;
    run_id: string | null;
    parent_run_id: string | null;
    latest_status: TrackerEntry["status"];
    latest_step: string | null;
    latest_data_json: string | null;
    latest_error: string | null;
    latest_tracker_ts: string;
  } | undefined;

  if (!row) return null;
  return {
    workflow: row.workflow,
    id: row.item_id,
    ...(row.run_id ? { runId: row.run_id } : {}),
    ...(row.parent_run_id ? { parentRunId: row.parent_run_id } : {}),
    status: row.latest_status,
    ...(row.latest_step ? { step: row.latest_step } : {}),
    data: parseStringRecord(row.latest_data_json),
    ...(row.latest_error ? { error: row.latest_error } : {}),
    timestamp: row.latest_tracker_ts,
  };
}

function isTerminal(status: TrackerEntry["status"]): boolean {
  return status === "done" || status === "failed" || status === "skipped";
}

function parseStringRecord(raw: string | null): Record<string, string> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === "string") out[key] = value;
      else if (value !== undefined && value !== null) out[key] = String(value);
    }
    return out;
  } catch {
    return {};
  }
}
