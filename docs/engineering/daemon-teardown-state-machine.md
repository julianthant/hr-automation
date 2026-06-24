# Daemon teardown state machine — map, gap analysis, and the root-fix plan

**Status:** decision layer DONE (2026-06-24) — the rest stays analysis/history.
The `resolveTeardownTransition` pure function (item #1 + #4 below) now exists in
`src/core/daemon/teardown-transition.ts` and is the single decision authority
shared by the claim loop (`daemon.ts`) and the outer-finally sweep
(`shutdown.ts`); each site keeps its own BODY (the sweep's `bestEffort`/
`settleDependency:false`, each site's distinct cancel) and `shutdown.ts`'s
`skipShutdownEmit` pre-gate. Landed as its own gated effort (NOT bundled with the
2026-06-13 stabilization), proven behavior-preserving by `daemon.test.ts`
(VS-003 / VQ-003 / F5 / E2E-101 / reassign / ISS-006) + the cranked 50×
`daemon-teardown-soak.test.ts` + a dedicated `teardown-transition.test.ts`. The
terminal-write guard + queued-sweep (items #2/#3) were already minimal-fixed
on 2026-06-15 (see below) and were intentionally left out of this extraction.

## Why this doc exists

Across almost every AI-e2e run, the deepest findings cluster in ONE subsystem —
the daemon claim / force-stop / reassign / stop-all / shutdown logic:

| Date | Finding | What broke |
|---|---|---|
| 2026-06-04 | signal-only-wait deadlock | force-stop killed chrome, but a handler parked in a browserless `ctx.signal` wait never unwound |
| 2026-06-07 | reassign-to-peer / fail-loud (F5) | a wedged peer "absorbed" a reassigned item that then sat `queued` forever |
| 2026-06-07 | per-instance reassign vs stop-all fail | the in-flight item's fate depends on an intent flag, not just "is shutting down" |
| 2026-06-13 | VQ-003 double-terminalize | one in-flight run wrote a cancel row AND a fail row ~2 ms apart on stop-all |
| 2026-06-13 | VS-003 session-label collision | two daemons both allocated `"<wf> 1"` |
| 2026-06-13 | ISS-001 enqueue-before-wake | idle daemon woken before the task row existed → missed the claim |
| 2026-06-13 (this pass) | queued-orphan on simultaneous stop-all | a never-claimed task left `queued` with zero daemons alive (candidate — see below) |
| 2026-06-24 | ISS-004 double `workflow_end` on per-instance stop | the dashboard handler synthesized `workflow_end(failed)` to close the card while the gracefully-stopped daemon emitted its OWN `workflow_end(done)` ~64ms later — two conflicting session-end events. Fixed by `shouldSynthesizeStopInstanceEnd` (`control/ops/worker-control.ts`): on the graceful path, poll for the daemon's own end within a grace window and synthesize only as a fallback. |

Every one of these is a **state-transition defect**: a terminal transition fired
from the wrong place, fired twice, or never fired. They keep recurring because
the teardown state machine is **implicit and scattered** — no single module owns
"what terminal transition is legal from control_state X under teardown intent Y."

## The states (SQLite `tasks.control_state`)

```
queued → claimed → running → done
                          ↘ cancel_requested → cancelling → cancelled
                          ↘ failed
waiting_dependencies → queued   (dependency release)
```

Plus the un-claim edge used by reassign: `claimed|running → queued`
(`returnTaskToQueued`, `task-store/claim.ts:99`) — preserves attempt/runId so the
run continues on a peer.

## The teardown intents (what decides the terminal transition)

Two daemon-state flags + the deliberate-cancel signal form the intent, resolved
in the claim-loop `isCancelOutcome` branch (`daemon/daemon.ts:594–671`) and
mirrored in the outer-finally safety net (`daemon/shutdown.ts`):

| Intent | Trigger | Flags | Terminal action |
|---|---|---|---|
| **deliberate-cancel** | `/cancel-current`, `cancel_task`, browser-disconnect, OCR discard | neither flag; daemon stays alive | ONE orange `failed`+`step:"cancelled"` row (`daemon.ts:749`) |
| **reassign** | per-instance card stop (`/api/daemon/stop-instance` → `/stop {reassign:true}`) AND a **responsive** peer | `reassignInFlight` | un-claim → `returnTaskToQueued`, wake peers, NO terminal row (`reassignInFlightItem`, `in-flight-shutdown.ts:172`) |
| **fail-loud (no responsive peer)** | reassign requested but every peer is wedged | `reassignInFlight`, peers exist but none pass `filterResponsiveDaemons` (`registry.ts:180`) | red `failed`, `SHUTDOWN_NO_RESPONSIVE_PEER_FAIL_REASON` |
| **fail-red (no peer)** | stop-all, SIGINT/TERM, or the last daemon | `forceShutdown` | red `failed`, `SHUTDOWN_NO_DAEMON_FAIL_REASON` |

The `origin: 'user' | 'shutdown'` threaded through `runRegistry.cancel`
(run-registry) is the VQ-003 fix: a shutdown-origin abort makes the kernel
SUPPRESS its own terminal cancelled row so the daemon owns the single terminal
write. That suppression is the seam that keeps "exactly one terminal" true — but
it is a *patch on top of* the scatter, not a structural guarantee.

## Where the logic lives (the scatter)

| Concern | File |
|---|---|
| claim-loop three-way branch | `daemon/daemon.ts:594–671, 749` |
| outer-finally safety-net (mirror) | `daemon/shutdown.ts` |
| shared reassign/fail emit + canonical fail strings | `daemon/in-flight-shutdown.ts` (`emitShutdownRow`/`reassignInFlightItem`/`failInFlightItem`) |
| un-claim primitive | `task-store/claim.ts` (`returnTaskToQueued`) |
| terminal done/failed | `daemon/queue.ts` (`markItemDone`/`markItemFailed`) |
| cancel origin + suppression seam | `core/run-registry.ts` |
| peer liveness gate | `daemon/registry.ts` (`filterResponsiveDaemons`) |
| force-stop signal abort | `createAbortLaunchAndKillSession` (signal-only-wait fix) |
| worker-command stop | `daemon/worker-commands.ts` |
| session-name allocation | `daemon/registry.ts` (`scanAliveDaemonInstanceNames`) + `tracker/session-events.ts` |

Two paths (`daemon.ts` claim loop + `shutdown.ts` outer-finally) must agree on
row shape / error text / dependency-settle or they silently drift — the
2026-06-07 lesson already calls this out and shares helpers via
`in-flight-shutdown.ts`, but the *decision logic* (which branch, under which
flags) is still duplicated, and the queued-item sweep lives only in `shutdown.ts`.

## The invariants the scatter is supposed to uphold (but only by convention)

1. **Exactly one terminal write per run.** No cancel-then-fail double settle
   (VQ-003). Currently held by the `origin:'shutdown'` suppression seam.
2. **A never-claimed queued task reaches a terminal when its last owning daemon
   dies.** Currently the `shutdown.ts` queued sweep, gated on `otherAlive`.
   **This is the one with an open gap** (below).
3. **Reassign continues the SAME runId on a responsive peer, or fails loud — it
   never silently re-queues to a wedged peer** (2026-06-07 F5).
4. **A deliberate cancel stays orange (alive daemon); a shutdown fail goes red.**
   The intent, not the abort mechanism, decides the color.
5. **Each concurrent daemon gets a distinct `(instanceName, sessionId)`** so
   session cards / peer detection don't collapse (VS-003).

## The open gap this pass surfaced — NOW CLOSED (2026-06-15)

> **STATUS: CLOSED.** The queued-orphan gap (E2E-105) and the related
> single-terminal-write violation on a deliberate cancel of a signal-only wait
> (E2E-101) are fixed and pinned. The transition-table refactor below remains a
> good future cleanup, but the two correctness gaps it would have closed are
> already closed by the minimal fix described in **"How E2E-105 + E2E-101 were
> actually fixed"** at the end of this section. Do NOT re-open the gap as
> outstanding.

`tests/delegation/daemon-teardown-soak.test.ts` (Stop-All leg, run with 3 items
/ 2 daemons during development) reproduced: on a **simultaneous** stop-all of
EVERY daemon, a never-claimed `queued` task can be **orphaned** — each dying
daemon's queued sweep sees `otherAlive > 0` (the peer hasn't removed its lockfile
yet) and leaves the task "for the peer," which is also dying. Result: 0 daemons
alive, task stuck `queued` in SQLite, no terminal row. This violates invariant #2
and the e2e skill's Phase-5 expectation ("queued items terminalized by the last
daemon").

It is the queued-item analogue of the exact race the reassign-gating lesson
warned about for in-flight items ("every daemon tries to bounce its item to peers
that are ALSO dying → orphaned"). Repro
in the soak by enqueuing N+1 items for N daemons, holding all, `stopAll`, then
asserting the queued one's SQLite `control_state`.

**CONFIRMED PRODUCTION-REAL (2026-06-15 AI e2e run, finding E2E-105).** Driving
the *real* dashboard with *real* daemon subprocesses — `POST /api/daemon/stop`
for `oath-signature` with **3 alive daemons + 3 never-claimed queued tasks** — left
all 3 in-flight items `failed` (red, correct) but the 3 queued tasks stuck
`control_state=queued` with **0 daemons alive and no terminal row** (`/stop`
response `queuedCancelled: 0`). So the gap is not a harness artifact; the
`otherAlive > 0` queued-sweep race fires identically against real subprocesses.

**It was bounded, not "lost forever":** the dashboard-side backstop
`scanOrphanedQueueItems` (`src/tracker/dashboard/sweeps.ts`, `ORPHAN_QUEUE_GRACE_MS
= 5 min`) terminalized all 3 orphans to `failed` ~5 minutes later. So the
pre-fix real-world impact was a **≤5-minute window of zero terminal state** plus
a dependency on the dashboard process being up. The backstop stays (defense in
depth) but is no longer the path that recovers a stop-all — the daemon now
terminalizes queued at teardown.

### How E2E-105 + E2E-101 were actually fixed (2026-06-15 — minimal, not the full refactor)

The full `resolveTeardownTransition` table below was **not** built; the two gaps
were closed with a targeted, behavior-preserving change:

1. **E2E-105 — queued sweep gates on AVAILABLE-FOR-HANDOFF, not PID-alive.** The
   root cause was the gate `otherAlive.length === 0`: a dying peer's lockfile is
   still on disk, so every dying daemon thought "a peer will take it." The fix
   adds a deterministic happens-before signal: `/whoami` now reports
   `shuttingDown` (sourced from `state.shuttingDown`), and the dashboard's
   workflow-scoped `/stop` sets `shuttingDown` **synchronously in every daemon's
   `/stop` handler before that handler responds**. By the time any daemon runs
   its teardown sweep (well after all `/stop` HTTP handlers returned), a stopped
   peer reports `shuttingDown: true`. The queued sweep now gates on
   `filterPeersAvailableForHandoff(otherAlive)` (`registry.ts` — responsive
   `match` AND `shuttingDown === false`) being empty, not on `otherAlive` being
   empty. So the effectively-last responsive owner terminalizes the queue (red),
   while a genuinely-surviving (not-stopped) peer still reports
   `shuttingDown: false` and absorbs the items — per-instance stop / partial
   teardown keep "≥1 live daemon → leave queued" intact. (Several dying daemons
   may each elect themselves owner; the `stillQueued` re-read + the terminal-write
   guard below keep it to one terminal row per item.)
2. **E2E-101 — terminal-write guard keyed by runId enforces invariant #1
   structurally.** `runRegistry` gained `claimTerminalWrite(runId)` /
   `releaseTerminalWrite(runId)`: the FIRST caller to claim writes the run's sole
   terminal row, every later caller defers. Both racing emitters claim it — the
   kernel's `withTrackedWorkflow` catch (wired via `claimTerminalWrite` opt,
   claimed ONLY when it actually emits, i.e. not suppressed) AND the daemon's
   teardown fail branches + deliberate-cancel branch. On a deliberate
   `/cancel-current` of a signal-only wait, the kernel wins (origin:'user', not
   suppressed) and the daemon defers → exactly one orange row, instead of the two
   consistent rows ~32ms apart it wrote before. On a force-shutdown (VQ-003,
   origin:'shutdown') the kernel is suppressed and does NOT claim, so the
   daemon's `failInFlightItem` claims and writes the sole red row — unchanged
   behavior, now structurally guaranteed rather than convention-only. The token
   is released by the daemon's **per-item finally** (not `unregister`, which
   fires earlier inside `run-one-item`, before the daemon's three-way branch
   reads the token).

Pinned by `tests/delegation/daemon-teardown-soak.test.ts` (new Stop-All
queued-orphan leg — every never-claimed queued item reaches terminal
`control_state` `failed`; cranked `HR_TEARDOWN_SOAK_ITERATIONS=50` green) +
`tests/unit/core/daemon.test.ts` (new E2E-101 case — deliberate `/cancel-current`
of a signal-only wait → exactly one `failed/step:cancelled` row). The existing
VQ-003 / F5 / reassign / cancel cases in `daemon.test.ts`,
`run-registry.test.ts`, `cancel-mechanism.test.ts`, and `daemon/shutdown.test.ts`
stay green.

## The root fix: make the transition table explicit

The bugs are invalid transitions in an implicit machine. Make the machine
explicit so invalid/duplicate transitions are unrepresentable or assertable in
ONE place:

1. **A single `resolveTeardownTransition(state, intent, peers)` pure function**
   returning a typed `TerminalAction`. **DONE (2026-06-24)** — shipped as
   `src/core/daemon/teardown-transition.ts` returning `{kind:'reassign'} |
   {kind:'fail', reason:'no-responsive-peer'|'no-daemon'} | {kind:'cancel'}`.
   Inputs are the booleans/peer-counts the two sites already compute
   (`reassignInFlight`, `forceShutdown`, `hasTaskId`, `responsivePeerCount` from
   `filterPeersAvailableForHandoff`, `pidAlivePeerCount`). Both the claim-loop
   branch and the outer-finally net call it — the decision logic is no longer
   duplicated; the 2026-06-07 "two paths must agree" hazard is now structural. The
   per-site BODIES (reassign/fail args, each site's cancel) stay at the call
   sites; `cancel` is the deliberate `/cancel-current` in the claim loop and the
   browser-disconnect/crash case in the sweep.
2. **A terminal-write guard keyed by runId.** A run that already produced a
   terminal row in this teardown cannot produce a second (invariant #1 enforced
   structurally, not via the suppression seam — which can then be simplified or
   kept as defense-in-depth).
3. **Move the queued sweep into the same resolver** so "last daemon terminalizes
   queued" is decided by the same authority that decides in-flight fate, closing
   the orphan gap: the last daemon (or a deterministic election among the dying
   set) owns the queued terminal, never "leave it for a peer that is also dying."
4. **Keep the state vocabulary**; add an exhaustive `switch` over
   `(control_state × intent)` so a new state or intent is a compile error if
   unhandled.

## Execution plan (its own effort — sequential, NOT a same-pass change)

1. **Design** (`feature-dev:code-architect`): write the `TerminalAction` type +
   `resolveTeardownTransition` signature; enumerate every `(state, intent)` cell
   and map each to its CURRENT behavior (file:line above) so the refactor is
   provably behavior-preserving where behavior is already correct.
2. **Confirm the queued-orphan** (Explore + the soak): is it prod-real or
   harness-only? Decide whether #3 is a behavior CHANGE (fix a real bug) or a
   harness artifact to document.
3. **Implement** the resolver + terminal-write guard; route `daemon.ts` and
   `shutdown.ts` through it; fold in the queued sweep. Keep `in-flight-shutdown.ts`
   as the emit layer.
4. **Verify** — this is the payoff of building the soak first: the entire
   existing `daemon.test.ts` matrix + `daemon-teardown-soak.test.ts` (cranked,
   `HR_TEARDOWN_SOAK_ITERATIONS=50`) must stay green, plus a new soak leg pinning
   the queued-terminalization once #2 resolves the orphan question. Then
   `npm run test` + `test:architecture` + `lint`.

The refactor is "fix the root" for the whole nest: instead of patching each new
invalid transition as an e2e finds it, invalid transitions become a compile error
or a single-guard assertion, and the soak guards the timing races in CI.
