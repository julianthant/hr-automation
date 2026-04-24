# Daemon-Mode Run Isolation + Separations Stability — Design

**Date:** 2026-04-23
**Status:** Draft, pending implementation
**Scope:** separations workflow + kernel daemon mode + cross-workflow primitives
**Prior context:** `2026-04-22-workflow-daemon-mode-design.md`, `2026-04-23-run-events-instance-filtering-design.md`, session memories S99, S102, S108, S114, S116

## Executive Summary

Separations is the highest-complexity workflow in this repo (4 systems, interleaved auth, multi-phase orchestration) and it's the first to expose several daemon-mode issues that will affect every other daemonized workflow as they see real usage. This spec covers:

1. **P0 bugs blocking the current separations run** — transaction number dropping when a later step throws; Kuali step-cache serving stale user-edited data; cross-item state bleed in the dashboard.
2. **Daemon-mode run isolation hardening** — `filterEventsForRun`'s orphan-event fallback currently attributes every daemon-level event to every item; scoping it by time window fixes the real bug.
3. **Cross-workflow primitives that are ready but selectively wired** — a name-based empl-id lookup usable as a three-tier fallback in `getJobSummaryData`; screenshot outlier cleanup.
4. **Knowledge transfer** — document the new patterns in per-layer `CLAUDE.md` files so onboarding / work-study / emergency-contact sessions inherit the fixes instead of re-discovering them.

The design is organized so that Part 2 fixes probably make Part 1.4 (cross-item dashboard state) fall out for free. Part 3 is independent and can ship in any order.

## Scope

### In scope

**Part 1 — Separations stability (P0)**
- 1.1 Transaction number not populating on docs completed via idempotency or when a later step throws
- 1.2 Remove `stepCacheGet`/`stepCacheSet` from `kuali-extraction`
- 1.3 Daemon startup opacity when `launchFn` hangs ("browsers don't launch")
- 1.4 `WorkflowBox` / `StepPipeline` showing stale per-step state from previous items

**Part 2 — Daemon-mode run isolation (cross-cutting)**
- 2.1 `filterEventsForRun` time-window fallback so orphan events don't bleed across items in the same daemon
- 2.2 Verify and commit the in-flight working-tree changes (`itemInFlight`, authTimings rotation, stale-screenshot filter)
- 2.3 Document the run-isolation contract in `src/core/CLAUDE.md`

**Part 3 — Cross-workflow primitives**
- 3.1 `lookupEmplIdByName(page, name)` in `src/systems/ucpath/` as a standalone primitive
- 3.2 Extend `getJobSummaryData(page, eid, nameHint?)` with the three-tier cascade (Workforce → Person Org Summary by EID → Person Org Summary by Name)
- 3.3 Remove or repurpose the `page.screenshot` outlier at `src/systems/ucpath/transaction.ts:536`
- 3.4 Document the "when to promote a fallback to system-level" pattern

**Part 4 — Knowledge transfer**
- 4.1 Update `src/workflows/separations/CLAUDE.md` with new lessons
- 4.2 Update `src/core/CLAUDE.md` with the isolation contract
- 4.3 Update `src/systems/ucpath/CLAUDE.md` with the cascade pattern

### Out of scope (deferred)

- **Cross-workflow error taxonomy framework** — audit shows no concrete cross-workflow demand; premature.
- **Browser-utility helper library** (`.catch()` chain extraction) — audit labelled this "opportunity, not urgent"; inline chains are more readable than helpers for one-off call sites.
- **Universal cache-clear CLI + `invalidateIfPriorRunFailed` primitive** — decided against in this pass after memory S99's step-cache discussion: disabling the one problematic caller is simpler and correct.
- **Step pipeline `34+6≠39` rounding fix** — likely a symptom of the cross-item bleed (Part 1.4), not a rounding bug. Revisit only if it persists after Part 1.4 + Part 2.1 ship.
- **Kernel-level "resume from last successful step"** — remains explicitly out of scope per `2026-04-18-step-cache-design.md`.

## Part 1 — Separations Stability

### 1.1 Transaction number not populating on completed docs

**Symptom.** Doc 3927 completed but the detail panel shows `Txn # = "—"`.

**Root cause.** `src/workflows/separations/workflow.ts:430-607` sets the local `transactionNumber` var at three success points (lines 473, 483, 516) but only calls `ctx.updateData({ transactionNumber, ... })` at handler exit (line 596). If `kuali-finalization` (line 568) throws — e.g., Kuali page timeout, save button not found — the exception unwinds the handler before reaching line 596. The tracker entry's `data` never gets patched.

**Fix.** Call `ctx.updateData({ transactionNumber })` inline immediately after each of the three assignment sites. `ctx.updateData` is idempotent (merging the same value is a no-op), so keeping the final exit updateData for the other fields is safe.

**Edit sites (workflow.ts):**
- After line 473 (idempotency-hit with recorded txn)
- After line 483 (idempotency readback recovery)
- After line 530 (fresh submit `recordSuccess`, where `transactionNumber` is now known)

**Test.** `tests/unit/workflows/separations/txn-number-propagation.test.ts` — mock a handler that throws in `kuali-finalization` after a successful ucpath-transaction, assert the tracker entry's `data.transactionNumber` is non-empty at the terminal `failed` event.

### 1.2 Remove Kuali-extraction step-cache

**Symptom.** User corrected a wrong EID in Kuali doc 3924, re-ran separations, but the step-cache served the previous-run's stale EID, causing downstream wrong-employee actions.

**Root cause.** `src/workflows/separations/workflow.ts:80` imports `stepCacheGet`/`stepCacheSet`; lines 219 and 236 wire them into `kuali-extraction`. Kuali docs are user-editable between runs. Caching user-editable sources violates the only safe caching rule: write-once sources only.

**Fix.** Remove the import and the two call sites. Verify no other step in separations caches extracted data.

**Generalization.** Document the rule in `src/core/CLAUDE.md` (Part 4.2): *cache only write-once or non-user-editable sources*. Examples safe to cache: CRM employee record (onboarding), UCPath Person Org Summary on a known EID (read-only). Examples unsafe: Kuali Build docs (user-editable forms), any source the user might correct between runs.

### 1.3 Daemon startup opacity

**Symptom.** "the 5min startup timeout isn't working for newer added separations. it doesn't use the browsers at all and just times out."

**Current state.** `src/core/daemon.ts:130` starts the HTTP server (including `/whoami`) BEFORE `launchFn` is invoked at line 171, so `spawnDaemon`'s handshake resolves quickly. The observable failure mode must therefore be: daemon is alive per `/whoami`, but `launchFn` hangs or throws silently during auth. The daemon's `withBatchLifecycle` wrapper propagates the throw, emits `workflow_end(failed)`, and the process exits — leaving enqueued items stranded.

**Fix — observability first.** This is a case where "make the failure legible" is more important than "automatically recover" because we don't have enough signal yet to know whether the right fix is Duo retry, sessionDir reset, or something else.

Three additive changes:

1. **Lifecycle-phase logging in daemon main loop** — emit `log.step("[Daemon %s] phase=launching")`, `phase=authenticating`, `phase=idle`, `phase=processing`, `phase=draining`. Each phase transition is one log line. Visible via `npm run separation:attach`.

2. **Expose phase in `/status`** — add `phase` field to the `/status` JSON response. `npm run separation:status` prints it. CLI can warn "daemon stuck in authenticating for 4+ minutes" rather than silently timing out.

3. **Auth-failure fanout for daemon mode** — when `launchFn` throws in `runWorkflowDaemon`, emit a `daemon_auth_failed` tracker event (workflowInstance-scoped, no itemId) with the error message. The dashboard's sessions panel shows this so the user sees "daemon went away due to auth failure" instead of just "daemon disappeared."

**Files touched.** `src/core/daemon.ts`, `src/tracker/session-events.ts` (new event type), `src/dashboard/components/SessionPanel.tsx` (render the new failure state).

**Deferred.** Auto-retry on daemon-level auth failure — loginWithRetry already does per-login retry; daemon-wide retry is a larger design change. Revisit after we have more signal from the instrumented version.

### 1.4 Dashboard cross-item state bleed

**Symptom.** `WorkflowBox` for doc 3927 shows Kuali Extraction "in progress" alongside Kronos Search "green 34s" and UCPath Job Summary "red 6s" — impossible in the sequential step order, and the 34s/6s match durations from previously-processed doc 3924.

**Current state.** `computeStepDurations` in `src/tracker/dashboard.ts:1002` is already per-runId keyed (`stepDurationsByRun` at line 1558). Scoping is correct at the backend. The leak must be either:
- (a) Frontend `activeRun?.stepDurations ?? entry?.stepDurations` fallback in `LogPanel.tsx:225` picking up a stale prior-item `entry`
- (b) SSE stream delivering previously-aggregated payload that the frontend hasn't reset on `runId` change
- (c) An event-log fallback (Part 2.1) pulling orphan events into the current run's view

**Fix — diagnose then fix.** Implementation order:
1. Ship Part 2.1 (event-log time-window filter) first. This likely fixes the visible symptom because `entry.stepDurations` is populated from the filtered event stream. If the WorkflowBox renders correctly after Part 2.1, no further fix needed.
2. If the symptom persists, add a diagnostic `console.log` in `StepPipeline.tsx:307` showing the received `stepDurations` and `entry.runId`. Confirm whether the frontend is receiving stale data (backend bug — Part 2.1 regression) or retaining stale props (frontend bug).
3. Frontend fix (if needed): in `LogPanel.tsx`, reset local state on `runId` change using a `useEffect(..., [runId])` hook.

**Files touched (probable).** None beyond Part 2.1. Worst case: `src/dashboard/components/LogPanel.tsx` + one test.

## Part 2 — Daemon-Mode Run Isolation

### 2.1 Event-log time-window filter

**Symptom.** User sees events from other items appearing in a given item's drill-in log view, when those items share the same daemon.

**Root cause.** `filterEventsForRun(events, trackers, runId)` in `src/tracker/dashboard.ts:89` matches events two ways:
```ts
events.filter((e) => e.runId === runId || (!e.runId && e.workflowInstance === instance))
```

Clause (b) was designed for batch mode (one `workflowInstance` = one batch of items, all sharing a single `Session.launch`). In that shape, orphan events (`browser_launch`, session-level events without a `runId` in scope) belong to every item in the batch.

In daemon mode, one `workflowInstance` spans the daemon's entire lifetime — many items, each a distinct runId. Clause (b) pulls orphan events from every past and future item into every item's view.

**Fix.** Time-window the fallback clause by the run's tracker-entry span.

```ts
export function filterEventsForRun(
  events: SessionEvent[],
  trackers: TrackerEntry[],
  runId: string,
): SessionEvent[] {
  const runEntries = trackers.filter((t) => t.runId === runId);
  if (runEntries.length === 0) {
    return events.filter((e) => e.runId === runId);
  }
  const instance = runEntries[0].data?.instance;
  const runStart = Math.min(...runEntries.map((t) => new Date(t.timestamp).getTime()));
  const runEnd = Math.max(...runEntries.map((t) => new Date(t.timestamp).getTime()));

  return events.filter((e) => {
    if (e.runId === runId) return true;
    if (e.runId) return false; // belongs to a different run
    if (e.workflowInstance !== instance) return false;
    const ets = new Date(e.ts).getTime();
    return ets >= runStart && ets <= runEnd;
  });
}
```

**Edge cases.**
- **In-progress run** has no terminal tracker entry → `runEnd` uses `max(lastTrackerTs, Date.now())`. Implementation: in the endpoint handler, pass `runEndOverride: Date.now()` when the run's final-status entry isn't present.
- **Single-item daemon** behaves identically — single tracker span, no overlap possible.
- **Pre-roll window** — auth events emitted via the kernel's observer carry a `runId` when per-item (see `authTimings` injection in `runOneItem`). Daemon-level auth (first item only) emits orphan events but those precede item #1's tracker entries by <1s; they should remain visible via the workflowInstance-plus-window clause, which naturally includes them. No extra pre-roll window needed.

**Tests.** `tests/unit/tracker/filter-events-for-run-timewindow.test.ts` — table-driven:
1. Single-item daemon: orphan events within item's window included; outside excluded.
2. Two-item daemon: item-A events not visible in item-B view.
3. Legacy batch (shared `workflowInstance`, all items within one shared span): behaves as before (all orphans visible in each item's view).
4. In-progress run: orphan events after `lastTrackerTs` up to `Date.now()` included.

### 2.2 Verify and commit in-flight changes

The working tree currently has uncommitted changes to:
- `src/core/daemon.ts` — emits `item_start`/`item_complete` in the claim loop; first item gets real `authTimings`, subsequent items get zero-duration synthetic timings anchored at claim time
- `src/dashboard/components/WorkflowBox.tsx`, `types.ts` — `itemInFlight` state + `Idle` pill when daemon is between items
- `src/tracker/dashboard.ts` — `itemInFlight` in `WorkflowInstanceState`, flipped on `item_start`/`item_complete`; stale-screenshot-path filter in `buildScreenshotsHandler`
- `vite.dashboard.config.ts` — `/screenshots` proxy

**Action.** These changes are coherent with the isolation design. Review the diff once more for correctness, wire the unit tests from Part 2.1 as a cross-check, then commit as `feat(daemon): per-item isolation for authTimings, itemInFlight, screenshot paths`.

### 2.3 Document the isolation contract

Add a section to `src/core/CLAUDE.md` titled **"Run isolation in daemon mode"** covering:

1. **Primary filter by `runId`** — every per-item tracker event carries it; the SSE endpoint and dashboard filters trust it first.
2. **Orphan-event fallback by `workflowInstance` + time window** — orphan events (no runId) attach to a run only if they fall within that run's `[firstTrackerTs, lastTrackerTs]` span AND share the same `workflowInstance`.
3. **`itemInFlight` is the authoritative live-state signal** — set on `item_start`, cleared on `item_complete`. Dashboard uses this for the "Idle" vs "processing <doc>" pill. Do not infer live state from tracker events.
4. **`authTimings` rotation pattern** — real daemon-startup timings are injected into item #1 only; subsequent items get zero-duration synthetic `auth:<id>` rows anchored at claim time. Explicit design choice: using real startup timings for item #N would drag `firstLogTs` back to daemon-start, inflating the item's elapsed timer by the full queue-wait.

## Part 3 — Cross-Workflow Primitives

### 3.1 `lookupEmplIdByName` primitive

Add `src/systems/ucpath/employee-search.ts`:

```ts
export interface EmployeeSearchResult {
  emplId: string;
  firstName: string;
  lastName: string;
}

/**
 * Search Person Org Summary for one employee by name. Used as a last-resort
 * fallback when EID-based searches fail (e.g., wrong EID entered upstream).
 *
 * Tries name variants: full → first-only → middle-only. Returns null if
 * no unique match.
 */
export async function lookupEmplIdByName(
  page: Page,
  name: string,
): Promise<EmployeeSearchResult | null>
```

Implementation reuses the same Person Org Summary search form that eid-lookup and `lookupJobInfoByEidFromPersonOrgSummary` already use — one shared `searchPersonOrgSummaryByName` helper between eid-lookup and this new primitive.

**Barrel export.** Add to `src/systems/ucpath/index.ts`.

**Refactor note.** eid-lookup workflow's per-item handler has this logic inlined; as a follow-up (not this pass), refactor eid-lookup to call the new primitive. Not required for this spec — only the primitive needs to exist for Part 3.2.

### 3.2 Three-tier cascade in `getJobSummaryData`

**Current shape.** `getJobSummaryData(page, emplId)` in `src/systems/ucpath/job-summary.ts:238` tries Workforce Job Summary (`searchJobSummary`); on empty, falls back to Person Org Summary by EID (`lookupJobInfoByEidFromPersonOrgSummary`).

**New shape.** `getJobSummaryData(page, emplId, opts?: { nameHint?: string })`. Three-tier cascade:
1. Workforce Job Summary by EID
2. Person Org Summary by EID
3. If `opts.nameHint` is provided AND tiers 1–2 failed: `lookupEmplIdByName(page, opts.nameHint)` → if unique match, retry Person Org Summary with the found EID → return the new EID alongside job data so the caller can update downstream state.

**Return type change.** Extend the return to include an `emplIdUsed` field so callers can detect "we actually used a different EID" and log / update accordingly.

```ts
export interface JobSummaryResult {
  deptId: string;
  departmentDescription: string;
  jobCode: string;
  jobDescription: string;
  emplIdUsed: string; // NEW — the EID that actually resolved
}
```

**Separations wiring.** In `workflow.ts`, the ucpath-job-summary task calls `getJobSummaryData(page, kualiData.eid, { nameHint: kualiData.employeeName })`. If `emplIdUsed !== kualiData.eid`, log a `log.warn("[Separations] Kuali EID %s resolved to correct EID %s via name fallback")` and propagate `emplIdUsed` into subsequent UCPath steps (the `ucpath-transaction` step fills `emplId` on the Smart HR form).

**Opt-in for other workflows.** Other callers pass `{ nameHint: ... }` when they have a name. No caller is broken by the change since `nameHint` is optional.

**Files touched.** `src/systems/ucpath/job-summary.ts`, `src/systems/ucpath/employee-search.ts` (new, from 3.1), `src/systems/ucpath/index.ts`, `src/workflows/separations/workflow.ts`.

### 3.3 Screenshot outlier at ucpath/transaction.ts:536

**Current line:** `await page.screenshot({ path: '.screenshots/save-disabled-${Date.now()}.png' }).catch(() => {})`.

**Context.** This fires when the Save/Submit button is disabled after all form filling — a diagnostic capture for a known failure mode (missing required field, modal mask covering the button).

**Fix.** Replace with a structured emission via a `ctx.screenshot`-equivalent primitive. Since `ucpath/transaction.ts` is a system module (not a workflow handler), it doesn't have `ctx` in scope. Two options:

- **Option A:** Thread `ctx.screenshot` into `clickSaveAndSubmit(page, frame, ucpathName, opts?: { screenshot?: ScreenshotFn })`. Caller (workflow handler) passes its `ctx.screenshot` as a bound callback.
- **Option B:** Remove the screenshot. The kernel's `Stepper.step` catch-block already invokes `screenshotAll` on step failure — the disabled-Save case manifests as a thrown error in `clickSaveAndSubmit`, so the kernel's screenshot will fire anyway with the same state.

**Chosen: Option B.** The kernel's failure screenshot is already structured (emits a tracker event with `kind: "error"`, labeled with the step name, dashboard-queryable). The ad-hoc `.png` dump is redundant and unstructured.

**Files touched.** `src/systems/ucpath/transaction.ts` (one-line removal + brief comment).

### 3.4 Document the cascade pattern

Add to `src/systems/ucpath/CLAUDE.md` a section **"Workflow-aware fallback primitives"** describing:
- When to promote a fallback from workflow-level to system-level (rule: if more than one workflow would benefit AND the fallback is stateless wrt workflow context)
- `getJobSummaryData`'s three-tier cascade as the reference pattern
- How future workflows opt in (pass `nameHint` at call site)

## Part 4 — Knowledge Transfer

### 4.1 `src/workflows/separations/CLAUDE.md` additions

Under "Lessons Learned," add dated entries for:
- **2026-04-23: TXN # requires inline updateData at each success point** (not just handler exit) because later steps can throw.
- **2026-04-23: Kuali extraction excluded from step-cache** — user-editable source; caching violates write-once rule.
- **2026-04-23: `getJobSummaryData` accepts `nameHint`** for three-tier EID fallback; separations passes `kualiData.employeeName`.
- **2026-04-23: Daemon-mode event isolation via time-window fallback** — `filterEventsForRun` now scopes orphan events to the run's tracker-entry span.

### 4.2 `src/core/CLAUDE.md` additions

Under "Design invariants":
- **Run isolation contract** (see Part 2.3 text above) — new top-level section.

Under "Lessons Learned":
- **2026-04-23: `filterEventsForRun` time-window fallback** — one-line summary + pointer to this spec.
- **2026-04-23: Caching rule for step-cache callers** — write-once or non-user-editable sources only; user-editable sources either skip cache or use manual invalidation.

### 4.3 `src/systems/ucpath/CLAUDE.md` additions

- Under "Lessons Learned": **2026-04-23: Three-tier cascade in getJobSummaryData** — pointer to 3.4 design.
- New selectors registered in `selectors.ts` by `lookupEmplIdByName` (if any are not already covered by Person Org Summary registrations).

## Implementation Sequencing

**Wave 1 — P0 fixes (ship first):**
1. Part 1.1 — TXN # inline updateData (3 edits + 1 test) — 15 min
2. Part 1.2 — remove Kuali step-cache (3 line deletions) — 5 min
3. Part 2.1 — `filterEventsForRun` time-window + tests — 45 min
4. Part 1.4 — verify symptom resolved; frontend fix only if needed — 15 min

**Wave 2 — commit in-flight + observability:**
5. Part 2.2 — review + commit working-tree changes — 15 min
6. Part 1.3 — daemon-phase logging + `/status` exposure + `daemon_auth_failed` event — 45 min

**Wave 3 — primitives:**
7. Part 3.1 — `lookupEmplIdByName` primitive + tests — 30 min
8. Part 3.2 — `getJobSummaryData` cascade + separations wiring + tests — 30 min
9. Part 3.3 — screenshot outlier removal — 5 min

**Wave 4 — docs + verification:**
10. Part 4.1 / 4.2 / 4.3 — CLAUDE.md updates — 30 min
11. End-to-end verification: fresh separation daemon, 3+ docs with one pre-edited to need name fallback; confirm TXN # populated, per-item logs isolated, WorkflowBox shows correct per-item state, `daemon-attach` shows phase transitions.

**Estimated total:** ~4 hours of focused implementation.

## Testing Strategy

**Unit tests (new):**
- `tests/unit/tracker/filter-events-for-run-timewindow.test.ts` — 4 scenarios (see Part 2.1)
- `tests/unit/workflows/separations/txn-number-propagation.test.ts` — mid-handler-throw scenarios
- `tests/unit/systems/ucpath/employee-search.test.ts` — name-variant fallback chain
- `tests/unit/systems/ucpath/job-summary-cascade.test.ts` — three-tier cascade (Workforce empty → PersonOrg empty → name-search success)

**End-to-end verification (manual):**
Run a real daemon with 3 docs: one good, one with a wrong-EID Kuali form (exercises the name fallback), one with a genuinely unfixable error (exercises kuali-finalization-throws → TXN # still populated). Visually inspect the dashboard:
- Each doc's LogPanel drill-in shows only its own events
- Each doc's detail panel shows correct TXN # even when later steps fail
- WorkflowBox pill shows `Idle` between items, `<docId>` during processing
- `npm run separation:status` shows `phase` transitions during startup
