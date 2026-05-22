# Core — File Listing

Full file-by-file reference for `src/core/`. Orientation, design invariants, and lessons live in `src/core/CLAUDE.md`.

## `kernel/` — workflow execution primitives

- `types.ts` — `WorkflowConfig`, `Ctx`, `SystemConfig`, `RunOpts`, `WorkflowMetadata`, `DetailField`, `RetryOpts`. Single source of truth for the kernel surface.
- `workflow.ts` — `defineWorkflow`, `runWorkflowBatch` (sequential mode, wrapped in `withBatchLifecycle`), `buildTrackerOpts`, `deriveItemId`. `runWorkflowBatch` delegates to `runWorkflowPool` when `batch?.mode === "pool"` and to `runWorkflowSharedContextPool` when `"shared-context-pool"`. Public `runWorkflow` is re-exported from `run-workflow.ts`.
- `run-workflow.ts` — `runWorkflow` (single-item entry point). Implements the kernel envelope around `runOneItem` for non-batch callers.
- `session-observer.ts` — `createSessionObserver` factory used by `runWorkflow` and batch lifecycle for auth-timing observation.
- `workflow-tracker-data.ts` — `buildInitialTrackerData`, `splitPrefilled`, `toRecord`, `deriveItemId` shared helpers (extracted from `workflow.ts`).
- `pool.ts` — `runWorkflowPool`: N workers, each with its own Session. One Duo per worker. Queue-based distribution. Wraps body in `withBatchLifecycle` — per-worker `SessionObserver` captures per-worker `authTimings[]`.
- `shared-context-pool.ts` — `runWorkflowSharedContextPool`: one parent Session, N worker views via `Session.forWorker`, lazy per-worker pages. Wraps body in `withBatchLifecycle` with a single observer + shared `authTimings[]`.
- `batch-lifecycle.ts` — `withBatchLifecycle(...)` — shared lifecycle shell for every batch runner. Owns instance allocation, one `workflow_start`/`workflow_end` per batch, SIGINT fanout, and auth-failure fanout. Also exports `createBatchObserver`. **`ownSigint: false`** is the daemon-mode opt-out.
- `run-one-item.ts` — `runOneItem`: per-item `withLogContext` + `withTrackedWorkflow` wrapper; emits synthetic auth `running` entries from `authTimings[]`.
- `batch-helpers.ts` — shared batch utilities (item queue, worker dispatch).
- `session.ts` — `Session` class. `Session.launch(systems, opts)` does parallel browser launch → CDP tiling → auth chain (sequential / interleaved / parallel-staggered, all with 3-attempt retry). Exposes `page(id)`, `reset(id)`, `healthCheck(id)`, `killChrome`, `screenshotAll`.
- `stepper.ts` — `Stepper` class. Owns `currentStep`, `data`, `step` (wraps `fn` with emit-start + catch-screenshot-emit-fail + rethrow), `markStep`, `parallel`/`parallelAll`, `updateData`.
- `ctx.ts` — `makeCtx({ session, stepper, isBatch, runId })` — the only constructor for `Ctx`. Shared across all run modes.
- `registry.ts` — In-memory `WorkflowMetadata` map. `defineWorkflow` auto-registers; `register` is the escape hatch for direct metadata injection (tests, future non-kernel callers).
- `handler-runner.ts`, `screenshot.ts`, `ucpath-idle-hooks.ts` — handler lifecycle helpers.

## `daemon/` — daemon mode (persistent processes, SQLite queue)

- `types.ts` — `DaemonLockfile`, `Daemon`, `QueueEvent`, `QueueItem`, `QueueState`, `DaemonFlags`, `EnqueueResult`.
- `daemon-types.ts` — `DaemonPhase`, `DaemonState`, `DaemonInFlight` runtime state types shared across the split daemon modules.
- `registry.ts` — lockfile read/write, PID + `/whoami` liveness, `findAliveDaemons`, `spawnDaemon`.
- `queue.ts` — `enqueueItems`, `claimNextItem`, `markItemDone`/`Failed`/`Cancelled`, `unclaimItem`, `recoverOrphanedClaims`, `readQueueState`.
- `client.ts` — `ensureDaemonsAndEnqueue(wf, inputs, flags, opts)` — the ONE function every daemon-mode CLI adapter calls.
- `daemon.ts` — `runWorkflowDaemon(wf, opts)`: long-running daemon main loop. HTTP surface: `GET /whoami`, `POST /wake`, `POST /stop`. Delegates shutdown/cleanup, worker-command handling, and auth-timing rotation to sibling modules.
- `shutdown.ts` — `runDaemonShutdownCleanup`, `buildShutdownTrackerData`, `createAbortLaunchAndKillSession`. Terminalizes queued + in-flight items, preserves display metadata on cancellation rows.
- `worker-commands.ts` — `createHandleWorkerCommand`, `createPollWorkerCommands`, `startWorkerTickInterval`. Routes `cancel_task` / `drain_worker` / `stop_worker` / `kill_browser` / `health_check`; defaults unknown command types to `failCommand` so orphan recovery isn't blocked.
- `in-process-control.ts` — in-process control-DB hooks for HTTP / dashboard-initiated enqueues to live daemons.
- `in-process-runs.ts` — module-level registry of fire-and-forget `runWorkflow` calls inside the dashboard process; `/api/cancel-running` falls back here when no daemon claim exists (e.g. sharepoint-download). Hard-kills Chromium via `session.killChromeHard()` for Duo-stuck launches.
- `auth-timing.ts` — daemon-only auth timing rotation: `snapshotStartupAuthTimings`, `buildClaimAnchoredAuthTimings`, `createDaemonItemAuthTimingResolver`. Startup session launch + observer wiring stays inline in `daemon.ts`.
- `http.ts` — daemon HTTP server (express-like minimal server for control surface).
- `worker-store.ts` — daemon/dashboard worker rows, heartbeat, `worker_commands`, `browser_processes`.
- `keepalive.ts` — idle healthcheck + stale-worker recovery tick.
- `enqueue-dispatch.ts` — dispatch/wake helpers; HTTP enqueue pending-data shaping via `buildHttpPendingData` + `buildTrackerDataForInput`.

## `task-store/` — SQLite control plane

- `index.ts`, `enqueue.ts`, `claim.ts`, `retry.ts`, `terminal.ts`, `queries.ts`, `types.ts`, `child-state.ts`.

## Top-level files

- `control-db.ts` / `control-schema.ts` — open/migrate shared SQLite state DB.
- `workflow-loaders.ts` — lazy-import map for daemon spawn.
- `find-input.ts`, `task-control.ts`, `task-display.ts` — task lookup and display helpers.
- `cli-adapter.ts` — shared daemon-mode CLI adapter helpers (`buildCliAdapter`, `runCliEntry`) for validate/enqueue/pre-emit boilerplate.
- `index.ts` — public barrel.

> **Note (2026-04-23):** `idempotency.ts` and `step-cache.ts` were deleted. No tracker-side idempotency cache or step-cache remains in the kernel. Workflows needing dupe-protection use live-page probes (see separations' `findExistingTerminationTransaction`, oath-signature's existing-oath sentinel).
