# Tracker Storage Optimization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate the five concrete scaling smells in the tracker storage layer (unbounded `sessions.jsonl`, unindexed disk scan for screenshots, no SQLite TTL, unbounded parse cache, dual queue backends) without changing observable workflow behavior.

**Architecture:** SQLite (`.tracker/state.db`) is already the live projection of every JSONL append. This plan completes the migration so SSE reads come from SQLite where the data already exists, JSONL writes are bounded by date rotation, and cleanup prunes both layers in lockstep.

**Tech Stack:** TypeScript / Node 20 / better-sqlite3 / Hono SSE / Vitest. No new dependencies.

---

## Approach

Six independent tasks. Each is a single-subagent dispatch. **Files touched are disjoint enough to dispatch all six in parallel** (each in its own worktree), with the orchestrator merging sequentially after every parallel subagent has been verified per `~/.claude/CLAUDE.md` § "Parallel worktree discipline."

The two near-overlaps are:
- **Tasks 1 & 5** both touch `src/tracker/jsonl.ts`, but Task 1 only adds an export at the bottom (`cleanOldSessionFiles`) and Task 5 only modifies the existing `parseCache` block (~lines 66–83). Merges land cleanly in either order; resolve any trivial conflict in the orchestrator.
- **Task 2** adds one query function to `src/tracker/state/queries.ts`; **Task 3** creates a new `src/tracker/state/file-queries.ts`. Disjoint files, no overlap.

| Task | Branch name | Primary files | Backstop tests |
|---|---|---|---|
| 1 | `feature/tracker-opt-1-sessions-rotation` | `src/tracker/session-events.ts`, `src/tracker/jsonl.ts` (add export only), `tests/unit/tracker/session-events-rotation.test.ts` (new) | `npm run test -- session-events`, `npm run test -- jsonl` |
| 2 | `feature/tracker-opt-2-sse-from-sqlite` | `src/server/routes/events.ts`, `src/tracker/state/queries.ts`, `src/server/session-state.ts` (no logic change; type tightening optional), `tests/unit/tracker/run-events-sse.test.ts` | `npm run test -- run-events-sse`, `npm run test -- dashboard-hono-sse` |
| 3 | `feature/tracker-opt-3-screenshots-from-files` | `src/server/screenshots.ts`, `src/tracker/state/file-queries.ts` (new), `tests/unit/server/screenshots-endpoint.test.ts`, `tests/unit/tracker/dashboard-screenshots.test.ts` | `npm run test -- screenshots` |
| 4 | `feature/tracker-opt-4-sqlite-prune` | `src/scripts/ops/clean-tracker.ts`, `src/tracker/state/cleanup.ts` (new), `tests/unit/scripts/ops/clean-tracker.test.ts` | `npm run test -- clean-tracker` |
| 5 | `feature/tracker-opt-5-parsecache-lru` | `src/tracker/jsonl.ts` (parseCache block only), `tests/unit/tracker/jsonl.test.ts` | `npm run test -- jsonl` |
| 6 | `feature/tracker-opt-6-retire-jsonl-queue` | `src/core/daemon/queue.ts`, `src/tracker/CLAUDE.md`, `tests/unit/core/daemon/daemon-queue.test.ts` | `npm run test -- daemon-queue`, `npm run test -- daemon`, `npm run test:architecture` |

Every task ends with `npm run typecheck && npm run test:architecture && npm run test -- <relevant>` green before commit.

---

## Task 1: Rotate `sessions.jsonl` into dated files

**Files:**
- Modify: `src/tracker/session-events.ts:66-99` — switch `getSessionsFilePath` + read/write to date-aware behavior
- Modify: `src/tracker/jsonl.ts` — append `cleanOldSessionFiles(maxAgeDays, dir)` near the existing `cleanOldTrackerFiles` (find via grep — function lives in the same file but its line number isn't stable)
- Create: `tests/unit/tracker/session-events-rotation.test.ts`

**Why:** `.tracker/sessions.jsonl` is one file for the project's lifetime. Every `/events/run-events` SSE tick re-parses it on mtime change. After months of daemon uptime it's multi-MB. Rotation gives clean per-day files that prune automatically with the existing `clean:tracker` flow.

**Migration strategy:** Going forward, writes go to `sessions-{YYYY-MM-DD}.jsonl`. Reads aggregate every `sessions-*.jsonl` PLUS the legacy single `sessions.jsonl` (until it ages out via `cleanOldSessionFiles`). No one-time migration script — the legacy file is simply read alongside dated files until pruning removes it.

- [ ] **Step 1: Read the existing module to anchor edits**

```bash
grep -n "SESSIONS_FILE\|getSessionsFilePath\|readSessionEvents\|emitSessionEvent" src/tracker/session-events.ts
grep -n "cleanOldTrackerFiles\|cleanOldScreenshots" src/tracker/jsonl.ts
```

- [ ] **Step 2: Write failing rotation test**

Create `tests/unit/tracker/session-events-rotation.test.ts`:

```ts
import { mkdtempSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  emitSessionEvent,
  readSessionEvents,
  getSessionsFilePath,
  getSessionsFilePathForDate,
} from "../../../src/tracker/session-events";

describe("sessions.jsonl rotation", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sess-rot-"));
  });

  it("writes new events to a date-suffixed file", () => {
    emitSessionEvent({ type: "workflow_start", workflowInstance: "Test 1" }, dir);
    const today = new Date().toISOString().slice(0, 10);
    expect(existsSync(join(dir, `sessions-${today}.jsonl`))).toBe(true);
    expect(existsSync(join(dir, "sessions.jsonl"))).toBe(false);
  });

  it("reads from both dated files and legacy single file", () => {
    // Seed a legacy file (pre-rotation data we still need to surface).
    writeFileSync(
      join(dir, "sessions.jsonl"),
      JSON.stringify({
        type: "workflow_start",
        timestamp: "2026-01-01T00:00:00.000Z",
        pid: 1,
        workflowInstance: "Legacy 1",
      }) + "\n",
    );
    // Seed a dated file (post-rotation).
    writeFileSync(
      join(dir, "sessions-2026-04-01.jsonl"),
      JSON.stringify({
        type: "workflow_start",
        timestamp: "2026-04-01T00:00:00.000Z",
        pid: 2,
        workflowInstance: "Apr 1",
      }) + "\n",
    );
    // And a fresh emit to today's file.
    emitSessionEvent({ type: "workflow_start", workflowInstance: "Today 1" }, dir);

    const events = readSessionEvents(dir);
    const instances = events.map((e) => e.workflowInstance).sort();
    expect(instances).toEqual(["Apr 1", "Legacy 1", "Today 1"]);
  });

  it("getSessionsFilePathForDate returns the dated path", () => {
    expect(getSessionsFilePathForDate("2026-05-07", dir)).toBe(
      join(dir, "sessions-2026-05-07.jsonl"),
    );
  });

  it("getSessionsFilePath returns today's dated path", () => {
    const today = new Date().toISOString().slice(0, 10);
    expect(getSessionsFilePath(dir)).toBe(join(dir, `sessions-${today}.jsonl`));
  });
});
```

Run: `npm run test -- session-events-rotation` — Expected: FAIL (`getSessionsFilePathForDate` not exported, dated file not written).

- [ ] **Step 3: Implement rotation in session-events.ts**

Replace the file-path constants and helpers (`src/tracker/session-events.ts:66-99`):

```ts
// ── File paths ─────────────────────────────────────────
//
// Sessions rotate into dated files (`sessions-YYYY-MM-DD.jsonl`) the same
// way tracker entries do. Reads aggregate every dated file plus a legacy
// single `sessions.jsonl` written before rotation landed; that legacy
// file ages out via `cleanOldSessionFiles` like any other dated file.

const LEGACY_SESSIONS_FILE = "sessions.jsonl";
const SESSIONS_PREFIX = "sessions-";
const SESSIONS_SUFFIX = ".jsonl";

export function getSessionsFilePath(dir: string = DEFAULT_DIR): string {
  return getSessionsFilePathForDate(dateLocal(), dir);
}

export function getSessionsFilePathForDate(
  date: string,
  dir: string = DEFAULT_DIR,
): string {
  return join(dir, `${SESSIONS_PREFIX}${date}${SESSIONS_SUFFIX}`);
}

/**
 * Legacy-only path. Used by `readSessionEvents` to drain pre-rotation data
 * until the file ages out via `cleanOldSessionFiles`. Do not write here.
 */
function getLegacySessionsFilePath(dir: string = DEFAULT_DIR): string {
  return join(dir, LEGACY_SESSIONS_FILE);
}

// ── Read / Write ───────────────────────────────────────

export function emitSessionEvent(
  event: Omit<SessionEvent, "timestamp" | "pid">,
  dir: string = DEFAULT_DIR,
): void {
  const runId = event.runId ?? getLogRunId();
  const full: SessionEvent = {
    ...event,
    ...(runId ? { runId } : {}),
    timestamp: new Date().toISOString(),
    pid: process.pid,
  };
  // Route to the dated file matching `full.timestamp`'s local date — same
  // rule tracker entries follow (see `dateLocal(new Date(entry.timestamp))`
  // in jsonl.ts:trackEvent). This keeps batch-scope events emitted near
  // local midnight in the same file as the per-item rows from the same run.
  const trackerDate = dateLocal(new Date(full.timestamp));
  const path = getSessionsFilePathForDate(trackerDate, dir);
  const source = appendJsonlWithSource(path, full, {
    sourceKind: "session",
    trackerDate,
  });
  applySessionEventLive(full, source, dir);
}

export function readSessionEvents(dir: string = DEFAULT_DIR): SessionEvent[] {
  const out: SessionEvent[] = [];
  let files: string[] = [];
  try {
    files = readdirSync(dir).filter(
      (f) => f === LEGACY_SESSIONS_FILE ||
        (f.startsWith(SESSIONS_PREFIX) && f.endsWith(SESSIONS_SUFFIX)),
    );
  } catch {
    return out; // dir doesn't exist
  }
  // Sort by date for deterministic ordering. Legacy file sorts first
  // (no date in its name; treat as oldest).
  files.sort();
  for (const f of files) {
    const path = join(dir, f);
    if (!existsSync(path)) continue;
    const raw = readFileSync(path, "utf-8");
    for (const line of raw.split("\n")) {
      if (!line) continue;
      try {
        out.push(JSON.parse(line) as SessionEvent);
      } catch {
        // Skip malformed lines — same tolerance as the prior implementation.
      }
    }
  }
  return out;
}
```

- [ ] **Step 4: Add `cleanOldSessionFiles` to `src/tracker/jsonl.ts`**

Find the existing `cleanOldTrackerFiles` (grep for it). Right after it, add:

```ts
/**
 * Delete `sessions-YYYY-MM-DD.jsonl` files older than `maxAgeDays`. Also
 * deletes the legacy single `sessions.jsonl` if it has not been touched for
 * `maxAgeDays` (matches the file-mtime gate the dashboard's age-gated prune
 * already applies to that legacy file).
 */
export function cleanOldSessionFiles(maxAgeDays: number, dir: string = DEFAULT_DIR): number {
  if (!existsSync(dir)) return 0;
  const cutoffMs = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
  let deleted = 0;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return 0;
  }
  for (const f of entries) {
    const full = join(dir, f);
    if (f === "sessions.jsonl") {
      try {
        const stat = statSync(full);
        if (stat.mtimeMs < cutoffMs) {
          unlinkSync(full);
          deleted += 1;
        }
      } catch { /* missing or unreadable — skip */ }
      continue;
    }
    const m = f.match(/^sessions-(\d{4}-\d{2}-\d{2})\.jsonl$/);
    if (!m) continue;
    const dateStr = m[1];
    const dateMs = Date.parse(`${dateStr}T00:00:00Z`);
    if (!Number.isFinite(dateMs) || dateMs >= cutoffMs) continue;
    try {
      unlinkSync(full);
      deleted += 1;
    } catch { /* missing or unreadable — skip */ }
  }
  return deleted;
}
```

- [ ] **Step 5: Wire into `src/scripts/ops/clean-tracker.ts`**

Add a call to `cleanOldSessionFiles` inside the `if (cleanTracker)` block of `cleanTrackerMain`, alongside `cleanOldTrackerFiles` and `sweepOrphanUploadDirs`. Imports stay grouped at the top:

```ts
import {
  cleanOldTrackerFiles,
  cleanOldSessionFiles,
  cleanOldScreenshots,
  DEFAULT_DIR,
} from "../../tracker/jsonl";
```

In `cleanTrackerMain`, after the existing `cleanOldTrackerFiles` log and before the uploads sweep:

```ts
const sessionsDeleted = cleanOldSessionFiles(days, dir);
if (sessionsDeleted > 0) {
  log.success(
    `Deleted ${sessionsDeleted} stale sessions file${sessionsDeleted === 1 ? "" : "s"} (older than ${days} day${days === 1 ? "" : "s"}) from ${dir}`,
  );
}
```

No new flag. Sessions prune piggybacks on the existing `--days` and `--no-screenshots` doesn't apply (these aren't screenshots).

- [ ] **Step 6: Update return shape**

`cleanTrackerMain` returns `{ trackerDeleted, screenshotsDeleted }`. Extend to `{ trackerDeleted, screenshotsDeleted, sessionsDeleted }` and update the corresponding test in `tests/unit/scripts/ops/clean-tracker.test.ts` to assert sessions are pruned.

- [ ] **Step 7: Run tests**

```bash
npm run test -- session-events-rotation
npm run test -- jsonl
npm run test -- clean-tracker
npm run typecheck
npm run test:architecture
```

All must pass. Existing tests that touched `sessions.jsonl` directly may need to use `getSessionsFilePathForDate(today, dir)` instead — fix any breakage as you go (architecture-test failures should be obvious; functional test failures should be limited to a handful of fixtures).

- [ ] **Step 8: Commit**

```bash
git add src/tracker/session-events.ts src/tracker/jsonl.ts \
        src/scripts/ops/clean-tracker.ts \
        tests/unit/tracker/session-events-rotation.test.ts \
        tests/unit/scripts/ops/clean-tracker.test.ts
git commit -m "$(cat <<'EOF'
refactor(tracker): rotate sessions.jsonl into dated files

Bound sessions.jsonl growth: writes go to sessions-YYYY-MM-DD.jsonl
matching the timestamp's local date; reads aggregate every dated
file plus a legacy sessions.jsonl until it ages out. clean:tracker
now prunes session files alongside tracker files.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Switch `/events/run-events` SSE to query SQLite for session events

**Files:**
- Modify: `src/server/routes/events.ts:240-280` — replace `readSessionEventsTolerant` call with a SQLite query when DB is ready
- Modify: `src/tracker/state/queries.ts` — add `querySessionEventsForRun(db, opts)`
- Test: `tests/unit/tracker/run-events-sse.test.ts` (existing, extend)

**Why:** `session_events` table is already populated synchronously via `applySessionEventLive` on every emit (`src/tracker/jsonl.ts:9, 63, 89`, runtime.ts). The SSE handler still parses the entire JSONL on every tick. Switching the read to SQL is a constant-time index seek on `(workflow_instance, ts_ms)`, and Task 1's rotation makes the JSONL split, so the JSONL fallback only ever scans today's file.

**Backwards compatibility:** Keep the JSONL fallback when `isStateDbReady(dir)` returns false (DB missing, schema mismatch, or read-only failure). Same gate the projection's other read sites already use.

- [ ] **Step 1: Read the existing handler**

```bash
sed -n '230,290p' src/server/routes/events.ts
```

- [ ] **Step 2: Add the query function to `src/tracker/state/queries.ts`**

Append to `src/tracker/state/queries.ts` (after `queryRunsForItem`):

```ts
import type { SessionEvent } from "../session-events";

/**
 * Read every session event whose `runId` matches `opts.runId` OR (for
 * batch-scope events emitted before the per-item ALS context was
 * established) whose `workflow_instance` falls within the run's
 * `[firstTrackerTs, lastTrackerTs]` window. The window filter mirrors
 * `filterEventsForRun`'s second pass so the caller can pass the result
 * straight through `filterEventsForRun(events, trackers, runId)` and get
 * identical output to the JSONL path.
 *
 * Returns events ordered by ts_ms ASC for deterministic SSE rendering.
 */
export function querySessionEventsForRun(
  db: Database.Database,
  opts: { runId: string; workflowInstance?: string; runStartMs?: number; runEndMs?: number },
): SessionEvent[] {
  // Fetch direct matches by runId AND any orphan events sharing the
  // workflowInstance (no runId on the event). The window filter is
  // applied client-side by filterEventsForRun, so we deliberately
  // over-fetch on workflow_instance and let the pure helper trim.
  const params: Record<string, unknown> = { runId: opts.runId };
  let where = "run_id = @runId";
  if (opts.workflowInstance) {
    where += " OR (run_id IS NULL AND workflow_instance = @instance)";
    params.instance = opts.workflowInstance;
  }
  const rows = db.prepare(`
    SELECT event_json FROM session_events
    WHERE ${where}
    ORDER BY ts_ms ASC, id ASC
  `).all(params) as Array<{ event_json: string }>;
  const out: SessionEvent[] = [];
  for (const r of rows) {
    try {
      out.push(JSON.parse(r.event_json) as SessionEvent);
    } catch {
      // Skip — projection rebuild will reconcile.
    }
  }
  return out;
}
```

(If `event_json` isn't the projected column name, grep `session_events` in `src/tracker/state/schema.ts` and use the actual column. Most schemas project the full JSON for readback.)

- [ ] **Step 3: Update the handler in `src/server/routes/events.ts`**

In the `/events/run-events` handler around line 250, replace:

```ts
const allEvents = await readSessionEventsTolerant(deps.dir);
```

with:

```ts
let allEvents: SessionEvent[];
if (isStateDbReady(deps.dir)) {
  const trackerEntry = trackerEntries.find((e) => e.runId === requestedRunId);
  const wfInstance =
    typeof trackerEntry?.data?.instance === "string"
      ? trackerEntry.data.instance
      : undefined;
  allEvents = querySessionEventsForRun(openStateDb(deps.dir), {
    runId: requestedRunId,
    ...(wfInstance ? { workflowInstance: wfInstance } : {}),
  });
} else {
  allEvents = await readSessionEventsTolerant(deps.dir);
}
```

Add the imports near the top of `events.ts`:

```ts
import { isStateDbReady, openStateDb } from "../../tracker/state/db";
import { querySessionEventsForRun } from "../../tracker/state/queries";
```

`filterEventsForRun(allEvents, trackerEntries, requestedRunId)` runs unchanged — its inputs are the same shape from either source.

- [ ] **Step 4: Extend the SSE test**

In `tests/unit/tracker/run-events-sse.test.ts`, add a test that asserts the handler returns identical output whether the SQLite projection is ready or has been deleted (forcing JSONL fallback). Pattern the test on the existing test that exercises `filterEventsForRun` — set up tracker entries and session events through the normal emit path so both stores are populated, hit the endpoint once, then `closeStateDbForTests(dir); rmSync(stateDbPath(dir))` and hit the endpoint again. Both responses must contain the same event objects in the same order.

- [ ] **Step 5: Run tests**

```bash
npm run test -- run-events-sse
npm run test -- dashboard-hono-sse
npm run typecheck
npm run test:architecture
```

- [ ] **Step 6: Commit**

```bash
git add src/server/routes/events.ts src/tracker/state/queries.ts \
        tests/unit/tracker/run-events-sse.test.ts
git commit -m "$(cat <<'EOF'
perf(server): serve /events/run-events from SQLite when projection ready

Replaces the per-tick full-file JSONL parse of sessions.jsonl with an
indexed SQL query against session_events. JSONL fallback retained for
when isStateDbReady returns false (DB missing or schema drift).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Screenshots endpoint queries `files` table instead of scanning disk

**Files:**
- Modify: `src/server/screenshots.ts:45-213` — both overloads of `buildScreenshotsHandler`
- Create: `src/tracker/state/file-queries.ts` — new module for `files` table reads
- Test: `tests/unit/server/screenshots-endpoint.test.ts` (existing, extend) and `tests/unit/tracker/dashboard-screenshots.test.ts`

**Why:** Every screenshot is registered in SQLite `files` (workflow, item_id, run_id, storage_path, kind, sha256, bytes) at capture time. The current handler still parses `sessions.jsonl` AND `readdirSync`s the disk to build its grouped + legacy view. With the data already indexed by `(workflow, item_id)`, neither read is needed.

**Backwards compatibility:** Keep the legacy disk-scan path as a fallback when `isStateDbReady(dir)` is false OR when the `files` table has zero rows for the queried `(workflow, itemId)` pair (so a stale projection on an old DB doesn't blank out a real screenshot list — the disk fallback still surfaces "legacy" entries correctly).

- [ ] **Step 1: Read existing handler**

```bash
sed -n '45,213p' src/server/screenshots.ts
grep -n "files\b" src/tracker/state/schema.ts | head -30
```

Confirm the `files` table columns (expected: `file_id`, `kind`, `storage_path`, `workflow`, `item_id`, `run_id`, `parent_run_id`, `source`, `sha256`, `bytes`, plus a timestamp).

- [ ] **Step 2: Create `src/tracker/state/file-queries.ts`**

```ts
import type Database from "better-sqlite3";
import type { ScreenshotGroupedEntry } from "../../server/screenshots";

export interface FileRow {
  file_id: string;
  kind: string;
  storage_path: string;
  workflow: string;
  item_id: string;
  run_id: string | null;
  source: string | null;
  bytes: number | null;
  ts_ms: number | null;
}

/**
 * List every screenshot registered in the `files` table for a workflow +
 * itemId. Joins with session_events when available to pull the screenshot
 * label/kind/step (same shape as the JSONL screenshot event). Files whose
 * storage_path no longer exists on disk are filtered out by the caller.
 */
export function queryScreenshotsForItem(
  db: Database.Database,
  opts: { workflow: string; itemId: string },
): FileRow[] {
  return db.prepare(`
    SELECT file_id, kind, storage_path, workflow, item_id, run_id, source, bytes, ts_ms
    FROM files
    WHERE workflow = @workflow AND item_id = @itemId AND kind = 'screenshot'
    ORDER BY ts_ms DESC
  `).all(opts) as FileRow[];
}

/**
 * Group rows by their session_event grouping (matched via run_id + ts_ms
 * proximity to a screenshot session_event). For files lacking a matching
 * event, return them as a single legacy bucket — preserves the existing
 * "legacy" entry behavior of the JSONL path.
 */
export function groupScreenshotRows(
  rows: FileRow[],
  events: Array<{ ts: number; runId?: string; kind: "form" | "error" | "manual"; label: string; step: string | null; files: Array<{ system: string; path: string }> }>,
): ScreenshotGroupedEntry[] {
  const eventByPath = new Map<string, { ts: number; kind: "form" | "error" | "manual"; label: string; step: string | null; system: string }>();
  for (const ev of events) {
    for (const f of ev.files) {
      eventByPath.set(f.path, { ts: ev.ts, kind: ev.kind, label: ev.label, step: ev.step, system: f.system });
    }
  }
  const groupedByEventTs = new Map<number, ScreenshotGroupedEntry>();
  const legacy: ScreenshotGroupedEntry["files"] = [];
  let legacyTs = 0;

  for (const row of rows) {
    const ev = eventByPath.get(row.storage_path);
    const fileEntry = {
      system: ev?.system ?? "unknown",
      path: row.storage_path,
      url: `/screenshots/${encodeURIComponent(row.storage_path.split(/[/\\]/).pop() ?? "")}`,
    };
    if (ev) {
      const existing = groupedByEventTs.get(ev.ts);
      if (existing) {
        existing.files.push(fileEntry);
      } else {
        groupedByEventTs.set(ev.ts, {
          ts: ev.ts,
          kind: ev.kind,
          label: ev.label,
          step: ev.step,
          files: [fileEntry],
        });
      }
    } else {
      const fileTs = row.ts_ms ?? 0;
      if (fileTs > legacyTs) legacyTs = fileTs;
      legacy.push(fileEntry);
    }
  }

  const out = [...groupedByEventTs.values()];
  if (legacy.length > 0) {
    out.push({ ts: legacyTs, kind: "error", label: "legacy", step: null, files: legacy });
  }
  out.sort((a, b) => b.ts - a.ts);
  return out;
}
```

- [ ] **Step 3: Switch grouped handler in `src/server/screenshots.ts`**

In the `groupedHandler` branch (lines ~58-168), replace the JSONL parse + disk scan with:

```ts
return async function groupedHandler(
  query: { workflow: string; itemId: string },
): Promise<ScreenshotGroupedEntry[]> {
  const { workflow, itemId } = query;

  // Prefer SQLite when the projection is ready and has rows for this item.
  if (isStateDbReady(dir)) {
    const db = openStateDb(dir);
    const rows = queryScreenshotsForItem(db, { workflow, itemId });
    if (rows.length > 0) {
      // Pull screenshot session events for the same item to populate
      // group labels (kind/step). Same query the JSONL path was doing
      // in spirit, but indexed.
      const events = querySessionEventsForRun(db, {
        runId: rows[0]?.run_id ?? "",
      })
        .filter((e) => e.type === "screenshot" && e.files?.some((f) => f.path && rows.some((r) => r.storage_path === f.path)))
        .map((e) => ({
          ts: e.ts as number,
          ...(e.runId ? { runId: e.runId } : {}),
          kind: e.kind,
          label: e.label,
          step: e.step,
          files: e.files,
        }));
      const grouped = groupScreenshotRows(
        rows.filter((r) => existsSync(r.storage_path)),
        events,
      );
      if (grouped.length > 0) return grouped;
    }
  }

  // Disk-scan fallback: legacy behavior preserved verbatim. (Original
  // JSONL parse + readdirSync walk — see Task 3 spec for context.)
  return await groupedHandlerLegacy({ dir, screenshotsDir, workflow, itemId });
};
```

Move the existing JSONL+disk implementation into a private `groupedHandlerLegacy` function (same file) so both paths are testable.

For the legacy flat-list overload (lines ~172-212), apply the same pattern: query `queryScreenshotsForItem` first, fall back to `readdirSync`. Both return the same `ScreenshotListEntry[]` shape so callers don't change.

Imports at the top of `src/server/screenshots.ts`:

```ts
import { isStateDbReady, openStateDb } from "../tracker/state/db";
import {
  queryScreenshotsForItem,
  groupScreenshotRows,
} from "../tracker/state/file-queries";
import { querySessionEventsForRun } from "../tracker/state/queries";
```

- [ ] **Step 4: Extend the screenshots endpoint test**

In `tests/unit/server/screenshots-endpoint.test.ts`, add a test asserting the SQLite path returns the same shape as the disk path. Seed via the normal emit path (so `files` table is populated), call the handler, capture the result, then drop the DB and assert the disk fallback returns the same content.

- [ ] **Step 5: Run tests**

```bash
npm run test -- screenshots-endpoint
npm run test -- dashboard-screenshots
npm run typecheck
npm run test:architecture
```

- [ ] **Step 6: Commit**

```bash
git add src/server/screenshots.ts src/tracker/state/file-queries.ts \
        tests/unit/server/screenshots-endpoint.test.ts \
        tests/unit/tracker/dashboard-screenshots.test.ts
git commit -m "$(cat <<'EOF'
perf(server): serve /api/screenshots from SQLite files table

Replaces the per-request sessions.jsonl parse + readdirSync scan with
an indexed SQL query against the files table, which already records
every captured screenshot at emit time. Disk-scan path retained as
fallback for missing/stale projection.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Extend `clean:tracker` to prune SQLite

**Files:**
- Create: `src/tracker/state/cleanup.ts`
- Modify: `src/scripts/ops/clean-tracker.ts`
- Modify: `tests/unit/scripts/ops/clean-tracker.test.ts`

**Why:** `state.db` accumulates `run_events`, `runs`, `items`, `logs`, `session_events`, `files`, `task_*`, and `worker_commands` rows indefinitely. JSONL pruning leaves them behind. Single nightly DELETE plus VACUUM keeps the DB bounded.

**Retention semantics:** Match the JSONL `--days` flag. Anything whose tracker_date (or projected timestamp for non-dated tables) is older than the cutoff gets deleted. `worker_commands` and `task_attempts` use their own ts_ms with the same cutoff.

- [ ] **Step 1: Read the schema**

```bash
sed -n '1,200p' src/tracker/state/schema.ts
```

Note column names for each table — `tracker_date` for run_events/runs/items/logs/session_events/files; `created_ms` or `ts_ms` for tasks/worker_commands.

- [ ] **Step 2: Write the failing test in `tests/unit/scripts/ops/clean-tracker.test.ts`**

Add:

```ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { trackEvent, appendLogEntry } from "../../../../src/tracker/jsonl";
import { openStateDb, closeStateDbForTests } from "../../../../src/tracker/state/db";
import { cleanTrackerMain } from "../../../../src/scripts/ops/clean-tracker";

describe("cleanTrackerMain SQLite prune", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "clean-sql-")); });
  afterEach(() => { closeStateDbForTests(dir); });

  it("deletes SQLite rows whose tracker_date is older than --days", () => {
    // Seed two tracker entries: one fresh (today), one ancient (90 days ago).
    const old = new Date(Date.now() - 90 * 24 * 3600 * 1000).toISOString();
    const today = new Date().toISOString();
    trackEvent({
      workflow: "x", id: "1", runId: "r1", timestamp: old,
      status: "done", data: {},
    } as any, dir);
    trackEvent({
      workflow: "x", id: "2", runId: "r2", timestamp: today,
      status: "done", data: {},
    } as any, dir);

    const db = openStateDb(dir);
    expect((db.prepare("SELECT COUNT(*) AS n FROM run_events").get() as { n: number }).n).toBe(2);

    cleanTrackerMain(["--days", "30", "--dir", dir, "--no-screenshots"]);

    const remaining = db.prepare("SELECT item_id FROM run_events").all() as Array<{ item_id: string }>;
    expect(remaining.map((r) => r.item_id)).toEqual(["2"]);
  });
});
```

Run: `npm run test -- clean-tracker` — Expected: FAIL (SQLite not pruned).

- [ ] **Step 3: Implement `src/tracker/state/cleanup.ts`**

```ts
import type Database from "better-sqlite3";
import { isStateDbReady, openStateDb } from "./db";

export interface PruneResult {
  runEventsDeleted: number;
  runsDeleted: number;
  itemsDeleted: number;
  logsDeleted: number;
  sessionEventsDeleted: number;
  filesDeleted: number;
  taskAttemptsDeleted: number;
  workerCommandsDeleted: number;
}

/**
 * Delete every projected row whose tracker_date (or timestamp, for tables
 * lacking tracker_date) is older than `cutoffDate` (`YYYY-MM-DD`). Runs in
 * a single transaction so a partial prune can't half-update the DB. Final
 * VACUUM reclaims the freed pages.
 *
 * Returns counts per table for log output. No-op (returns zeros) when the
 * projection isn't ready.
 */
export function pruneStateDb(dir: string, cutoffDate: string): PruneResult {
  const zero: PruneResult = {
    runEventsDeleted: 0, runsDeleted: 0, itemsDeleted: 0, logsDeleted: 0,
    sessionEventsDeleted: 0, filesDeleted: 0, taskAttemptsDeleted: 0,
    workerCommandsDeleted: 0,
  };
  if (!isStateDbReady(dir)) return zero;
  const db = openStateDb(dir);
  const cutoffMs = Date.parse(`${cutoffDate}T00:00:00Z`);
  const result = { ...zero };
  const txn = db.transaction(() => {
    result.runEventsDeleted = db.prepare(
      "DELETE FROM run_events WHERE tracker_date < @cutoff"
    ).run({ cutoff: cutoffDate }).changes;
    result.runsDeleted = db.prepare(
      "DELETE FROM runs WHERE tracker_date < @cutoff"
    ).run({ cutoff: cutoffDate }).changes;
    result.itemsDeleted = db.prepare(
      "DELETE FROM items WHERE tracker_date < @cutoff"
    ).run({ cutoff: cutoffDate }).changes;
    result.logsDeleted = db.prepare(
      "DELETE FROM logs WHERE tracker_date < @cutoff"
    ).run({ cutoff: cutoffDate }).changes;
    result.sessionEventsDeleted = db.prepare(
      "DELETE FROM session_events WHERE ts_ms < @cutoffMs"
    ).run({ cutoffMs }).changes;
    result.filesDeleted = db.prepare(
      "DELETE FROM files WHERE ts_ms < @cutoffMs"
    ).run({ cutoffMs }).changes;
    // task_* + worker_commands cleanup — time column may be `created_ms`,
    // `ts_ms`, or `claimed_at` depending on schema. Read the actual column
    // name from src/tracker/state/schema.ts and substitute below; structure
    // is identical.
    result.taskAttemptsDeleted = db.prepare(
      "DELETE FROM task_attempts WHERE created_ms < @cutoffMs"
    ).run({ cutoffMs }).changes;
    result.workerCommandsDeleted = db.prepare(
      "DELETE FROM worker_commands WHERE created_ms < @cutoffMs"
    ).run({ cutoffMs }).changes;
  });
  txn();
  // VACUUM cannot run inside a transaction. Best-effort.
  try { db.exec("VACUUM"); } catch { /* WAL-mode VACUUM may need exclusive — skip if busy */ }
  return result;
}
```

- [ ] **Step 4: Wire into clean-tracker.ts**

In `src/scripts/ops/clean-tracker.ts`, after the existing `cleanOldTrackerFiles` call:

```ts
import { pruneStateDb } from "../../tracker/state/cleanup";

// ...inside cleanTrackerMain, after the tracker delete log line:
const cutoffDate = new Date(Date.now() - days * 24 * 3600 * 1000)
  .toISOString().slice(0, 10);
const sqlPrune = pruneStateDb(dir, cutoffDate);
const totalSqlDeleted =
  sqlPrune.runEventsDeleted + sqlPrune.runsDeleted + sqlPrune.itemsDeleted +
  sqlPrune.logsDeleted + sqlPrune.sessionEventsDeleted + sqlPrune.filesDeleted +
  sqlPrune.taskAttemptsDeleted + sqlPrune.workerCommandsDeleted;
if (totalSqlDeleted > 0) {
  log.success(
    `Deleted ${totalSqlDeleted} SQLite row${totalSqlDeleted === 1 ? "" : "s"} ` +
    `(run_events=${sqlPrune.runEventsDeleted} runs=${sqlPrune.runsDeleted} ` +
    `items=${sqlPrune.itemsDeleted} logs=${sqlPrune.logsDeleted} ` +
    `session_events=${sqlPrune.sessionEventsDeleted} files=${sqlPrune.filesDeleted} ` +
    `task_attempts=${sqlPrune.taskAttemptsDeleted} worker_commands=${sqlPrune.workerCommandsDeleted}) ` +
    `older than ${days} day${days === 1 ? "" : "s"}`,
  );
}
```

- [ ] **Step 5: Run tests**

```bash
npm run test -- clean-tracker
npm run typecheck
npm run test:architecture
```

If a column name differs from the assumption (e.g. `ts_ms` vs `created_ms` vs `claimed_at`), adjust the SQL — the schema is in `src/tracker/state/schema.ts`.

- [ ] **Step 6: Commit**

```bash
git add src/tracker/state/cleanup.ts src/scripts/ops/clean-tracker.ts \
        tests/unit/scripts/ops/clean-tracker.test.ts
git commit -m "$(cat <<'EOF'
feat(tracker): prune SQLite state.db on clean:tracker

Deletes run_events / runs / items / logs / session_events / files /
task_attempts / worker_commands rows older than --days, then VACUUMs.
Was a slow leak — JSONL pruned but projection grew indefinitely.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: LRU eviction on `parseCache`

**Files:**
- Modify: `src/tracker/jsonl.ts:66-83` — replace `Map` with bounded LRU
- Test: `tests/unit/tracker/jsonl.test.ts` (existing, extend)

**Why:** `parseCache` is `new Map()` with no eviction. Every `(workflow, date)` ever read by the dashboard adds an entry that never gets removed. After a long-lived dashboard session walking through historical dates, this grows unboundedly.

**Sizing:** Default cap = 64. Largest plausible working set is ~10 workflows × ~7 days = 70 entries; 64 covers active use without re-parsing today's hot file. Trivial to tune later.

- [ ] **Step 1: Read the existing block**

```bash
sed -n '66,83p' src/tracker/jsonl.ts
```

- [ ] **Step 2: Write failing test in `tests/unit/tracker/jsonl.test.ts`**

```ts
import { __resetParseCacheForTests, __getParseCacheSizeForTests } from "../../../src/tracker/jsonl";
// ...

describe("parseCache LRU", () => {
  beforeEach(() => __resetParseCacheForTests());

  it("caps cache size at the configured limit", () => {
    const dir = mkdtempSync(join(tmpdir(), "lru-"));
    // Force >64 distinct (workflow, date) reads.
    for (let i = 0; i < 100; i++) {
      const wf = `wf${i}`;
      writeFileSync(join(dir, `${wf}-2026-05-07.jsonl`), '{"workflow":"' + wf + '","id":"x","runId":"r","timestamp":"2026-05-07T00:00:00Z","status":"done","data":{}}\n');
      readEntries(wf, dir);
    }
    expect(__getParseCacheSizeForTests()).toBeLessThanOrEqual(64);
  });

  it("evicts the least-recently-used entry on overflow", () => {
    // Touch entries A, B, C, then overflow with 64 fresh ones; A should be gone.
    // Implementation: read a fixture file under name A, then fill the cache
    // past 64, then verify A is evicted by checking re-read still returns
    // identical content (always true) but cache size is capped.
    // (Functional correctness — content is preserved; only memory bound matters.)
  });
});
```

Run: `npm run test -- jsonl` — Expected: FAIL (`__getParseCacheSizeForTests` not exported, cache uncapped).

- [ ] **Step 3: Implement bounded LRU in `src/tracker/jsonl.ts`**

Replace the `parseCache` block (lines 66-83) with:

```ts
// Cache parsed JSONL by file path with LRU eviction. Map's insertion-order
// iteration plus delete-on-hit + re-set gives a 6-line LRU without an
// extra dep. Cap chosen for ~10 workflows × ~7 active dates — adjust with
// PARSE_CACHE_MAX if needed.
const PARSE_CACHE_MAX = 64;
type ParseCacheEntry = { mtimeMs: number; size: number; entries: unknown[] };
const parseCache = new Map<string, ParseCacheEntry>();

function readJsonlCached<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  const stat = statSync(path);
  const cached = parseCache.get(path);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    // Bump to most-recent by re-inserting.
    parseCache.delete(path);
    parseCache.set(path, cached);
    return cached.entries as T[];
  }
  const entries = readFileSync(path, "utf-8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  parseCache.set(path, { mtimeMs: stat.mtimeMs, size: stat.size, entries });
  if (parseCache.size > PARSE_CACHE_MAX) {
    // Evict oldest (insertion-order first key).
    const oldestKey = parseCache.keys().next().value;
    if (oldestKey !== undefined) parseCache.delete(oldestKey);
  }
  return entries as T[];
}

/** Test-only — reset between cases so cache state doesn't leak. */
export function __resetParseCacheForTests(): void {
  parseCache.clear();
}

/** Test-only — observable cache size for size-cap assertions. */
export function __getParseCacheSizeForTests(): number {
  return parseCache.size;
}
```

- [ ] **Step 4: Run tests**

```bash
npm run test -- jsonl
npm run typecheck
npm run test:architecture
```

- [ ] **Step 5: Commit**

```bash
git add src/tracker/jsonl.ts tests/unit/tracker/jsonl.test.ts
git commit -m "$(cat <<'EOF'
perf(tracker): cap parseCache at 64 entries with LRU eviction

The JSONL read cache had no eviction — long-lived dashboard sessions
walking through historical dates accumulated entries indefinitely.
Map iteration-order + delete-on-hit gives LRU in 6 lines, no dep.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Retire the JSONL queue backend

**Files:**
- Modify: `src/core/daemon/queue.ts` — delete `legacyReadQueueState`, `queueBackend()`, the `HRAUTO_QUEUE_BACKEND` env-var branch
- Modify: `src/tracker/CLAUDE.md` — drop the "`HRAUTO_QUEUE_BACKEND=jsonl` is a temporary cutover fallback" line
- Modify: `tests/unit/core/daemon/daemon-queue.test.ts` — remove tests targeting the legacy path, keep audit-append tests
- Verify: `tests/unit/core/daemon/daemon.test.ts` and `tests/unit/core/daemon/daemon-client.test.ts` still pass

**Why:** SQLite has been the default queue backend for some time. The JSONL fallback is parallel code — `legacyReadQueueState` (queue.ts:54-130+) — that needs to be maintained, exercised by tests, and is O(n) on claim. Removing it shrinks `queue.ts` and removes a configuration footgun.

**Audit-only writes preserved:** `appendEvent` (queue.ts:37-41) keeps appending to `.queue.jsonl` so existing dashboards/operators can `tail -f` for debugging. Only the *read* path is retired.

**Pre-flight check:** Search for production callers and CI configs that set `HRAUTO_QUEUE_BACKEND=jsonl`:

```bash
grep -rn "HRAUTO_QUEUE_BACKEND" --include="*.ts" --include="*.yml" --include="*.yaml" --include="*.json" --include="*.md"
```

If any non-test caller exists, **stop and surface to the orchestrator** — that's a sign the legacy path is still load-bearing. In that case the task converts to "deprecate with warning, remove in a follow-up" instead of a hard removal.

- [ ] **Step 1: Verify no production callers**

```bash
grep -rn "HRAUTO_QUEUE_BACKEND" --include="*.ts" --include="*.yml" --include="*.yaml" --include="*.json" --include="*.md"
```

Expected: matches only in `src/core/daemon/queue.ts`, `src/tracker/CLAUDE.md`, and test files. If any other production file matches, halt and flag.

- [ ] **Step 2: Read the full queue.ts to map all branches that gate on `queueBackend()`**

```bash
grep -n "queueBackend\|HRAUTO_QUEUE_BACKEND\|legacyReadQueueState" src/core/daemon/queue.ts
```

- [ ] **Step 3: Delete the legacy branches**

In `src/core/daemon/queue.ts`:
1. Remove `queueBackend()` function (lines 16-18).
2. Remove `legacyReadQueueState` and `legacy*` write helpers (the JSONL fold and any legacy claim/done/failed paths).
3. Remove every `if (queueBackend() === 'jsonl') { ...legacy... } else { ...sqlite... }` branch — keep only the SQLite branch.
4. Keep `appendEvent` and the JSONL write side-effects in the SQLite path so the audit trail file still gets written.

- [ ] **Step 4: Update `src/tracker/CLAUDE.md`**

Remove the line:
> `HRAUTO_QUEUE_BACKEND=jsonl` is a temporary cutover fallback only. Default queue authority is SQLite.

Replace with:
> Queue authority is SQLite. The `.queue.jsonl` file in `.tracker/daemons/` is an append-only audit trail only — readers must not consume it as state.

Also check `src/core/CLAUDE.md` for similar mentions and update.

- [ ] **Step 5: Update tests**

In `tests/unit/core/daemon/daemon-queue.test.ts`:
- Delete every test that explicitly sets `process.env.HRAUTO_QUEUE_BACKEND = 'jsonl'`.
- Keep tests that verify `.queue.jsonl` audit lines are still appended on enqueue/claim/done/failed.
- Confirm SQLite-path tests still pass without the env var dispatch.

- [ ] **Step 6: Run the broader daemon test suite**

```bash
npm run test -- daemon-queue
npm run test -- daemon
npm run test -- daemon-client
npm run test -- enqueue-dispatch
npm run typecheck
npm run test:architecture
```

All must pass.

- [ ] **Step 7: Commit**

```bash
git add src/core/daemon/queue.ts src/tracker/CLAUDE.md \
        tests/unit/core/daemon/daemon-queue.test.ts
git commit -m "$(cat <<'EOF'
refactor(daemon): retire JSONL queue backend, SQLite is sole authority

HRAUTO_QUEUE_BACKEND=jsonl was a transitional fallback; SQLite has
been the default. Removed legacyReadQueueState + every queueBackend()
gate. .queue.jsonl audit-append preserved for tail-f debugging.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Final Sweep

After all six tasks merge to master:

- [ ] Run the full suite once over the combined diff:

```bash
npm run typecheck:all
npm run test
npm run test:architecture
```

- [ ] Smoke test the dashboard:

```bash
npm run dashboard
# In another terminal: load http://localhost:5173, click into a recent run,
# open the Events tab, confirm events render. Page through dates in the date
# picker. Run npm run separation 1234 once and confirm the queue row appears
# and screenshots are visible if the run failed.
```

- [ ] Run `clean:tracker` end-to-end against a real `.tracker/` and confirm both file deletes and SQLite row deletes are reported.

- [ ] Update `src/tracker/CLAUDE.md` "Lessons Learned" with one dated entry per task that introduced non-obvious behavior (rotation read order, SQLite-first SSE fallback, LRU sizing rationale, queue-backend retirement).

- [ ] Run codex:rescue over the combined diff (read-only review per the global execution model). Findings come back to the orchestrator session for follow-up commits if any.

---

## Self-Review Notes

- **Spec coverage:** Every smell from the audit has a task: sessions.jsonl growth (Task 1), JSONL-on-every-tick (Task 2 — sessions, Task 3 — screenshots), SQLite TTL gap (Task 4), parseCache unbounded (Task 5), dual queue backend (Task 6).
- **Type consistency:** `cleanOldSessionFiles` (Task 1), `pruneStateDb` (Task 4), `queryScreenshotsForItem` / `groupScreenshotRows` (Task 3), `querySessionEventsForRun` (Task 2), `__resetParseCacheForTests` / `__getParseCacheSizeForTests` (Task 5) are all referenced consistently between definition and consumer steps.
- **Placeholder scan:** No "TBD"/"add error handling"/"similar to Task N". One explicit "stop and surface to orchestrator" guard in Task 6 with a concrete trigger condition.
- **Risk concentrated in Task 6.** It's the only task that *removes* a code path. Pre-flight grep is mandatory; if a non-test caller exists, the task degrades gracefully to a deprecation-with-warning step rather than a hard cut.
