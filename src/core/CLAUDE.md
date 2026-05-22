# Core — Workflow Kernel

Declarative workflow primitives. Every kernel workflow is a `defineWorkflow({...})` call; `runWorkflow` / `runWorkflowBatch` / `runWorkflowPool` execute it. This directory is the canonical place to introduce new cross-cutting behavior (new step semantics, new run modes, new Ctx capabilities) — do NOT inline those concerns into individual workflow handlers.

This doc includes a user-facing primer below. The rest covers **internals**.

## User-facing primer

**Kernel API quick reference:**
- `defineWorkflow({ name, systems, steps, schema, operatorSubject, handler, ... })` — declare workflow with type-narrowed steps + auto-registered in dashboard
- `archetype: "single" | "batch" | "delegating" | "delegating-batch" | "utility"` — required; kernel stamps `data.archetype` on every tracker row so queue surface, log panel footer chip, and display-name resolver all dispatch on one field. Declare explicitly so `tests/unit/architecture/archetype-coverage.test.ts` passes.
- `ctx.page(id)` — Playwright Page for a system; blocks until auth is ready
- `ctx.step(name, fn)` — wraps your code, catches errors, screenshots on failure, emits to tracker
- `ctx.updateData(patch)` — merge into tracker entry's data field (use for operator-facing fields like emplId, name, etc.)
- `ctx.parallel({ task1, task2, ... })` — Promise.allSettled over multiple tasks
- Live-page dupe-protection: check the page state before submitting (e.g., `findExistingTerminationTransaction`) — no tracker cache
- `authChain: "sequential" | "interleaved"` — sequential: wait for each Duo before next; interleaved: auth#1 blocking, #2+ in background

**Minimal workflow example + archetype glossary:** `src/workflows/CLAUDE.md` → "Writing a new workflow".

## Daemon mode

Kernel workflows exposed on the CLI (`npm run separation`, `npm run work-study`, `npm run eid-lookup`, etc.) default to **daemon mode**:

- **First invocation with no alive daemon** → spawns one detached daemon (`tsx src/cli-daemon.ts <workflow>`), waits for auth (Duo once), enqueues the item. Daemon stays alive after processing.
- **Subsequent invocations** → insert into the shared SQLite queue (`tasks` table in `.tracker/state.db`, audit-appended to `.tracker/daemons/{workflow}.queue.jsonl` for `tail -f` debugging) and `POST /wake` every alive daemon. No re-Duo.
- **Multi-daemon dispatch**: all alive daemons for a workflow race to claim the next queued row via a single `UPDATE … RETURNING` against `tasks` indexed by `tasks_control_claimable_idx (workflow, control_state, priority DESC, enqueued_at ASC)`, run inside a `transaction(...)`. Dynamic load balancing without a coordinator.
- **Keepalive**: every 15 min idle, each daemon runs `session.healthCheck(system)` per system so SAML/Duo sessions don't silently expire between items.

Flags (on supported CLI commands):
- `-n, --new` — spawn one **additional** daemon even if others are alive.
- `-p, --parallel <N>` — ensure ≥N daemons are alive before enqueueing (spawns `max(0, N - alive)`).

Lifecycle: `npm run <workflow>:stop` — soft-stop (drain in-flight, re-queue). `-- --force` marks in-flight as failed immediately.

**Daemon-mode conversion guide:** `src/workflows/CLAUDE.md` → "Daemon-mode conversion template".  
**Implementation:** `src/core/daemon/{types,registry,queue,client,daemon}.ts` + `src/cli-daemon.ts`.  
**Design doc:** `docs/superpowers/specs/2026-04-22-workflow-daemon-mode-design.md`.

## Files

**`kernel/`** — workflow execution primitives:
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

**`daemon/`** — daemon mode (persistent processes, SQLite queue):
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

**`task-store/`** — SQLite control plane:
- `index.ts`, `enqueue.ts`, `claim.ts`, `retry.ts`, `terminal.ts`, `queries.ts`, `types.ts`, `child-state.ts`.

**Top-level:**
- `control-db.ts` / `control-schema.ts` — open/migrate shared SQLite state DB.
- `workflow-loaders.ts` — lazy-import map for daemon spawn.
- `find-input.ts`, `task-control.ts`, `task-display.ts` — task lookup and display helpers.
- `cli-adapter.ts` — shared daemon-mode CLI adapter helpers (`buildCliAdapter`, `runCliEntry`) for validate/enqueue/pre-emit boilerplate.
- `index.ts` — public barrel.

> **Note (2026-04-23):** `idempotency.ts` and `step-cache.ts` were deleted. No tracker-side idempotency cache or step-cache remains in the kernel. Workflows needing dupe-protection use live-page probes (see separations' `findExistingTerminationTransaction`, oath-signature's existing-oath sentinel).

## Design invariants

- **Every mode constructs Ctx via `makeCtx`.** This is why `runWorkflow`, `runWorkflowBatch`, and `runWorkflowPool` behave identically. Adding a new run mode? Use `makeCtx` — never hand-roll a `Ctx` literal.
- **`buildTrackerOpts(wf)` is shared across all modes.** Guarantees `declaredDetailFields`, `nameFn`, `idFn` land in lockstep on every mode's `withTrackedWorkflow` call. Subsystem D's runtime warning relies on this.
- **`operatorSubject` is required for new workflows.** The kernel stamps it into initial tracker data as `data.__subject` / `data.__subjectKind`; dashboard toasts, Telegram, task display, and later SQLite projections rely on it.
- **`data.archetype` is the canonical row-type discriminator.** Set by the kernel on every per-item tracker row via `withTrackedWorkflow` opts; set explicitly by orchestrator/prep code for `batch-parent`/`dispatch` rows that don't go through the per-item path. Dashboard queue surface, log panel footer chip, and display-name resolver dispatch on this single field. `resolveRowArchetype` still keeps read-time fallbacks for legacy JSONL (`data.mode === "prepare"`, `data.taskRole === "utility"`, `data.requestRole === "delegation-dispatch"`, then `parentRunId`) so old rows/tests remain readable, but new writes must stamp `data.archetype`. Declare `archetype` on every `defineWorkflow` call — the architecture guard in `tests/unit/architecture/archetype-coverage.test.ts` enforces this.
- **Convention owner for execution behavior.** New cross-workflow execution semantics, cancellation checks, task/control contracts, and `Ctx` capabilities belong in `src/core/`. Do not patch those into individual workflow handlers.
- **SQLite is live queue/control truth.** Daemon queue authority, worker ownership, command rows, retry attempts, and browser process targeting live in SQLite. JSONL queue/control writes are audit/history output during the transition. If you change queue/control behavior, update SQLite state and JSONL audit together, and never add a dashboard control that only mutates process-local state.
- **Daemon queue readers only see daemon tasks.** The shared SQLite `tasks` table also stores non-daemon dependency parents such as OCR rows (`task_kind = "ocr"`). `claimNextTask`, `readQueueState`, orphan sweeps, and position counts must filter to `task_kind = "workflow_item"` plus `source = "daemon"`; otherwise in-process parents can be mistaken for abandoned queue work and overwritten by daemon cleanup.
- **SIGINT ownership.** `withTrackedWorkflow` installs a SIGINT handler for real runs. The kernel's `runWorkflow` installs its own only in the `trackerStub` test branch. Two simultaneous handlers would double-write `failed` entries.
- **Auth chain semantics.** `authChain: "sequential"` — every `login` awaits the previous one before starting. `"interleaved"` — `login[0]` blocks, then `login[1..N]` are chained in the background via `.catch(() => {}).then(...)`. Each chain step swallows the predecessor's failure so one bad auth doesn't block the next. `"parallel-staggered"` — every system's IIFE registers its `readyPromise` synchronously, then awaits `i * staggerMs` before clicking submit. All Duos pend in parallel; total auth time is `max(single Duo) + (N-1)*staggerMs` instead of `sum(all Duos)`. `staggerMs` defaults to 5000ms (the rule-of-thumb spacing that avoids the multi-Duo collision documented in `src/infra/auth/CLAUDE.md`); tests override via `LaunchOpts.staggerMs`. Auth failures surface via the observer's `onAuthFailed`/`failed` tracker row, not by throwing out of `Session.launch`. `Session.page(id)` awaits that system's ready promise before returning in every mode, so handlers that call `ctx.page("system-b")` implicitly block until system-b's auth clears.
- **Per-item wrapping.** `runWorkflowBatch` and `runWorkflowPool` both wrap each item in `withLogContext` + `withTrackedWorkflow`. The caller never writes these names — they're kernel-internal. `trackerStub: true` is the only way to skip wrapping (tests use no-op emitters).
- **`preAssignedRunId` + `onPreEmitPending`** are the "dashboard shows the row before the first step runs" contract. Caller passes `runId` in, `onPreEmitPending` fires with the same `runId`, `withTrackedWorkflow` uses that `runId` for all subsequent events instead of generating its own. `deriveItemId` lets callers shape itemIds the built-in deriver (`emplId` → `docId` → `email` → UUID) can't produce.
- **`preAssignedInstance` + `authTimings`** are the "single batch instance + accurate per-system auth durations" contract. `withBatchLifecycle` allocates one instance name per batch and passes it into every `runOneItem` call as `preAssignedInstance`, which forwards to `withTrackedWorkflow` and suppresses its per-item `workflow_start` / `workflow_end` emits. `runOneItem` also accepts `authTimings: AuthTiming[]` (from `createBatchObserver.getAuthTimings()`) and, BEFORE invoking the handler, writes one synthetic `running` tracker entry per auth timing at the recorded `startTs` (step = `auth:<systemId>`). Result: every item's step pipeline tiles elapsed time exactly and shows real auth durations instead of collapsing auth into step 1. `pool` mode uses per-worker observers (each worker's items get that worker's `authTimings[]`); `sequential` + `shared-context-pool` share one observer for the entire batch.
- **Single timer per workflow — one anchor, one span.** Every dashboard timer for a run (header Elapsed, queue-row elapsed, step pipeline widths) MUST reference the same `t=0`, defined as the run's earliest tracker-entry timestamp. For batch items that is the synthetic auth `running` entry emitted at `onAuthStart`, NOT the first log line (which comes AFTER auth). The dashboard enforces this by folding `earliestTrackerTs` / `latestTrackerTs` from `buildRunTimelines` into each enriched entry's `firstLogTs` / `lastLogTs` — so `sum(stepDurations) ≡ lastLogTs − firstLogTs` tiles exactly. When adding a new run mode, preserve this by: (a) emitting the synthetic auth rows (already handled by `runOneItem` when `authTimings` is passed), and (b) keeping hub **`entries`** payloads (or any successor live feed) aligned with `buildRunTimelines`. If you invent a new timer source, document why it diverges — but the default answer is "reuse the existing anchor."
- **`runOrdinal` is backend-assigned, not runId-parsed.** The queue row's `#N` label and the RunSelector's `Run #N` label come from `runOrdinal` (chronological 1-indexed, derived from each run's earliest tracker timestamp). This works for both runId shapes — legacy `{id}#N` and UUIDs from batch/pool runners. `src/dashboard/components/log-panel/RunSelector.tsx` and `EntryItem.tsx` fall back to parsing `{id}#N` for older payloads, but new surfaces should consume `runOrdinal` directly. Never re-derive this client-side; `EntryItem` only sees one deduped entry and can't compute ordinals without the full runs list.

## Escape hatches

Workflows that need capabilities the declarative shape doesn't express reach for:

- **`ctx.session.page(id)`** — the raw authenticated Playwright `Page` for a system. Add new session escape hatches deliberately in `makeCtx` instead of leaving throwing stubs in the public surface.
- **`ctx.isBatch` / `ctx.runId`** — conditional logic for batch-only cleanup or runId-correlated external writes.
- **`runWorkerPool` from `src/utils/`** — in-handler fan-out that shares one `Session` across N tabs (used by eid-lookup for the "1 Duo, N searches" pattern the kernel's `pool` mode doesn't support — `pool` launches one Session per worker, which re-triggers Duo per worker).

When an escape hatch becomes a recurring pattern across workflows, promote it to a first-class kernel feature rather than letting it ossify in handlers.

## When NOT to touch this directory

- **Without updating all modes.** If you add a new field to `Ctx`, add it to `makeCtx`, verify `buildTrackerOpts` still works, and run both `runWorkflow` and `runWorkflowBatch` (sequential + pool branches) end-to-end.
- **Without updating tests.** Kernel tests live in `tests/unit/core/`. Changes to `Session.launch`, `Stepper.step`, or `buildTrackerOpts` likely need new fixtures.
- **Without updating docs that point here.** Future sessions reach kernel internals through root `CLAUDE.md` and module docs; keep those cross-references accurate when the public kernel surface changes.

## Run isolation in daemon mode

A daemon keeps one `workflowInstance` for its entire lifetime and processes many items (each with a distinct `runId`) under that single instance. Four rules keep events, step durations, and dashboard state from bleeding across items:

1. **Every per-item tracker row carries `runId` + `workflowInstance`.** Hub topic **`runEvents`** (multiplexed `GET /events/hub`) and `filterEventsForRun` trust `runId` first. Events with a `runId` that doesn't match the requested run are never shown.

2. **Orphan events (no `runId`) fall back to `workflowInstance` + time window.** `Session.launch` emits `auth_start` / `auth_complete` / `browser_launch` at batch scope with no runId. `filterEventsForRun` attributes these to a run only if they (a) share `workflowInstance` AND (b) fall within the run's `[firstTrackerTs, lastTrackerTs]` span. The time-window gate prevents daemon-lifetime events from leaking across items. `runEndFallback` (default `Date.now()`) extends the window for in-progress runs whose tracker hasn't emitted a terminal status yet.

3. **`itemInFlight` is the authoritative live-state signal.** The daemon emits `item_start` on claim and `item_complete` on release. Dashboard's `WorkflowInstanceState.itemInFlight` flips on those boundaries — use it for "Idle" vs "processing <doc>" UI, never infer live state from tracker rows.

4. **`authTimings` rotation in daemon mode.** Real per-system Duo durations are captured once at daemon startup and injected into item #1 only. Every subsequent item gets zero-duration synthetic `auth:<systemId>` tracker rows anchored at its claim time. Re-using startup timings for item #N would drag that item's `firstLogTs` back to daemon-start and inflate its elapsed timer by the full queue-wait gap.

## Lessons Learned

- **Lesson maintenance rule:** Before adding a core/kernel lesson, search this section for the same run mode, daemon lifecycle, or tracker contract. Merge dated migration notes into the current invariant whenever possible.
- **Daemon shutdown rows must preserve display metadata.** Cancellation/terminal rows emitted during daemon/browser shutdown need the same pending-row data (`buildHttpPendingData`), `data.archetype`, and `parentRunId`; sparse terminal rows overwrite rich rows in dashboard dedupe.
- **Task-store corruption should fail loud.** Malformed `tasks.input_json` must throw from `parseJson` with a raw-prefix diagnostic instead of coercing to `{}` and surfacing confusing workflow schema errors.
- **Queue SQLite mutations and JSONL audit share one boundary.** Claims, terminalization, unclaim, and recovery should snapshot one timestamp and wrap SQLite state mutation plus queue audit append in one `ControlDb.transaction(...)` so timeline ordering and rollback semantics stay aligned.
- **Claim recovery is lease-based, not only dead-worker based.** `claim_expires_at <= now` is recoverable even if the owner still heartbeats; queued/acknowledged cancel or force-stop commands still block recovery.
- **Active teardown requires exact run ids.** Voluntary/SIGINT unclaim paths must pass the claimed `runId`; newest-by-item fallback is only for recovery sweeps because item ids can be re-enqueued.
- **Browser disconnect during shutdown is cancellation.** Set `state.cancelTarget` from `state.inFlight` before waking shutdown so `Stepper.step` reclassifies browser/page-closed errors as `CancelledError` instead of failed workflow work.
- **Live-page probes replaced tracker-side caches.** `step-cache.ts`, `idempotency.ts`, `cache_hit` events, dashboard cache-hit enrichment, `runSeparationRecover`, and `separation:recover` are gone. Workflows that need duplicate protection should query the target system directly before writing.
- **Daemon run isolation uses runId first, then instance+time window.** `filterEventsForRun` trusts matching `runId`; orphan launch/auth/browser events are attributed only when `workflowInstance` matches and timestamps fall inside the run window.
- **Daemon lifecycle is explicit.** `runWorkflowDaemon` phase transitions (`launching`, `authenticating`, `idle`, `processing`, `keepalive`, `draining`, `exited`) feed `/status`; lockfiles self-heal while the daemon is alive and the heal interval is `.unref()`'d.
- **Auth/session logging has stable prefixes.** Use `[Auth: <id>]` for retry-loop messages and `[Session: <id>]` for browser lifecycle. `<ephemeral>` means no persistent sessionDir configured; keep it distinct from `<empty>` and `<none>`.
- **Batch lifecycle is shared.** New batch-like modes should call `withBatchLifecycle`, then feed `preAssignedInstance` and captured `authTimings` into `runOneItem`. If using `authChain: "interleaved"`, await `session.page(sys.id)` for every system before snapshotting auth timings.
- **Daemon mode is lifecycle-level, queue-backed execution.** It reuses `withBatchLifecycle({ ownSigint: false, perItem: [] })` and claims from SQLite over time. New daemon CLI adapters should use `buildCliAdapter`; bespoke adapters need a real grouping/failure-hook reason.
- **Between-item reset is one hook.** Use `betweenItems: ["reset"]`; the old `"reset-browsers"` / `"navigate-home"` split collapsed because both called `session.reset(id)`.
- **Verification screenshots belong on `Ctx`.** Reuse `ctx.captureAndStampScreenshot` for best-effort form screenshots that need to be stamped into tracker data instead of repeating workflow-local try/catch blocks.
