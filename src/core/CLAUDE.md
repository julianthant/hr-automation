# Core — Workflow Kernel

Declarative workflow runtime. Cross-workflow execution behavior, cancellation, task/control contracts, and new `Ctx` capabilities belong here, not in individual workflow handlers.

## Public Surface

- `defineWorkflow({...})` declares workflow metadata, schema, systems, steps, archetype, runtimePolicy, operator subject, and handler.
- `ctx.page(id)` waits for auth and returns a Playwright Page proxy that injects per-run `ctx.signal` into signal-aware methods.
- `ctx.signal` is the per-run AbortSignal. Pass it to non-Playwright awaits that support cancellation.
- `ctx.step(name, fn)` emits step status, captures screenshots on failure, and maps aborts to the standard cancelled terminal row.
- `ctx.updateData(patch)` writes operator-facing fields into tracker data.
- `ctx.workflowInstance` is the session-drawer instance name owning the run; `ctx.reportPhase(step)` pushes a phase into the terminal-drawer timeline (session `item_start`+`step_change`) **without** a queue row — for handlers that emit their own rows and bypass `ctx.step` (today only OCR). Every other handler drives the timeline for free via `ctx.step`/`ctx.markStep`.
- `ctx.parallel({...})` runs named tasks with `Promise.allSettled`.
- `ctx.delegateTo` / `ctx.delegateToAll` compose workflows. The kernel owns `parentRunId`, pending-row pre-emits, input persistence, and child watching.

Auth is global: one system uses the fast path; multiple systems use parallel prepare + staggered Duo submit. See `src/infra/auth/CLAUDE.md`.

## Daemon Mode

Dashboard input runs use daemon mode when the workflow is registered in `src/core/workflow-loaders.ts`.

- First run with no alive daemon spawns `tsx src/cli-daemon.ts <workflow>`, authenticates once, then enqueues work.
- Later runs insert into SQLite `tasks` and wake alive daemons; no re-Duo.
- Daemons race to claim queued work through SQLite, not JSONL.
- Idle daemons keep sessions warm with periodic `session.healthCheck(system)`.
- `npm run <workflow>:stop` drains in-flight work; `-- --force` marks it failed immediately.

## Invariants

- Every run mode constructs `Ctx` via `makeCtx`; never hand-roll a Ctx literal.
- `buildTrackerOpts(wf)` must stay shared across all modes so detail fields, display names, ids, and runtime warnings behave the same.
- New workflows require `operatorSubject`, `archetype`, and `runtimePolicy`.
- `data.archetype` is the canonical row-shape discriminator; delegated scope is `parentRunId`.
- SQLite is live queue/control truth. JSONL is audit/history output during transition.
- `tasks.original_input_json` preserves pristine task input; retries must replay that value, not accumulated tracker data.
- Requeued existing tasks should call `ensureDaemonsAvailable`, not `ensureDaemonsAndEnqueue`, to avoid duplicate rows.
- Delegation must route through `ctx.delegateTo` / `ctx.delegateToAll`; direct child `runWorkflow(... parentRunId ...)` and child `ensureDaemonsAndEnqueue(... parentRunId ...)` are forbidden by architecture guards.
- Cancel is one mechanism: per-run `AbortController` registered on the unified `runRegistry` (`src/core/run-registry.ts`) + Page proxy + stepper remap to `CancelledError`. Every trigger (daemon `cancel_task`, HTTP `/cancel-current`, browser-disconnect, daemon shutdown sweep) calls `runRegistry.cancel(runId)`, which aborts the controller, writes the SQLite cancel audit for in-process runs, and watchdog hard-kills chromium after `hardKillAfterMs` if the run hasn't unregistered. Daemon state is a single `state.activeRun: RunHandle | null`. Do not reintroduce force-stop mode, page-navigation tricks, or the legacy `cancelTarget` / `in-process-runs` split (guard: `tests/unit/architecture/cancel-mechanism.test.ts`).
- Daemon queue readers must filter to daemon workflow tasks; OCR/dependency parents can also live in `tasks`.
- `withTrackedWorkflow` owns real-run SIGINT; tests using `trackerStub` are the only `runWorkflow` branch with its own handler.
- `runOrdinal` is backend-assigned from earliest tracker timestamp; never derive it client-side from runId.

## Escape Hatches

- `ctx.session.page(id)` gives the raw authenticated Page.
- `ctx.isBatch` and `ctx.runId` are available for batch-only cleanup or external correlation.
- `runWorkerPool` / shared-context pool modes are for in-handler fan-out sharing authenticated sessions, as in Person Lookup's one-Duo-many-tabs pattern.
- Person Lookup / UCPath date naming: `startDate` is the Last Hire / first day of service shown to operators as "Start Date"; assignment `effectiveDate`/EFFDT is backend matching context. Do not repurpose EFFDT as the dashboard-facing start date.

Recurring escape hatches should become first-class kernel features.

## Run Isolation

Every per-item row carries `runId` + `workflowInstance`; `filterEventsForRun` trusts `runId` first. Orphan auth/browser events without `runId` are attributed only when `workflowInstance` matches and timestamps fall inside the run window. `itemInFlight` from daemon events is the live-state signal; do not infer live state from tracker rows.

## Lessons Learned

- **Lesson maintenance rule:** Merge dated migration notes into current invariants whenever possible.
- **2026-06-02: `ctx.parentRunId` exposes delegated scope to self-emitting handlers.** The kernel stamps `parentRunId` on the rows IT emits, but a delegation never injects it into the child *input* (it's a `runWorkflow` option, not an input field). A handler that owns its own tracker emission (today only OCR's orchestrator, which bypasses `ctx.step`) therefore had no way to re-stamp it and its latest-wins rows looked standalone — which hid OCR's Approve button. `parentRunId` is now threaded `run-workflow`/`run-one-item` → `runWorkflowHandler` → `makeCtx` and surfaced on `Ctx`. OCR forwards `ctx.parentRunId` into its orchestrator input so every self-emitted row carries it. Normal handlers don't need it — `ctx.step`/`delegateTo` already stamp parentRunId for free.
- **2026-05-31: `queueRowKind` + `__traceId` must ride EVERY row, not just `pending`.** They were stamped only by `buildPendingTrackerData` (the pre-emit path); live rows (`running`/`done`/`failed` + the synthetic auth-timing rows) build their `data` from `stringifiedSeed` → `withTrackedWorkflow`, which carries `__subject`/`archetype` but not these two. Because the dashboard collapses a run to its *latest* row (`dedupeLatestByIdWithCarriedEmplId`), the kind/trace-id vanished the instant the run left `pending`, and the kind-driven title/subtitle fell back. **There are TWO seed paths and both needed the fix:** `run-one-item.ts` (the daemon-worker path; also what `tests/scenarios` exercise) AND `run-workflow.ts` (the in-process `runWorkflow` real-run path used by non-daemon `delegateTo` children — OCR preview, sharepoint-download — and `delegateToAll`). Both build a seed via `buildInitialTrackerData` then hand it to `withTrackedWorkflow`; the fix seeds `queueRowKind` (recomputed via `resolveQueueRowKindFromValue`) and `__traceId` onto that seed so they propagate to every emission. The trace id is **frozen once** — read back from the run's first pending row via `findFrozenTraceId` (shared helper in `find-latest-entry.ts`), falling back to a fresh `buildTraceId`. In `run-workflow.ts` the trace id is only stamped when `opts.preAssignedRunId` is set (delegation always sets it; a bare `runWorkflow` lets `withTrackedWorkflow` mint the id and own the pending emit). The daemon worker's own `pending` re-emit passes the frozen id to `buildPendingTrackerData`'s new `traceId` opt so it doesn't recompute a time-drifted one. **Gotcha:** `withTrackedWorkflow` SKIPS its own pending emit when `preAssignedRunId` is provided — so don't synthesize a runId just to stamp the trace id, or you'd suppress the pending row. Pinned by `find-frozen-trace-id.test.ts`, `pending-data-root-code.test.ts`, `run-workflow-kind-trace.test.ts`, and the scenario snapshots.
- **2026-05-31: Cancel/shutdown rebuilt rows must inherit the frozen `__traceId`.** `buildShutdownTrackerData` re-derives a cancelled/terminalized row's `data` from `input`, which reproduces name/EID/archetype/queueRowKind but NOT `data.__traceId` — the trace id is stamped once at pre-emit with the original timestamp, so rebuilding would mint a *different* id than the pending row showed. It now accepts `{ runId, trackerDir }` and copies the frozen trace id forward from the run's pending row via the shared `findFrozenTraceId` helper (`preserveFrozenTraceId` wrapper). All three callers pass it: the daemon claim-loop cancel emit and both `shutdown.ts` terminalize sites (in-flight + queued). Invariant: cancellation changes `status` only, never the row's trace-id identity. Pinned by `tests/unit/core/daemon/shutdown.test.ts`.
- **2026-05-30: Delegated trace ids carry the parent workflow's code (provenance).** `buildPendingTrackerData`'s `rootCode` opt (consumed at `code: opts.rootCode ?? wf.code`) is now threaded for delegated children. The delegating parent's 2-char `code` flows `handler-runner` → `makeCtx({ code })` → `buildDelegateApi({ code })` → `delegateToImpl` / `delegateToAllImpl` as `rootCode`, so a child's `data.__traceId` is prefixed with the workflow that spawned it, not the child's own code. It rides the existing `__runtimeOptions` channel (`splitPrefilled`/`normalizeRuntimeOptions`, like `rowShape`) so it survives the SQLite task store to the daemon worker's own `run-one-item` re-emit. **Root vs immediate-parent:** this is the **immediate** parent's code — the parent ctx knows its own code but not, transitively, the root's (unlike `parentSubject`, which each level forwards through the child input schema). For the common one-level delegations (OCR→person-lookup, oath-upload→oath-signature) the immediate parent IS the root, so the trace id names the originating workflow correctly. Deeper chains would need the root code carried transitively in input — deliberately not added (no new uniform plumbing beyond what `parentSubject` establishes). Pinned by `tests/unit/core/pending-data-root-code.test.ts` + the provenance tests in `ctx-delegate-to.test.ts`.
- **2026-06-02: Root trace-id propagation — the root PREFIX propagates transitively; each row composes prefix + its OWN runId4 (trace/span model).** A parallel channel to `rootCode`: `rootTracePrefix` carries the originating run's `<code>-<HHMMSS>` PREFIX (NOT its full id) so every row of one operation reads `ou-090553-<theirOwnRunId4>` — visibly ONE operation (shared prefix) yet each row individually greppable by its own runId (logs/SQLite/footer `#run` keep the row's own id). The descendant COMPOSES `buildTraceId({ …, rootPrefix })` = `<prefix>-<ownRunId4>` (`tracePrefix(id)` in `queue-trace-id.ts` extracts the prefix; `buildTraceId`'s `rootPrefix` opt composes). Plumbing mirrors `rootCode`: `delegate.ts` (`DelegateCoreArgs.rootTracePrefix` → `withRootRuntimeOptions` merges it onto `__runtimeOptions`; pre-emit sites pass it as `buildPendingTrackerData`'s `rootTracePrefix` opt → COMPOSE) → SQLite task store → `normalizeRuntimeOptions` (`rootTracePrefix`) → BOTH seed paths in lockstep: `findFrozenTraceId(...) ?? buildTraceId({ …, rootPrefix: rootTracePrefix })` (frozen-once stays FIRST). **Transitivity (unlike `rootCode`):** `makeCtx` computes `forwardRootTracePrefix = parent.rootTracePrefix ?? tracePrefix(findFrozenTraceId(parent))` once and threads it into `buildDelegateApi`, so a root derives the prefix from its OWN frozen id and forwards it, while a non-root passes through the prefix it inherited → grandchildren share the ORIGINAL root prefix, each with its own tail (the `parentSubject` pattern). **Gotcha:** a physical root's `forwardRootTracePrefix` auto-read only works once a row carries an id — a non-preAssigned `runWorkflow` root has a pending row (seeded), but the real OCR root passes `rootTracePrefix` EXPLICITLY at its fan-out sites (orchestrator's person-lookup `delegateToAllImpl` passes `tracePrefix(traceId)`, and approve.ts's HTTP fan-out reads the OCR row's frozen id via `findFrozenTraceId` then stamps `tracePrefix(...)`), not relying on the auto-read. OCR brands the operation via the form spec's `traceCode` (oath → `ou`; standalone/EC keep `oc`). **`buildPendingTrackerData` resolution order:** verbatim `traceId` (a re-emit reuses the already-composed id) → compose with `rootTracePrefix` → plain compute. Cancel/shutdown needs NO change — `preserveFrozenTraceId` already copies the frozen (already-composed) id forward. Pinned by `queue-trace-id.test.ts` (prefix helpers + compose), `ctx-delegate-to.test.ts` (compose + 3-level transitivity, distinct tails), `run-one-item.test.ts` + `run-workflow-kind-trace.test.ts` (both seed paths), `daemon/shutdown.test.ts`, `ocr-approve-oath-fanout.test.ts`, and `tests/scenarios/delegate-to/oath-upload-shape.test.ts`.
- **2026-05-27: Delegated stages keep natural shape plus `parentRunId`.** Projection decides flat/preview/grouped presentation.
- **Daemon shutdown rows must preserve display metadata.** Sparse terminal rows overwrite rich pending rows in dashboard dedupe.
- **Task-store corruption should fail loud.** Malformed `tasks.input_json` must throw with a raw-prefix diagnostic.
- **Live-page probes replaced tracker caches.** Query the target system directly before writes for dupe protection.
- **Verification screenshots belong on `Ctx`.** Use `ctx.captureAndStampScreenshot` instead of workflow-local screenshot try/catch blocks.
