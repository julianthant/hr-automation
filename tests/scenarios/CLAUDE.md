# Scenario Tests

Dashboard-contract tests for workflow row lifecycles. They run the real kernel, tracker, and projection with scripted handlers instead of browsers. Each test uses an isolated temp tracker dir.

## What They Lock

Snapshots should cover row title, subtitle, status, archetype, surface placement, and data shape at meaningful milestones. They do not test production Playwright handlers or live systems.

## Recipe

- Build workflow-specific `ScenarioBeat[]` helpers in `_beats.ts`.
- Use `createScenarioRuntime({ workflow })`.
- Snapshot a FLAT row through `snapshotRow(...)`; snapshot a BATCH/PREVIEW group card through `snapshotGroupAnchor(...)`. Both pass rows through the same projection/display pipeline as the dashboard.
- Mask volatile ids before inline snapshots (`maskVolatile` for oath-signature) OR pass a fixed `runId` to `enqueue(...)` so the snapshot's `runId` field is deterministic. Trace ids are auto-scrubbed by the snapshot helpers.
- Regenerate with `npx vitest run tests/scenarios/<workflow>/ -u` only for legitimate row-shape changes, then review the diff.

## Snapshot fidelity (do NOT regress)

The snapshot helpers route through the SAME code the React queue panel uses, so a status/subtitle bug in source surfaces as a snapshot diff:

- **Status label + secondary tag** come from the real `resolveQueueRowStatus` + the workflow's `statusExtensions` (registered via `queue-row-status-index.js`). So derived statuses (person-lookup `notFound`, OCR `needsReview`) and the A/IA secondary chip appear in `statusLabel` / `secondaryTag` exactly as rendered. Do NOT reimplement status logic in the harness.
- **Group-anchor subtitle** comes from `buildProjectionFromQueueSurface` with `preferTraceIdSubtitle: true`. A person batch/preview anchor's footer subtitle is the TRACE ID (never a repeated member EID); a file/catalog anchor's is always the trace id. `snapshotRow` (per-row projection) does NOT exercise this — use `snapshotGroupAnchor` for it.
- **Surface collapse** mirrors the dashboard's two-stage dedup: `dedupeLatestByIdWithCarriedEmplId` (latest row per `id`) → `groupMergedTrackerEntries` (one primary per merge key). Both stages are required — skipping the first ties the `activityTimestamp` sort across a run's pending/running/done rows (they share `firstLogTs`) and flakily picks a stale primary.

## Isolation

- Always register `rt.cleanup()` with `t.onTestFinished`.
- No browser, daemon, dashboard server, or real `.tracker/` writes should occur.
- Vitest runs files sequentially in one fork, but concurrent enqueues inside one runtime can still share holds/cancel state.

## Known Gaps

- Scenario retry tests do not exercise the real control-layer retry path or SQLite `tasks.original_input_json`; unit tests cover that.
- Scenario cancel tests exercise the between-step cancel checkpoint, not mid-Playwright abort via the Page proxy; `tests/unit/core/ctx-signal.test.ts` covers proxy wiring.
- Multi-EID per-run cancel is not modeled because the runtime cancel flag is shared.
- Daemon stop/SIGTERM scenarios are not modeled because the production path exits the process.
