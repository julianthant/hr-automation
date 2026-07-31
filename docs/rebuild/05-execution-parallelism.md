# 05 — Execution Kernel: Workers & Browser Sessions

Status: **revised 2026-07-30 after operator review.** The executor-lane and static per-system
capacity design is retired. One worker handles one item at a time; parallelism comes from starting
more workers; workflows explicitly declare steps that require a fresh browser session.

## Ownership (D1)

| This doc **OWNS** (siblings reference, never redefine) |
|---|
| Worker claim/heartbeat/recovery behavior and the one-item-in-flight invariant |
| Browser-session ownership, reuse, reset/close discipline, and explicit fresh-session boundaries |
| Worker spawning and queue dispatch/backpressure |
| The speed contract: condition waits, sleep-tax removal, and bounded operations |
| The page/subject-isolation invariant (§6.1) |

| This doc **references** (owner) |
|---|
| Task contract, `SessionNeed`, exclusive driver use, retry policy → **doc 01** |
| Run state machine, gates/parks, checkpoints, RunEnvelope → **doc 02** |
| Worker/run/task span wire schema, Session Panel projections, notes → **doc 03** |
| Command/claim authority, degraded storage mode, notifications → **doc 03** |
| Semantic UI ids, typed drivers, action evidence, scenarios → **doc 12** |
| OnBase cross-process identity lease → **D15** |

Grounding: today's daemon already has one `state.activeRun` per process. The rebuild keeps that
understandable ownership model and removes the proposed scheduler inside each process.

---

## 0. Settled decision

1. **No executor lanes.** There is no global `lanes` number, lane reservation, capacity chip, or
   per-workflow lane cap.
2. **No static per-system capacity math.** There is no `ucpath 1/1` or `crm 1/2` budget contract.
   Concrete browser health tiles show the sessions that actually exist.
3. **One worker, one active item.** A worker does not claim a second run until its active run parks
   or reaches a terminal state.
4. **Parallelism is worker count.** Starting N workers for a workflow creates N independent workers.
   The Add-workers UI does not invent a hidden lease calculation or global cap.
5. **Browser sessions belong to a worker.** Distinct workers own independent system sessions.
6. **Workflows declare fresh-session boundaries.** Reuse is normal. If a particular step must run
   in a new browser session, the workflow descriptor says so explicitly. The kernel never infers a
   boundary from a counter, step name, or queue state.
7. **No cross-workflow browser pool.** Authenticated pages are not shared between unrelated
   workflows.

“Lane” remains valid terminology for test suites (`stub lane`, `live lane`) and visual workflow
graph branches. Those uses do not describe executor capacity and are unaffected.

---

## 1. Units, named precisely

- **Run** — one item's execution of a workflow.
- **Worker** — one long-lived process/instance assigned to one workflow. It owns at most one active
  run and its browser sessions.
- **Browser session** — one authenticated `BrowserContext` and controlled page/window set for one
  system inside one worker.
- **Driver lease** — exclusive task-length access to a system driver backed by the worker's current
  browser session. A transaction may retain it across prepare → fence → commit → proof.
- **Fresh-session boundary** — an authored workflow instruction that closes the current session for
  a named system before the next node and authenticates a new one.

---

## 2. Workflow session contract

The descriptor compiler resolves every browser-backed node to an explicit policy:

```ts
export interface SessionNeed<S extends BrowserSystemId> {
  system: S;
  access: "read" | "transaction";
  session: "reuse-worker" | "fresh";
}
```

- `reuse-worker` uses the worker's current healthy authenticated session for that system, creating
  one lazily if none exists.
- `fresh` first performs the bounded close protocol, then creates and authenticates a new session
  before the node begins.
- Authoring may omit `session` only where the descriptor schema supplies the literal, test-pinned
  default `reuse-worker`. Runtime code never guesses.
- A session boundary is visible in the Explorer and worker/run spans as
  `browser_session:close` followed by `browser_session:start`, including system and reason.
- A workflow that needs several sessions states boundaries at the exact nodes. It does not raise a
  worker-wide number or create a second item slot.

### 2.1 Gates and parks

A parked run owns no browser resources. Before parking, the worker resets/closes active sessions
according to the provider policy and releases identity leases. Resume is a fresh claim. An overnight
approval holds neither a browser nor an execution slot.

---

## 3. Worker lifecycle and claiming

Each worker is workflow-scoped and runs the proven claim-generation protocol:

```ts
export async function runWorker(config: WorkerConfig): Promise<void> {
  const sessions = new WorkerSessions(config.workflow);
  while (!state.shuttingDown) {
    const run = await claimNextRun({ workflow: config.workflow });
    if (!run) {
      await parkUntilWakeOr(IDLE_REPOLL_MS);
      continue;
    }
    await driveRunStateMachine(run, sessions); // one awaited run
  }
}
```

- Claim authority remains SQLite with owner, attempt, claim generation, heartbeat renewal, fenced
  terminalization, dead-worker recovery, and bounded re-poll.
- A worker renews exactly its one active claim.
- A gate parks the run and frees the worker to claim another item.
- Retry backoff rides `not_before`; a worker never sleeps while owning a run merely to wait for a
  retry time.
- `+ Add workers` chooses a workflow and a count. Starting 5 creates 5 independently owned workers
  and browser-session sets.

### 3.1 Dispatch and fairness

Within a workflow queue, claim order is priority then FIFO. Interactive work may be server-stamped
ahead of bulk members, but there is no reserved interactive lane. Across workflows, the operator
chooses worker counts per workflow, and each worker claims only its workflow's rows. A large fan-out
cannot consume another workflow's workers.

---

## 4. Browser-session behavior

- Driver use is exclusive while held.
- `release("clean")` navigates to the system's verified neutral reset state before reuse.
- A failed reset, aborted Playwright call, subject mismatch, or `release("poisoned")` closes the page
  and session; the next need creates a fresh one.
- A `session:"fresh"` boundary uses the same close proof before replacing the session.
- OnBase releases its identity lease only after every page/context close is proven.
- Login is bounded and single-flight within that worker/system session creation. There is no
  cross-worker login promise or shared context.

An individual workflow may declare internally proven parallel work, such as OCR provider page
concurrency. That is workflow-owned behavior with its own tests, not a generic executor capacity
model.

The Session Panel shows worker phase, queued count, trace id, current step, browser health tiles,
wait reasons, and failure state. It does not show lane or per-system capacity counters. Settings has
no lane/budget reference page.

---

## 5. Speed engineering

Removing lanes does not preserve the fixed-sleep tax:

1. Replace `waitForTimeout` calls with waits on actual readiness predicates plus a bounded quiet
   window where PeopleSoft fragment refreshes require it.
2. Live-verify each replacement and record the selector/state proof.
3. Extend the wait-for-timeout ratchet to rebuild code with a zero allowlist for new files and a
   shrink-only allowance for ported files.
4. Record cumulative fixed-sleep time and real wait time on task spans.
5. Keep tasks and transactions under immutable, abortable deadlines. A service that ignores abort
   cannot occupy a worker indefinitely.

For batch speed, start more workers. A warm worker amortizes login across sequential items unless a
workflow-authored fresh boundary or failed reset requires replacement.

---

## 6. Failure isolation

### 6.1 Page/subject-isolation invariant

> A page belongs to at most one task execution at any instant. It is reusable only after a
> successful bounded reset to the system's neutral state; otherwise it is closed. Before a write
> fence, the driver freshly observes the declared subject on the staged page and the kernel requires
> an exact normalized match. Mismatch or unknown prevents commit and closes the session.

One worker never shares its page with another worker. One workflow never borrows another workflow's
authenticated context.

### 6.2 Failure matrix

| Failure | Blast radius | Mechanism |
|---|---|---|
| Task throws | Its run/worker | Release clean or poisoned; apply retry policy; worker claims next eligible row |
| Cancel during Playwright | Its page/session | Abort-racing proxy + poison-close |
| One system session wedges | That worker's system session | health ladder → close/re-auth or structured failure |
| Worker crashes | Its one active run | claim-generation recovery; transaction recovery before replay |
| Retry storm | No head-of-line block | `not_before`; idle workers claim other eligible rows |
| Authority DB degraded | All mutation stops | doc 03 storage-health gate; dashboard remains diagnostic |

---

## 7. Mechanical guards

| Risk | Required guard |
|---|---|
| A worker starts two items concurrently | worker-soak test asserts max active claims per worker is exactly 1 |
| UI/config reintroduces capacity fields | unit guard rejects worker/session fixtures containing `lanes` or `budgets`; dashboard verification asserts capacity copy is absent |
| Parallelism silently serializes | spawn test starts N workers and proves N distinct worker ids/browser owners |
| Fresh-session request is ignored | descriptor scenario asserts close proof precedes new-session start and node execution |
| Session boundary is inferred | descriptor projection test proves only authored `session:"fresh"` produces a boundary |
| Dirty page crosses people | alternating-subject scenario proves reset-or-close + subject observation before write fence |
| Raw page APIs bypass ownership | imports/newPage are restricted to driver/session internals |
| Fixed sleeps return | wait-for-timeout ratchet + span sleep budget |
| OnBase overlap | identity-lease test proves close-before-release and dead-owner takeover |

---

## 8. Worked example — 10-person I-9 Check

Choosing **3 workers** creates three independently authenticated UCPath/I-9 session sets. Each
worker claims one member, runs it to park/terminal, resets its sessions, and claims the next. No
worker has a second in-flight item and no capacity counter participates.

If a specific step needs a clean UCPath context, the I-9 Check descriptor marks that node
`session:"fresh"`; other steps reuse their worker-local session.

---

## 9. Settled defaults

1. One active item per worker.
2. Parallelism is explicit worker count, chosen per workflow.
3. Session reuse is the descriptor default; fresh boundaries are explicit and observable.
4. No global executor lane budget, lane chip, per-system capacity chip, pool-mode table, or
   lane-based fairness math.
5. Queue admission is blocked only by authority/storage correctness; worker availability affects
   when work starts, not whether it may be enqueued.
