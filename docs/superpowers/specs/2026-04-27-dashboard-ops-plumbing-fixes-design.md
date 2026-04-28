# Dashboard Ops Plumbing — Consistency Fixes

**Date:** 2026-04-27
**Scope:** Three small, related fixes that make `/api/retry` and `/api/run-with-data` work consistently with the rest of the codebase. No new features, no workflow changes — only plumbing.

## Background

The separations workflow already has the correct granular skip logic for edit-and-resume:

| Field present in `prefilledData` | Step skipped |
| --- | --- |
| `name` + `eid` + `rawTerminationType` + `separationDate` + `lastDayWorked` | `kuali-extraction` |
| `lastDayWorked` | `kronos-search` |
| `transactionNumber` | `ucpath-transaction` |

Source: `src/workflows/separations/workflow.ts` (lines 286, 376, 589). Nothing about that logic is wrong.

What's wrong is the plumbing that delivers `prefilledData` to the workflow. Two distinct bugs surface as user-visible failures on the retry / edit-data buttons:

1. **`no tracker entry found for id=<X>`** — appears every day after ~5 PM PDT. The dashboard's date picker shows "today" in local time, but the backend's `getLogPath` derives "today" via `new Date().toISOString().slice(0,10)` which is UTC. After local 5 PM PDT, UTC has rolled to the next day, so reads/writes hit a different tracker file than the one the dashboard is showing. Every operational lookup that calls `readEntries(workflow, dir)` (without a `date` argument) misses the actual data.

2. **`No alive daemon available to process this item. Start a daemon and retry.`** — appears when the user clicks retry / edit-data while no daemon is alive. The backend correctly enqueues the item, calls `spawnDaemon`, and waits for a Duo approval. But the same backend's SSE loop runs `scanOrphanedQueueItems` every 1s with a 90s grace period. For separations (4 sequential Duo prompts), the spawn takes 2–3 minutes — well past 90s — so the sweep marks the item failed before its own spawn finishes registering.

3. **Code duplication** — `buildRetryHandler` and `buildRunWithDataHandler` are near-identical. The only meaningful difference is whether the user's edits ride along as `prefilledData`. Two functions for what is conceptually one operation makes the code harder to reason about and creates two places to fix bugs.

## Goals

- After the fix, the retry and edit-data buttons work at any time of day, against any entry the dashboard shows.
- The two handlers share a single core function. Adding a third operation built on the same primitive (e.g., a future "run with custom input shape") becomes trivial.
- No semantic change to retry behavior — the path with `prefilledData = undefined` is byte-identical to the current retry implementation.
- Tracker files roll at local midnight instead of UTC midnight.

## Non-Goals

- No changes to the workflow handlers' skip logic. It already works.
- No changes to daemon mode, the queue protocol, or `ensureDaemonsAndEnqueue`.
- No new endpoints. Frontend retains two distinct affordances (RetryButton, EditDataTab) calling two distinct routes.
- No backfill of legacy UTC-named tracker files. They remain readable by name; only new writes use local naming.

## Design

### 1. Local-time tracker filenames (`dateLocal()`)

Add an exported `dateLocal(d?: Date)` helper to `src/tracker/jsonl.ts`:

```ts
export function dateLocal(d: Date = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
```

Replace every "today" derivation that's used to construct or compare tracker filenames:

- `src/tracker/jsonl.ts` — `getLogFilePath`, `getLogPath`, `cleanOldTrackerFiles` cutoff
- `src/tracker/dashboard.ts` — `today` in `/events`, `/events/logs`, `/events/run-events`; date-list build in `buildSelectorWarningsHandler`; cutoff in `buildSearchHandler`
- `src/tracker/session-events.ts` — file lookup in `recentStepLogExists` and `emitStepChange`
- `src/tracker/spreadsheet.ts` — daily worksheet name

Mirror on the frontend in `src/dashboard/lib/utils.ts`:

```ts
export function dateLocal(d: Date = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
```

Replace UTC slices in:

- `src/dashboard/App.tsx` — initial date in URL state
- `src/dashboard/components/TopBar.tsx` — day-chevron arithmetic
- `src/dashboard/components/hooks/useEntries.ts` — `today` for SSE URL composition

Date arguments computed from arbitrary `Date` objects (cutoffs, day iterations) use `dateLocal(d)`. "Today" calls use `dateLocal()`.

Existing UTC-named files are left untouched; their filenames are still date-shaped, so any code that walks the directory by regex still finds them. The only difference is that new writes go to local-named files. There is no migration step.

### 2. Consolidated `reEnqueueEntry`

In `src/tracker/dashboard-ops.ts`, extract the shared core:

```ts
async function reEnqueueEntry(
  workflow: string,
  id: string,
  runId: string | undefined,
  prefilledData: Record<string, unknown> | undefined,
  dir: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!workflow || !id) return { ok: false, error: "workflow and id are required" };

  const lookup = findEntryInput(workflow, id, runId, dir);
  if ("error" in lookup) return { ok: false, error: lookup.error };

  let input: Record<string, unknown> = lookup.input;
  if (prefilledData) {
    const previousData = findLatestEntryData(workflow, id, dir);
    input = { ...input, prefilledData: { ...previousData, ...prefilledData } };
  }

  const result = await enqueueFromHttp(workflow, [input], dir);
  if (!result.ok) return { ok: false, error: result.error ?? "enqueue failed" };
  return { ok: true };
}
```

Two thin handler wrappers:

```ts
export function buildRetryHandler(dir: string) {
  return (req: RetryRequest) =>
    reEnqueueEntry(req.workflow, req.id, req.runId, undefined, dir);
}

export function buildRunWithDataHandler(dir: string) {
  return (req: RunWithDataRequest) => {
    if (!req.data || typeof req.data !== "object") {
      return Promise.resolve({ ok: false as const, error: "data is required" });
    }
    return reEnqueueEntry(req.workflow, req.id, req.runId, req.data, dir);
  };
}
```

`buildRetryBulkHandler` continues to delegate to `buildRetryHandler` — no change.

### 3. Orphan sweep grace = 5 min

In `src/tracker/dashboard.ts`:

```ts
const ORPHAN_QUEUE_GRACE_MS = 5 * 60_000;
```

The grace must cover the full spawn-to-lockfile window: tsx cold start (1–3s) + module loading (1–2s) + browser launches + every Duo approval. Separations alone declares 4 systems with sequential Duo, which can take 2–3 minutes total. The lockfile is written only after `Session.launch` completes, so `findAliveDaemons` returns 0 for the entire authentication window.

5 minutes matches `spawnDaemon`'s own deadline. Inside that window, the spawn is still legitimately in progress; past it, the spawn promise has rejected and the item is genuinely orphaned. The comment is updated to explain this.

The other option considered — tracking in-flight spawns in dashboard process state via a `Map<workflow, count>` — was rejected as more code for marginal benefit. It would only protect dashboard-initiated spawns; CLI-initiated spawns (from a different process) would still need a grace heuristic, leaving us maintaining two mechanisms for one job.

## Validation

- `npm run typecheck` passes.
- `npm run test` passes (modulo two pre-existing failures unrelated to this change: `session.screenshotAll` × 2 and one screenshot-events typecheck issue on master).
- 16 test files updated to import the new `dateLocal` helper so they remain stable across the UTC rollover window.

## Risk Assessment

- **Blast radius:** Eight source files, one frontend helper, sixteen test files. All changes are mechanical replacements or additions of small wrappers.
- **Behavior preservation:** With `prefilledData = undefined`, the new retry path produces an identical call into `enqueueFromHttp` as the old retry path. Bulk retry semantics are unchanged.
- **Data compatibility:** Old UTC-named tracker files keep working. New writes use local naming. There is no rotation event or migration.
- **Single user-visible behavior change:** Tracker filenames now roll at local midnight rather than UTC midnight, matching what the dashboard's date picker already shows.

## Rollout

The dashboard's SSE backend on port 3838 does not hot-reload. After merging, the user must restart `npm run dashboard` for the fix to take effect on the running process. Once restarted, the retry and edit-data buttons work end-to-end, including for entries from past dates.
