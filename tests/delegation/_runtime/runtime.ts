import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID, type UUID } from "node:crypto";

import { Session } from "../../../src/core/kernel/session.js";
import { runWorkflowDaemon } from "../../../src/core/daemon/daemon.js";
import { clear } from "../../../src/core/kernel/registry.js";
import {
  enqueueItems,
  readQueueStateIncludingTerminals,
} from "../../../src/core/daemon/queue.js";
import { findAliveDaemons, invalidateAliveDaemonsCache } from "../../../src/core/daemon/registry.js";
import { _resetRunRegistryForTests } from "../../../src/core/run-registry.js";
import { closeStateDbForTests } from "../../../src/tracker/state/db.js";
import { buildCancelRunningHandler } from "../../../src/control/ops/cancel.js";
import { logFilePath, rowFilePath, rowsDir, logsDir } from "../../../src/tracker/paths.js";
import { dateLocal, parseWorkflowDateFilename } from "../../../src/tracker/jsonl.js";
import type { RegisteredWorkflow } from "../../../src/core/kernel/types.js";

import {
  createGateCoordinator,
  makeGatedWorkflow,
  type GateCoordinator,
  type GatedInput,
  type GatedWorkflowSpec,
} from "./scenario-handler.js";
import {
  snapshotRow,
  snapshotGroupAnchor,
  readRowTimeline,
  type RowSnapshot,
  type GroupAnchorSnapshot,
} from "./snapshot-row.js";

/** A registered workflow the harness can drive a daemon for. */
export type DelegationWorkflow = RegisteredWorkflow<GatedInput, readonly string[]>;

/**
 * A workflow registration with an explicit daemon-instance count. A single
 * daemon processes ONE run at a time (serial claim loop), so to hold N children
 * of the SAME workflow concurrently the harness must run N daemon instances
 * that race to claim through SQLite — mirroring how a real workflow scales its
 * daemon pool. `instances` defaults to 1.
 */
export interface WorkflowRegistration {
  workflow: DelegationWorkflow | GatedWorkflowSpec;
  /** Number of racing daemon instances for this workflow. Default 1. */
  instances?: number;
}

/** Fake `Session.launch` — no browsers, used by every harness daemon. */
function stubLaunch(): typeof Session.launch {
  return (async () =>
    Session.forTesting({
      systems: [],
      browsers: new Map(),
      readyPromises: new Map(),
    })) as unknown as typeof Session.launch;
}

export interface EnqueueOpts {
  /** Pre-assign the run id (else a fresh UUID). */
  runId?: string;
  /** Stamp `tasks.parent_run_id` so the row renders as a delegated child. */
  parentRunId?: string;
  /** Pre-assign the item id (else `deriveItemId(input)` or the input `id`). */
  itemId?: string;
  /**
   * Render the enqueued row as a delegated **batch member** (count badge +
   * member preview under the parent anchor). Stamps
   * `__runtimeOptions.rowShape = "batch-member"` on the input — exactly what
   * the real `approveTo` fan-out (`withBatchMemberRuntimeOptions`) does. Use
   * with `parentRunId` to model the OCR→oath-signature independent-child star
   * case. Without it, a `parentRunId`-enqueued row keeps the workflow's own
   * archetype (`single`) plus delegated scope.
   */
  renderAs?: "batch";
}

export interface WaitForEventOpts {
  /** Scope to one run (the primary match key). */
  runId?: string;
  /** Filter by `step` (for `step:start` / `step:done`). */
  step?: string;
  /** Filter by `occasion` (for `run:terminal`: completed/failed/cancelled). */
  occasion?: string;
  /** Filter by `childWorkflow` (for `delegation:children-spawned`). */
  childWorkflow?: string;
  /** Resolve only once N matching lines have appeared. Default 1. */
  count?: number;
  timeoutMs?: number;
}

/** One structured log line read from a `logs/<workflow>-<date>.jsonl` file. */
interface LogLine {
  workflow?: string;
  runId?: string;
  itemId?: string;
  event?: string;
  step?: string;
  occasion?: string;
  childWorkflow?: string;
  count?: number;
}

export interface DashboardView {
  /** Per-row projection — exactly what the React queue panel would render. */
  row(workflow: string, runId: string): RowSnapshot;
  /** Group-card projection for a batch/preview anchor (by parent run id). */
  groupAnchor(workflow: string, parentRunId: string): GroupAnchorSnapshot;
  /** Raw tracker entries for one run — assert on the full step sequence. */
  timeline(workflow: string, runId: string): ReturnType<typeof readRowTimeline>;
}

export interface CreateDelegationRuntimeOpts {
  /**
   * Workflows to register + start a daemon for. Either pre-built (via
   * `makeGatedWorkflow`), a `GatedWorkflowSpec` the runtime builds with its own
   * coordinator, or a `WorkflowRegistration` carrying an `instances` count for
   * concurrent-child fan-out (N racing daemons).
   */
  workflows: ReadonlyArray<DelegationWorkflow | GatedWorkflowSpec | WorkflowRegistration>;
  /** Reserved for OCR scenarios (P2.9) — a PDF the OCR seam will register. */
  pdf?: string;
  /** Daemon idle window. Keep small so daemons spin down promptly. */
  idleTimeoutMs?: number;
}

export interface DelegationRuntime {
  /** Temp tracker dir for this runtime — removed by `cleanup()`. */
  trackerDir: string;
  /** The registered workflows, keyed by name. */
  workflows: Map<string, DelegationWorkflow>;

  /** Enqueue one item for `workflow`. Returns the assigned `runId`. */
  enqueue(
    workflow: DelegationWorkflow | string,
    input?: Partial<GatedInput> & { id?: string },
    opts?: EnqueueOpts,
  ): Promise<{ runId: string; itemId: string }>;

  /**
   * Tail `logs/<workflow>-<date>.jsonl` across all daemons and resolve once the
   * named structured `event` (P1.6) has appeared `count` times (filtered by
   * `runId`/`step`/`occasion`/`childWorkflow`). No sleeps — pure log tailing.
   */
  waitForEvent(event: string, opts?: WaitForEventOpts): Promise<void>;

  /** Mark every run of `workflow` reaching `stage` as held until released. */
  holdAll(workflow: DelegationWorkflow | string, stage: string): void;
  /** Release a specific held stage for one run (lets it reach `done`). */
  release(runId: string, stage: string): void;

  /** Cancel a run through the REAL control-layer cancel path. */
  cancel(runId: string): Promise<void>;

  /** Child runs of `parentRunId` (by `tasks.parent_run_id` / JSONL parentRunId). */
  children(parentRunId: string): Promise<Array<{ workflow: string; runId: string; itemId: string }>>;

  /** REAL projection over the temp tracker (salvaged snapshot-row). */
  dashboard(): DashboardView;

  /** Stop all daemons + closeStateDbForTests + rm temp dir. Idempotent. */
  cleanup(): Promise<void>;

  /**
   * OCR LLM stub injector — SEAM for P2.9 (see CLAUDE.md). The generic harness
   * does not wire the real OCR orchestrator; P2.9 fleshes this using the
   * `_ocrPipelineOverride` / `_loadRosterOverride` pattern from
   * `tests/integration/ocr/end-to-end.test.ts`.
   */
  stubOcr(records: ReadonlyArray<Record<string, unknown>>): void;
}

/** Internal per-workflow daemon handle. */
interface DaemonHandle {
  workflow: string;
  port: number;
  runPromise: Promise<void>;
}

async function waitForDaemons(
  workflow: string,
  dir: string,
  count: number,
  timeoutMs = 8000,
): Promise<number[]> {
  const start = Date.now();
  for (;;) {
    invalidateAliveDaemonsCache(workflow, dir);
    const alive = await findAliveDaemons(workflow, dir);
    if (alive.length >= count) return alive.slice(0, count).map((d) => d.port);
    if (Date.now() - start > timeoutMs) {
      throw new Error(
        `daemon '${workflow}' only registered ${alive.length}/${count} within ${timeoutMs}ms`,
      );
    }
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** Every workflow that has written a logs/ file under `dir`. */
function listLogWorkflows(dir: string): string[] {
  const ldir = logsDir(dir);
  if (!existsSync(ldir)) return [];
  const names = new Set<string>();
  for (const file of readdirSync(ldir)) {
    const parsed = parseWorkflowDateFilename(file);
    if (parsed) names.add(parsed.workflow);
  }
  return [...names];
}

function readLogLines(workflow: string, dir: string): LogLine[] {
  const path = logFilePath(workflow, dateLocal(), dir);
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line) as LogLine;
      } catch {
        return {} as LogLine;
      }
    });
}

/**
 * Build a Tier-1 delegation runtime: one real daemon per workflow against a
 * temp tracker root, with no browser (every daemon uses `stubLaunch()`). All
 * tracker JSONL, SQLite state, and daemon lockfiles land under `trackerDir` —
 * the real `.tracker/` is never touched.
 */
export async function createDelegationRuntime(
  opts: CreateDelegationRuntimeOpts,
): Promise<DelegationRuntime> {
  const trackerDir = mkdtempSync(join(tmpdir(), "hrauto-delegation-"));
  // Fresh registry + run-registry so a prior test's workflows / in-flight runs
  // don't leak into this runtime.
  clear();
  _resetRunRegistryForTests();

  const coordinator = createGateCoordinator();

  // Register every workflow (build gated stubs from specs as needed) + record
  // its requested daemon-instance count.
  const workflows = new Map<string, DelegationWorkflow>();
  const instanceCounts = new Map<string, number>();
  for (const entry of opts.workflows) {
    const reg: WorkflowRegistration =
      "workflow" in entry ? entry : { workflow: entry };
    const wf =
      "config" in reg.workflow
        ? reg.workflow
        : makeGatedWorkflow(reg.workflow, coordinator);
    workflows.set(wf.config.name, wf);
    instanceCounts.set(wf.config.name, Math.max(1, reg.instances ?? 1));
  }

  // Start `instances` daemon(s) per workflow against the SAME temp trackerDir
  // (shared state.db; each daemon gets its own port + lockfile and races to
  // claim through SQLite). A single daemon's claim loop is serial — holding N
  // children of one workflow concurrently requires N racing daemons. Enqueue
  // happens later, so idle daemons wait for a wake/claim.
  const daemons: DaemonHandle[] = [];
  for (const wf of workflows.values()) {
    const count = instanceCounts.get(wf.config.name)!;
    const runPromises = Array.from({ length: count }, () =>
      runWorkflowDaemon(wf, {
        trackerDir,
        sessionLaunchFn: stubLaunch(),
        idleTimeoutMs: opts.idleTimeoutMs ?? 30_000,
        heartbeatIntervalMs: 40,
        commandPollIntervalMs: 40,
        lockHealIntervalMs: 100,
      }),
    );
    const ports = await waitForDaemons(wf.config.name, trackerDir, count);
    for (let i = 0; i < count; i++) {
      daemons.push({ workflow: wf.config.name, port: ports[i]!, runPromise: runPromises[i]! });
    }
  }

  const resolveWf = (workflow: DelegationWorkflow | string): DelegationWorkflow => {
    const name = typeof workflow === "string" ? workflow : workflow.config.name;
    const wf = workflows.get(name);
    if (!wf) throw new Error(`workflow '${name}' is not registered with this runtime`);
    return wf;
  };

  // ── enqueue ──────────────────────────────────────────────────────────────
  const enqueue: DelegationRuntime["enqueue"] = async (workflow, input, enqueueOpts) => {
    const wf = resolveWf(workflow);
    const item: GatedInput = {
      id: enqueueOpts?.itemId ?? input?.id ?? `item-${randomUUID().slice(0, 8)}`,
      ...(input ?? {}),
      // Mirror `withBatchMemberRuntimeOptions` — the real approve fan-out stamps
      // this so the daemon's pre-emit derives a `batch-member` archetype.
      ...(enqueueOpts?.renderAs === "batch"
        ? { __runtimeOptions: { rowShape: "batch-member" } }
        : {}),
    } as GatedInput;
    const runId = (enqueueOpts?.runId ?? randomUUID()) as UUID;
    const [enqueued] = await enqueueItems<GatedInput>(
      wf.config.name,
      [item],
      (d) => d.id,
      trackerDir,
      [runId],
      enqueueOpts?.parentRunId ? [enqueueOpts.parentRunId] : undefined,
    );
    // Wake every daemon instance of this workflow so one claims promptly
    // instead of waiting out the idle window. Best-effort — a missed wake just
    // means the next idle tick claims.
    await Promise.all(
      daemons
        .filter((d) => d.workflow === wf.config.name)
        .map((d) =>
          fetch(`http://127.0.0.1:${d.port}/wake`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: "{}",
          }).catch(() => undefined),
        ),
    );
    return { runId, itemId: enqueued!.id };
  };

  // ── waitForEvent ─────────────────────────────────────────────────────────
  const waitForEvent: DelegationRuntime["waitForEvent"] = (event, waitOpts) => {
    const want = waitOpts?.count ?? 1;
    const timeoutMs = waitOpts?.timeoutMs ?? 10_000;
    const start = Date.now();
    return new Promise<void>((resolve, reject) => {
      const tick = (): void => {
        let matches = 0;
        for (const name of listLogWorkflows(trackerDir)) {
          for (const line of readLogLines(name, trackerDir)) {
            if (line.event !== event) continue;
            if (waitOpts?.runId && line.runId !== waitOpts.runId) continue;
            if (waitOpts?.step && line.step !== waitOpts.step) continue;
            if (waitOpts?.occasion && line.occasion !== waitOpts.occasion) continue;
            if (waitOpts?.childWorkflow && line.childWorkflow !== waitOpts.childWorkflow) continue;
            matches++;
          }
        }
        if (matches >= want) {
          resolve();
          return;
        }
        if (Date.now() - start > timeoutMs) {
          reject(
            new Error(
              `waitForEvent("${event}"${
                waitOpts ? " " + JSON.stringify(waitOpts) : ""
              }) timed out after ${timeoutMs}ms (saw ${matches}/${want})`,
            ),
          );
          return;
        }
        setTimeout(tick, 25);
      };
      tick();
    });
  };

  // ── hold / release ───────────────────────────────────────────────────────
  const holdAll: DelegationRuntime["holdAll"] = (workflow, stage) => {
    coordinator.holdAll(resolveWf(workflow).config.name, stage);
  };
  const release: DelegationRuntime["release"] = (runId, stage) => {
    coordinator.release(runId, stage);
  };

  // ── cancel (REAL control-layer path) ─────────────────────────────────────
  // Drives the same handler the dashboard cancel button reaches:
  // `buildCancelRunningHandler` resolves the running task in SQLite (at this
  // temp trackerDir), flips it to cancel_requested, and enqueues a `cancel_task`
  // worker command. The owning daemon's poller picks it up → `requestCancel` →
  // `runRegistry.cancel(runId)` aborts the per-run AbortController → the held
  // stage's `ctx.signal` rejects → the stepper remaps it to a cancelled
  // terminal row.
  const cancel: DelegationRuntime["cancel"] = async (runId) => {
    // Find which workflow owns this run by scanning the latest row's workflow.
    const owner = findRunOwner(runId);
    if (!owner) {
      throw new Error(`cancel: no tracker row found for runId=${runId}`);
    }
    const r = await buildCancelRunningHandler(trackerDir)({
      workflow: owner,
      id: itemIdForRun(owner, runId) ?? runId,
      runId,
    });
    if (!r.ok) {
      throw new Error(`cancel(${runId}) rejected by control layer: ${r.error}`);
    }
  };

  const findRunOwner = (runId: string): string | undefined => {
    for (const name of listRowWorkflows()) {
      const rows = readTrackerRows(name);
      if (rows.some((row) => row.runId === runId)) return name;
    }
    return undefined;
  };

  const itemIdForRun = (workflow: string, runId: string): string | undefined => {
    for (const row of readTrackerRows(workflow)) {
      if (row.runId === runId) return row.id;
    }
    return undefined;
  };

  const readTrackerRows = (workflow: string): Array<{ id: string; runId?: string; parentRunId?: string }> => {
    const path = rowFilePath(workflow, dateLocal(), trackerDir);
    if (!existsSync(path)) return [];
    return readFileSync(path, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { id: string; runId?: string; parentRunId?: string });
  };

  // Every workflow that has written a rows/ file — includes in-process
  // delegated children whose workflow isn't a registered daemon here.
  const listRowWorkflows = (): string[] => {
    const dir = rowsDir(trackerDir);
    if (!existsSync(dir)) return [];
    const names = new Set<string>();
    for (const file of readdirSync(dir)) {
      const parsed = parseWorkflowDateFilename(file);
      if (parsed) names.add(parsed.workflow);
    }
    return [...names];
  };

  // ── children ─────────────────────────────────────────────────────────────
  const children: DelegationRuntime["children"] = async (parentRunId) => {
    const out: Array<{ workflow: string; runId: string; itemId: string }> = [];
    const seen = new Set<string>();
    for (const name of listRowWorkflows()) {
      for (const row of readTrackerRows(name)) {
        if (row.parentRunId === parentRunId && row.runId && !seen.has(row.runId)) {
          seen.add(row.runId);
          out.push({ workflow: name, runId: row.runId, itemId: row.id });
        }
      }
    }
    return out;
  };

  // ── dashboard ────────────────────────────────────────────────────────────
  const dashboard: DelegationRuntime["dashboard"] = () => ({
    row: (workflow, runId) =>
      snapshotRow({ trackerDir, workflow, runId, workflowLabel: resolveLabel(workflow) }),
    groupAnchor: (workflow, parentRunId) =>
      snapshotGroupAnchor({ trackerDir, workflow, parentRunId, workflowLabel: resolveLabel(workflow) }),
    timeline: (workflow, runId) => readRowTimeline({ trackerDir, workflow, runId }),
  });
  const resolveLabel = (workflow: string): string =>
    workflows.get(workflow)?.config.label ?? workflow;

  // ── stubOcr (seam for P2.9) ──────────────────────────────────────────────
  const stubOcr: DelegationRuntime["stubOcr"] = () => {
    throw new Error(
      "stubOcr is a P2.9 seam — wire the real runOcrOrchestrator overrides " +
        "(_ocrPipelineOverride / _loadRosterOverride / _enqueueEidLookupOverride) " +
        "per tests/integration/ocr/end-to-end.test.ts when building the OCR fan-out test.",
    );
  };

  // ── cleanup ──────────────────────────────────────────────────────────────
  let cleanedUp = false;
  const cleanup: DelegationRuntime["cleanup"] = async () => {
    if (cleanedUp) return;
    cleanedUp = true;
    for (const d of daemons) {
      await fetch(`http://127.0.0.1:${d.port}/stop`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }).catch(() => undefined);
    }
    await Promise.allSettled(daemons.map((d) => d.runPromise));
    try {
      closeStateDbForTests(trackerDir);
    } catch {
      /* best-effort */
    }
    try {
      rmSync(trackerDir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  };

  return {
    trackerDir,
    workflows,
    enqueue,
    waitForEvent,
    holdAll,
    release,
    cancel,
    children,
    dashboard,
    cleanup,
    stubOcr,
  };
}

export {
  createGateCoordinator,
  makeGatedWorkflow,
  type GateCoordinator,
  type GatedWorkflowSpec,
  type GatedInput,
} from "./scenario-handler.js";

/** Re-export for tests that progress-poll the queue directly. */
export { readQueueStateIncludingTerminals };
