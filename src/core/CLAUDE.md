# Core — Workflow Kernel

Declarative workflow primitives. Every kernel workflow is a `defineWorkflow({...})` call; `runWorkflow` / `runWorkflowBatch` / `runWorkflowPool` execute it. This directory is the canonical place to introduce new cross-cutting behavior (new step semantics, new run modes, new Ctx capabilities) — do NOT inline those concerns into individual workflow handlers.

This doc includes a user-facing primer below. The rest covers **internals**.

## User-facing primer

**Kernel API quick reference:**
- `defineWorkflow({ name, systems, steps, schema, operatorSubject, handler, ... })` — declare workflow with type-narrowed steps + auto-registered in dashboard
- `archetype: "single" | "batch" | "delegating" | "delegating-batch" | "utility"` — required; kernel stamps `data.archetype` on every tracker row so queue surface, log panel footer chip, and display-name resolver all dispatch on one field. Declare explicitly so `tests/unit/architecture/archetype-coverage.test.ts` passes.
- `ctx.page(id)` — Playwright Page for a system; blocks until auth is ready. Returns a signal-injecting Proxy (Contract 5): every method that accepts a `signal?: AbortSignal` option auto-receives `ctx.signal`, so operator cancel rejects in-flight Playwright calls within ms instead of waiting on the call's declared timeout.
- `ctx.signal` — per-run `AbortSignal` sourced from a per-item `AbortController` the kernel constructs. Passes to anything AbortSignal-aware (`fetch`, `setTimeout`, custom helpers); the Page proxy passes it implicitly into all signal-aware Playwright methods (`click`, `fill`, `goto`, `waitForSelector`, `screenshot`, etc. — NOT `evaluate` / `$eval` / `$$eval`: those take `(fn, arg)` with no options bag, so the proxy can't inject signal there; rely on the between-step `isCancelRequested` probe for those). On abort, the kernel's stepper remaps the resulting AbortError into `CancelledError` and stamps `step: "cancelled"` — same terminal-row shape as soft cancel.
- `ctx.step(name, fn)` — wraps your code, catches errors, screenshots on failure, emits to tracker
- `ctx.updateData(patch)` — merge into tracker entry's data field (use for operator-facing fields like emplId, name, etc.)
- `ctx.parallel({ task1, task2, ... })` — Promise.allSettled over multiple tasks
- `ctx.delegateTo(child, input, opts?)` — run a single child workflow in-process, await its terminal status, return a typed `ChildRunResult`. Kernel handles parentRunId stamping, archetype derivation, pre-emit, pristine input persistence (Contract 3). `opts.renderAs: "batch" | "preview" | "flat"` overrides the child's row archetype; `opts.fireAndForget: true` returns immediately with `status: "pending"`.
- `ctx.delegateToAll(child, inputs, opts?)` — fan out to N child runs. Dispatches via daemon enqueue when the child is daemon-capable (registered in `WORKFLOW_LOADERS`); otherwise runs in-process with optional `opts.concurrency`. Awaits all terminal statuses via `watchChildRuns` (daemon path) or per-run promises (in-process).
- Live-page dupe-protection: check the page state before submitting (e.g., `findExistingTerminationTransaction`) — no tracker cache
- `authChain: "sequential" | "interleaved"` — sequential: wait for each Duo before next; interleaved: auth#1 blocking, #2+ in background

**Minimal workflow example + archetype glossary:** `src/workflows/CLAUDE.md` → "Writing a new workflow".

## Daemon mode

Kernel workflows exposed on the CLI (`npm run separation`, `npm run work-study`, `npm run eid-lookup`, etc.) default to **daemon mode**:

- **First invocation with no alive daemon** → spawns one detached daemon (`tsx src/cli-daemon.ts <workflow>`), waits for auth (Duo once), enqueues the item. Daemon stays alive after processing.
- **Subsequent invocations** → insert into the shared SQLite queue (`tasks` in `.tracker/state.db`) and `POST /wake` every alive daemon. No re-Duo. Queue audit: `.tracker/daemons/{workflow}.queue.jsonl`.
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

→ Full file listing: `docs/engineering/core-internals.md`

## Design invariants

- **Every mode constructs Ctx via `makeCtx`.** This is why `runWorkflow`, `runWorkflowBatch`, and `runWorkflowPool` behave identically. Adding a new run mode? Use `makeCtx` — never hand-roll a `Ctx` literal.
- **`buildTrackerOpts(wf)` is shared across all modes.** Guarantees `declaredDetailFields`, `nameFn`, `idFn` land in lockstep on every mode's `withTrackedWorkflow` call. Subsystem D's runtime warning relies on this.
- **`operatorSubject` is required for new workflows.** Kernel stamps it as `data.__subject`/`data.__subjectKind`; toasts, task display, and SQLite projections rely on it.
- **`data.archetype` is the canonical row-type discriminator.** Every tracker row goes through `emitTrackerRow` from `src/tracker/jsonl-io.ts`, which requires `data: StampedData` (`Record<string, string> & { archetype: RowArchetype }`) at the type level. The kernel auto-stamps via `runOneItem` / `cli-adapter` / `pre-emit-helpers` using `deriveRowArchetype(wf.archetype, parentRunId)`. Orchestrator + prep code stamps explicitly (`batch-parent` for OCR prep parents, `delegate-child` for fan-out children). Control-layer cancel/retry rows inherit archetype from the prior tracker row via `resolveRowArchetype`. Declare `archetype` on every `defineWorkflow` call (architecture guard: `tests/unit/architecture/archetype-coverage.test.ts`); architecture guard `tests/unit/architecture/tracker-row-emission.test.ts` blocks new direct callers of the legacy `trackEvent` alias. `resolveRowArchetype` throws on rows with an invalid stamped `data.archetype`; missing archetype falls back to the canonical mapping (`delegate-child` with parent, else `single`). The legacy heuristics (`mode === "prepare"` etc.) are gone.
- **Convention owner for execution behavior.** New cross-workflow execution semantics, cancellation checks, task/control contracts, and `Ctx` capabilities belong in `src/core/`. Do not patch those into individual workflow handlers.
- **SQLite is live queue/control truth.** Daemon queue authority, worker ownership, command rows, retry attempts, and browser process targeting live in SQLite. JSONL queue/control writes are audit/history output during the transition. If you change queue/control behavior, update SQLite state and JSONL audit together, and never add a dashboard control that only mutates process-local state.
- **Pristine original input is preserved per task.** `tasks.original_input_json` (migration 11) snapshots the input the task was first enqueued with. `enqueueTasks` writes it on INSERT; `retryTaskFromAttempt` resets `input_json ← original_input_json` so retries replay with the original payload, never accumulated state from a prior run. Read via `findOriginalInputForRunId`. Contract 2 (Uniform Retry) — see `src/control/CLAUDE.md` → "Retry contract".
- **Delegation routes through the kernel (Contract 3).** Workflows compose like functions via `ctx.delegateTo(child, input, opts?)` and `ctx.delegateToAll(child, inputs, opts?)`. The kernel stamps `parentRunId` from `ctx.runId`, pre-emits the child's pending row through `emitTrackerRow` with archetype derived via `deriveRowArchetype(child.archetype, parentRunId)` (or `opts.renderAs` override), and persists the pristine input on the pending row's `input` field (Contract 2 tier 2) — daemon-dispatched fan-outs also write `tasks.original_input_json` (Contract 2 tier 1). Workflow handlers must NOT call `runWorkflow(child, ..., { parentRunId: ... })` or `ensureDaemonsAndEnqueue(child, ..., { parentRunId: ... })` directly — the architecture guard at `tests/unit/architecture/delegate-to-usage.test.ts` blocks new occurrences. The internal `delegateToAllImpl` exposes `deriveItemId`, `buildPendingExtras`, and `onPreparedItems` hooks for orchestrators (OCR's eid-lookup fan-out) that need to wire SQLite task dependencies into the dispatch lifecycle; those hooks are NOT on the public `ctx` surface.
- **Cancel is one mechanism via per-run `AbortController` (Contract 5).** Every `runOneItem` constructs an `AbortController`; its `signal` rides on `ctx.signal` and is auto-injected into every Playwright method that accepts `signal?: AbortSignal` via the Page proxy returned by `ctx.page(id)` (see `src/core/kernel/page-proxy.ts`). When the daemon receives a `cancel_task` worker command (or the HTTP `/cancel-current` route fires), it both sets `state.cancelTarget` AND calls `controller.abort()` on `state.currentRunController` — so any in-flight `waitForSelector` / `click` / `goto` rejects within ms instead of waiting on its declared timeout. The stepper's existing between-step `isCancelRequested` probe remains as the synchronous-checkpoint when no Playwright call is in flight; both paths converge on `CancelledError('cancelled')` + `step: "cancelled"` on the terminal row. Soft/force-stop distinction is gone — there is no `/api/task/force-stop` route, no `CancelMode` type, no Force Stop button. See `src/control/CLAUDE.md` → "Cancel contract".
- **Daemon queue readers only see daemon tasks.** The shared SQLite `tasks` table also stores non-daemon dependency parents such as OCR rows (`task_kind = "ocr"`). `claimNextTask`, `readQueueState`, orphan sweeps, and position counts must filter to `task_kind = "workflow_item"` plus `source = "daemon"`; otherwise in-process parents can be mistaken for abandoned queue work and overwritten by daemon cleanup.
- **SIGINT ownership.** `withTrackedWorkflow` installs a SIGINT handler for real runs. The kernel's `runWorkflow` installs its own only in the `trackerStub` test branch. Two simultaneous handlers would double-write `failed` entries.
- **Auth chain semantics.** `"sequential"` — each login awaits the previous. `"interleaved"` — `login[0]` blocks, `login[1+]` chain in background (each swallows predecessor failure). `"parallel-staggered"` — all Duos pend simultaneously with `staggerMs` (default 5000ms) spacing; total auth time is `max(single Duo) + (N-1)*staggerMs`. Auth failures surface via observer's `failed` tracker row, not by throwing from `Session.launch`. `ctx.page(id)` always blocks until that system's auth clears. Full details: `src/infra/auth/CLAUDE.md`.
- **Per-item wrapping.** `runWorkflowBatch` and `runWorkflowPool` both wrap each item in `withLogContext` + `withTrackedWorkflow`. The caller never writes these names — they're kernel-internal. `trackerStub: true` is the only way to skip wrapping (tests use no-op emitters).
- **`preAssignedRunId` + `onPreEmitPending`** — caller passes `runId` in; `withTrackedWorkflow` uses it for all events so the dashboard shows the pending row before step 1 runs. `deriveItemId` shapes itemIds the built-in deriver can't produce.
- **`preAssignedInstance` + `authTimings`** — `withBatchLifecycle` allocates one instance name and passes it into every `runOneItem` as `preAssignedInstance`, suppressing per-item `workflow_start`/`workflow_end` emits. `runOneItem` writes synthetic `running` tracker entries per auth timing BEFORE the handler runs so the step pipeline tiles real auth durations. `pool` uses per-worker observers; `sequential`/`shared-context-pool` share one.
- **Single timer — one anchor.** Every dashboard timer references the run's earliest tracker-entry timestamp as `t=0` (the synthetic auth entry, not the first log line). `buildRunTimelines` folds `earliestTrackerTs`/`latestTrackerTs` into `firstLogTs`/`lastLogTs` so `sum(stepDurations) ≡ lastLogTs − firstLogTs`. New run modes must emit synthetic auth rows and keep hub `entries` payloads aligned.
- **`runOrdinal` is backend-assigned.** `#N` labels come from `runOrdinal` (1-indexed by earliest tracker timestamp), not runId parsing. Never re-derive client-side.

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

→ Full details: `docs/engineering/core-internals.md`

Key rules: (1) every per-item row carries `runId` + `workflowInstance`; `filterEventsForRun` trusts `runId` first. (2) Orphan launch/auth events (no `runId`) are attributed only if `workflowInstance` matches AND timestamps fall inside the run's `[firstTrackerTs, lastTrackerTs]` window. (3) `itemInFlight` (from `item_start`/`item_complete` daemon events) is the live-state signal — never infer from tracker rows. (4) Startup `authTimings` inject into item #1 only; subsequent items get zero-duration synthetic rows anchored at claim time.

## Lessons Learned

- **Lesson maintenance rule:** Before adding a core/kernel lesson, search this section for the same run mode, daemon lifecycle, or tracker contract. Merge dated migration notes into the current invariant whenever possible.
- **Daemon shutdown rows must preserve display metadata.** Cancellation/terminal rows emitted during daemon/browser shutdown need the same pending-row data (`buildHttpPendingData`), `data.archetype`, and `parentRunId`; sparse terminal rows overwrite rich rows in dashboard dedupe.
- **Task-store corruption should fail loud.** Malformed `tasks.input_json` must throw from `parseJson` with a raw-prefix diagnostic instead of coercing to `{}` and surfacing confusing workflow schema errors.
- **Queue SQLite + JSONL audit share one transaction boundary.** Wrap SQLite state mutation + audit append in one `ControlDb.transaction(...)` with a shared timestamp.
- **Claim recovery is lease-based.** `claim_expires_at <= now` is recoverable even if the worker still heartbeats; pending cancel/force-stop commands block recovery.
- **Active teardown requires exact run ids.** Voluntary/SIGINT unclaim paths must pass the claimed `runId`; newest-by-item fallback is only for recovery sweeps because item ids can be re-enqueued.
- **Browser disconnect during shutdown is cancellation.** Set `state.cancelTarget` from `state.inFlight` before waking shutdown so `Stepper.step` reclassifies browser/page-closed errors as `CancelledError` instead of failed workflow work.
- **Live-page probes replaced tracker-side caches.** `step-cache.ts`, `idempotency.ts`, and all cache-hit infrastructure are gone. Query the target system directly before writing for dupe protection.
- **Daemon run isolation uses runId first, then instance+time window.** `filterEventsForRun` trusts matching `runId`; orphan launch/auth/browser events are attributed only when `workflowInstance` matches and timestamps fall inside the run window.
- **Daemon lifecycle is explicit.** Phase transitions (`launching`→`authenticating`→`idle`→`processing`→`keepalive`→`draining`→`exited`) feed `/status`; lockfiles self-heal and the heal interval is `.unref()`'d.
- **Auth/session logging prefixes.** `[Auth: <id>]` for retry-loop; `[Session: <id>]` for browser lifecycle. `<ephemeral>` = no persistent sessionDir.
- **Batch lifecycle is shared.** New batch-like modes call `withBatchLifecycle` then feed `preAssignedInstance` + `authTimings` into `runOneItem`. With `"interleaved"` auth, await every `session.page(sys.id)` before snapshotting timings.
- **Daemon mode reuses `withBatchLifecycle({ ownSigint: false })`.** New daemon adapters use `buildCliAdapter`.
- **Daemon spawn is serialized per workflow.** `ensureDaemonsAndEnqueue` wraps discover + spawn in `withDaemonSpawnLock` (in-process, keyed by `workflow` + `trackerDir`) to prevent the TOCTOU race where two simultaneous enqueues each see 0 alive daemons and both spawn — producing duplicate `<Workflow> 1 / <Workflow> 2` instances. Lock is in-process only; separate CLI processes are not covered.
- **Between-item reset is one hook.** Use `betweenItems: ["reset"]`; the old `"reset-browsers"` / `"navigate-home"` split collapsed because both called `session.reset(id)`.
- **Verification screenshots belong on `Ctx`.** Reuse `ctx.captureAndStampScreenshot` for best-effort form screenshots that need to be stamped into tracker data instead of repeating workflow-local try/catch blocks.
