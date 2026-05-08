# Perf Tier 1+2+3 Review Follow-ups Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` to execute this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Address every concrete finding from the consolidated Tier 1+2+3 perf review (3 Important + 7 Minor follow-ups; the lint-commit revert recommendation is intentionally out of scope per user direction).

**Architecture:** Each fix is small and disjoint. All run sequentially on master with one commit per task. No worktrees — no shared-file conflicts and the plan is short enough that linear history is easier to read than parallel merges.

**Tech Stack:** Node 26, `node:sqlite`, Hono, React 19, tsx.

**Verification (every task):**
- `npm run typecheck` — must pass
- `npm run test:architecture` — must pass
- Per-task unit tests where listed

**Source review:** Findings come from a code reviewer subagent over `git diff 0c2de27c..c5661915` (the full perf-review arc, 26 commits). Each task quotes the relevant finding for context.

---

## Task 1: `useSessions` structural compare in setState updater

**Why:** Tier 3 Task 10B dropped the `JSON.stringify(prev) === JSON.stringify(data)` short-circuit in `useSessions` on the assumption that "downstream consumers already memoize." That assumption is wrong — `TerminalDrawer` (`TerminalDrawer.tsx:43`) does `state.workflows.filter(...)`, producing a fresh array reference on every SSE tick even when the underlying data is identical. `React.memo`'d `WorkflowBox` children re-render anyway because the array prop fails referential equality. Net effect: dropping the dedupe **increases** render frequency for the drawer subtree.

**Fix:** Restore deduplication with a fast structural compare in the `setState` updater function. No more `JSON.stringify` cost; same-state messages keep the previous reference, breaking the downstream re-render chain.

**Files:**
- Modify: `src/dashboard/components/hooks/useSessions.ts` (37 lines today; one `setState` callsite at line 18)

**Reference shape (read first):** `src/dashboard/components/shared/types.ts:295-298` defines `SessionState` as `{ workflows: WorkflowInstanceState[], duoQueue: DuoQueueEntry[] }`. The fields that meaningfully change between SSE ticks are `instance`, `active`, `pidAlive`, `currentItemId`, `currentStep`, `itemInFlight`, `finalStatus`, `sessions.length` per workflow + `requestId`, `state` per duoQueue entry.

- [ ] **Step 1: Baseline**

```bash
npm run typecheck && npm run test:architecture
```

- [ ] **Step 2: Replace the body of `useSessions.ts`**

Open `src/dashboard/components/hooks/useSessions.ts`. Replace the file with:

```ts
import { useState, useEffect } from "react";
import type { SessionState, WorkflowInstanceState, DuoQueueEntry } from "@/components/shared/types";

const EMPTY_STATE: SessionState = { workflows: [], duoQueue: [] };

/**
 * Cheap structural fingerprint compare. Returns true when the meaningful
 * fields are identical. Replaces the previous `JSON.stringify` short-circuit
 * (1-5ms per tick on large payloads) and the briefly-broken "no dedupe"
 * variant (Tier 3 Task 10B) which caused TerminalDrawer's filter() to
 * produce fresh array refs on every tick, defeating React.memo on children.
 */
function sessionStateEqual(a: SessionState, b: SessionState): boolean {
  if (a === b) return true;
  if (a.workflows.length !== b.workflows.length) return false;
  if (a.duoQueue.length !== b.duoQueue.length) return false;
  for (let i = 0; i < a.workflows.length; i++) {
    if (!workflowEqual(a.workflows[i], b.workflows[i])) return false;
  }
  for (let i = 0; i < a.duoQueue.length; i++) {
    if (!duoEntryEqual(a.duoQueue[i], b.duoQueue[i])) return false;
  }
  return true;
}

function workflowEqual(a: WorkflowInstanceState, b: WorkflowInstanceState): boolean {
  return (
    a.instance === b.instance &&
    a.active === b.active &&
    a.pidAlive === b.pidAlive &&
    a.crashedOnLaunch === b.crashedOnLaunch &&
    a.currentItemId === b.currentItemId &&
    a.itemInFlight === b.itemInFlight &&
    a.currentStep === b.currentStep &&
    a.finalStatus === b.finalStatus &&
    a.startedAt === b.startedAt &&
    a.sessions.length === b.sessions.length
  );
}

function duoEntryEqual(a: DuoQueueEntry, b: DuoQueueEntry): boolean {
  return (
    a.requestId === b.requestId &&
    a.state === b.state &&
    a.position === b.position
  );
}

export function useSessions(): { state: SessionState; connected: boolean } {
  const [state, setState] = useState<SessionState>(EMPTY_STATE);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    const es = new EventSource("/events/sessions");

    es.onopen = () => setConnected(true);

    es.onmessage = (e) => {
      try {
        const data: SessionState = JSON.parse(e.data);
        setState((prev) => (sessionStateEqual(prev, data) ? prev : data));
      } catch {
        // Ignore malformed
      }
    };

    es.onerror = () => {
      setConnected(false);
    };

    return () => {
      es.close();
      setConnected(false);
    };
  }, []);

  return { state, connected };
}
```

Note: deliberately *no* deep compare of `sessions[i].browsers`. If a browser auth state changes (`idle → authenticating → authed`), the workflow's `currentStep` or `itemInFlight` will also change in the same tick — those drive the equality miss. If they don't, the browser-only change is invisible to the drawer until the next meaningful event. That matches the previous `JSON.stringify` behavior closely enough that the perf win dominates.

- [ ] **Step 3: Type-check**

```bash
npm run typecheck
```

Expected: clean. The new helpers are pure-typed against the existing `SessionState` shape.

- [ ] **Step 4: Architecture + full tests**

```bash
npm run test:architecture && npm run test
```

Expected: all pass. There are no existing `useSessions` unit tests (no jsdom harness in this repo) — frontend hooks are validated manually. Manually verify by running `npm run dashboard` and watching that `TerminalDrawer` no longer flickers per tick when no workflow state has changed.

- [ ] **Step 5: Commit**

```bash
git add src/dashboard/components/hooks/useSessions.ts
git commit -m "$(cat <<'EOF'
fix(dashboard): structural dedupe in useSessions setState updater

Tier 3 Task 10B dropped the JSON.stringify dedupe on the assumption
that downstream consumers already memoize. TerminalDrawer.filter()
produces a fresh array reference per tick, so React.memo'd children
re-render anyway — the perf win was negative.

Restore dedupe with a typed structural compare on the meaningful
fields (workflow length + per-instance active/pidAlive/currentStep
/itemInFlight/finalStatus/sessions.length, duoQueue length + per-
entry requestId/state/position). Same-state messages keep the
previous reference; downstream React.memo wins again.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: OCR localStorage `pagehide` flush

**Why:** Tier 3 Task 10D added `setTimeout(300)` debounce around `OcrReviewPane`'s localStorage write. The previous synchronous-on-every-keystroke shape meant the operator's last edit always survived a tab close. After the debounce, hitting Cmd-W within 300ms of typing drops that final character from `localStorage.getItem(storageKey)` on next page load — a regression for the close-and-restore UX.

**Fix:** Add a `pagehide` listener that flushes any pending debounce synchronously. `pagehide` fires reliably on tab close, navigation, and bfcache eviction; it's the modern replacement for `beforeunload` and is supported in every evergreen browser. Combined with the existing 300ms debounce, no in-flight edit is lost.

**Files:**
- Modify: `src/dashboard/components/ocr/OcrReviewPane.tsx:142-154` (one `useEffect`)

- [ ] **Step 1: Baseline**

```bash
npm run typecheck && npm run test:architecture
```

- [ ] **Step 2: Replace the localStorage debounce effect**

In `src/dashboard/components/ocr/OcrReviewPane.tsx`, find:

```ts
  // Persist edits — debounced 300ms so rapid keystrokes don't hit localStorage
  // synchronously on every character. Final write still lands; intermediate
  // writes are dropped.
  useEffect(() => {
    const handle = window.setTimeout(() => {
      if (Object.keys(localEdits).length === 0) {
        try { window.localStorage.removeItem(storageKey); } catch { /* ignore */ }
        return;
      }
      try { window.localStorage.setItem(storageKey, JSON.stringify(localEdits)); } catch { /* quota / unavailable */ }
    }, 300);
    return () => window.clearTimeout(handle);
  }, [localEdits, storageKey]);
```

Replace with:

```ts
  // Persist edits — debounced 300ms so rapid keystrokes don't hit localStorage
  // synchronously on every character. Final write still lands; intermediate
  // writes are dropped. A `pagehide` listener flushes the pending write so a
  // tab close within 300ms of the last keystroke doesn't lose it.
  useEffect(() => {
    let pendingFlush: (() => void) | null = null;

    const flush = (): void => {
      if (Object.keys(localEdits).length === 0) {
        try { window.localStorage.removeItem(storageKey); } catch { /* ignore */ }
        return;
      }
      try { window.localStorage.setItem(storageKey, JSON.stringify(localEdits)); } catch { /* quota / unavailable */ }
    };

    const handle = window.setTimeout(() => {
      pendingFlush = null;
      flush();
    }, 300);
    pendingFlush = flush;

    const onPageHide = (): void => {
      if (pendingFlush) {
        pendingFlush();
        pendingFlush = null;
      }
    };
    window.addEventListener("pagehide", onPageHide);

    return () => {
      window.clearTimeout(handle);
      window.removeEventListener("pagehide", onPageHide);
    };
  }, [localEdits, storageKey]);
```

Behavior:
- During normal typing: every keystroke restarts the 300ms timer, only the final `flush` runs. Same as before.
- On `pagehide` (tab close, navigation, bfcache): the pending `flush` runs synchronously before the document unloads. No edits lost.
- Cleanup on unmount: clears the timer and detaches the listener.

- [ ] **Step 3: Type-check**

```bash
npm run typecheck
```

Expected: clean.

- [ ] **Step 4: Architecture + full tests**

```bash
npm run test:architecture && npm run test
```

Expected: all pass. No tests for this hook today (no jsdom harness). Manually validate: open `OcrReviewPane`, type into a field, immediately Cmd-W; reopen and confirm the typed character is restored from localStorage.

- [ ] **Step 5: Commit**

```bash
git add src/dashboard/components/ocr/OcrReviewPane.tsx
git commit -m "$(cat <<'EOF'
fix(dashboard): flush OCR localEdits on pagehide

Tier 3 Task 10D's 300ms debounce coalesces keystrokes but loses the
final character if the operator closes the tab within the debounce
window. Add a `pagehide` listener that flushes the pending write
synchronously before the document unloads — no edits lost on tab
close, no regression in the steady-state typing path.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: `findPriorEntriesByKey` SQLite/JSONL parity (TRIM + local-timezone cutoff)

**Why:** Tier 3 Task 7 added a SQLite path for `/api/find-prior-by-key` but the SQLite and JSONL paths now diverge in two ways:

1. **Whitespace handling.** JSONL path (`ops/queue.ts:347`) does `String(value).trim() !== wantedValue` — it trims the candidate value before comparing. SQLite path (`queries.ts:327`) uses exact `json_extract(latest_data_json, '$.' || @key) = @value`. An entry stored with surrounding whitespace matches in JSONL but not in SQLite. Low likelihood (data is mostly trimmed at write time), but the paths are no longer equivalent.

2. **Cutoff timezone.** `ops/queue.ts:309` computes `cutoff.toISOString().slice(0, 10)` — that's UTC. JSONL fallback at line 336 parses dates as local (`new Date(d + "T00:00:00").getTime()`). Late-evening US queries can differ by a day between paths.

**Fix:**
- Trim in SQL: `TRIM(json_extract(latest_data_json, '$.' || @key)) = @value`. The JS-side caller already trims `wantedValue` at `ops/queue.ts:300`, so the comparison is symmetric.
- Use `dateLocal()` for the cutoff so it matches the JSONL path's local-time semantics.

**Files:**
- Modify: `src/tracker/state/queries.ts` (the `queryPriorEntriesByKey` SQL at line 327)
- Modify: `src/tracker/dashboard/ops/queue.ts` (the cutoff derivation at line 309)
- Modify: `tests/unit/tracker/queries.test.ts` (add parity coverage; if file doesn't exist, see Step 5)

- [ ] **Step 1: Baseline**

```bash
npm run typecheck && npm run test:architecture && npm run test -- --grep "queryPriorEntriesByKey|findPriorEntriesByKey"
```

Note the existing test file path from the output. Tier 3 Task 7 added 7 new tests for `queryPriorEntriesByKey` — they live somewhere under `tests/unit/tracker/`.

- [ ] **Step 2: Add TRIM to the SQL in `queryPriorEntriesByKey`**

In `src/tracker/state/queries.ts`, find the SQL at line 321-330. Change:

```ts
      AND json_extract(latest_data_json, '$.' || @key) = @value
```

to:

```ts
      AND TRIM(json_extract(latest_data_json, '$.' || @key)) = @value
```

(One-character change conceptually: wrap the `json_extract` call in `TRIM(...)`. SQLite `TRIM` returns NULL if its arg is NULL, so the existing `latest_data_json IS NOT NULL` predicate still gates correctly. `TRIM` with no second arg defaults to whitespace.)

Update the JSDoc on `queryPriorEntriesByKey` to reflect the trim semantic. Find:

```ts
 * SQLite JSON1: `json_extract(latest_data_json, '$.' || @key)` works for
 * top-level keys only — behaviorally equivalent to the JSONL path's
 * `entry.data?.[keyField]` (which is also single-level).
 */
```

Replace with:

```ts
 * SQLite JSON1: `json_extract(latest_data_json, '$.' || @key)` works for
 * top-level keys only — behaviorally equivalent to the JSONL path's
 * `entry.data?.[keyField]` (which is also single-level). The result is
 * wrapped in TRIM(...) to match the JSONL path's `String(value).trim()`
 * comparison; callers should pass an already-trimmed @value.
 */
```

- [ ] **Step 3: Switch the cutoff in `findPriorEntriesByKey` to local time**

In `src/tracker/dashboard/ops/queue.ts`, find the cutoff derivation around line 297-309:

```ts
  const days = Math.max(1, Math.min(opts.days ?? 90, 365));
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  const cutoffMs = cutoff.getTime();
  const wantedValue = keyValue.trim();
  if (!wantedValue) return [];

  // SQLite fast path: query the `items` table (latest event per item_id per date)
  // when the projection DB is available. Falls back to JSONL scan on any hiccup.
  if (isStateDbReady(dir)) {
    try {
      const db = openStateDb(dir);
      // Compute YYYY-MM-DD cutoff matching the JSONL path's date arithmetic.
      const cutoffDate = cutoff.toISOString().slice(0, 10);
```

Verify the import path for `dateLocal` (already used in the same file? if not, add the import — `import { dateLocal } from "../../jsonl.js";` matching the existing tracker conventions; check sibling imports).

Replace the `const cutoffDate = ...` line with:

```ts
      // Match the JSONL fallback's local-time cutoff. UTC slicing here would
      // shift the cutoff by a day for late-evening queries in negative-UTC
      // timezones (US/PT), silently dropping the boundary day's hits.
      const cutoffDate = dateLocal(cutoff);
```

If `dateLocal` isn't already imported in this file, add the import (top-of-file, matching existing tracker imports).

- [ ] **Step 4: Add a parity unit test**

Find the existing test file from Step 1's output (likely `tests/unit/tracker/queries.test.ts`). Add a test alongside the existing `queryPriorEntriesByKey` tests:

```ts
test("queryPriorEntriesByKey trims candidate whitespace to match JSONL semantics", () => {
  const dir = mkdtempSync(join(tmpdir(), "qpebk-trim-"));
  try {
    const db = openStateDb(dir);
    // Insert a row whose data_json field has surrounding whitespace.
    insertItemRow(db, {
      workflow: "separations",
      tracker_date: "2026-05-08",
      item_id: "doc-001",
      latest_run_id: "doc-001#1",
      latest_status: "done",
      latest_step: "transaction",
      latest_ts: "2026-05-08T10:00:00.000Z",
      latest_data_json: JSON.stringify({ employeeName: "  Jane Doe  " }),
    });
    const rows = queryPriorEntriesByKey(db, {
      workflow: "separations",
      keyField: "employeeName",
      keyValue: "Jane Doe",
      cutoffDate: "2026-04-01",
    });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, "doc-001");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
```

(Adjust the `insertItemRow` helper invocation to whatever the existing tests in this file use to populate the `items` table — copy the shape from a neighbor test.)

- [ ] **Step 5: Verify the new test fails before the fix and passes after**

If you've already applied Step 2's TRIM change, the test will pass. To verify pre-fix behavior, temporarily revert just the SQL change, run the test, confirm FAIL, then reapply.

```bash
npm run test -- --grep "queryPriorEntriesByKey"
```

Expected: all 7 existing tests + the new trim test pass.

- [ ] **Step 6: Full verification**

```bash
npm run typecheck && npm run test:architecture && npm run test
```

All three must pass.

- [ ] **Step 7: Commit**

```bash
git add src/tracker/state/queries.ts src/tracker/dashboard/ops/queue.ts tests/unit/tracker/
git commit -m "$(cat <<'EOF'
fix(tracker): SQLite/JSONL parity for findPriorEntriesByKey

Tier 3 Task 7's SQLite path drifted from the JSONL fallback in two
ways: (1) JSONL trims the candidate value before comparing; SQLite
used exact equality, missing entries with surrounding whitespace.
(2) JSONL parses dates as local time; SQLite used `cutoff.toISOString().slice(0,10)`
(UTC), shifting the boundary by a day for late-evening queries in
negative-UTC zones.

Wrap the SQL json_extract in TRIM() and switch the cutoff derivation
to dateLocal(). The two paths now return identical results for the
same input. Adds a regression test for the trim semantic.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Migration 6 first-boot rewrite — operator note

**Why:** Tier 3 Task 4 adds migration 6 which runs `ALTER TABLE run_events DROP COLUMN raw_json`. SQLite implements DROP COLUMN as a full table rewrite (not in-place metadata). On a prod state DB with millions of `run_events` rows, the first dashboard boot after this change pauses for tens of seconds while the rewrite runs. The plan acknowledged the cost but didn't surface it to the operator anywhere they'd see it.

**Fix:** Documentation-only. Add a short operator note to `src/tracker/CLAUDE.md`'s Lessons Learned section, and a comment in `schema.ts` at migration 6 explaining the one-time cost. No code change.

**Files:**
- Modify: `src/tracker/state/schema.ts` (migration 6's comment, near `LATEST_SCHEMA_VERSION = 6`)
- Modify: `src/tracker/CLAUDE.md` (Lessons Learned section, append a dated entry)

- [ ] **Step 1: Baseline**

```bash
npm run typecheck && npm run test:architecture
```

- [ ] **Step 2: Expand the migration 6 comment**

In `src/tracker/state/schema.ts`, find the migration-6 entry. The current shape (illustrative — match what's actually there):

```ts
{
  version: 6,
  up: (db) => {
    // SQLite 3.35+ supports DROP COLUMN. node:sqlite ships modern SQLite.
    db.exec(`ALTER TABLE run_events DROP COLUMN raw_json;`);
  },
},
```

Replace its inline comment with:

```ts
{
  version: 6,
  up: (db) => {
    // SQLite 3.35+ supports DROP COLUMN as a full table rewrite (not
    // metadata-only). For an existing prod state DB with millions of
    // run_events rows, this migration pauses the first dashboard boot
    // by tens of seconds while the rewrite runs. Subsequent boots are
    // unaffected. Fresh DBs run migrations 1→6 in sequence and pay the
    // cost on a near-empty table — negligible. See tracker/CLAUDE.md
    // 2026-05-08 lesson for the operator-side surface.
    db.exec(`ALTER TABLE run_events DROP COLUMN raw_json;`);
  },
},
```

- [ ] **Step 3: Append a dated lesson to `src/tracker/CLAUDE.md`**

In `src/tracker/CLAUDE.md`, find the `## Lessons Learned` section. Insert a new entry at the top of the list (most recent first):

```markdown
- **2026-05-08: Migration 6 (drop run_events.raw_json) is a full table rewrite on first boot.** SQLite 3.35+'s `DROP COLUMN` rebuilds the table rather than mutating metadata in place. On a prod state DB with millions of `run_events` rows, the first `openStateDb()` after pulling Tier 3 will pause for tens of seconds while the rewrite runs — operators may see the dashboard "hang" on startup. Subsequent boots are unaffected. If the pause is unacceptable on a particular deployment, the workaround is to back up `.tracker/state.db`, delete it, and let the projection rebuild on next dashboard launch (cost: full JSONL replay, but background-free). Fresh DBs running migrations 1→6 in sequence pay the cost on a near-empty table and aren't affected.
```

- [ ] **Step 4: Verify**

```bash
npm run typecheck && npm run test:architecture && npm run test
```

All three should pass — comment + markdown changes only.

- [ ] **Step 5: Commit**

```bash
git add src/tracker/state/schema.ts src/tracker/CLAUDE.md
git commit -m "$(cat <<'EOF'
docs(tracker): note migration 6 first-boot rewrite cost

Migration 6 (drop run_events.raw_json, Tier 3 Task 4) runs SQLite's
DROP COLUMN, which rebuilds the entire table. On prod DBs with
millions of run_events rows the first boot pauses for tens of
seconds. Document the cost and workaround in the migration's inline
comment + tracker CLAUDE.md lessons-learned, so operators know to
expect the pause.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Daemon `onBrowserDisconnect` dead-code cleanup

**Why:** Tier 3 Task 5 added a closure-scoped `lastRegisteredInFlight` flag to skip redundant `registerBrowserProcesses` calls. The `onBrowserDisconnect` handler resets `browsersRegistered = false` and `lastRegisteredInFlight = null` "so a future Session.launch re-registers fresh PIDs" (`daemon.ts:487-489`). Reviewer caught that there's no future Session.launch — the very next lines set `shuttingDown = true` and `shutdownResolve?.()`, the daemon exits, and one daemon never re-launches in the same process lifetime. The reset code is harmless but misleading and adds noise.

**Fix:** Drop the two reset lines, keep the warn + shutdown signal. Clarify the comment.

**Files:**
- Modify: `src/core/daemon/daemon.ts:486-497` (the `unsubscribeDisconnect` handler body)

- [ ] **Step 1: Baseline**

```bash
npm run typecheck && npm run test:architecture && npm run test -- --grep "daemon"
```

- [ ] **Step 2: Edit the disconnect handler**

In `src/core/daemon/daemon.ts`, find the handler (around line 486-497):

```ts
        const unsubscribeDisconnect = session.onBrowserDisconnect((systemId) => {
          // Reset so a future Session.launch re-registers fresh PIDs.
          browsersRegistered = false
          lastRegisteredInFlight = null
          if (shuttingDown) return
          log.warn(
            `[Daemon ${wf.config.name}/${instanceId}] browser disconnected (${systemId}); shutting down`,
          )
          shuttingDown = true
          shutdownResolve?.()
          wakeResolve?.()
        })
```

Replace with:

```ts
        const unsubscribeDisconnect = session.onBrowserDisconnect((systemId) => {
          // A daemon's lifetime is one Session.launch — there is no
          // re-launch path inside a single daemon process. So we don't
          // bother resetting browsersRegistered / lastRegisteredInFlight
          // here (they'd be dead-code resets). The disconnect just
          // triggers shutdown; the OS reclaims the daemon's state.
          if (shuttingDown) return
          log.warn(
            `[Daemon ${wf.config.name}/${instanceId}] browser disconnected (${systemId}); shutting down`,
          )
          shuttingDown = true
          shutdownResolve?.()
          wakeResolve?.()
        })
```

- [ ] **Step 3: Verify daemon tests still pass**

```bash
npm run test -- --grep "daemon|registerBrowserProcesses"
```

Expected: pass. No test should depend on the removed resets — Tier 3 Task 5's verification deliberately preserved per-claim re-registration semantics; the dead resets were never exercised by tests.

- [ ] **Step 4: Full verification**

```bash
npm run typecheck && npm run test:architecture && npm run test
```

All three must pass.

- [ ] **Step 5: Commit**

```bash
git add src/core/daemon/daemon.ts
git commit -m "$(cat <<'EOF'
refactor(daemon): drop dead-code reset in onBrowserDisconnect

Tier 3 Task 5 added a closure-scoped browsersRegistered guard.
The disconnect handler reset it "so a future Session.launch
re-registers fresh PIDs" — but a daemon's lifetime is one
Session.launch, no re-launch path exists in the same process.
The resets are harmless but misleading. Remove them; clarify
the comment to explain why no reset is needed.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: `recomputeRunOrdinals` — parameterized SQL

**Why:** Tier 3 Task 3 implemented `recomputeRunOrdinals` as a single CTE-driven UPDATE via `db.exec(...)`. Because `db.exec` doesn't bind parameters at the top level, `date` is escaped via `safeDate.replace(/'/g, "''")`. Reviewer noted the pattern is fragile — even though `dateLocal()` only produces YYYY-MM-DD strings, manual escape is the kind of thing that drifts out of correctness when someone edits the function later. SQLite supports parameterized statements via `db.prepare(...).run()` for non-SELECT statements; CTE in an UPDATE works fine in a prepared statement.

**Fix:** Replace the `db.exec` call with `db.prepare(...).run({ date })`. Same SQL, same perf, no manual escape.

**Files:**
- Modify: `src/tracker/state/rebuild.ts:248-280` (the `recomputeRunOrdinals` function)

- [ ] **Step 1: Baseline**

```bash
npm run typecheck && npm run test:architecture && npm run test -- --grep "recomputeRunOrdinals|rebuild"
```

- [ ] **Step 2: Replace `recomputeRunOrdinals`**

In `src/tracker/state/rebuild.ts`, find:

```ts
export function recomputeRunOrdinals(db: Database, date: string): void {
  // Single CTE-driven UPDATE replaces N per-row UPDATEs.
  // date is a controlled YYYY-MM-DD string from dateLocal() — not user input.
  const safeDate = date.replace(/'/g, "''");
  db.exec(`
    WITH ordered AS (
      SELECT
        workflow, item_id, run_id,
        ROW_NUMBER() OVER (
          PARTITION BY workflow, item_id
          ORDER BY COALESCE(first_work_ts, first_any_ts), run_id
        ) AS ordinal
      FROM runs
      WHERE tracker_date = '${safeDate}'
    )
    UPDATE runs
    SET run_ordinal = (
      SELECT ordinal FROM ordered
      WHERE ordered.workflow = runs.workflow
        AND ordered.item_id = runs.item_id
        AND ordered.run_id  = runs.run_id
    )
    WHERE tracker_date = '${safeDate}'
      AND EXISTS (
        SELECT 1 FROM ordered
        WHERE ordered.workflow = runs.workflow
          AND ordered.item_id  = runs.item_id
          AND ordered.run_id   = runs.run_id
      );
  `);
}
```

Replace with:

```ts
export function recomputeRunOrdinals(db: Database, date: string): void {
  // Single CTE-driven UPDATE replaces N per-row UPDATEs. Parameterized
  // via db.prepare(...).run() — node:sqlite supports CTE in UPDATEs
  // through prepared statements, no manual string escape needed.
  db.prepare(`
    WITH ordered AS (
      SELECT
        workflow, item_id, run_id,
        ROW_NUMBER() OVER (
          PARTITION BY workflow, item_id
          ORDER BY COALESCE(first_work_ts, first_any_ts), run_id
        ) AS ordinal
      FROM runs
      WHERE tracker_date = @date
    )
    UPDATE runs
    SET run_ordinal = (
      SELECT ordinal FROM ordered
      WHERE ordered.workflow = runs.workflow
        AND ordered.item_id = runs.item_id
        AND ordered.run_id  = runs.run_id
    )
    WHERE tracker_date = @date
      AND EXISTS (
        SELECT 1 FROM ordered
        WHERE ordered.workflow = runs.workflow
          AND ordered.item_id  = runs.item_id
          AND ordered.run_id   = runs.run_id
      );
  `).run({ date });
}
```

(Two `'${safeDate}'` references become `@date`; the manual escape line goes away; `.run({ date })` binds.)

- [ ] **Step 3: Verify the existing rebuild tests still pass**

```bash
npm run test -- --grep "recomputeRunOrdinals|rebuild"
```

Expected: pass. The semantic is identical — same SQL, just parameterized. Tier 3 Task 3's idempotency test (`tests/unit/tracker/state-projector.test.ts`) is the canary here.

- [ ] **Step 4: Full verification**

```bash
npm run typecheck && npm run test:architecture && npm run test
```

All three must pass.

- [ ] **Step 5: Commit**

```bash
git add src/tracker/state/rebuild.ts
git commit -m "$(cat <<'EOF'
refactor(tracker): parameterize recomputeRunOrdinals SQL

Tier 3 Task 3's CTE-driven UPDATE used db.exec with manual
quote-escape (safeDate.replace(/'/g, "''")). The pattern is
fragile — fine for dateLocal()'s controlled output today but
drifts out of correctness if a future edit changes the input.
node:sqlite supports CTE in UPDATEs through db.prepare().run(),
so use that instead — same SQL, same perf, no manual escape.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Skip `rebuild`'s screenshot backfill UPDATE when no new session lines

**Why:** Tier 3 Task 3's `rebuildProjectionForDate` ends with a `UPDATE files SET workflow = ..., item_id = ...` to backfill ownership for screenshot rows whose run row arrived after `applyScreenshotFiles` (`rebuild.ts:236-244`). The UPDATE runs unconditionally on every incremental rebuild — even when no new session lines arrived. With Tier 3 Task 1's `idx_files_run_id_screenshot` partial index it's fast, but every dashboard wake still does a scan.

**Fix:** Track whether any session lines were applied in this rebuild pass. Only run the backfill UPDATE if `sessionLineCountTotal > 0`. The UPDATE is idempotent — skipping it when no new sessions arrived is a true no-op for correctness.

**Files:**
- Modify: `src/tracker/state/rebuild.ts:213-245` (the session loop + trailing UPDATE)

- [ ] **Step 1: Baseline**

```bash
npm run typecheck && npm run test:architecture && npm run test -- --grep "rebuild"
```

- [ ] **Step 2: Add a counter and gate the UPDATE**

In `src/tracker/state/rebuild.ts`, find the session loop + trailing UPDATE block (around line 213-245):

```ts
    for (const { path: sessionsPath, incremental } of sessionFilePairs) {
      const startAt = incremental ? (existingOffsets.get(sessionsPath) ?? 0) : 0;
      const sessions = incremental
        ? parseJsonlFrom<SessionEvent | ScreenshotSessionEvent>(sessionsPath, startAt)
        : parseJsonl<SessionEvent | ScreenshotSessionEvent>(sessionsPath);
      let sessionLineCount = 0;
      for (const row of sessions) {
        const eventDate = sessionEventDate(row.value);
        if (eventDate !== date) continue;
        sessionLineCount += 1;
        applySessionEvent(db, row.value, source(sessionsPath, "session", row.line, row.offset, eventDate));
      }
      recordSource(db, { path: sessionsPath, sourceKind: "session", trackerDate: date, lineCount: sessionLineCount });
    }

    recomputeRunOrdinals(db, date);

    // Backfill workflow + item_id on screenshot files whose run row arrived
    // after `applyScreenshotFiles` ran (or that predate the join fix landing
    // in the 2026-05-07 storage-opt). `queryScreenshotsForItem` filters by
    // (workflow, item_id), so null-owner rows are otherwise invisible to the
    // SQLite-first /api/screenshots path. Idempotent — re-running matches
    // the same rows the next pass would.
    db.prepare(`
      UPDATE files
      SET workflow = (SELECT workflow FROM runs WHERE runs.run_id = files.run_id),
          item_id  = (SELECT item_id  FROM runs WHERE runs.run_id = files.run_id)
      WHERE files.kind = 'screenshot'
        AND files.run_id IS NOT NULL
        AND (files.workflow IS NULL OR files.item_id IS NULL)
        AND EXISTS (SELECT 1 FROM runs WHERE runs.run_id = files.run_id)
    `).run();
  });
}
```

Modify to track total applied session lines and gate the UPDATE:

```ts
    let sessionLinesAppliedTotal = 0;
    for (const { path: sessionsPath, incremental } of sessionFilePairs) {
      const startAt = incremental ? (existingOffsets.get(sessionsPath) ?? 0) : 0;
      const sessions = incremental
        ? parseJsonlFrom<SessionEvent | ScreenshotSessionEvent>(sessionsPath, startAt)
        : parseJsonl<SessionEvent | ScreenshotSessionEvent>(sessionsPath);
      let sessionLineCount = 0;
      for (const row of sessions) {
        const eventDate = sessionEventDate(row.value);
        if (eventDate !== date) continue;
        sessionLineCount += 1;
        applySessionEvent(db, row.value, source(sessionsPath, "session", row.line, row.offset, eventDate));
      }
      sessionLinesAppliedTotal += sessionLineCount;
      recordSource(db, { path: sessionsPath, sourceKind: "session", trackerDate: date, lineCount: sessionLineCount });
    }

    recomputeRunOrdinals(db, date);

    // Backfill workflow + item_id on screenshot files whose run row arrived
    // after `applyScreenshotFiles` ran (or that predate the join fix landing
    // in the 2026-05-07 storage-opt). `queryScreenshotsForItem` filters by
    // (workflow, item_id), so null-owner rows are otherwise invisible to the
    // SQLite-first /api/screenshots path. Idempotent — re-running matches
    // the same rows the next pass would. Skip when no new session lines
    // arrived: screenshot rows are only emitted as ScreenshotSessionEvents,
    // so without a session-line increment there are no new candidate rows.
    if (sessionLinesAppliedTotal > 0) {
      db.prepare(`
        UPDATE files
        SET workflow = (SELECT workflow FROM runs WHERE runs.run_id = files.run_id),
            item_id  = (SELECT item_id  FROM runs WHERE runs.run_id = files.run_id)
        WHERE files.kind = 'screenshot'
          AND files.run_id IS NOT NULL
          AND (files.workflow IS NULL OR files.item_id IS NULL)
          AND EXISTS (SELECT 1 FROM runs WHERE runs.run_id = files.run_id)
      `).run();
    }
  });
}
```

(Three changes: declare the total counter outside the loop, accumulate inside, wrap the UPDATE in an `if`.)

- [ ] **Step 3: Verify**

```bash
npm run test -- --grep "rebuild|projection"
```

Expected: pass. Tier 3 Task 3's idempotency test should pass unchanged — it adds new session lines on each pass, so `sessionLinesAppliedTotal > 0` always holds in that test.

- [ ] **Step 4: Full verification**

```bash
npm run typecheck && npm run test:architecture && npm run test
```

All three must pass.

- [ ] **Step 5: Commit**

```bash
git add src/tracker/state/rebuild.ts
git commit -m "$(cat <<'EOF'
perf(tracker): skip screenshot backfill UPDATE when no new sessions

Tier 3 Task 3's trailing UPDATE files SET workflow=..., item_id=...
ran on every incremental rebuild even when no new session lines
arrived. With idx_files_run_id_screenshot the scan is fast but it
still wakes the page cache for nothing. Track the total applied
session lines and gate the UPDATE on > 0 — screenshots are only
emitted via ScreenshotSessionEvents so no session-line increment
means no new candidate rows.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: `parseJsonlFrom` truncation detection

**Why:** Tier 3 Task 3's incremental rebuild keys off `stat.size > startAt`. If a JSONL file is *truncated below* its previously-recorded byte_offset and then rewritten with shorter content (or just truncated and not yet rewritten), `parseJsonlFrom` skips it entirely (`stat.size <= startAt` returns `[]`). New bytes appended *after* the truncation never get parsed because the byte_offset lookup still returns the pre-truncation value. JSONL files are append-only via `appendFileSync` in normal operation, so this is exotic — but adding a single-line safety net costs nothing.

**Fix:** When `stat.size < startAt` (file shrank), reset `startAt = 0` and parse from the beginning. `INSERT OR IGNORE` on UNIQUE(source_path, source_offset) absorbs any duplicates. Also store the new size as the byte_offset on the next `recordSource` call (already does — the helper writes `stat.size` regardless).

**Files:**
- Modify: `src/tracker/state/rebuild.ts:56-84` (`parseJsonlFrom`)

- [ ] **Step 1: Baseline**

```bash
npm run typecheck && npm run test:architecture && npm run test -- --grep "rebuild|projection"
```

- [ ] **Step 2: Add truncation detection inside `parseJsonlFrom`**

In `src/tracker/state/rebuild.ts`, find the existing function (lines 56-84):

```ts
function parseJsonlFrom<T>(path: string, startAt: number): ParsedLine<T>[] {
  const stat = existsSync(path) ? statSync(path) : null;
  if (!stat || stat.size <= startAt) return [];
  const remaining = stat.size - startAt;
  const buf = Buffer.alloc(remaining);
  const fd = openSync(path, "r");
  try {
    readSync(fd, buf, 0, remaining, startAt);
  } finally {
    closeSync(fd);
  }
  const text = buf.toString("utf-8");
  const out: ParsedLine<T>[] = [];
  let offset = startAt;
  let line = 1; // approximate — we don't track absolute line number from startAt
  for (const rawLine of text.split("\n")) {
    const bytes = Buffer.byteLength(rawLine + "\n");
    if (rawLine.trim()) {
      try {
        out.push({ value: JSON.parse(rawLine) as T, line, offset });
      } catch {
        // Tolerant — a truncated tail line should not block the dashboard.
      }
    }
    offset += bytes;
    line += 1;
  }
  return out;
}
```

Replace with:

```ts
function parseJsonlFrom<T>(path: string, startAt: number): ParsedLine<T>[] {
  const stat = existsSync(path) ? statSync(path) : null;
  if (!stat) return [];
  // Truncation detection: if the file is now shorter than the cached
  // offset, the file was truncated/rewritten between rebuilds. Reset to
  // the start; INSERT OR IGNORE on UNIQUE(source_path, source_offset)
  // absorbs duplicates. Without this branch, post-truncation appends
  // would be skipped forever (`stat.size <= startAt`).
  const effectiveStart = stat.size < startAt ? 0 : startAt;
  if (stat.size <= effectiveStart) return [];
  const remaining = stat.size - effectiveStart;
  const buf = Buffer.alloc(remaining);
  const fd = openSync(path, "r");
  try {
    readSync(fd, buf, 0, remaining, effectiveStart);
  } finally {
    closeSync(fd);
  }
  const text = buf.toString("utf-8");
  const out: ParsedLine<T>[] = [];
  let offset = effectiveStart;
  let line = 1; // approximate — we don't track absolute line number from startAt
  for (const rawLine of text.split("\n")) {
    const bytes = Buffer.byteLength(rawLine + "\n");
    if (rawLine.trim()) {
      try {
        out.push({ value: JSON.parse(rawLine) as T, line, offset });
      } catch {
        // Tolerant — a truncated tail line should not block the dashboard.
      }
    }
    offset += bytes;
    line += 1;
  }
  return out;
}
```

(Three changes: introduce `effectiveStart`, replace two uses of `startAt` with `effectiveStart`. Behavior unchanged when `stat.size >= startAt`; new safety net when shrunk.)

- [ ] **Step 3: Add a regression test**

In Tier 3 Task 3's test file (likely `tests/unit/tracker/state-projector.test.ts`), append:

```ts
test("rebuild handles JSONL truncation by re-reading from offset 0", () => {
  const dir = mkdtempSync(join(tmpdir(), "rebuild-trunc-"));
  try {
    const date = "2026-05-08";
    const path = join(dir, `separations-${date}.jsonl`);

    // Write 3 entries, rebuild — projection_sources records byte_offset = full size.
    appendFileSync(path, JSON.stringify({ workflow: "separations", id: "doc-1", runId: "doc-1#1", status: "pending", timestamp: "2026-05-08T10:00:00Z" }) + "\n");
    appendFileSync(path, JSON.stringify({ workflow: "separations", id: "doc-2", runId: "doc-2#1", status: "pending", timestamp: "2026-05-08T10:01:00Z" }) + "\n");
    appendFileSync(path, JSON.stringify({ workflow: "separations", id: "doc-3", runId: "doc-3#1", status: "pending", timestamp: "2026-05-08T10:02:00Z" }) + "\n");
    const db = openStateDb(dir);
    rebuildProjectionForDate(db, { dir, date });
    const before = db.prepare(`SELECT COUNT(*) AS n FROM run_events WHERE workflow = 'separations' AND tracker_date = ?`).get(date) as { n: number };
    assert.equal(before.n, 3);

    // Truncate the file to a single (different) entry — file is now smaller.
    writeFileSync(path, JSON.stringify({ workflow: "separations", id: "doc-4", runId: "doc-4#1", status: "pending", timestamp: "2026-05-08T11:00:00Z" }) + "\n");
    rebuildProjectionForDate(db, { dir, date });

    // The new doc-4 line lands; doc-1/2/3 stay (INSERT OR IGNORE doesn't delete).
    const after = db.prepare(`SELECT COUNT(*) AS n FROM run_events WHERE workflow = 'separations' AND tracker_date = ?`).get(date) as { n: number };
    assert.ok(after.n >= 4, `expected at least 4 (3 stale + 1 new), got ${after.n}`);
    const newRow = db.prepare(`SELECT 1 FROM run_events WHERE workflow = 'separations' AND item_id = 'doc-4'`).get();
    assert.ok(newRow, "doc-4 (post-truncation) should be present");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
```

(Adjust imports — `writeFileSync`/`appendFileSync` from `node:fs`, `mkdtempSync`/`rmSync` likely already imported, `openStateDb` from the state module. Match existing imports in the test file.)

- [ ] **Step 4: Verify**

```bash
npm run test -- --grep "rebuild|projection"
```

Expected: all existing tests + the new truncation test pass.

- [ ] **Step 5: Full verification**

```bash
npm run typecheck && npm run test:architecture && npm run test
```

All three must pass.

- [ ] **Step 6: Commit**

```bash
git add src/tracker/state/rebuild.ts tests/unit/tracker/
git commit -m "$(cat <<'EOF'
fix(tracker): detect JSONL truncation in incremental rebuild

parseJsonlFrom returned [] when stat.size <= cached byte_offset,
which means a file truncated below its cached offset (and any new
appends to it) would be skipped forever. JSONL files are append-only
in normal operation but the safety net is a one-line cost. If
stat.size < startAt, reset to 0 and re-parse — INSERT OR IGNORE on
UNIQUE(source_path, source_offset) absorbs duplicates.

Adds a regression test that truncates a JSONL between rebuilds and
verifies the post-truncation entries land in the projection.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: `session-events.ts` step LIKE wildcard escape

**Why:** Tier 2 Task `emitStepChange` SQLite seek uses `message LIKE '%' || @step || '%'` (`session-events.ts:205`). SQLite's `LIKE` interprets `%` and `_` as wildcards by default — if a step name ever contains either character, the LIKE behavior surprises (matches more than the literal step name). The JSONL fallback uses `String.includes` which has no wildcard semantics. No current step name uses these characters, but a future step could. The fix is one of two patterns: (a) `LIKE '%' || REPLACE(REPLACE(@step, '\\', '\\\\'), '%', '\\%') || '%' ESCAPE '\\'` — ugly but parameterized; (b) restrict step names at write time to a documented charset and add an architecture test. (a) is more robust and one-time cost; (b) requires guarding every step name producer.

**Fix:** (a) — wrap @step in REPLACE chains that escape `\`, `%`, `_`, then add `ESCAPE '\\'` to the `LIKE`. Add a regression test.

**Files:**
- Modify: `src/tracker/session-events.ts:195-218` (the `findStepWithinWindow` SQLite path)

- [ ] **Step 1: Baseline**

```bash
npm run typecheck && npm run test:architecture && npm run test -- --grep "emitStepChange|session-events|findStepWithinWindow"
```

- [ ] **Step 2: Add wildcard escape**

In `src/tracker/session-events.ts`, find the SQLite branch around lines 195-217:

```ts
    try {
      const db = openStateDb(dir);
      const row = db.prepare(`
        SELECT 1
        FROM logs
        WHERE workflow = @workflow
          AND tracker_date = @date
          AND run_id = @runId
          AND level = 'step'
          AND ts_ms >= @cutoff
          AND message LIKE '%' || @step || '%'
        LIMIT 1
      `).get({
        workflow,
        date: dateLocal(),
        runId,
        cutoff: cutoffMs,
        step,
      });
      return row !== undefined;
    } catch {
      // Fall through to JSONL path on any SQLite hiccup.
    }
```

Replace with:

```ts
    try {
      const db = openStateDb(dir);
      // Escape SQL LIKE wildcards (%, _) and the escape character (\) in
      // @step so the substring match is literal — same semantics as the
      // JSONL fallback's String.includes. Without this, a future step name
      // containing % or _ would over-match. Use \ as the escape character
      // (uncommon in step names; see ESCAPE clause).
      const row = db.prepare(`
        SELECT 1
        FROM logs
        WHERE workflow = @workflow
          AND tracker_date = @date
          AND run_id = @runId
          AND level = 'step'
          AND ts_ms >= @cutoff
          AND message LIKE
            '%' ||
            REPLACE(REPLACE(REPLACE(@step, '\\', '\\\\'), '%', '\\%'), '_', '\\_')
            || '%' ESCAPE '\\'
        LIMIT 1
      `).get({
        workflow,
        date: dateLocal(),
        runId,
        cutoff: cutoffMs,
        step,
      });
      return row !== undefined;
    } catch {
      // Fall through to JSONL path on any SQLite hiccup.
    }
```

(SQL string-literal `'\\'` in TypeScript = a single backslash; SQLite LIKE's `ESCAPE '\\'` declares that backslash. The triple-nested REPLACE escapes `\` first, then `%`, then `_` — same order as if hand-escaping in JS.)

- [ ] **Step 3: Add a regression test**

Find the existing tests for `emitStepChange` / `findStepWithinWindow` (likely in `tests/unit/tracker/session-events.test.ts` or `tests/unit/tracker/state-jsonl-live-apply.test.ts`). Append:

```ts
test("findStepWithinWindow LIKE escape: % and _ in step name match literally", () => {
  const dir = mkdtempSync(join(tmpdir(), "step-like-"));
  try {
    // Seed two log rows: one whose message contains the literal step "extract%done",
    // and one whose message would only match if % were a wildcard ("extractZdone").
    // The literal-only match should hit; the wildcard-leak match should not.
    const db = openStateDb(dir);
    const date = dateLocal();
    db.prepare(`
      INSERT INTO logs (workflow, tracker_date, item_id, run_id, level, message, ts_ms, source_path, source_offset, applied_at)
      VALUES
        ('test-wf', ?, 'item-1', 'item-1#1', 'step', 'literal extract%done message', ?, 'fake', 0, ?),
        ('test-wf', ?, 'item-1', 'item-1#1', 'step', 'extractZdone wildcard-leak message', ?, 'fake', 1, ?)
    `).run(date, Date.now(), new Date().toISOString(), date, Date.now(), new Date().toISOString());

    // findStepWithinWindow searches today + last N min, so use the live function.
    const found = findStepWithinWindow({ workflow: "test-wf", runId: "item-1#1", step: "extract%done", windowMs: 60_000, dir });
    assert.equal(found, true, "literal step name should match");

    // Wildcard-leak: searching for "extractXdone" should NOT match "extractZdone"
    // even though % wildcard semantics would allow it. The escape ensures literal-only.
    const leak = findStepWithinWindow({ workflow: "test-wf", runId: "item-1#1", step: "extractXdone", windowMs: 60_000, dir });
    assert.equal(leak, false, "literal step name should not match different message under wildcard semantics");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
```

(Adjust imports + the `findStepWithinWindow` import to match the actual exported name and signature in `session-events.ts`. Read the file before writing the test.)

- [ ] **Step 4: Verify**

```bash
npm run test -- --grep "session-events|findStepWithinWindow|emitStepChange"
```

Expected: all existing tests + the new wildcard-escape test pass.

- [ ] **Step 5: Full verification**

```bash
npm run typecheck && npm run test:architecture && npm run test
```

All three must pass.

- [ ] **Step 6: Commit**

```bash
git add src/tracker/session-events.ts tests/unit/tracker/
git commit -m "$(cat <<'EOF'
fix(tracker): escape % and _ in findStepWithinWindow LIKE clause

Tier 2 emitStepChange's SQLite seek used LIKE '%' || @step || '%'
without escaping wildcards. JSONL fallback uses String.includes
(no wildcard semantics). No current step name contains % or _, but
a future one could and the divergence would silently over-match.

Wrap @step in REPLACE chains that escape \\, %, and _, declare
ESCAPE '\\\\' on the LIKE. Adds a regression test that wildcards
in the search term match literally only.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 10: SQLite/JSONL parity lesson + parseJsonlFrom line-number comment

**Why:** Two small documentation items:

1. **Reviewer recommendation:** "json_extract(...) = @value SQL parity should be a checklist item for any future SQLite vs JSONL parallel-path migration." Tier 3 Task 7's whitespace + timezone divergence is the kind of bug that won't show in dev but silently loses hits in prod. Surface this in `LESSONS.md` so future sessions doing parallel-path SQLite migrations have the checklist.

2. **Minor #8 acknowledgement:** `parseJsonlFrom`'s comment notes "approximate — we don't track absolute line number from startAt." `source.line` is a debug field today (UNIQUE constraint uses `source_offset`), but the comment should be more explicit so a future dev surfacing `source.line` in a debug tool doesn't get confused.

**Fix:** Append a dated lesson to `src/LESSONS.md`. Tighten the line-number comment in `rebuild.ts`.

**Files:**
- Modify: `src/LESSONS.md` (append a dated entry)
- Modify: `src/tracker/state/rebuild.ts` (the `line = 1; // approximate` comment in `parseJsonlFrom`)

- [ ] **Step 1: Baseline**

```bash
npm run typecheck && npm run test:architecture
```

- [ ] **Step 2: Append lesson to `src/LESSONS.md`**

In `src/LESSONS.md`, find the most-recent-first lessons list. Append at the top:

```markdown
- **2026-05-08: SQLite/JSONL parallel-path parity checklist.** Tier 3's `findPriorEntriesByKey` SQLite migration drifted from its JSONL fallback in two non-obvious ways: (1) JSONL trimmed candidate values via `String(value).trim()`; SQLite used exact `=` until a follow-up wrapped it in `TRIM(...)`. (2) JSONL's date cutoff was local time (`new Date(d + "T00:00:00").getTime()`); SQLite used UTC (`cutoff.toISOString().slice(0, 10)`), shifting the boundary by a day for late-evening queries in negative-UTC zones. Both bugs would silently lose hits in prod without surfacing as test failures (dev data is mostly clean and the timezone-boundary case requires running queries past local midnight UTC ≈ 5pm PT). When migrating any JSONL-walking handler to SQLite, write a parity checklist before shipping: (a) **whitespace** — does the JSONL path call `.trim()` / `.toLowerCase()` / etc on candidate values? Mirror in SQL via `TRIM`, `LOWER`. (b) **timezone** — does any date cutoff use `dateLocal()` / `new Date()` parsing? Mirror in SQL with the same local-time derivation, never `toISOString().slice(0, 10)`. (c) **wildcards** — does the JSONL path use `String.includes`? SQL `LIKE` interprets `%` and `_` as wildcards; escape them via `REPLACE` chains + `ESCAPE` clause if the SQL match should be literal-only. (d) **null vs empty** — JSONL's `entry.data?.[key] === value` treats missing-data and missing-key the same; `json_extract(..., '$.' || @key)` returns `NULL` for both, so `IS NOT NULL` gating before the comparison is fine. (e) **dedup semantics** — JSONL Map walks reduce to "latest per key"; SQL aggregation may need `MAX(ts) GROUP BY key` or a CTE that picks the latest. The Tier 3 Task 7 deviation pivoted to the `items` table specifically because it pre-stores latest-per-(workflow, tracker_date, item_id), eliminating the GROUP BY — but that's not always available; default to "verify the dedup explicitly."
```

- [ ] **Step 3: Tighten the line-number comment in `rebuild.ts`**

In `src/tracker/state/rebuild.ts`, find the `parseJsonlFrom` comment:

```ts
  let offset = effectiveStart;
  let line = 1; // approximate — we don't track absolute line number from startAt
```

(If Task 8 hasn't landed yet, the variable is `startAt` not `effectiveStart` — keep whichever Task 8 produced.)

Replace with:

```ts
  let offset = effectiveStart;
  // The `line` field is local to this read slice (1-indexed from startAt),
  // NOT an absolute line number in the file. Used only as a debug breadcrumb
  // — UNIQUE constraint on (source_path, source_offset) means correctness
  // hinges on `offset`, not `line`. If a future debug tool surfaces
  // `source.line`, document this caveat there.
  let line = 1;
```

- [ ] **Step 4: Verify**

```bash
npm run typecheck && npm run test:architecture && npm run test
```

All three must pass — comment + markdown only.

- [ ] **Step 5: Commit**

```bash
git add src/LESSONS.md src/tracker/state/rebuild.ts
git commit -m "$(cat <<'EOF'
docs: SQLite/JSONL parity checklist + parseJsonlFrom line-number caveat

Append a 2026-05-08 lesson to src/LESSONS.md capturing the parallel-
path parity checklist surfaced by Tier 3 Task 7's whitespace +
timezone drift: trim, timezone, wildcards, null vs empty, dedup
semantics. Future SQLite migrations should walk this list before
shipping.

Tighten the parseJsonlFrom line-number comment so a future debug
tool surfacing `source.line` understands it's relative to the read
slice, not the file. Correctness hinges on `offset`, not `line`.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## End-of-plan verification

After all 10 tasks are committed, run:

```bash
npm run typecheck:all
npm run test
npm run test:architecture
git log --oneline -10
```

Expected:
- All three must pass.
- `git log` shows 10 new commits (3 `fix(...)`, 2 `refactor(...)`, 1 `perf(...)`, 1 `docs(...)` for migration 6, 1 `docs(...)` for the LESSONS.md, plus the inline tighten — collapse the LESSONS.md + rebuild comment into one task=one commit; final count is 10 commits matching task numbers).

The previous Tier 1+2+3 perf review's three Important findings + four of seven Minors are addressed. The lint-commit revert (Minor #10) is intentionally out of scope.
