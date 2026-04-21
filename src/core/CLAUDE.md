# Core — Workflow Kernel

Declarative workflow primitives. Every kernel workflow is a `defineWorkflow({...})` call; `runWorkflow` / `runWorkflowBatch` / `runWorkflowPool` execute it. This directory is the canonical place to introduce new cross-cutting behavior (new step semantics, new run modes, new Ctx capabilities) — do NOT inline those concerns into individual workflow handlers.

See root `CLAUDE.md` for a user-facing kernel primer + minimal example. This doc covers the **internals**.

## Files

- `types.ts` — `WorkflowConfig`, `Ctx`, `SystemConfig`, `RunOpts`, `WorkflowMetadata`, `DetailField`, `RetryOpts`. Single source of truth for the kernel surface.
- `workflow.ts` — `defineWorkflow`, `runWorkflow`, `runWorkflowBatch` (sequential mode), `buildTrackerOpts`, `deriveItemId`. `runWorkflowBatch` delegates to `runWorkflowPool` when `batch?.mode === "pool"`.
- `pool.ts` — `runWorkflowPool`: N workers, each with its own Session. One Duo per worker. Queue-based distribution.
- `session.ts` — `Session` class. `Session.launch(systems, opts)` does parallel browser launch → CDP tiling → auth chain (sequential or interleaved, both with 3-attempt retry). Exposes `page(id)` (auth-ready-aware), `reset(id)`, `healthCheck(id)`, `killChrome`, `screenshotAll`.
- `stepper.ts` — `Stepper` class. Owns `currentStep`, `data`, `step` (wraps `fn` with emit-start + catch-screenshot-emit-fail + rethrow), `markStep`, `parallel`/`parallelAll`, `updateData`. Consumes `emitStep` / `emitData` / `emitFailed` callbacks from the tracker wrapping.
- `ctx.ts` — `makeCtx({ session, stepper, isBatch, runId })` — the only constructor for `Ctx`. Shared by `runWorkflow`, `runWorkflowBatch`, and `runWorkflowPool` to guarantee identical surface across modes. Also owns the `retry` implementation (linear backoff).
- `registry.ts` — In-memory `WorkflowMetadata` map. `defineWorkflow` registers; `defineDashboardMetadata` registers with intent-signaling semantics ("not opted-in to the Option-A runtime warning"). `autoLabel` + `normalizeDetailField` for dashboard-shape normalization.
- `idempotency.ts` — `hashKey(record)` + `hasRecentlySucceeded(key, { withinDays, dir })` + `recordSuccess(key, transactionId, workflow, dir)` + `findRecentTransactionId(key, ...)` + `pruneOld(withinDays, dir)`. Storage: `.tracker/idempotency.jsonl`, one success record per line. Used by onboarding + work-study to skip duplicate Smart HR transactions when a workflow is re-run post-crash. Default lookback window: 14 days.
- `step-cache.ts` — `stepCacheGet(workflow, itemId, stepName, { withinHours?, dir? })` + `stepCacheSet(workflow, itemId, stepName, value, { dir? })` + `stepCacheClear(workflow, itemId, stepName?, dir?)` + `pruneOldStepCache(maxAgeHours?, dir?)`. Storage: `.tracker/step-cache/{workflow}-{itemId}/{stepName}.json`, one atomic-written JSON per step. Default TTL 2h on read; default prune 168h (7 days). All three path segments (workflow, itemId, stepName) are path-safety-checked on write + clear (`/`, `\`, `..`, NUL, ASCII ctrl rejected). Used by onboarding's `extraction` step to skip CRM re-scrape on retry. Design: `docs/superpowers/specs/2026-04-18-step-cache-design.md`. On a hit, also emits a `cache_hit` session event via `emitCacheHit(...)` so the dashboard's StepPipeline can decorate the step dot (blue + snowflake) and the Events tab can surface the hit. Best-effort; emit failures never mask a cache hit.
- `index.ts` — Public barrel.

## Design invariants

- **Every mode constructs Ctx via `makeCtx`.** This is why `runWorkflow`, `runWorkflowBatch`, and `runWorkflowPool` behave identically. Adding a new run mode? Use `makeCtx` — never hand-roll a `Ctx` literal.
- **`buildTrackerOpts(wf)` is shared across all modes.** Guarantees `declaredDetailFields`, `nameFn`, `idFn` land in lockstep on every mode's `withTrackedWorkflow` call. Subsystem D's runtime warning relies on this.
- **SIGINT ownership.** `withTrackedWorkflow` installs a SIGINT handler for real runs. The kernel's `runWorkflow` installs its own only in the `trackerStub` test branch. Two simultaneous handlers would double-write `failed` entries.
- **Auth chain semantics.** `authChain: "sequential"` — every `login` awaits the previous one before starting. `"interleaved"` — `login[0]` blocks, then `login[1..N]` are chained in the background via `.catch(() => {}).then(...)`. Each chain step swallows the predecessor's failure so one bad auth doesn't block the next. `Session.page(id)` awaits that system's ready promise before returning, so handlers that call `ctx.page("system-b")` implicitly block until system-b's auth clears.
- **Per-item wrapping.** `runWorkflowBatch` and `runWorkflowPool` both wrap each item in `withLogContext` + `withTrackedWorkflow`. The caller never writes these names — they're kernel-internal. `trackerStub: true` is the only way to skip wrapping (tests use no-op emitters).
- **`preAssignedRunId` + `onPreEmitPending`** are the "dashboard shows the row before the first step runs" contract. Caller passes `runId` in, `onPreEmitPending` fires with the same `runId`, `withTrackedWorkflow` uses that `runId` for all subsequent events instead of generating its own. `deriveItemId` lets callers shape itemIds the built-in deriver (`emplId` → `docId` → `email` → UUID) can't produce.

## Escape hatches

Workflows that need capabilities the declarative shape doesn't express reach for:

- **`ctx.session.page(id)` / `ctx.session.newWindow(id)`** — the `Session` handle. `newWindow` and `closeWindow` are not yet implemented (stubs throw). Use `session.page` to get raw Pages.
- **`ctx.isBatch` / `ctx.runId`** — conditional logic for batch-only cleanup or runId-correlated external writes.
- **`runWorkerPool` from `src/utils/`** — in-handler fan-out that shares one `Session` across N tabs (used by eid-lookup for the "1 Duo, N searches" pattern the kernel's `pool` mode doesn't support — `pool` launches one Session per worker, which re-triggers Duo per worker).

When an escape hatch becomes a recurring pattern across workflows, promote it to a first-class kernel feature rather than letting it ossify in handlers.

## When NOT to touch this directory

- **Without updating all modes.** If you add a new field to `Ctx`, add it to `makeCtx`, verify `buildTrackerOpts` still works, and run both `runWorkflow` and `runWorkflowBatch` (sequential + pool branches) end-to-end.
- **Without updating tests.** Kernel tests live in `tests/unit/core/`. Changes to `Session.launch`, `Stepper.step`, or `buildTrackerOpts` likely need new fixtures.
- **Without updating the root `CLAUDE.md` kernel primer.** Future sessions read that before touching kernel internals. Keep it in sync.

## Lessons Learned

- **2026-04-15: `bringToFront()` before each system's login.** Multi-browser tiling hides background tabs; the active one must surface before the user approves Duo. Fixed in `Session.launch`.
- **2026-04-16: Auth retry on Duo timeout.** `loginWithRetry` refreshes `about:blank` and retries login up to 3 attempts on auth failure. Replaces the old "workflow crashes on flaky Duo" behavior.
- **2026-04-17 (subsystem D): `buildTrackerOpts` extracted.** All three modes pass identical richness-hook bundles to `withTrackedWorkflow` — the runtime warning, getName, and getId are consistent across single / batch / pool.
- **2026-04-17 (subsystem D): Screenshot every active page on step failure.** `Stepper.step`'s catch invokes `screenshotFn(stepName)` via `Session.screenshotAll` before emitting `failed`. Best-effort — one failed screenshot mustn't skip siblings.
- **2026-04-17 (kernel debt #1): Wrap each batch/pool item in `withTrackedWorkflow`.** Previously the batch runner emitted only aggregate events; individual items had no dashboard row. Fixed by per-item wrapping with `preAssignedRunId` threading.
- **2026-04-17: Idempotency keys.** `idempotency.ts` gives workflows a way to skip duplicate Smart HR transactions after a crash mid-submit. Key is a SHA-256 of `{ workflow, emplId, ssn?, effectiveDate, ... }` — sorted-keys JSON so field order is irrelevant. Check via `hasRecentlySucceeded(key)`; on success call `recordSuccess(key, transactionId, workflow)`. Onboarding + work-study wire this into their transaction step. Storage lives alongside tracker JSONL and is gitignored.
- **2026-04-18: Step-cache primitive (pattern-twin of idempotency.ts).** Solves "don't redo expensive read-only work on retry" — the complement of idempotency's "don't double-submit transactional work." Storage co-located under `.tracker/step-cache/`. Deliberate scope choice over a full kernel-level "replay from last successful step" feature: a kernel-driven step-skip would require handlers to be structured with ctx-threaded state instead of local closures (onboarding today uses `let data: EmployeeData | null` mutated inside `ctx.step(...)`). Shipping the primitive + opting onboarding in delivers the actual user-visible savings (~2–3 min) without the handler rewrite.
- **2026-04-19: stepCacheGet emits cache_hit.** Best-effort instrumentation; wrapped in try/catch so an emit failure cannot mask the cached value being returned. Misses and read errors emit nothing (silent fall-through preserved).
- **2026-04-21 (Task 5.2): Step-cache miss-reason / hit-age debug log contract.** `stepCacheGet` emits `log.debug("[StepCache] miss: workflow='...' itemId='...' step='...' reason='<token>'")` on every miss path and `log.debug("[StepCache] hit: ... age=${h}h")` on every hit. Reason enum: `no-file`, `parse-error`, `corrupt-record`, `bad-ts`, `ttl-expired-${N}h`. When adding a new miss branch, emit a reason token before `return null` so retry debugging stays introspectable. Hit-age is computed from `record.ts` (cache-write time), not `stat.mtimeMs` — matters if someone later adds a file-touch helper that would desync the two. Edge case: `withinHours === 0` skips the `bad-ts` check by design (TTL escape hatch), so a hand-tampered record with a malformed `ts` logs `age=NaNh` on that path — cosmetic, intentional.
- **2026-04-21 (Task 5.1): Session auth/launch log contract.** `loginWithRetry` emits `log.step("[Auth: <systemId>] Starting login (attempt 1/AUTH_MAX_ATTEMPTS)")` on attempt 1, `log.warn("[Auth: <systemId>] Retrying (attempt N/MAX) — previous error: ${lastError ?? '<none>'}")` on attempts ≥2, and `log.success("[Auth: <systemId>] Recovered on attempt N")` when a retry finally succeeds (no success log on first-attempt wins — the step's own success carries that signal). `defaultLaunchOne` wraps `launchBrowser` in try/catch and classifies via `classifyPlaywrightError`: `process-singleton` kind → `log.error("[Session: <systemId>] ProcessSingleton collision — ... pid=<pid> sessionDir='<dir or <ephemeral>>'")`, other kinds → `log.error("[Session: <systemId>] launch failed: <kind> — <summary>")`, then re-throws unwrapped. Two prefix taxonomy: `[Auth: <id>]` for login-retry loop, `[Session: <id>]` for browser lifecycle. `<ephemeral>` is a third sentinel (alongside `<empty>` / `<none>` from separations) meaning "absent-by-design" (no persistent sessionDir configured).
