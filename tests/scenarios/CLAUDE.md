# Scenario Tests

Dashboard-contract tests for workflow row lifecycles. They run the real kernel, tracker, and projection with scripted handlers instead of browsers. Each test uses an isolated temp tracker dir.

## What They Lock

Snapshots should cover row title, subtitle, status, archetype, surface placement, and data shape at meaningful milestones. They do not test production Playwright handlers or live systems.

## Recipe

- Build workflow-specific `ScenarioBeat[]` helpers in `_beats.ts`.
- Use `createScenarioRuntime({ workflow })`.
- Snapshot through `snapshotRow(...)` so rows pass through the same projection/display pipeline as the dashboard.
- Mask volatile ids before inline snapshots.
- Regenerate with `npx vitest run tests/scenarios/<workflow>/ -u` only for legitimate row-shape changes, then review the diff.

## Isolation

- Always register `rt.cleanup()` with `t.onTestFinished`.
- No browser, daemon, dashboard server, or real `.tracker/` writes should occur.
- Vitest runs files sequentially in one fork, but concurrent enqueues inside one runtime can still share holds/cancel state.

## Known Gaps

- Scenario retry tests do not exercise the real control-layer retry path or SQLite `tasks.original_input_json`; unit tests cover that.
- Scenario cancel tests exercise the between-step cancel checkpoint, not mid-Playwright abort via the Page proxy; `tests/unit/core/ctx-signal.test.ts` covers proxy wiring.
- Multi-EID per-run cancel is not modeled because the runtime cancel flag is shared.
- Daemon stop/SIGTERM scenarios are not modeled because the production path exits the process.
