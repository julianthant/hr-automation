# Tracker Module

JSONL + SQLite projection for workflow observability. Workflow handlers should use `ctx.step`, `ctx.markStep`, and `ctx.updateData`; they should not call tracker primitives directly.

## Directory layout (`.tracker/`)

`src/tracker/paths.ts` is the **single source of truth** for every path under the tracker dir. Never build a `join(trackerDir, ...)` path inline — add a helper there instead.

```
.tracker/
├── state.db (+ -wal, -shm)        SQLite live truth (root; see state/db.ts)
├── rows/      <workflow>-<date>.jsonl   tracker / queue rows
├── logs/      <workflow>-<date>.jsonl   operator log lines (NOTE: no "-logs" suffix)
├── sessions/  <date>.jsonl              session events (NOTE: no "sessions-" prefix)
├── runtime/   rotation-state-*.json     runtime state (OCR key rotation, …)
├── daemons/   <workflow>-<ISO>.log + *.queue.jsonl + *.lock.json
├── debug/     row-lifecycle-<date>.{json,jsonl}
├── pdf-cache/ , uploads/               artifacts
```

Row **kind is the directory**, not a filename suffix: a `rows/` file and a `logs/` file share the identical `<workflow>-<date>.jsonl` name. Classify by `trackerKindForPath(path)` (parent-dir segment), never by `.endsWith("-logs.jsonl")` or a `sessions-` prefix. Helpers: `rowFilePath` / `logFilePath` / `sessionFilePath` / `runtimeFilePath`, the `*Dir` accessors, and `parseWorkflowDateFilename` / `parseSessionFilename`. All are re-exported from the `jsonl.ts` barrel.

## Row Emission

- New persisted rows go through `emitTrackerRow` in `jsonl-io.ts`.
- Every row must carry `data.archetype`; TypeScript and architecture guards enforce this.
- Workflow rows use `stampArchetypeForRow(data, { workflowArchetype, parentRunId })`.
- `parentRunId` means delegated scope only. It does not change row shape.
- Control-layer replacement rows must inherit archetype and display metadata through `src/control/ops/emit-inherited.ts`.
- `trackEvent` / `trackEventForDate` are deprecated shims kept only for tracker internals and synchronous SIGINT paths.

## Live State

- SQLite is live queue/control truth: tasks, attempts, worker heartbeats, commands, browser processes, dependency rows, and projection tables.
- JSONL is append-only audit/history and dashboard visibility. `.tracker/daemons/*.queue.jsonl` is tail/debug output, not queue state.
- Queue/control changes must update SQLite and write expected JSONL audit rows together.
- `watchChildRuns` remains fallback for legacy rows with no SQLite task/dependency records.

## Dashboard Observability

Rows should prefer structured operator subjects over raw ids: `data.__subject`, `data.__subjectKind`, task role/group fields, and structured log fields like `category`, `occasion`, `system`, `step`, `attempt`, `durationMs`, or `childWorkflow`.

`parentRunId` is for dashboard parent/child visualization. Child watching is itemId/dependency based, not parentRunId based.

Failure-pattern scans run from the dashboard server on a short interval, prefer SQLite projection data when ready, and fall back to JSONL scans only when necessary. Notification errors must not stall dashboard streaming.

Full reference: `docs/engineering/tracker-reference.md`.

## Gotchas

- ExcelJS loses column key mappings after `readFile()`; reapply keys before `addRow(data)`.
- Tracker filenames, Excel tabs, dashboard date selection, and historical JSONL tests use local-calendar `YYYY-MM-DD`.
- Tracker `.xlsx` files belong under the owning workflow, never project root.
- Port 3838 conflicts should log and skip server start.
- Use both `withLogContext` and `withTrackedWorkflow`; neither replaces the other.
- Do not resurrect `markStaleRunningEntries`; long Duo/Kronos waits can look stale but be valid.
- SIGINT writes must be synchronous because `process.exit` follows immediately.
- Do not wrap synchronous append calls in async mutexes; `appendFileSync` with `O_APPEND` provides the read-after-write behavior tests rely on.

## Adding Tracking

Kernel workflows get tracking for free through `defineWorkflow` + the kernel runners. No non-kernel workflows currently ship under `src/workflows/*`; use `defineWorkflow` for new work.

## Lessons Learned

- **Lesson maintenance rule:** Merge stale tracker lessons into current rules instead of appending another dated variant.
- **Projection writes fail loud and recover async.** JSONL writes first, then SQLite projection applies; repeated projection failures should schedule guarded rebuilds rather than block workflow hot paths.
- **DB handles are file-sensitive.** A live dashboard may outlast `.tracker/state.db` deletion/recreation; resolve DB handles at request/tick time.
- **JSONL readers validate at the boundary.** Use focused validators and preserve each caller's public no-match value.
- **Workflow actions are centralized in `src/control/`.** Dashboard routes should be thin wrappers over `performWorkflowAction`.
- **Queue surfaces classify shape x scope.** Use canonical row shape plus `parentRunId`, not legacy archetype strings.
- **OCR discard is a cancel variant.** Keep it routed through central cancel/control paths with OCR context.
- **Row lifecycle debug is observational only.** It replays JSONL and must not mutate classification inputs or become streamed state.
- **Caches are bounded and resettable.** Register test-visible caches in `__resetAllDashboardCachesForTests()`.
- **2026-06-01: `.tracker/` is split into typed subdirs; `paths.ts` owns all path construction.** Rows → `rows/`, logs → `logs/` (dropped the `-logs` suffix), sessions → `sessions/` (dropped the `sessions-` prefix), OCR rotation state → `runtime/`. `state.db` + `daemons/`/`debug/`/`pdf-cache/`/`uploads/` are unchanged. Kind is now conveyed by **directory** (`trackerKindForPath`), so the old suffix/prefix classification special-cases collapsed. `clean:tracker` now also prunes `daemons/*.log` (was unbounded — a fresh timestamped file per daemon launch) via `cleanOldDaemonLogs`. **Gotcha:** raw `appendFileSync`/`writeFileSync` in tests must `mkdirSync(rowsDir(dir)|logsDir(dir)|sessionsDir(dir), {recursive:true})` first — those fns don't create parent dirs (the production `appendJsonlWithSource` does). **Inventory gotcha:** the original touchpoint sweep missed a reader in `src/workflows/` — `oath-upload/duplicate-check.ts` scanned the flat dir; when restructuring tracker paths, grep `src/workflows/` and `src/domain/` too, not just `src/tracker/` + `src/control/`.
