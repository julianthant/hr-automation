# 05 — Execution Kernel: Parallelism & Speed

Status: **Phase 0 design — for operator review.** Conforms to `00-charter.md` (§9 automated Duo,
§10 parallelism-first) and `04-reconciliation.md` (D1, D5, D15). Code lands in `temp_src/`.

## Ownership (D1)

| This doc **OWNS** (siblings reference, never redefine) |
|---|
| The scheduler: lanes, claim policy, fairness, backpressure, per-system budgets |
| The **session pool**: page leases, pool sizing, release/reset discipline, single-flight login, health-ladder integration |
| The **executor process model** (successor of per-workflow daemons): spawn, registry, heartbeat/lease porting, blast-radius policy |
| The speed contract: sleep-tax elimination plan, readiness-wait rules, pipelining, the per-span sleep-budget metric |
| The page-isolation invariant (§6.1) |

| This doc **references** (owner) |
|---|
| Task contract, `SessionNeed` (one system per task), exclusive leases, session providers, retry policy → **doc 01** |
| Run-state machine, gates/parks (D5), checkpoints, navigation-ownership rule (§3.1 there), RunEnvelope → **doc 02** |
| Worker/run/task span wire schema, session-card projections, notes stream → **doc 03** |
| OnBase cross-process SQLite lease → **D15** (mechanics here in §3.4; contract in doc 01 §2.1) |

Grounding (read, not imagined): `src/core/daemon/daemon.ts` (claim loop: ONE
`state.activeRun: RunHandle | null` per daemon — one item in flight per process),
`daemon-types.ts`, `src/core/kernel/shared-context-pool.ts` + `src/workflows/person-lookup/CLAUDE.md`
(the proven one-Duo/4-tab UCPath+CRM pool), `src/services/ocr/per-page-pool.ts` + `usage-tracker`
(the one real intra-run parallel engine), `tests/unit/architecture/wait-for-timeout-allowlist.test.ts`
(the fixed-sleep inventory), `src/systems/ucpath/CLAUDE.md`/`LESSONS.md`,
`src/systems/onbase/LESSONS.md` (one app session per identity), `src/core/e2e/stub-workflows.ts`
(the cancel/parallel matrix already under deterministic test).

---

## 0. Why today is slow (measured, not vibes)

1. **One item in flight per daemon process.** The claim loop holds a single
   `activeRun` (`daemon-types.ts:79`); N-way parallelism costs N OS processes × N chromium sets ×
   N full Duo chains. `spawnDaemon` at least parallelizes the N auths (2026-06-24 lesson), but the
   marginal worker still costs a full browser + login.
2. **The fixed-sleep tax.** The `waitForTimeout` allowlist counts **47 sleeps in
   `src/systems/ucpath/` alone** (transaction.ts 18, person-org-summary 8 — mostly 3s each,
   personal-data 7, navigate 6, ss-smart-hr 5, job-summary 3). The 2026-07-04 improvement audit
   measured **~33s of pure sleep per UCPath item**. A person-org lookup spends more time in
   `waitForTimeout(3_000)` than in actual page interaction.
3. **Per-item serialization even where reads dominate.** i9-check runs a dedicated
   single-UCPath-browser daemon, strictly sequential with a reset-URL between items — for a
   workflow that mutates nothing.
4. **Idle latency.** Claim wake-ups race (`wakePending` latch, ISS-008), backstopped by a 30s
   re-poll — a fan-out's members trickle in on poll cadence when a wake is lost.
5. **The one counterexample proves the ceiling is soft:** the OCR per-page pool fans ~100 pages
   across every provider key concurrently with real admission control (RPM/TPM/RPD windows,
   tier-1 patience), and person-lookup's shared-context pool runs **4 workers as 4 tabs on ONE
   authenticated UCPath+CRM context** — live-verified for months. Parallel tabs on one Duo'd
   PeopleSoft session work; today's kernel just doesn't offer that shape to daemons.

---

## 1. The concurrency model

### 1.1 Units, named precisely

- **Run** — one item's execution of a workflow (doc 02's state machine). Lightweight: a state
  record in SQLite + checkpoints. Runs are cheap; hundreds may be queued.
- **Task execution** — one bounded task (doc 01) of one run. **This is the unit the scheduler
  dispatches.** A task needs at most ONE browser session (doc 01's store constraint: a task's
  `SessionNeed.system` is its store's system — cross-system work is workflow composition). This
  single-system property is load-bearing: no multi-lock acquisition, **no lock-ordering deadlock
  is constructible** at the task grain.
- **Lane** — a scheduler slot inside an executor: "up to L runs may be in flight here." A lane
  holds a claimed run and drives its state machine; the run's current task borrows a page lease
  from the session pool for exactly the task's duration.
- **Page lease** — exclusive checkout of one Playwright `Page` from a system's pooled,
  authenticated `BrowserContext` (§3).

### 1.2 Where the scheduler sits relative to doc 02

Doc 02's run-state machine defines **what** transitions exist (queued → claimed → validating →
running(node i) → parked/terminal). The scheduler is the engine that decides **when and where**:

```
             SQLite (cross-process truth: queue, claims, leases, budgets)
                                │  claim / renew / requeue  (ported: claim_generation,
                                │   renewClaim, recoverClaimsForDeadWorkers, terminalization fencing)
   ┌────────────────────────────┴─────────────────────────────┐
   │ EXECUTOR process                                          │
   │  scheduler loop ── lane 1: run A ── task ── page lease ──┐│
   │       │            lane 2: run B ── task ── page lease ──┼┼── SessionPool
   │       │            lane 3: run C ── (validating, no page)││   ucpath ctx: pages ×3
   │       └─ park/resume, retry backoff, fairness             │   crm ctx:    pages ×2
   │  SessionPool: one authenticated context per system        │   onbase ctx: page ×1 (+ D15 lease)
   └───────────────────────────────────────────────────────────┘
```

- **Within one run, tasks are serial** (doc 02's ordered node list; DAG deferred per its OQ5).
  Parallelism is **across runs** — while run A's task awaits a PeopleSoft roundtrip on tab 1,
  run B's task drives tab 2. That IS the pipelining; no intra-run DAG machinery needed for it.
- **Tasks from different workflows share the same pool.** The scheduler claims runs across ALL
  workflows (fairness, §5); an oath-signature member and a person-lookup run interleave on the
  same UCPath context's tabs. Login happens once per system per executor, not once per workflow
  per worker.
- Service-store tasks (`ocr`, `extraction`, `roster` — D4) take no page lease and don't count
  against system budgets; the OCR page pool keeps its own internal admission control unchanged.
- Gates (D5): a lane hitting a gate node parks the run, **returns all page leases to the pool**,
  and frees the lane immediately. Parked runs cost zero capacity.

### 1.3 Claim protocol (ported, widened)

The SQLite claim machinery ports nearly verbatim — it is already correct under contention
(claim_generation lease, heartbeat `renewClaim`, `returnTaskToQueued`, the fenced terminalization
state machine, the `wakePending` latch + bounded re-poll). Two changes:

1. **Claims are per-lane, not per-process** — an executor claims up to `lanes` runs concurrently.
   `workers.last_heartbeat_at` renews every held claim (same 5s cadence, N claims per tick).
2. **The claim query is workflow-agnostic** with a fairness ORDER BY (§5.2), filtered by "can I
   serve this run's systems within current budgets" — an executor with a saturated UCPath pool
   skips UCPath-bound runs and may still claim a kuali-only run.

---

## 2. Executor process model — decision

**Decision: replace per-workflow daemons with a small pool of workflow-agnostic EXECUTOR
processes. Default ONE executor; more are an operator choice for isolation, never a requirement
for parallelism.** Parallelism comes from lanes × pooled tabs inside an executor, not from
process count.

Why not keep per-workflow daemons (status quo, multi-lane'd):

- Sessions could never be shared across workflows — oath-signature, person-lookup, i9-check each
  keep paying their own UCPath login and holding their own chromium set. The operator's #1 cost
  (browser + login per unit of parallelism) survives.
- The ~10-registry problem returns operationally: per-workflow spawn maps, per-workflow stop
  scripts, per-workflow idle daemons burning memory.

Why not one session-broker process per system (browser-server + `connect()` from many clients):

- Playwright page ownership across process boundaries is a new, unproven layer ON the hot path;
  a broker crash takes down every workflow at once anyway — same blast radius as one executor,
  more moving parts. Rejected as speculative complexity.

What **ports** into the executor (charter: port, don't rewrite, proven machinery): lockfile +
registry + `/whoami` + heartbeat, claim-generation lease + renew, teardown transition table +
`in-flight-shutdown` emit dedup, terminalization fencing (2026-07-15), the wake latch + bounded
re-poll, orphan recovery. All of it is already workflow-agnostic except the claim filter — the
"per-workflow" in today's daemon is one WHERE clause, not deep structure.

**Doc 03 alignment (resolves its open question 2):** worker spans become **per-executor** —
one `worker` span per executor process, one `browser` child span per pooled system session.
Session cards become executor cards: the same card shape (system tiles + health rings), with the
subtitle cycling the in-flight runs' trace ids (`run.claimed.workerId` links each run to the
card, as doc 03 already specifies). A run's workflow is on its run span; the card does not need
daemon:workflow 1:1.

**Blast radius, honestly:** one executor crash interrupts every in-flight run (they re-pend via
lease recovery; mutate-step crashes park `needs-operator` per doc 02 §5.6). Mitigations: (a) a
browser/system failure is contained to that system's lanes — a wedged Kuali context no longer
kills UCPath work-in-flight (today a browser disconnect tears the whole daemon down); (b) the
operator can pin a workflow to a dedicated executor (`executorGroup` on the RunEnvelope claim
filter) when isolation matters more than sharing — e.g. a risky live batch.

```ts
// temp_src/exec/executor.ts — the shape (machinery ports; loop is new)
export interface ExecutorConfig {
  lanes: number;                        // max concurrent runs (default 4)
  systems: Partial<Record<BrowserSystemId, SystemPoolConfig>>;  // §3.2 sizing
  group?: string;                       // optional isolation pin
}
export async function runExecutor(cfg: ExecutorConfig): Promise<void> {
  const pool = await SessionPool.create(cfg.systems);       // lazy per-system login (§3.3)
  const lanes = new LaneSet(cfg.lanes);
  while (!state.shuttingDown) {
    const run = await claimNextRun({ fairness: FAIR_SHARE, budgets: pool.budgets() });
    if (!run) { await parkUntilWakeOr(IDLE_REPOLL_MS); continue; }   // ported latch + re-poll
    lanes.dispatch(run, (r) => driveRunStateMachine(r, pool));       // doc 02's engine, per lane
  }
}
```

---

## 3. The session pool

### 3.1 Page leases

```ts
// temp_src/exec/session-pool.ts
export interface PageLease {
  page: Page;                 // abort-racing proxy, ported from page-proxy.ts
  system: BrowserSystemId;
  kind: "read" | "write";     // derived from the task contract's effect (D7) — never re-declared
  release(disposition: "clean" | "poisoned"): Promise<void>;
}
export interface SessionPool {
  /** Blocks until a lease is available within budget; single-flight login on first use (§3.3). */
  acquire(system: BrowserSystemId, effect: EffectClass, signal: AbortSignal): Promise<PageLease>;
  budgets(): BudgetSnapshot;  // feeds the claim filter (§1.3) and the dashboard
}
```

- **Exclusive while held.** `ctx.page(system)` inside a task resolves to the lease's page and
  nothing else; the pool never hands one page to two tasks. Kernel-owned — a task cannot opt out.
- **Checked out per task, not per run.** Between tasks (and at any gate) the run holds no page.
  This is what makes D5's "parking is free" true and what returns capacity to siblings.
- **Release discipline (the §6.1 invariant's mechanical half):** `release("clean")` navigates the
  page to the system's `resetUrl` (bounded, e.g. 5s) before returning it to the pool; if the
  reset fails or the disposition is `"poisoned"` (aborted mid-Playwright-call — ports
  `poisonPage`), the page is closed and a fresh one is opened lazily. A page with a half-filled
  form can therefore never reach the next task.
- Doc 02 §3.1 (every task navigates itself from any fresh page) is the other half: the reset is
  belt, task-owned navigation is suspenders. The ISS-B02 lesson (URL says right page, search box
  gone) is exactly why both exist.

### 3.2 Pool sizing per system — honest defaults

| System | read tabs | write tabs | Evidence / constraint |
|---|---|---|---|
| ucpath | **3** | **1** | 4-tab shared-context reads live-proven for months (person-lookup pool). Concurrent Smart HR **writes** on one session are UNVERIFIED — PeopleSoft component state + the modal-mask dance make multi-tab wizards a real risk; writes serialize on one dedicated tab until a live dry-run proves more. |
| crm | 2 | 1 | Same person-lookup pool evidence (UCPath+CRM contexts shared 4 ways). |
| onbase | — | **1, cross-process** | ONE app session per identity (LESSONS.md 2026-07-02). D15 SQLite lease acquired **before** the context opens; held for the task, released on task end/park. The one deliberate global serialization point. |
| kuali, servicenow, i9, new/old-kronos, sharepoint | 1 | 1 | No multi-tab evidence. Start at 1; raising any number requires a live-verification note (§7 guard 5). |

Budgets are **per session** (per executor) here; §5.1 adds the cross-executor per-system cap.
Sizes live in Settings → Performance beside today's worker/OCR knobs — operator-visible, sparse
override (empty = these defaults).

### 3.3 Login: once per system per executor, single-flight, fully automated

- The pool logs into a system **lazily on first acquire** (or eagerly at executor start for
  systems named by the first claimed runs — same eager/on-first-use policy the workflow `auth()`
  override selects, doc 01 §6.1). One `login()` per system per executor lifetime, serving every
  workflow — the per-worker Duo chain is gone.
- **Single-flight:** N lanes racing to acquire a not-yet-authenticated system all await the same
  in-flight login promise. Pinned by test (§7 guard 6).
- Duo is cleared hands-off by Duo Autopilot inside the store's `login` for ALL runs, production
  included (charter §9): login is a bounded operation (~20–40s), never a park, never a phone.
- **Health:** the browser-health verdict ladder ports as pool behavior — per-system verdicts
  (`ok/soft/wedged/expired/closed/dead`), refresh rung → reopen rung → surface `failed`; the
  idle-refresh cadence keeps warm sessions alive between claims (both keyed by the store
  `SessionProvider`'s `idleRefresh`/`resetUrl`, doc 01). A system going `failed` drains that
  system's leases and fails/requeues only tasks ON it; other systems' lanes keep running.

### 3.4 OnBase (D15) — how the one deliberate serialization point plugs in

`acquire("onbase", …)` first takes the **cross-process SQLite lease** (daemons/executors are
separate OS processes; an in-process mutex cannot serialize them — D15). Lease scope = the task
execution; released with the page lease, including on park (D5) and on crash via the ported
lease-expiry recovery. Contention is visible: a lane waiting on the OnBase lease reports a
`waiting` note on its task span, not silence.

### 3.5 Gates return capacity (D5, restated as pool behavior)

Park ⇒ every lease released (reset-or-close), every exclusive lease released, lane freed. Resume
is a fresh claim: sessions reacquired through the pool (already-authenticated fast path, else
idempotent re-login). An overnight approval holds **zero** browser resources.

---

## 4. Speed engineering

### 4.1 Killing the sleep tax (the ~33s/item)

The leaf drivers port **verbatim in commit 1** (charter). Sleep elimination is a deliberate,
per-store **commit-2+ hardening pass** with the discipline the 2026-06-22 job-summary regression
taught (a naive spinner-wait is WORSE than the sleep it replaced — it returns early and
un-synchronized):

1. **`stores/common/waits.ts`** provides condition waits that poll the *actual* readiness
   predicate: `settle(frame, { until: Locator|predicate, quietMs })` — target-element presence /
   value, plus a short DOM-mutation quiet window for PeopleSoft fragment refreshes; the
   `pollForJobInfoScan` pattern (poll the data you need, injected sleep, unit-testable)
   generalized. Never "wait for spinner" alone — spinners are unreliable (2026-06-22).
2. **Each replaced sleep is individually live-verified** (headless selector session, standing
   pre-authorization) — the replacement names the condition it waits on, gets a `// verified`
   date, and lands per-file so a regression bisects to one wait.
3. **The wait-for-timeout ratchet extends to `temp_src` with a ZERO allowlist for new code**;
   ported files inherit their current counts as shrink-only entries. The genuinely-fixed delays
   (old-kronos 80ms JQX debounce) stay allowlisted with reasons, as today.
4. **Sleep is measured, not guessed:** the page proxy records cumulative `waitForTimeout` ms per
   task execution → a `sleepMs` field on the task span's end note (doc 03 notes stream). The
   dashboard can show sleep-per-task; a ratchet pins per-contract sleep budgets and only shrinks.
   What gets measured gets deleted.

Expected recovery: person-org lookup drops from ~24s sleep to <5s of condition-wait residue;
Smart HR transaction from ~30s+ toward the real PeopleSoft roundtrip time. Combined with 3-tab
reads this is where the order-of-magnitude lives — sleeps don't just cost their own duration,
they cost it **while holding a lease**.

### 4.2 What parallelism UCPath actually tolerates — stated honestly

- **Proven:** 4 concurrent tabs on ONE logged-in PeopleSoft session doing person-org/CRM reads
  (person-lookup shared-context pool, months of live operation). One Duo serves them all.
- **Unproven and deliberately not assumed:** concurrent Smart HR *wizard* fills in multiple tabs
  of one session. PeopleSoft keeps server-side component state per window; the modal-mask, grid
  re-index (`$11`→`$0`), and fragment-refresh lessons all point to state that a sibling tab could
  perturb. Default: **one write tab per UCPath session** — mutate-effect tasks queue for it;
  read tasks keep flowing on the read tabs meanwhile. Raising `writeTabs` requires a live
  dry-run proof, recorded, before the config guard (§7 #5) admits it.
- Multiple *sessions* (2 executors, 2 Duo logins, same operator account): PeopleSoft allows
  concurrent sessions per user; this is today's N-daemon model and remains available as the
  scale-out path for write-heavy batches — now a choice, not the only shape.

### 4.3 Pipelining, concretely

With `lanes: 4`, ucpath `{read:3, write:1}`, a mixed queue schedules itself: reads interleave on
the read tabs; the write tab stays saturated by whichever run reaches its mutate step next;
validation/compute/service-store steps (no lease) overlap everything. No bespoke pipeline code —
the lease-per-task grain + multi-lane claim IS the pipeline. In-run parallel branches (today's
`ctx.parallel`, verify's dual fan-out) remain workflow composition per doc 02 OQ5; they appear
to the pool as ordinary concurrent tasks of one run.

---

## 5. Backpressure and fairness

### 5.1 Budgets (three nested caps, all operator-visible)

1. **Per-system, per-executor:** the §3.2 tab counts — the hard physical cap.
2. **Per-system, global:** SQLite-registered cap across executors (e.g. `ucpath: 6`) so two
   executors can't jointly hammer one backend; OnBase's global cap is structurally 1 (D15).
3. **Per-workflow lane cap:** max runs of one workflow in flight per executor (default = lanes),
   so one workflow cannot monopolize even when it owns the queue.

All three land in Settings → Performance beside the existing knobs (default workers, OCR
concurrency, nav timeouts), sparse-override style.

### 5.2 Fairness — a 100-member fan-out never starves the interactive run

Claim order is **fair-share, then FIFO**: group queued runs by workflow; pick from the workflow
with the fewest currently-running claims (tie → oldest `enqueued_at`). Plus one reservation:
**at least one lane is reserved for operator-interactive runs** (root runs with no
`parentRunId`) whenever any exist — a fresh person-lookup typed into the dashboard claims within
one scheduler tick even mid-fan-out. Fan-out members (operation-member shape) fill the remaining
lanes. Retry backoff rides a `not_before` timestamp on the queue row — a backing-off run is
simply not claimable yet and blocks nothing (no head-of-line: the claim query skips it).

```sql
-- claim sketch: fairness folded into the ported indexed claim
SELECT ... FROM runs WHERE state='queued' AND not_before <= @now
  AND (@interactiveLaneFree OR parent_run_id IS NOT NULL OR ...)
ORDER BY running_count_for_workflow ASC, enqueued_at ASC LIMIT 1;
```

### 5.3 Backpressure signals

- Pool exhaustion is **visible**: lanes waiting on a lease emit `waiting` notes (span-addressed);
  the executor card shows per-system `in-use / cap`.
- Enqueue is never blocked (queue depth is unbounded, as today); admission control happens at
  claim time. The rail's queue badges stay backend-authoritative (doc 03 wfCounts).

---

## 6. Failure isolation

### 6.1 THE page-isolation invariant (the real HR-data hazard, stated precisely)

> **A `Page` is referenced by at most one task execution at any instant. A page that hosted a
> task is returned to the pool only after a successful bounded navigation to the system's
> neutral `resetUrl` — otherwise it is closed. A page that hosted an aborted/poisoned task is
> ALWAYS closed, never reused. Identity of lease-holder is checked on every `ctx.page` call.**

Two items sharing a page mid-form — task B typing into the Smart HR wizard task A half-filled —
is the one failure mode that silently writes person A's data into person B's transaction. The
invariant kills it three ways: exclusivity (no concurrent reference), reset-or-close (no residual
form state), poison-close (no reuse after an indeterminate abort). Mechanical guards: §7 #2.

### 6.2 Crash/failure matrix

| Failure | Blast radius | Mechanism |
|---|---|---|
| One task throws (business or transient) | Its run only | Lane frees; retry policy (doc 01) in-run or cross-run per doc 02; lease released clean or poisoned |
| Task aborted (cancel) mid-Playwright call | Its run + its page | Ported abort-racing proxy + poison-close; sibling tabs on the same context untouched (proven shape: person-lookup workers already fail independently on a shared context) |
| One system's browser wedges/dies | That system's lanes | Health ladder refresh→reopen→failed; tasks on it fail/requeue; **other systems' lanes keep running** (better than today: a daemon dies whole) |
| Session expired (SSO bounce) | That system | Surface `failed` + re-login on next acquire (idempotent login); no auto-Duo-loop hiding it |
| Executor crash | Its in-flight runs | Ported heartbeat/lease recovery re-pends reads; crash-mid-mutate parks `needs-operator` (doc 02 §5.6 #2) |
| Retry storm | None (no HOL) | `not_before` backoff — backing-off runs are invisible to claims |

### 6.3 Retries schedule like everything else

A retry (in-run attempt or cross-run `retryOf`) is just a claimable run with a `not_before`; it
competes under fair-share like any run. No lane ever sleeps waiting for a backoff to elapse.

---

## 7. Adversarial self-review — how this rots, and the guard for each

| # | Rot vector | Mechanical guard |
|---|---|---|
| 1 | **Hidden serialization returns** — a well-meaning mutex/`await` chain quietly makes lanes run one-at-a-time | The e2e stub parallel matrix (already deterministic via hold gates) gains a lane-overlap scenario: two held runs of different workflows must be simultaneously `running` on one executor; asserted on span timestamps. A scheduler metric (`maxConcurrentLanes`) is asserted ≥2 in that lane |
| 2 | **Page cross-contamination** — pool hands a dirty or shared page | Unit-pinned: `release("clean")` must navigate-or-close before re-checkout; poisoned ⇒ closed (test constructs the half-filled-form case). Runtime: lease records `(runId, spanPath)`; `ctx.page` throws if the caller isn't the lease-holder. Ratchet: no `Page` value may be stored on module scope in `stores/**` (grep guard) |
| 3 | **Sleep tax re-accretes** | wait-for-timeout ratchet extended to `temp_src` with zero-allowlist for new files, shrink-only for ported ones; `sleepMs` recorded per task span + budget ratchet (§4.1) |
| 4 | **Fan-out starves interactive runs** | Unit test seeds 100 members + 1 root run, asserts the root claims within one tick (interactive lane reservation); fair-share ORDER BY pinned by query test |
| 5 | **Pool sizes creep past evidence** — someone bumps ucpath `writeTabs: 3` to go faster | Config guard: defaults above §3.2's table require an adjacent `// verified <date>` live-proof note; snapshot test enumerates all raised values |
| 6 | **Login stampede** — N lanes trigger N concurrent Duo logins for one system | Single-flight pinned: N concurrent `acquire`s on a cold system produce exactly one `login()` call (spy test) |
| 7 | **OnBase lease bypass** — a code path opens OnBase without the D15 lease | Type-level: every onbase contract's `SessionNeed` carries `exclusive: true` (coverage guard walks contracts); the only page source is the pool, and the pool's onbase path acquires the lease unconditionally (unit-pinned) |
| 8 | **Executor becomes a new god-process nobody can restart** | Parked-runs-are-free (D5) + lease recovery mean restart cost is bounded; a soak test (ports `daemon-teardown-soak`) kills an executor mid-lanes and asserts every run reaches re-pend/park/terminal with zero orphans |
| 9 | **Budgets silently ignored** (a direct `context.newPage()` beside the pool) | Grep ratchet: `newPage(` allowlisted only inside `session-pool.ts`; all task page access flows through `ctx.page` → lease |
| 10 | **Fairness math starves the fan-out instead** (inverse of #4) | Same seeded test asserts members drain at ≥ (lanes−1) concurrency while the interactive lane is idle |

Honest residuals: (a) PeopleSoft multi-tab **write** behavior is an unknown until the live
dry-run proof — the design defaults safe (1 write tab) and treats widening as an experiment, not
an assumption; (b) one-executor-default concentrates failure — mitigated by containment (§6.2)
and the `executorGroup` pin, but a chromium-wide OS failure still interrupts everything in
flight at once.

---

## 8. Worked example — a 10-person i9-check batch

Phase 1 (OCR) is unchanged — the per-page pool already parallelizes extraction. This schedules
**Phase 2**: 10 member runs, each `person-match` (UCPath read) → `person-lookup` (UCPath read,
conditional — assume 4 of 10 need it) → `roster-match` (local compute + one serialized xlsx
append; the retention-tracker file is a single-writer resource → a `local` exclusive lease, ~1s).

**Today** (dedicated single-browser i9-check daemon, strictly sequential, reset-URL between
items): spawn + Duo ≈ 45s; per member ≈ 60–90s, of which ~25–30s is fixed sleep
(person-org-summary's 3s×8 + navigate settles). **Total ≈ 11–15 min.**

**New kernel** — one executor, `lanes: 4`, ucpath `{read: 3}` (all tasks are reads — the write
tab is never touched), spreadsheet lease serializes only the ~1s appends:

```
t=0        claim R1..R4 (lane cap 4); ucpath cold → single-flight login (~35s); R4 waits for a tab
t=35s      tab1: R1 person-match   tab2: R2 person-match   tab3: R3 person-match
t≈55s      matches resolve (~20s with condition waits, not 3s-sleep chains)
           tab1: R4 person-match   tab2: R5 …   tab3: R6 …      R1 → roster-match (no tab, 1s)
t≈75s      R7..R9 on tabs; R2,R3 roster-match; R1 done
t≈95s      R10 + the 4 person-lookup runs (needed-lookup members) start their second UCPath task
t≈115–140s stragglers: person-lookup (~25s each, 3-wide) + serialized appends drain
```

**Wall clock ≈ 2.5 min cold (≈2 min on a warm executor) vs ≈ 12 min today — roughly 5×**, from
three multiplicative sources: 3-wide read tabs (÷3 on the browser-bound path), sleep-tax removal
(~30s → ~5s per member), and no per-batch spawn+auth when the executor is warm. The only
serialization points are honest ones: the single Duo login (amortized) and the 1s-per-member
spreadsheet append (a real single-writer file).

---

## 9. Open questions for the operator / orchestrator

1. **Default lane count** — proposed `lanes: 4` per executor (matches the proven 4-worker pool).
   Higher is cheap for reads; is 4 the right operator-facing default?
2. **UCPath write-tab widening** — schedule a live dry-run experiment (2 concurrent Smart HR
   wizard fills in 2 tabs of one session, dryRun=true) early, or defer until a write-heavy
   migration (separations) forces the question?
3. **Executor spawn ownership** — dashboard backend spawns/adopts the default executor at boot
   (always-warm sessions, instant first run) vs on-first-enqueue as today (no idle chromium)?
4. **Interactive-lane definition** — "root run with no parentRunId" is the proposed heuristic;
   should the RunEnvelope instead carry an explicit `priority: interactive|bulk` the surfaces
   set (upload = bulk, typed input = interactive)?
5. **Cross-executor session budget store** — plain SQLite counters (proposed, matches D15's
   lease pattern) vs reusing the worker-heartbeat table with per-system columns?
