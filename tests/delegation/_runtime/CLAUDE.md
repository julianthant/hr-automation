# Delegation Runtime — Salvaged Projection Tooling

Moved here wholesale from `tests/scenarios/_runtime/` via `git mv` (history preserved).

## snapshot-row.ts — stable salvaged projection tool

`snapshotRow`, `snapshotGroupAnchor`, and `readRowTimeline` route rows through the **same** pipeline the React queue panel uses:

1. `buildTrackerQueueSurfaces` — assembles raw surfaces from tracker JSONL.
2. Two-stage collapse:
   - `dedupeLatestByIdWithCarriedEmplId` — latest row per `id` (stage 1, required).
   - `groupMergedTrackerEntries` — one primary per merge key (stage 2).
3. `resolveQueueRowStatus` + the workflow's `statusExtensions` — derives `statusLabel` / `secondaryTag`.
4. `buildProjectionFromQueueSurface` with `preferTraceIdSubtitle: true` — derives title, subtitle, footer fields.

**Do NOT reimplement status or projection logic in tests.** A status/subtitle/title bug in source surfaces as a snapshot diff.

## Snapshot-fidelity rules (do not regress)

- **Group-anchor subtitle** = trace id for person batch/preview anchors (never a repeated member EID). File/catalog anchors also use trace id. Use `snapshotGroupAnchor` (not `snapshotRow`) to exercise this path.
- **Two-stage collapse is required.** Skipping stage 1 (`dedupeLatestByIdWithCarriedEmplId`) ties the `activityTimestamp` sort across a run's pending/running/done rows (they share `firstLogTs`) and flakily picks a stale primary.
- **Trace ids are auto-scrubbed** by the snapshot helpers — no manual masking needed for them.

## Phase-1 seed note

`runtime.ts` and `scenario-handler.ts` came from the retired scenario test layer. They are built on `runOneItem` (no real daemon). The Tier-1 delegation harness (Phase 1) will rework `runtime.ts` to drive a **real daemon against a temp tracker root**; `scenario-handler.ts`'s beats vocabulary, `cloneWithScript`, and `ScriptHooks` pattern carry forward as-is. `snapshot-row.ts` carries forward unchanged.

**Treat `runtime.ts` as reference/seed until Phase 1 lands.**

## Sync primitive — structured log events (Phase 1 Task 6, landed)

The harness's `waitForEvent` (next task) tails `logs/<workflow>-<date>.jsonl`
under the temp tracker root and awaits a named **`event`** (`StructuredLogEvent.event`,
a closed `LogEventName` set). The emitted set + each name's fire site and fields
are documented in `docs/engineering/structured-log-events.md`. Match on
`event` + `runId` (always present on run-scope log lines); `step` /
`childWorkflow` / `count` / `occasion` further qualify specific events.
The available names: `step:start`, `step:done`, `delegation:children-spawned`
(carries `childWorkflow` + `count`), `ocr:awaiting-approval`, `cancel:requested`,
`run:terminal` (branch on `occasion`: `completed`/`failed`/`cancelled`). These
are a stable contract — do not rename without updating every `waitForEvent`
call. `traceId` is NOT on these events (scope by `runId`).
