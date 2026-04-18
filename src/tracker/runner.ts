/**
 * Runner — child-process registry that lets the dashboard spawn workflows
 * the same way the operator's terminal does.
 *
 * Every workflow we know how to launch has an entry in `ARGV_MAP`. Each
 * mapper takes a validated input object and returns `{ command, args, dryArgs? }`
 * — `command` is what we exec (`npm` or `tsx`), `args` is the argv list,
 * and `dryArgs` (optional) is the alternate args used when the caller asks
 * for a dry run (typically swaps `start-onboarding` → `start-onboarding:dry`
 * or appends `--dry-run`). The mapper is intentionally a pure function so
 * we can table-test it without touching child_process.
 *
 * `RunnerRegistry` owns the in-flight `Map<runId, ChildProcess>` and enforces
 * a hard concurrency cap (default 4 — matches the kronos default worker pool
 * and is plenty for an operator-driven dashboard). A `RunnerError` is thrown
 * when the cap would be exceeded; the HTTP layer translates that to 429.
 *
 * The spawned child uses `withTrackedWorkflow` like any terminal-launched
 * run, so its `runId` and tracker entries appear in the dashboard JSONL
 * naturally. No env-var plumbing is required for runId propagation.
 *
 * IMPORTANT: We pipe stdout/stderr (rather than `inherit`) so the parent
 * process doesn't end up sharing TTY with the child — the JSONL on disk is
 * the canonical source for log data. We don't read those pipes; Node will
 * happily drain them as long as they're set to "pipe".
 */

import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";

/** Arguments needed to spawn a child for one workflow run. */
export interface SpawnArgs {
  /** Executable name on PATH — `npm` for npm-script invocations, `tsx` for direct CLI. */
  command: "npm" | "tsx";
  /** Argv list passed verbatim to the spawned process. */
  args: string[];
}

/**
 * argv mapper — pure function that converts a validated input object into a
 * spawn invocation. Takes an optional `dryRun` flag. Returns null if the
 * workflow is recognized but the input is missing a required field; throws
 * for unknown workflow names (caller pre-validates the workflow name against
 * the registry).
 */
type ArgvMapper = (input: Record<string, unknown>, opts?: { dryRun?: boolean }) => SpawnArgs;

/**
 * The argv table. One entry per launchable workflow. The shape mirrors
 * how the operator would type each command in a terminal — see CLAUDE.md
 * "Commands" section for the canonical list.
 *
 * For workflows that have a `:dry` npm script, the `dryRun` branch swaps
 * to that script. For workflows that take `--dry-run` as a flag, we append
 * it instead.
 *
 * Workflows NOT in this table are CLI-only (or just don't need a launcher).
 * The `/api/workflows/:name/run` endpoint returns 404 for those.
 */
export const ARGV_MAP: Record<string, ArgvMapper> = {
  onboarding: (input, opts) => {
    const email = String(input.email ?? "");
    if (!email) throw new Error("onboarding requires `email`");
    const script = opts?.dryRun ? "start-onboarding:dry" : "start-onboarding";
    return { command: "npm", args: ["run", script, "--", email] };
  },

  separations: (input, opts) => {
    // Accept either `docId` (single) or `docIds` (array — batch mode).
    let docIds: string[];
    if (Array.isArray(input.docIds)) {
      docIds = input.docIds.map(String).filter(Boolean);
    } else if (typeof input.docId === "string" && input.docId) {
      docIds = [input.docId];
    } else {
      throw new Error("separations requires `docId` or `docIds`");
    }
    if (docIds.length === 0) throw new Error("separations requires at least one docId");
    const script = opts?.dryRun ? "separation:dry" : "separation";
    return { command: "npm", args: ["run", script, "--", ...docIds] };
  },

  "work-study": (input, opts) => {
    const emplId = String(input.emplId ?? "");
    const effectiveDate = String(input.effectiveDate ?? "");
    if (!emplId) throw new Error("work-study requires `emplId`");
    if (!effectiveDate) throw new Error("work-study requires `effectiveDate`");
    const script = opts?.dryRun ? "work-study:dry" : "work-study";
    return { command: "npm", args: ["run", script, "--", emplId, effectiveDate] };
  },

  "emergency-contact": (input, opts) => {
    const batchPath = String(input.batchPath ?? input.batchYaml ?? "");
    if (!batchPath) throw new Error("emergency-contact requires `batchPath`");
    const script = opts?.dryRun ? "emergency-contact:dry" : "emergency-contact";
    return { command: "npm", args: ["run", script, "--", batchPath] };
  },

  "kronos-reports": (input, opts) => {
    // Kronos doesn't take per-call records — it uses `batch.yaml` from disk.
    // Optional `workers`, `startDate`, `endDate` flags are appended via the
    // npm-script `--` separator.
    const flags: string[] = [];
    if (typeof input.workers === "number" && Number.isFinite(input.workers) && input.workers > 0) {
      flags.push("--workers", String(input.workers));
    }
    if (typeof input.startDate === "string" && input.startDate) {
      flags.push("--start-date", input.startDate);
    }
    if (typeof input.endDate === "string" && input.endDate) {
      flags.push("--end-date", input.endDate);
    }
    const script = opts?.dryRun ? "kronos:dry" : "kronos";
    // npm requires `--` to forward flags to the underlying script.
    return { command: "npm", args: ["run", script, "--", ...flags] };
  },

  "eid-lookup": (input, opts) => {
    // eid-lookup has no npm script — operator runs `tsx --env-file=.env src/cli.ts eid-lookup ...`
    // We replicate that exactly.
    const names: string[] = Array.isArray(input.names) ? input.names.map(String).filter(Boolean) : [];
    if (names.length === 0) throw new Error("eid-lookup requires at least one name");
    const flags: string[] = [];
    if (typeof input.workers === "number" && Number.isFinite(input.workers) && input.workers > 0) {
      flags.push("--workers", String(input.workers));
    }
    if (input.useCrm === false) flags.push("--no-crm");
    if (opts?.dryRun) flags.push("--dry-run");
    return {
      command: "tsx",
      args: ["--env-file=.env", "src/cli.ts", "eid-lookup", ...flags, ...names],
    };
  },
};

export class RunnerError extends Error {
  /** HTTP status code for translation in the dashboard route layer. */
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "RunnerError";
    this.status = status;
  }
}

export interface ActiveRun {
  runId: string;
  workflow: string;
  pid: number;
  startedAt: string;
}

export interface SpawnResult {
  runId: string;
  pid: number;
  child: ChildProcess;
}

/** Default concurrency cap — overridable via constructor for tests. */
export const DEFAULT_MAX_CONCURRENT = 4;

/**
 * In-process registry of spawned workflow runs. Single instance per
 * dashboard server (see `getRunnerRegistry()`).
 */
export class RunnerRegistry {
  private inflight = new Map<string, { child: ChildProcess; workflow: string; startedAt: string }>();
  private maxConcurrent: number;
  /** Override for tests — mocks `child_process.spawn`. Default uses the real one. */
  private spawnFn: typeof spawn;

  constructor(opts: { maxConcurrent?: number; spawnFn?: typeof spawn } = {}) {
    this.maxConcurrent = opts.maxConcurrent ?? DEFAULT_MAX_CONCURRENT;
    this.spawnFn = opts.spawnFn ?? spawn;
  }

  /**
   * Spawn a workflow child. Throws `RunnerError(429, ...)` when the
   * concurrency cap is hit. Returns the new runId + pid + child reference.
   *
   * The runId is a fresh UUID per spawn — independent of the workflow's
   * own `withTrackedWorkflow` runId, which is what shows up in the
   * dashboard JSONL. We use this UUID purely to track the child process
   * here so the operator can cancel it.
   */
  spawn(workflow: string, spawnArgs: SpawnArgs): SpawnResult {
    if (this.inflight.size >= this.maxConcurrent) {
      throw new RunnerError(
        429,
        `Concurrency cap reached (${this.maxConcurrent} runs in flight). Wait for a run to finish or cancel one.`,
      );
    }

    const runId = randomUUID();
    // pipe stdout/stderr so the parent doesn't share a TTY with the child;
    // we ignore the pipe data because the JSONL on disk is the source of truth.
    const child = this.spawnFn(spawnArgs.command, spawnArgs.args, {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
      // Don't detach — we want the child to die when the parent dies,
      // but it's also independent enough that closing the dashboard tab
      // (frontend) doesn't kill it. The parent here is the SSE server.
      detached: false,
      env: process.env,
    });

    // Drain stdout/stderr so the pipes don't fill up and block the child.
    // We don't store the data — JSONL is the canonical record.
    if (child.stdout) child.stdout.on("data", () => { /* drain */ });
    if (child.stderr) child.stderr.on("data", () => { /* drain */ });

    const startedAt = new Date().toISOString();
    this.inflight.set(runId, { child, workflow, startedAt });

    // Auto-remove from registry when the child exits, regardless of cause.
    child.once("exit", () => {
      this.inflight.delete(runId);
    });
    child.once("error", () => {
      // spawn errors (e.g. ENOENT for `npm` not on PATH) — still clean up.
      this.inflight.delete(runId);
    });

    return { runId, pid: child.pid ?? -1, child };
  }

  /**
   * Cancel an in-flight run by sending SIGTERM. The child's
   * `withTrackedWorkflow` SIGINT/SIGTERM handler writes a `failed` tracker
   * entry before exiting, so the dashboard sees the cancellation naturally.
   *
   * Returns `true` when a run with that ID was found and signaled, `false`
   * if no such run exists (e.g. it already exited or was never spawned).
   */
  cancel(runId: string): boolean {
    const entry = this.inflight.get(runId);
    if (!entry) return false;
    try {
      entry.child.kill("SIGTERM");
    } catch {
      /* best-effort — child may have already exited between get and kill */
    }
    return true;
  }

  /** List all in-flight runs. Used by `GET /api/runs/active`. */
  list(): ActiveRun[] {
    return [...this.inflight.entries()].map(([runId, { child, workflow, startedAt }]) => ({
      runId,
      workflow,
      pid: child.pid ?? -1,
      startedAt,
    }));
  }

  /**
   * Kill all in-flight children. Called on SSE server shutdown so we don't
   * leave orphaned workflow processes when the dashboard is restarted.
   */
  cleanup(): void {
    for (const [runId, { child }] of this.inflight) {
      try {
        child.kill("SIGTERM");
      } catch {
        /* best-effort */
      }
      this.inflight.delete(runId);
    }
  }

  /** Test helper — current in-flight count. */
  size(): number {
    return this.inflight.size;
  }
}

/**
 * Process-wide singleton. The HTTP route handlers in `dashboard.ts` use
 * this; tests construct their own `RunnerRegistry` directly so they can
 * inject a `spawnFn` mock.
 */
let singleton: RunnerRegistry | null = null;
export function getRunnerRegistry(): RunnerRegistry {
  if (!singleton) singleton = new RunnerRegistry();
  return singleton;
}

/** Test helper — reset the singleton between tests. Not part of the public API. */
export function __resetRunnerRegistry(): void {
  if (singleton) singleton.cleanup();
  singleton = null;
}
