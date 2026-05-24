# Scenario Tests

**What this is.** Black-box dashboard-contract tests for a workflow's row
lifecycle. A scenario runs the real kernel + real tracker + real projection
end-to-end, but with a **scripted handler** in place of the production
handler. No browsers launch, no `.tracker/` writes leak — every scenario
allocates its own `mkdtemp`'d tracker dir and tears it down.

**What it tests.** What the dashboard would render at every milestone of a
run. Each milestone is locked with `expect(snap).toMatchInlineSnapshot()`,
so any drift in row title, subtitle, status badge, archetype, surface
placement, or `data` shape fails the test the same as the dashboard
rendering wrong.

**What it does NOT test.** The production handler body (real Playwright,
real selectors, real UCPath responses) — those belong in `tests/unit/`
(pure-logic) and `tests/integration/` (future browser-backed). A scenario
swaps the handler with a `ScenarioBeat[]` script.

## Layout

```
tests/scenarios/
  _runtime/                  # Shared scenario harness (don't put workflow-specific code here)
    runtime.ts               # createScenarioRuntime(), waitForStepStart, cancelRow, etc.
    scenario-handler.ts      # cloneWithScript() — wraps a workflow's handler with a beat script
    snapshot-row.ts          # snapshotRow() — TrackerEntry + projection + display helpers → RowSnapshot
    index.ts                 # Barrel
  <workflow>/                # One folder per workflow with scenarios (e.g. oath-signature/)
    _beats.ts                # Beats builder helpers + maskVolatile() for that workflow
    happy-path-single.test.ts
    cancel-during-<step>.test.ts
    fail-during-<step>.test.ts
    retry-after-failure.test.ts
    multi-eid-batch.test.ts
```

## The 4-piece recipe

1. **Beats** — `ScenarioBeat[]` mirroring the real handler's `ctx.step` /
   `markStep` / `updateData` call sequence. Each workflow's beats live in
   `_beats.ts` so test files stay short.
2. **Runtime** — `createScenarioRuntime({ workflow })` allocates the temp
   tracker dir, builds a stub `Session` (no browsers), and exposes
   `enqueue`, `waitForStepStart`, `waitForTerminal`, `cancelRow`,
   `releaseHold`, `cleanup`.
3. **Snapshot** — `snapshotRow({ trackerDir, workflow, runId, workflowLabel })`
   reads the latest JSONL row, runs it through the same projection +
   `buildDisplayNameMap` + `resolveEntryName` pipeline the dashboard uses,
   and returns a `RowSnapshot`.
4. **Assert** — `expect(maskVolatile(snap)).toMatchInlineSnapshot()`. The
   mask hides volatile fields (`runId`, `itemId`, `instance` counter) so
   the snapshot locks the *shape* not the per-run ids. First run fills the
   literal; `npx vitest run -u` regens after legitimate row-shape changes.

## Minimal example

```ts
import { describe, test, expect } from "vitest";
import assert from "node:assert/strict";
import { createScenarioRuntime, snapshotRow } from "../_runtime/index.js";
import { oathSignatureWorkflow } from "../../../src/workflows/oath-signature/workflow.js";
import { oathSignatureBeats, maskVolatile } from "./_beats.js";

test("happy path", async (t) => {
  const rt = await createScenarioRuntime({ workflow: oathSignatureWorkflow });
  t.onTestFinished(() => rt.cleanup());

  const input = { emplId: "10873698", name: "Jane Doe" };
  const { runId, result } = rt.enqueue(input, {
    itemId: input.emplId,
    beats: oathSignatureBeats(input),
  });

  assert.equal((await result).ok, true);

  expect(maskVolatile(snapshotRow({
    trackerDir: rt.trackerDir,
    workflow: rt.workflow,
    runId,
    workflowLabel: oathSignatureWorkflow.config.label,
  }))).toMatchInlineSnapshot(/* auto-filled on first run */);
});
```

## Cancel mid-step

The runtime supports the cancel path. Add `hold: true` to the step you want
to pause at, then `rt.cancelRow(runId)` after `waitForStepStart`:

```ts
const { runId } = rt.enqueue(input, {
  beats: oathSignatureBeats(input, { holdAt: "transaction" }),
});
await rt.waitForStepStart("transaction");
// snapshot the held state
await rt.cancelRow(runId);
await rt.waitForTerminal(runId);
// snapshot the cancelled state — kernel stamps step: "cancelled"
```

The runtime's `cancelRow` flips the per-runtime cancel flag (read by
`runOneItem`'s `isCancelRequested` probe) AND rejects any active hold, so
the kernel's `mapEscapedHandlerError` remaps the throw to a
`CancelledError` + stamps `step: "cancelled"` — exactly what the dashboard
sees when an operator clicks Cancel.

## Retry across runs

`enqueue()` accepts per-call `beats`, so a retry scenario is just two
enqueues with the same `itemId` and different scripts:

```ts
const first = rt.enqueue(input, { itemId: input.emplId, beats: failBeats });
await first.result;
const retry = rt.enqueue(input, { itemId: input.emplId, beats: succeedBeats });
await retry.result;
// snap retry.runId → done
```

## Isolation guarantees

- Each `createScenarioRuntime()` allocates `mkdtempSync(tmpdir(), "hrauto-scenario-")`.
  The real `.tracker/` is never touched.
- `cleanup()` removes the temp dir; call it from `t.onTestFinished`.
- No browser launches (uses `Session.forTesting` + stubbed `captureAll`).
- No daemon subprocess, no port-3838 binding, no dashboard server.
- The `vitest.config.ts` runs files sequentially in one fork — multiple
  scenario files don't race on shared state, but inside one file two
  concurrent `enqueue()` calls share the runtime-level cancel flag and
  hold latches. For multi-row scenarios, prefer no holds + parallel
  completion (see `multi-eid-batch.test.ts`).

## Adding scenarios for a new workflow

1. Create `tests/scenarios/<workflow>/_beats.ts` with a beats builder that
   mirrors the real handler's `ctx.*` call sequence (look at the workflow's
   `workflow.ts → handler` and translate each `markStep` / `step` /
   `updateData` to a `ScenarioBeat`).
2. Add `maskVolatile` to `_beats.ts` (copy from oath-signature — it's
   workflow-agnostic, but keeping a per-folder copy avoids cross-workflow
   coupling).
3. Write one `.test.ts` per scenario. Each test runs a single workflow run
   (or two for retry) and snapshots at each milestone.
4. Run `npx vitest run tests/scenarios/<workflow>/ -u` to fill snapshots,
   review the diff, commit.

## Known gaps

- **Daemon stop scenarios (soft / force).** Force-stop sends SIGTERM which
  the kernel's `withTrackedWorkflow` handler turns into a `failed` row +
  `process.exit(143)`. Calling that path in-test would kill the test
  process. Would need a runtime extension that monkey-patches `process.exit`
  or extracts the SIGTERM handler logic. Soft-stop's drain behavior looks
  the same as happy-path from the dashboard's perspective, so isn't
  separately captured.
- **Multi-EID cancel.** The runtime's cancel flag is runtime-wide, not
  per-run. A multi-EID scenario that cancels one row cancels all of them.
  Per-run cancel needs a `Map<runId, boolean>` swap + per-run isolation of
  hold latches.
- **Real Contract 2 retry path is not exercised here.** `retry-after-failure.test.ts`
  re-enqueues the same itemId with a new runId via two direct `rt.enqueue()`
  calls — it does NOT go through the control-layer's `reEnqueueEntry`, the
  SQLite `tasks.original_input_json` lookup, or the `data.__retriedFrom`
  provenance stamp. That projection-layer drift is locked by the snapshot
  shape (any rename of those fields fails the test), but the actual Contract 2
  control path is covered only by `tests/unit/control/retry-uses-original-input.test.ts`.
  To exercise the real path in a scenario, the runtime would need
  SQLite-task-store enqueue + claim emulation (essentially an inline daemon).
