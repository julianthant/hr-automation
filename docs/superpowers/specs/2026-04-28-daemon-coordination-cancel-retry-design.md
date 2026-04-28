# Daemon Coordination: Cancel/Retry/Duplicate Prevention — Design

**Date:** 2026-04-28
**Status:** Draft, awaiting user review
**Scope:** kernel daemon mode (`src/core/daemon*.ts`, `src/core/stepper.ts`, `src/core/session.ts`), dashboard backend (`src/tracker/dashboard.ts`, `src/tracker/dashboard-ops.ts`), dashboard frontend (cancel/retry components, toast lifecycle), and the Duo auth poll cadence.
**Prior context:** `2026-04-22-workflow-daemon-mode-design.md`, `2026-04-23-daemon-isolation-and-separations-stability-design.md`, `2026-04-24-dashboard-operations-design.md`, `2026-04-27-dashboard-ops-plumbing-fixes-design.md`

## Background

Real-world separations runs surfaced four classes of failure on 2026-04-28:

1. **"No alive daemon available to process this item."** Items 3934 and 3935 failed with this message after item 3936 completed. The current orphan-queue sweep (`src/tracker/dashboard.ts:619` `ORPHAN_QUEUE_GRACE_MS = 5 * 60_000` and the sweep at `:669`) marks queued items failed once the grace elapses with zero alive daemons. The daemon's own exit-cleanup at `src/core/daemon.ts:487-528` does the same on every shutdown. Both paths are correct in isolation but combine into a 5-minute window where queued items "look stuck" before being marked failed.

2. **Retry "replaces" the active daemon, leaving 8 chrome windows.** Clicking Retry while a daemon is actively processing a different item sometimes spawns a duplicate daemon. Two underlying bugs feed this: (a) `findAliveDaemons` uses an HTTP `/whoami` probe whose timeout can race against a busy daemon's event loop, returning "0 alive" when one is actually fine; (b) the daemon's force-stop path (`setTimeout(50ms) → process.exit(1)` at `src/core/daemon.ts:159-162`) doesn't allow `Session.close()` to terminate the chrome subprocesses, so chrome windows persist as orphans tied to the user-data-dir. The next spawn attaches new chrome on top.

3. **Cancel toasts get stuck.** Clicking "Cancel" on a queued item (or "Stop daemon") shows a "Cancelling…" / "Stopping daemon…" toast that never resolves. The HTTP call returned, the cancel completed, but the toast doesn't reflect ground truth. When cancel-queued and cancel-daemon happen back-to-back, the daemon's mass-fail-on-exit overwrites the user's `cancelled` reason with `"Daemon stopped before this item could be processed"`, so the UI shows a daemon-stop message instead of the user's cancel intent.

4. **Variable Duo poll backoff (50–5000ms) triggers errors when separations launches 4 systems at once.** The current ramping backoff in the auth polling layer fires bursts of requests against UCSD SSO during simultaneous Duo prompts. The user observes auth-related errors that don't reproduce with a fixed cadence.

## Goals

A single integrated path through daemon coordination, with one principle: **every state transition has exactly one authoritative writer, and the dashboard is a strict reader**. No optimistic UI that diverges from on-disk state. No parallel paths that can race. No "helpful" auto-spawn that overrides reality.

After the change:

- Clicking Retry while a daemon is alive **never spawns a duplicate**. The "8 chrome windows" mode is impossible by construction.
- Cancel verbs each have a clearly defined blast radius and are reflected in the UI within 100ms (visual transition) and within 30s (terminal state).
- Daemon force-stop kills its chrome subprocesses cleanly. No orphan chrome remains.
- Queued items are never failed prematurely while a daemon is alive in any phase. They are failed promptly (≤5s) when no daemon exists.
- The user's "cancelled" intent on an item is never overwritten by a daemon-stop reason.
- Duo polling is a fixed 5000ms cadence, eliminating the 50–5000ms backoff burst.

## Non-Goals

- **No new "soft stop / drain" mode for daemons.** All `:stop` commands are force-stop. Per user direction: "I don't want graceful, I don't want unfinished business."
- **No multi-spawn UI in the dashboard.** Per user: existing `--parallel N` CLI flag is sufficient; the dashboard need not gain a count input.
- **No auto-respawn.** When a daemon dies, queued items fail. Retry is the user's recovery path.
- **No item targeting across daemons.** With multiple alive daemons, items are claimed by whichever daemon races to the queue mutex first. No "send to daemon X" affordance.
- **No graceful shutdown of in-flight chrome operations.** Cancel-running interrupts at step boundaries via cooperative cancellation; force-stop SIGKILLs chrome. Mid-Playwright operations are not aborted as a primitive.
- **Cluster B (terminal-style footer / SessionPanel relocation) and Cluster C (separations duplicate auto-fill) are deferred to follow-up sessions.** This spec covers Cluster A only.

## The Single Principle

> Every state transition has one authoritative writer; the dashboard reads ground truth.

Every section below maps to that principle:

- §1: queue-file is the single source of "is this item queued vs claimed vs failed". Pre-emitted tracker rows are presentation-layer mirrors; the queue file decides.
- §2: cancel verbs each have one writer (one HTTP endpoint → one tracker row). No double-marking. Authority hierarchy is explicit.
- §3: `findAliveDaemons` is the single source of "which daemons are alive". Probe is reliable enough to trust. Spawn pre-check enforces "no duplicate daemon, no orphan chrome."
- §4: tracker rows + SSE are the only signal for toast resolution. No optimistic UI states the daemon doesn't know about.
- §5: Duo poll cadence is a constant. No backoff variability for the dashboard to interpret.

## Section 1 — Pre-emit + Spawn-Then-Enqueue

### 1.1 Reorder `ensureDaemonsAndEnqueue`

**Where:** `src/core/daemon-client.ts` lines 62–200.

**Today's order:** enqueue first → wake alive → spawn new (this was the 2026-04-22 design choice for instant queue visibility).

**New order:**

1. **Pre-assign `runId` + `id` for every input** (synchronous; uses `randomUUID` + `idFn`).
2. **Fire `onPreEmitPending` immediately** for every input/runId pair. The dashboard sees `pending` tracker rows in <100ms — instant visibility — even though the queue file has not been touched yet. This callback is the user's signal that "something is happening."
3. **If 0 alive daemons:** `await spawnDaemon` for each spawn slot (sequential — Duo can't be parallelized). `spawnDaemon` blocks until `/whoami` responds, which means the lockfile has been written. After this step, every alive daemon is registered.
4. **Wake every alive daemon** (post `/wake`, fire-and-forget).
5. **Append items to the queue file.** This is the only "real" enqueue point.

**Why this order:** every entry that lands in the queue file has at least one registered daemon by construction. The orphan sweep can be aggressive (§1.3) without false positives on the spawn-in-flight window.

**Failure handling:** if `spawnDaemon` rejects (Duo declined, ProcessSingleton, browser launch fault before lockfile), the backend explicitly emits `failed` tracker rows for the pre-emitted ids, with the spawn error as `error`. The queue file is never touched, so there's nothing for the orphan sweep to find. This is symmetric: the same code that pre-emitted `pending` is responsible for emitting `failed` if the spawn never reaches the queue-append step.

### 1.2 New helper: `splitInputsForEnqueue`

**Where:** `src/core/daemon-client.ts`.

```ts
function splitInputsForEnqueue<TData>(
  inputs: TData[],
  idFn: (input: TData, idx: number) => string,
): Array<{ input: TData; id: string; runId: string }> {
  return inputs.map((input, idx) => ({
    input,
    id: idFn(input, idx),
    runId: randomUUID(),
  }))
}
```

Pre-assigning runIds means `onPreEmitPending` and `enqueueItems` agree byte-for-byte on what runId pairs with what input — no second pass to reconcile.

### 1.3 Orphan sweep: 5s cadence, 0 grace

**Where:** `src/tracker/dashboard.ts:619` (`ORPHAN_QUEUE_GRACE_MS`) and `:669` (the sweep emit).

**Change:**
- Sweep cadence: 1s → **5s** (matches the user's "every 5s" request, lighter on disk reads).
- Grace: 5min → **0**. Every queued item has at least one registered daemon by construction (§1.1). The only way this changes is if every alive daemon for the workflow exits — at which point the daemon's own exit-cleanup (`daemon.ts:487-528`) has already failed every queued item. The sweep is now strictly a safety net for "daemon process killed via SIGKILL before exit-cleanup ran."
- New error message text: `"No daemon alive for workflow. Click Retry to spawn a new daemon."` — explicit about how to recover.

**Why no grace works now:** the previous 5-min grace existed because the queue could be populated before any daemon registered. After §1.1, the queue file is only populated after a daemon has registered. The window where "queue has items but 0 alive daemons" is closed.

**Edge case — spawn rejected after queue write:** if `spawnDaemon` rejects mid-flight after a previous daemon disappeared (e.g., the only alive daemon dies right as a new spawn is in-flight), the queue could briefly contain items with no live daemon. The orphan sweep at 5s catches this. The pre-emit-fail path (§1.1) handles the more common case where spawn rejects before any queue write.

### 1.4 Tests

`tests/unit/core/daemon-client-preemit-then-spawn.test.ts`:
- Pre-emit fires before queue file is written; observable via the order of `onPreEmitPending` calls vs `enqueueItems` mock.
- If `spawnDaemon` rejects, every pre-emitted runId gets a corresponding `failed` tracker row, and the queue file is unchanged.
- If `spawnDaemon` resolves but auth never completes (orchestrated via test fixture), the orphan sweep at 5s + 0 grace marks the items failed only after `findAliveDaemons` returns 0.

`tests/unit/tracker/orphan-sweep-cadence.test.ts`:
- Sweep fires every 5s (not 1s).
- With 1+ alive daemon, sweep skips items regardless of how long they've been queued.
- With 0 alive daemons, sweep marks items failed on the first tick after the daemon disappears.

## Section 2 — Cancel Verbs and Authority

### 2.1 Authority hierarchy

| Verb | HTTP route | Daemon impact | Item impact | Authority |
|---|---|---|---|---|
| Cancel queued item | `POST /api/cancel-queued` | none | item → `failed`, `step="cancelled"` | low |
| Cancel running item | `POST /api/cancel-current` | none, daemon resets pages, claims next | in-flight item → `failed`, `step="cancelled"` | medium |
| Cancel daemon (force) | `POST /api/daemons/stop` | daemon dies, chrome killed | in-flight + every queued for this daemon → `failed` | high |

**Beats-relationship:** cancel-daemon supersedes cancel-running supersedes cancel-queued. If two verbs target the same item concurrently, the higher-authority one wins. Concretely:

- User clicks Cancel-running on item A, then Cancel-daemon → daemon dies before cancel-running reaches the next step boundary → item A ends up `failed` with the daemon-stop reason. (Cancel-daemon's blast radius covers item A.)
- User clicks Cancel-queued on item B, then Cancel-daemon → the cancel-queued backend handler races the daemon's exit-cleanup for the queue file mutex. If cancel-queued's tracker write wins first, item B is marked `cancelled`. Daemon's exit-cleanup sees item B's latest tracker row is `cancelled` and does NOT overwrite (see §2.5). If exit-cleanup wins first, item B is marked `failed` with the daemon-stop reason; the user's later cancel-queued click finds the item already in a terminal state and returns 200 with a `{ok: true, alreadyTerminal: true}` body. The frontend toast handles both cases via SSE subscription (§4.1) — whichever event lands first wins the visual.
- User clicks Cancel-queued on item B, then Cancel-running on item A (different items) → independent. Both succeed.

### 2.2 Cancel-running implementation

**Daemon HTTP endpoint** (`src/core/daemon.ts`):

```
POST /cancel-current
Body: { itemId: string, runId: string }
Returns: { ok: true, accepted: true } | { ok: false, error: string }
```

Daemon verifies that `inFlight?.itemId === body.itemId && inFlight?.runId === body.runId`. If match, sets a single shared flag `cancelRequested = true` (with the matched `{itemId, runId}` for verification at the throw site). Returns 200 immediately. If no in-flight item, or itemId/runId mismatches, returns `{ok: false, error: "no matching in-flight item"}` with 409.

**Kernel: `Stepper.step` checks the flag** (`src/core/stepper.ts`):

At the start of every `step(name, fn)`, before invoking `fn`, the stepper consults a callback `isCancelRequested?: () => { itemId: string; runId: string } | null`. If the callback returns a match for the current item, the stepper throws `new CancelledError(name)` instead of invoking `fn`. The error class lives in `src/core/types.ts`:

```ts
export class CancelledError extends Error {
  readonly cancelled = true as const
  constructor(public readonly stepName: string) {
    super(`Step '${stepName}' cancelled by user`)
  }
}
```

**`runOneItem` propagation** (`src/core/workflow.ts`):

- `runOneItem` accepts `isCancelRequested?: () => CancelTarget | null` in `RunOneItemOpts` and threads it into the stepper.
- When `CancelledError` propagates up from the handler, `runOneItem` catches it BEFORE the generic catch and emits a tracker `failed` row with `step: "cancelled"` (instead of the failing step name) and a special error: `"Cancelled by user before step '<stepName>'"`. The kernel's existing screenshot-on-failure path is **skipped** for `CancelledError` — there's nothing diagnostic to capture.
- `runOneItem` returns `{ ok: false, error: cancelledError.message, kind: "cancelled" }` so the daemon's claim loop can branch on it.

**Daemon claim loop** (`src/core/daemon.ts`):

After `runOneItem` returns, if `r.kind === "cancelled"`:
- Mark queue item failed with the cancellation message (same `markItemFailed`, distinct error text).
- **Reset every system's page** to its `resetUrl` via `await session.reset(systemId)` for each `sys of wf.config.systems`. This ensures the next item starts from a clean state.
- Clear the `cancelRequested` flag.
- Continue the loop (claim next item).

If `r.kind` is success or generic failure: existing behavior unchanged. (Defense-in-depth note: we considered always resetting between items, but that's a behavioral change to success paths and out of scope. Reset-on-cancel only.)

**Latency:** if the in-flight step is a long Playwright wait (e.g., 30s `waitForSelector`), that wait completes before the next step boundary check. Cancellation effectively materializes 0–30s after the click. This is documented behavior; the toast (§4) reflects it.

### 2.3 Cancel-daemon force-stop chrome cleanup

**Where:** `src/core/daemon.ts:135-163` (the `/stop` handler) and `src/core/session.ts` (chrome PID tracking).

**Today:** force-stop sets flags then `setTimeout(50ms, process.exit(1))`. Chrome subprocesses survive the parent.

**New:**

1. **`Session` tracks every chrome PID.** When `Session.launch` invokes `chromium.launch(...)` for each system, capture `browser.process()?.pid` and store it in a per-system `chromePids` map. Expose via `Session.chromePids: Record<string, number>`.

2. **Force-stop sequence** (in the `/stop` handler when `force === true`):

   ```ts
   // ~10ms: respond 200 to caller
   res.end('{"ok":true}')
   // ~50ms: send SIGTERM to every chrome PID
   for (const pid of Object.values(session.chromePids)) {
     try { process.kill(pid, 'SIGTERM') } catch { /* already dead */ }
   }
   // ~2s: any survivors get SIGKILL
   await new Promise(r => setTimeout(r, 2000))
   for (const pid of Object.values(session.chromePids)) {
     try { process.kill(pid, 'SIGKILL') } catch { /* already dead */ }
   }
   // ~50ms more: process.exit(1)
   process.exit(1)
   ```

3. **Total exit window:** ≤2.5s. The HTTP response is flushed within ~10ms. The chrome processes are guaranteed dead by the time `process.exit` runs.

4. **The graceful-stop path is removed.** `npm run separation:stop` becomes equivalent to `:stop -- --force`. The `force` body field stays for back-compat but is ignored — every stop is force.

### 2.4 Routing cancel-running to the right daemon

**Where:** `src/tracker/dashboard.ts` and `src/tracker/dashboard-ops.ts`.

The `/api/cancel-current` backend handler must forward to the daemon that owns the in-flight item. Resolution:

1. Read the queue state for the workflow (`readQueueState`).
2. Find the queue event for `itemId` with the most recent `claim` event (state.claimed has `claimedBy: instanceId`).
3. Look up the daemon's port via `findAliveDaemons` (filter by instanceId).
4. POST to `http://127.0.0.1:<port>/cancel-current` with the body.

If no `claim` event exists for the item, the latest queue event is `unclaim` (orphan recovery), or the claiming daemon is no longer alive, return 410 Gone with `"item not currently in flight on any alive daemon"` — the frontend toasts this as a stale-state hint (the item likely already finished, was recovered to queued by orphan recovery, or the daemon died). The frontend then re-fetches entry state to re-render with ground truth.

### 2.5 Exit-cleanup respects pre-existing cancellations

**Where:** `src/core/daemon.ts:487-528` (the orphan-queue cleanup in the outer `finally`).

When the last alive daemon exits and finds queued items, today's code calls `markItemFailed` + `trackEvent({status: "failed", error: failError})` for every queued item. The error message overwrites any prior cancel reason.

**Change:** before writing `failed`, check the latest tracker entry for each queue item. If `step === "cancelled"`, skip — that item already has the user's cancel reason recorded; don't overwrite. The queue file's `failed` event still gets appended (so the queue mutex/fold logic stays consistent), but the tracker row is left alone.

This preserves the user's intent across the cancel-queued + cancel-daemon race (§2.1).

### 2.6 Tests

`tests/unit/core/cancel-current.test.ts`:
- Daemon's `/cancel-current` rejects with 409 when no in-flight item or itemId mismatch.
- Daemon's `/cancel-current` accepts and sets the flag when itemId+runId match.
- Stepper throws `CancelledError` at the next step boundary after the flag is set.
- `runOneItem` distinguishes `CancelledError` from generic errors (no screenshot, distinct error text).
- After cancel, daemon's claim loop calls `session.reset` for every system before the next claim.

`tests/unit/core/daemon-force-stop-chrome.test.ts`:
- Force-stop signals SIGTERM to every captured chrome PID.
- After 2s, any survivors are SIGKILLed.
- Exit window ≤2.5s end-to-end.
- (Mock chrome PIDs via `child_process.spawn('sleep', ['10'])` and assert kill behavior.)

`tests/unit/core/daemon-exit-respects-cancelled.test.ts`:
- Pre-populate tracker with one `cancelled` row and one normal `running` row in queued state.
- Trigger daemon exit-cleanup.
- Assert: cancelled item's error text unchanged. Normal item gets daemon-stop error.

## Section 3 — Probe Reliability and Duplicate Prevention

### 3.1 Replace `/whoami` HTTP probe with TCP-port probe

**Where:** `src/core/daemon-registry.ts`, `findAliveDaemons` and its helper(s).

**Today:** for each lockfile, fetch `http://127.0.0.1:<port>/whoami` with a short timeout. Compare body to lockfile identity. If the fetch errors, the daemon is considered dead.

**Problem:** an HTTP roundtrip on a daemon mid-Playwright operation can race the timeout, returning "dead" while the daemon is fine. The HTTP server is not blocked (Node's event loop handles it), but the body parse + compare adds latency.

**New:** TCP-port probe via `net.Socket`:

```ts
async function tcpProbe(port: number, timeoutMs = 1000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket()
    const onDone = (alive: boolean): void => {
      socket.destroy()
      resolve(alive)
    }
    socket.setTimeout(timeoutMs, () => onDone(false))
    socket.once('error', () => onDone(false))
    socket.once('connect', () => onDone(true))
    socket.connect(port, '127.0.0.1')
  })
}
```

Combined with PID-alive check (`process.kill(pid, 0)`), this gives:
- Lockfile exists ✓
- PID is alive ✓
- TCP port is bound ✓
→ daemon is alive.

This is faster, more reliable, and more deterministic than HTTP. The `/whoami` endpoint stays in place for any external CLI consumer that cares, but `findAliveDaemons` no longer calls it.

**Stale-PID defense:** the HTTP `/whoami` probe verified daemon identity (workflow + instanceId match the lockfile body). The TCP probe doesn't. We lose this defense in the narrow case where a recycled PID is bound to the same port the stale lockfile recorded. The probability of this triple coincidence (PID reuse + same port + same workflow lockfile still on disk) is vanishingly small on modern Linux/macOS. Acceptable tradeoff; the alternative (HTTP `/whoami` with timeout race) costs us reliability today, which is the actual reported bug. If the defense matters more later, add an HMAC-signed lockfile + `/whoami` body verify as a hardening pass.

### 3.2 Spawn pre-check: kill orphan chrome before launching

**Where:** `src/core/daemon-registry.ts`, `spawnDaemon` (or a new helper called before).

**Before launching a new daemon for workflow `X`:**

1. List alive daemons via `findAliveDaemons(X)`. Collect their `chromePids` (via `/status` — see §3.3 — or via lockfile if we choose to record them there).
2. Run `pgrep -af "user-data-dir=.*${X}"` to find chrome processes using X's user-data-dir.
3. For each pgrep hit whose PID is NOT in the alive set's chromePids: SIGKILL it.
4. Then launch the new daemon.

This guarantees that the new daemon doesn't pile chrome on top of orphans. Orphan chrome only exists if a previous daemon was killed unclean (SIGKILL, OOM); the next spawn cleans up.

**Path safety:** the `pgrep` regex includes the workflow's user-data-dir path verbatim. We guard against false positives by requiring the path match (not just the workflow name).

### 3.3 Expose chrome PIDs via daemon `/status`

**Where:** `src/core/daemon.ts` (the `/status` handler).

**New response shape:**

```json
{
  "workflow": "separations",
  "instanceId": "...",
  "phase": "processing",
  "queueDepth": 2,
  "inFlight": "3936",
  "lastActivity": "...",
  "chromePids": [12345, 12346, 12347, 12348]
}
```

`chromePids` is read from `Session.chromePids` (§2.3). Used by §3.2 (orphan cleanup) and §2.4 (route resolution sanity check).

### 3.4 Retry path locks `flags = {}`

**Where:** `src/tracker/dashboard-ops.ts`, `buildRetryHandler` and `buildRunWithDataHandler`.

The `reEnqueueEntry` shared helper (introduced 2026-04-27) calls `enqueueFromHttp(workflow, [input], dir)`. `enqueueFromHttp` internally calls `ensureDaemonsAndEnqueue`. Today neither layer specifies `flags`, so `computeSpawnPlan` uses defaults — `flags.parallel ?? 1`, `flags.new ?? false` — giving `desired = 1`, `deficit = max(0, 1 - aliveCount)`, `spawnCount = deficit` (since `flags.new` is falsy).

**Result:** with 1+ alive daemons, retry spawns 0. This is correct behavior. No code change needed for the contract; the duplicate-spawn bug is solely in §3.1's probe (which we're fixing) and §3.2's orphan-chrome (which we're fixing).

**Defense:** add a unit test asserting that `enqueueFromHttp` calls `ensureDaemonsAndEnqueue` with `{}` (not `{new: true}` or `{parallel: 2}`). Locks the contract against future regressions.

### 3.5 Tests

`tests/unit/core/daemon-registry-tcp-probe.test.ts`:
- Lockfile + alive PID + bound port → alive.
- Lockfile + alive PID + port not bound → dead.
- Lockfile + dead PID → dead (regardless of port).
- Lockfile missing → dead.

`tests/unit/core/spawn-prechecks-orphan-chrome.test.ts`:
- Mock `pgrep` returning chrome PIDs that include some alive (in registered set) and some orphan.
- Assert SIGKILL fires for orphans only.

`tests/unit/tracker/retry-flags-locked.test.ts`:
- Spy on `ensureDaemonsAndEnqueue`. Verify `flags === {}` from both the retry and run-with-data paths.

## Section 4 — Toast Lifecycle and Cancelled Badge

### 4.1 SSE-aware toasts

**Where:** dashboard frontend — `src/dashboard/components/RetryButton.tsx`, `QueueItemControls.tsx`, the existing toast utility (extended with subscription support), and the new `CancelRunningButton.tsx`. The retry button's existing "Retrying 1 failed…" toast also adopts this pattern: watches the pre-emitted runId's tracker row, flips on the `running` → terminal transition.

**Today:** clicking Cancel/Stop fires the HTTP request, shows a transient "Cancelling…" toast, doesn't await an event-driven resolution. The toast disappears on a fixed timer (or sticks).

**New: every action toast is bound to a target entity** (item id + runId for item-level actions; daemon instanceId for daemon-level actions):

```ts
const id = useToast.start({
  message: "Cancelling 3934…",
  watch: { kind: "item", workflow: "separations", id: "3934", runId: "..." },
  timeoutMs: 10_000,
})
```

The `useToast` hook subscribes to the SSE feed (already streaming on the dashboard) and listens for tracker events matching the watch target. On the first event with a terminal status (`done`, `failed` with `step="cancelled"`, etc.), the toast flips to its resolved message:

- `step="cancelled"` → "Cancelled 3934"
- `failed` (other reason) → "3934 failed: <error>"
- `done` → "3934 completed"

**Daemon-level toasts** watch for the daemon to disappear from the alive set (polled via `/api/daemons` at 1s cadence — already exists per the 2026-04-24 spec):

- Daemon present → present-with-different-instanceId → present-without-this-instanceId: instance disappeared.
- Toast flips to "Daemon stopped, N items failed" (N = count of `failed` tracker rows for this workflow with timestamps within the last 30s).

### 4.2 10s fallback timeout

If no terminal event arrives within 10s, the toast flips to a neutral hint:

- "Cancelling 3934…" → "Still cancelling — check the entry status"
- "Stopping daemon…" → "Stop in progress — sessions panel will update"

The toast does NOT auto-dismiss in this state. The user dismisses manually or it's replaced by the eventual real terminal event when it arrives. This means a stuck cancel never silently disappears.

### 4.3 Distinct "cancelled" badge

**Where:** `src/dashboard/components/EntryItem.tsx`, status-color CSS variables.

Tracker entries with `step === "cancelled"` get a distinct visual:

- Badge text: "Cancelled" (not "Failed")
- Color: amber. Use the existing `--warning` color token if one exists; otherwise introduce `--cancelled` in the same place as the other status tokens (`src/dashboard/index.css` or the equivalent token file). Distinguishable from red `--failed`.
- Stat pill: cancelled items still count in the FAILED pill (no new pill — keeps screenshot UI compact). Hover tooltip on FAILED breaks down "X failed, Y cancelled."

The Retry button works on cancelled items the same way it works on failed items (one click → re-enqueue).

### 4.4 Tests

Frontend tests are out of scope per the project's "no frontend test harness" rule (established 2026-04-19, reaffirmed in `2026-04-24-dashboard-operations-design.md` non-goals). Manual verification:

1. Cancel a queued item → toast flips from "Cancelling…" to "Cancelled" within 1s of the SSE event.
2. Cancel a running item → toast flips after the cancel takes effect (0–30s depending on step).
3. Stop a daemon → toast flips when the daemon's lockfile disappears.
4. Cancelled items render with the amber badge; failed items render red.

## Section 5 — Duo Poll: Fixed 5s Cadence

### 5.1 Replace variable backoff with fixed interval

**Where:** `src/auth/duo-poll.ts` (the function that polls UCSD's Duo state during MFA).

**Today:** The current implementation uses an adaptive backoff in the 50–5000ms range. When separations launches 4 systems sequentially or interleaved, the bursts of polls during simultaneous Duo prompts produce auth-related errors that don't reproduce with a fixed cadence.

**New:** fixed 5000ms poll interval. No backoff, no jitter. One config constant exposed for tests:

```ts
const DUO_POLL_INTERVAL_MS = 5_000
```

Per call: poll, sleep 5s, poll, sleep 5s, … until Duo state resolves (approved / denied / timeout).

**Why 5s specifically:** matches the user's stated preference. UCSD's Duo backend tolerates this cadence (existing 5000ms ceiling in the variable backoff is the proof; nothing in our SSO error reports indicates 5s is too aggressive). It's slow enough that 4 simultaneous polls don't cluster into a request burst.

### 5.2 Tests

`tests/unit/auth/duo-poll-fixed-cadence.test.ts`:
- Assert poll is invoked exactly N times within N×5000ms ± tolerance.
- Inject the constant via test override; verify behavior at 100ms for fast tests.

## Section 6 — Build Sequence

Six waves. Each wave ships independently behind no flags — every change is a strict bug fix or behavior contraction.

### Wave 1 — Auth fix (lowest risk)
1. Section 5.1: `duo-poll.ts` fixed 5s. Smallest change, most isolated.

### Wave 2 — Probe + duplicate prevention (foundations for retry stability)
2. Section 3.1: TCP-port probe in `findAliveDaemons`.
3. Section 3.2: Spawn pre-check kills orphan chrome.
4. Section 3.3: `/status` exposes `chromePids`.
5. Section 3.4: Retry path test locks `flags={}`.

### Wave 3 — Pre-emit reorder + sweep
6. Section 1.1: `ensureDaemonsAndEnqueue` reorder.
7. Section 1.2: `splitInputsForEnqueue` helper.
8. Section 1.3: Orphan sweep 5s/0-grace.

### Wave 4 — Cancel-running + page reset
9. Section 2.2: `CancelledError`, stepper flag, `runOneItem` propagation.
10. Section 2.4: `/api/cancel-current` route + daemon `/cancel-current` endpoint.
11. Section 2.2 (claim loop): page reset between items on cancel.

### Wave 5 — Force-stop chrome cleanup + cancel preservation
12. Section 2.3: Chrome PID tracking + force-stop SIGTERM/SIGKILL.
13. Section 2.5: Daemon exit-cleanup respects `cancelled`.

### Wave 6 — Toast lifecycle + UI polish
14. Section 4.1: SSE-aware toasts.
15. Section 4.2: 10s fallback.
16. Section 4.3: Cancelled badge.

Each wave can be a separate PR. Waves 1–3 are pure backend; Waves 4–5 add daemon endpoints + kernel changes; Wave 6 is dashboard-only.

## Validation

- `npm run typecheck` passes after each wave.
- `npm run test` passes after each wave (modulo pre-existing failures: `session.screenshotAll` × 2 — same as 2026-04-27 spec noted).
- Unit tests added per section (see each section's "Tests" subsection).
- **End-to-end manual verification** at the end of Wave 5:
  - Spawn a separations daemon. Enqueue 3 items. While item 1 is running, click Retry on a previous failure → verify no second daemon spawns, no chrome window pile-up.
  - Click Cancel-running on item 1 → verify item fails with cancelled badge in 0–30s, daemon resets pages, claims item 2.
  - Click Cancel-queued on item 3 while items 1 and 2 are processing → verify item 3 marked cancelled immediately.
  - Click Stop-daemon while item 2 is processing → verify item 2 + queued items 3 (already cancelled) — verify item 3's cancelled reason is preserved (not overwritten by daemon-stop reason).
  - Force-kill the daemon process via `kill -9 <pid>` → verify orphan-sweep marks queued items failed within 5s. Click Retry → verify spawn pre-check kills the leaked chrome, new daemon launches cleanly.

## Section 7 — Failure Modes and Race Protection

### 7.1 Pre-emit then spawn rejected

`onPreEmitPending` fires for runId R. `spawnDaemon` rejects. Backend explicitly emits `failed` for R via `trackEvent`. Dashboard sees `pending → failed` transition. No queue file entry. No orphan to sweep.

### 7.2 Cancel-running on item that just finished

User clicks Cancel-running on item A. Daemon's `inFlight` already moved to item B before the request lands. Daemon's `/cancel-current` finds itemId mismatch, returns 409. Frontend toast flips to "3934 already finished — refreshing." Frontend re-fetches entry state.

### 7.3 Cancel-daemon during cancel-running

User clicks Cancel-running on item A. Daemon sets flag. User clicks Cancel-daemon before the next step boundary fires. Daemon's `/stop` is unblocked HTTP — runs concurrently. Force-stop sequence kills chrome → in-flight Playwright op throws → `runOneItem`'s catch sees a generic browser error (not `CancelledError`) → marks item A `failed`. Daemon's outer `finally` block then marks item A's tracker row with the force-stop message (`"Daemon force-stopped while processing this item."`) — overrides the inner failure. Cancel-running's flag is irrelevant by then.

Frontend toast for cancel-running times out at 10s ("Still cancelling…") and is then replaced by the force-stop terminal event. Toast for cancel-daemon resolves on lockfile disappearance.

This is acceptable: cancel-daemon is higher authority by §2.1. The user's frustration is captured by the explicit hierarchy.

### 7.4 Spawn pre-check kills the wrong chrome

`pgrep` regex matches a chrome process whose user-data-dir contains the workflow name as a substring but isn't actually for this workflow (e.g., a user's personal chrome session). We protect against this by:

1. The user-data-dir path is fully qualified in our spawn flags (`/Users/.../<workflow>/...`).
2. The pgrep regex matches the FULL path, not the workflow basename.
3. We verify the matched process's chrome version matches Playwright's bundled chrome (best-effort — the alive-daemon's chromePids are the negative filter, which is the strong guard).

If a false positive occurs anyway, the user loses an unrelated chrome window. Risk accepted; the alternative (no orphan cleanup) is worse.

### 7.5 TCP probe false positive

A recycled PID (rare on modern OSes) bound to the lockfile's stale port. `findAliveDaemons` reports the daemon alive when it isn't. Items are claimed-against-self in the queue; the next claim attempt fails (no real daemon answers); items end up failed via the orphan sweep + 0 grace once the recycled PID's connection dies. Recovery is bounded to one cycle.

### 7.6 Concurrent retry clicks

Two retry clicks on the same item land within 100ms. `enqueueFromHttp` runs twice. Both pre-emit `pending` rows with different runIds. Both append to the queue file under the mutex. Both items get processed by the daemon as separate runs.

This is consistent with current behavior (the 2026-04-24 spec accepts "two concurrent retries → two re-runs"). Worst case: one extra run. Not a correctness issue.

### 7.7 Daemon's `/cancel-current` arrives after `inFlight` cleared

Between `inFlight = null` and the next `claimNextItem`, the cancel HTTP arrives. Daemon returns 409 (no in-flight match). Cancel doesn't take effect. The dashboard's toast times out at 10s. User retries cancel — by then the daemon has claimed the next item; cancel applies to the new in-flight or also misses. This is a tight race; the dashboard's toast UX (§4.2) makes the failure mode visible rather than silent.

## Section 8 — Risk Assessment

- **Blast radius:** ~12 files in `src/core/`, `src/tracker/`, `src/dashboard/components/`. ~15 new tests.
- **Backward compatibility:**
  - The `/whoami` endpoint stays on the daemon; we just stop using it from `findAliveDaemons`. External tools that call it still work.
  - The `force` body field on `/stop` still parses, just ignored. Existing CLI calls to `:stop -- --force` work without semantic change.
  - The 5s/0-grace orphan sweep produces faster failures than today (5min). Users with a daemon-spawn-in-flight at upgrade time see no behavior change because the new pre-emit ordering ensures the queue is empty during spawn.
- **Behavior preservation:**
  - The pre-emit + spawn-then-enqueue reorder produces the same final state (same queue items, same tracker rows) as today's order. The difference is timing of pre-emit (sooner) and queue-append (later).
  - Cancel-running is a NEW affordance. No existing behavior changes.
  - Cancel-daemon's chrome cleanup is additive — same item state outcomes, just no orphan chrome.
- **Single user-visible removal:** the graceful (soft) stop mode is gone. `:stop` always force-stops. Users who relied on soft-stop's drain-and-exit behavior will need to wait for in-flight items to finish naturally before stopping (or accept the failure). Per user direction, this is the desired behavior.

## Section 9 — Rollout

The dashboard's SSE backend on port 3838 does not hot-reload (per `feedback_dashboard_restart_required.md` memory). After merging each wave, the user must restart `npm run dashboard` for the dashboard-side changes to take effect. Daemon-side changes (any change in `src/core/daemon*.ts`) require restarting all alive daemons to pick up — `npm run separation:stop` then a fresh enqueue.

## Section 10 — Out of Scope (Cluster B + Cluster C)

These are explicitly deferred to follow-up sessions:

- **Cluster B** — Terminal-style footer, SessionPanel relocation, preview/capture mode placement. UI redesign work. Will go through `superpowers:brainstorming` → `ui-ux-pro-max` → `frontend-design` per global CLAUDE.md instructions.
- **Cluster C** — Separations duplicate auto-fill: detect repeat EID/docId in queue and pre-fill `prefilledData` from the latest successful run's tracker history. Touches separations workflow + JSONL history reads + the `prefilledData` channel introduced in the 2026-04-24 spec.

Each cluster gets its own spec, plan, and implementation cycle. This document covers Cluster A only.
