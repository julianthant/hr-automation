# Workflow Daemon Mode — Persistent Sessions + Shared-Queue Multi-Daemon Dispatch

**Date:** 2026-04-22
**Status:** Approved (in-session)
**Scope:** New kernel run mode + daemon registry + CLI adapter pattern. Converts the "`npm run <wf>` launches browsers, does work, closes" flow into a "daemons stay alive; subsequent `npm run <wf>` invocations enqueue onto a shared queue" flow.

## Summary

Today every CLI invocation of a workflow (`npm run separation 3939`, `npm run work-study ...`, etc.) starts a fresh process that launches browsers, runs the Duo auth chain, processes the argv-provided item list, closes browsers, and exits. Adding one more doc to an in-flight batch requires Ctrl+C, rerun, redo all Duos — the entire pain point operators hit daily.

This design introduces **daemon mode**: long-running workflow processes that keep their `Session` (browsers + auth) alive and consume items from a **shared on-disk queue**. Multiple daemons can run concurrently for the same workflow; they are **peers** with no coordinator, racing to claim items via an atomic filesystem mutex. This gives dynamic load balancing ("whichever daemon finishes first grabs the next queued item") for free, with no leader election.

A single new kernel run mode (`runWorkflowDaemon`) is added alongside existing `runWorkflow` / `runWorkflowBatch` / `runWorkflowPool`. Every existing workflow CLI adapter is rewritten to a thin client that routes through a single shared helper: **if ≥1 alive daemon exists for this workflow, enqueue to the shared queue; otherwise spawn one detached daemon and then enqueue.** `--new` spawns an extra daemon unconditionally. `--parallel N` ensures ≥N daemons are alive before enqueueing. `--attach` / `--stop` / `--daemon-status` expose lifecycle controls.

The existing kernel modes (`runWorkflow`, `runWorkflowBatch`, `runWorkflowPool`, `runWorkflowSharedContextPool`) are **untouched** — they remain the direct-invocation path for scripts and tests. Only CLI adapters switch their default path.

## Motivation

Observed operator pain, as described:

> "The current workflows don't close when they are done. We have to run e.g. `npm run separation 3939` and it does that and stops, and we can't add another doc to that anymore. To run another separation, we have to rerun the npm command and do all Duos again. It is very inefficient."

Today's costs per fresh invocation:

- **Separations**: 4 Duo approvals (Kuali, Old Kronos, New Kronos, UCPath) + 4 browser launches + CDP tiling + SSO round-trips ≈ **45–60 s** before the first doc starts processing.
- **Onboarding**: 2 Duo approvals (CRM, UCPath) + I9 setup ≈ **30 s**.
- **Work-study**: 1 Duo (UCPath) ≈ **15 s**.
- **EID lookup**: 1 Duo (UCPath) + optional CRM ≈ **15–25 s**.

For solo-operator HR work where docs trickle in throughout the day, this overhead is paid per-doc. A single daemon per workflow amortizes it across every item the daemon processes in its lifetime.

Secondary motivation: the root `CLAUDE.md` already calls out "Replacement workflow launcher" as a deferred follow-up from the 2026-04-18 dashboard-runner removal. Daemon mode creates the primitive that the dashboard's future queue-add UI will drop onto with a single `fetch()` call — no second IPC protocol to invent.

## Non-goals

- **Cross-machine daemons.** Everything is localhost-only. No consideration of remote daemons, clustering, network partitions. The user runs on one macOS workstation.
- **Replacing existing kernel modes.** `runWorkflow` / `runWorkflowBatch` / `runWorkflowPool` / `runWorkflowSharedContextPool` stay. Daemon mode is additive.
- **Dashboard queue-add UI.** Documented follow-up. V1 lands the primitive + CLI surface only.
- **Idle timeout / auto-shutdown.** Explicitly rejected per user choice. Daemons stay alive until SIGINT or `:stop`.
- **Priority queues / item reordering.** FIFO only. No priority lanes. Simple.
- **Cross-workflow queue (one queue for all workflows).** Per-workflow queues. Each daemon is typed to a single workflow.
- **Dynamic daemon count scaling.** Daemons are spawned explicitly (default → 1, `--parallel N` → N). No "auto-scale up when queue depth > X" feature.
- **Full conversion of every workflow in this commit.** Kernel primitives + separations + work-study conversions ship in this session, proving the pattern on a multi-system and a single-system workflow. onboarding / emergency-contact / kronos-reports / eid-lookup conversions are mechanical follow-ups with a documented template.

## Architecture

### Directory shape

```
src/core/
  daemon-registry.ts       NEW — lockfile + PID probes + discovery + spawn helpers
  daemon-queue.ts          NEW — shared-queue JSONL ops (append, fold, claim, recover)
  daemon.ts                NEW — runWorkflowDaemon (the main loop)
  daemon-client.ts         NEW — ensureDaemonsAndEnqueue (the one CLI helper)
  daemon-types.ts          NEW — Daemon, QueueItem, DaemonFlags, EnqueueResult
  index.ts                 UPDATED — re-export new module surface

tests/unit/core/
  daemon-registry.test.ts  NEW — lockfile + discovery + staleness
  daemon-queue.test.ts     NEW — append + fold + claim-under-contention + recovery
  daemon-client.test.ts    NEW — ensureDaemonsAndEnqueue routing (spawn vs enqueue)
  daemon.test.ts           NEW — main loop with mocked session (trackerStub)

src/workflows/separations/
  workflow.ts              UPDATED — runSeparationDaemon adapter added
  index.ts                 UPDATED — barrel export
  CLAUDE.md                UPDATED — daemon-mode section

src/workflows/work-study/
  workflow.ts              UPDATED — runWorkStudyDaemon adapter added
  index.ts                 UPDATED — barrel export
  CLAUDE.md                UPDATED — daemon-mode section

src/cli.ts                 UPDATED — daemon-aware separation + work-study handlers
                                    + generic :attach / :stop / --daemon-status subcommands

CLAUDE.md                  UPDATED — daemon-mode section in root primer + pending-followups
src/core/CLAUDE.md         UPDATED — Files + Design invariants + Lessons
src/workflows/CLAUDE.md    UPDATED — daemon-conversion template for future workflows

package.json               UPDATED — script additions: separation:attach, separation:stop, etc.

.tracker/daemons/          NEW — runtime dir for lockfiles, queue files, logs, claim mutex
```

### Runtime layout (example: separations with 2 parallel daemons + 3 items)

```
.tracker/daemons/
  separations-w1-4a8e.lock.json    { pid: 42031, port: 51234, ... }
  separations-w2-b2c9.lock.json    { pid: 42089, port: 51291, ... }
  separations.queue.jsonl          [ { id: 3939, state: claimed, claimedBy: w1-4a8e },
                                     { id: 3940, state: claimed, claimedBy: w2-b2c9 },
                                     { id: 3941, state: queued } ]
  separations.queue.lock/          (directory-mutex, held for ~ms during claim)
  separations-w1-4a8e.log          rolling stdout/stderr of daemon
  separations-w2-b2c9.log          rolling stdout/stderr of daemon
```

### Core daemon lifecycle

```
spawn (detached from npm run X client)
  |
  bind HTTP :0 → kernel picks port
  write lockfile .tracker/daemons/{workflow}-{instanceId}.lock.json atomically
                 (via tmp + rename, with `wx` flag so we never clobber a sibling)
  |
  Session.launch(systems, { authChain, tiling, observer })
    → full Duo chain (interleaved or sequential per workflow config)
  |
  withBatchLifecycle opens (emits ONE workflow_start for the daemon's lifetime)
  |
  recoverOrphanedClaims(workflow, myInstanceId, aliveDaemons)
    → scan queue JSONL for claims whose claimedBy PID is dead or non-existent
    → emit re-queue event line per recovered claim
  |
  MAIN LOOP:
    while (!shuttingDown) {
      const item = await claimNextItem(workflow, myInstanceId)
      if (item) {
        await runOneItem({ wf, session, item: item.input, itemId: item.id, ... })
          (existing kernel machinery — unchanged)
        markItemDone(workflow, item.id, runId)  OR
        markItemFailed(workflow, item.id, error, runId)
      } else {
        await Promise.race([
          wakeEvent.once('wake'),
          setTimeout(15 * 60 * 1000),    // 15-min keepalive
          shutdownEvent.once('shutdown'),
        ])
        if (timeout fired) {
          // Keepalive: probe every system, re-auth any that failed
          for (const sys of systems) {
            if (!await session.healthCheck(sys.id)) {
              await loginWithRetry(sys, session.page(sys.id))
              // emits new auth:<id> tracker row with re-auth timestamp
            }
          }
        }
      }
    }
  |
  on SIGINT / POST /stop:
    set shuttingDown = true
    if in-flight claim: mark as queued (soft stop) or failed (force=1)
    await current runOneItem settles
    session.close()
    withBatchLifecycle closes (emits ONE workflow_end)
    unlink lockfile
    process.exit(0)
```

### The shared-queue protocol

`.tracker/daemons/{workflow}.queue.jsonl` — append-only JSONL, one event per line. Folded by `id` with last-event-wins, identical to the tracker JSONL pattern.

**Event shapes:**

```ts
type QueueEvent =
  | { type: 'enqueue'; id: string; workflow: string; input: unknown; enqueuedAt: string; enqueuedBy: string /* pid or 'cli-<pid>' */ }
  | { type: 'claim';   id: string; claimedBy: string /* instanceId */; claimedAt: string; runId: string }
  | { type: 'unclaim'; id: string; reason: 'recovered' | 'sigint-soft' | 'voluntary'; ts: string }
  | { type: 'done';    id: string; completedAt: string; runId: string }
  | { type: 'failed';  id: string; failedAt: string; runId: string; error: string }
```

**Writers:**

- **Enqueue (CLI client)**: append `{ type: 'enqueue', ... }`. Atomic at POSIX level (`appendFileSync` with flag `a`, sub-PIPE_BUF writes).
- **Claim (daemon)**: acquire mkdir-mutex → read queue JSONL → fold → find first `id` whose latest state is `queued` → append `{ type: 'claim', id, claimedBy: myId, ... }` → release mutex. All in one critical section to prevent two daemons claiming the same id.
- **Unclaim / done / failed (daemon)**: just append. State-fold always takes the latest event per id, so ordering across daemons is safe without the mutex.

**The mkdir-mutex:** `.tracker/daemons/{workflow}.queue.lock/` directory. `fs.mkdirSync(path)` is atomic across processes — if the dir exists, mkdir throws `EEXIST`. Daemons retry with exponential backoff + jitter (1ms → 8ms, ~10 attempts, total worst case ~100ms; in practice held for <5ms). Release is `fs.rmdirSync(path)`. If a daemon crashes holding the mutex, the next acquire retries long enough to hit the staleness check (~5 s): if the mutex dir's mtime is >5s old and no daemon's lockfile has its lock-held flag set, force-remove the mutex.

**State fold.** At any point, `readQueueState(workflow) → { queued[], claimed[], done[], failed[] }` by walking the JSONL and keeping the latest event per id. Used by daemons to find next claimable item, by the CLI client to compute queue position for user feedback, by `--daemon-status`, and (future) by the dashboard.

**Orphan recovery.** On daemon startup AND every 15-min keepalive cycle, each daemon scans for `claimed` entries whose `claimedBy` instance is not in the currently-alive daemon list (lockfile PID dead or missing). Such claims get a `{ type: 'unclaim', reason: 'recovered' }` event appended. Those items become re-queued and any alive daemon picks them up on the next claim cycle.

**Compaction.** When the queue JSONL exceeds 10,000 events, a daemon (whichever wins a compaction mutex) rewrites the file to contain only the latest event per id. Background concern — not v1-critical.

### The daemon registry

`.tracker/daemons/{workflow}-{instanceId}.lock.json` — one per daemon.

```ts
interface DaemonLockfile {
  workflow: string
  instanceId: string    // short random hex, e.g. "w1-4a8e"
  pid: number
  port: number          // HTTP listener port (from listen(0))
  startedAt: string     // ISO timestamp
  hostname: string      // for sanity only; cross-host is out of scope
  version: 1
}
```

Written via `writeFileSync(tmpPath, JSON.stringify(lock))` then `renameSync(tmpPath, finalPath)` — atomic on all POSIX filesystems.

**`findAliveDaemons(workflow, trackerDir?) → Promise<Daemon[]>`:**

```
1. Glob .tracker/daemons/{workflow}-*.lock.json
2. For each file:
   a. JSON.parse; ignore if parse fails
   b. process.kill(lock.pid, 0) — throws ESRCH if dead. If dead: fs.unlink the lockfile, skip.
   c. fetch(`http://127.0.0.1:${lock.port}/whoami`) with 500ms timeout
      Expected response: { workflow, instanceId } matching the lockfile
      Mismatch (port stolen by an unrelated process): skip + unlink the lockfile
   d. Include in result
3. Return array sorted by startedAt ascending
```

**`spawnDaemon(workflow, args, trackerDir?) → Promise<Daemon>`:**

```
1. child = child_process.spawn('node', ['--loader', 'tsx/esm', 'src/cli-daemon.ts',
                                        workflow, ...args],
   {
     detached: true,
     stdio: ['ignore', fsOpen('.tracker/daemons/{workflow}-...log', 'a'),
                       fsOpen('.tracker/daemons/{workflow}-...log', 'a')],
     env: process.env,
   })
2. child.unref()  — parent can exit without waiting
3. Poll for lockfile-with-handshake-success, max 5 min (auth time budget)
4. Resolve with Daemon shape once handshake passes
5. If timeout → reject with "daemon failed to start within 5min" — surface log path
```

**Daemon HTTP endpoints:**

- `GET /whoami` → `{ workflow, instanceId, pid, startedAt, version: 1 }`. Used for handshake. No side effects.
- `GET /status` → `{ workflow, instanceId, queueDepth, claimed: string[], inFlight: string | null, lastActivity, authState }`. Used by `:status` and future dashboard.
- `POST /wake` → `{ ok: true }`. Triggers the daemon's wakeEvent if idle. No-op if currently processing.
- `POST /stop` → `{ ok: true }`. Body: `{ force?: boolean }`. Soft stop drains in-flight; force marks as failed.

### The CLI client (`ensureDaemonsAndEnqueue`)

One function in `src/core/daemon-client.ts`:

```ts
export async function ensureDaemonsAndEnqueue<T>(
  wf: RegisteredWorkflow<T, readonly string[]>,
  inputs: T[],
  flags: { new?: boolean; parallel?: number } = {},
  trackerDir?: string,
): Promise<{ enqueued: { id: string; position: number }[]; daemons: Daemon[] }>
```

Logic:

```
1. aliveDaemons = await findAliveDaemons(wf.config.name, trackerDir)
2. Determine spawnCount (single unified rule):
     const desired = flags.parallel ?? 1
     const deficit = Math.max(0, desired - aliveDaemons.length)
     spawnCount = flags.new ? Math.max(1, deficit) : deficit
   Worked examples:
     - no flags, 0 alive         → desired=1, deficit=1, no --new  → spawn 1
     - no flags, ≥1 alive        → desired=1, deficit=0, no --new  → spawn 0 (enqueue only)
     - --new, 0 alive            → desired=1, deficit=1, --new      → spawn max(1,1) = 1
     - --new, 3 alive            → desired=1, deficit=0, --new      → spawn max(1,0) = 1
     - --parallel 4, 2 alive     → desired=4, deficit=2, no --new  → spawn 2
     - --parallel 4, 5 alive     → desired=4, deficit=0, no --new  → spawn 0
     - --parallel 4 --new, 2 alive → desired=4, deficit=2, --new   → spawn max(1,2) = 2
     - --parallel 4 --new, 6 alive → desired=4, deficit=0, --new   → spawn max(1,0) = 1
   Semantic: `--new` guarantees at least one brand-new daemon after the call;
             `--parallel N` guarantees at least N daemons alive after the call.
3. Spawn spawnCount daemons in parallel via Promise.all(spawnDaemon(...))
   — NOTE: in practice, auth is serial per user (one Duo prompt window at a time),
   so spawning >1 daemon simultaneously means the user approves ~N * (systems) Duos
   sequentially. This is the same Duo cost as today's `--parallel` pool mode.
4. allDaemons = [...aliveDaemons, ...newlySpawnedDaemons]
5. enqueueItems(wf.config.name, inputs, trackerDir) — appends N enqueue events
6. For each daemon in allDaemons: fire-and-forget POST /wake (ignore failures)
7. Return { enqueued, daemons: allDaemons }
```

The CLI adapter (e.g. `runSeparationCli` in `separations/workflow.ts`) becomes a thin wrapper:

```ts
export async function runSeparationCli(
  docIds: string[],
  options: { dryRun?: boolean; new?: boolean; parallel?: number } = {},
) {
  if (options.dryRun) {
    for (const id of docIds) previewSeparationPipeline(id)
    return
  }
  const inputs = docIds.map((docId) => ({ docId }))
  const result = await ensureDaemonsAndEnqueue(separationsWorkflow, inputs, {
    new: options.new,
    parallel: options.parallel,
  })
  for (const { id, position } of result.enqueued) {
    log.success(`Queued ${id} (position ${position} in separations queue)`)
  }
  log.step(`${result.daemons.length} daemon(s) processing.`)
}
```

### Daemon entry point (`src/cli-daemon.ts`)

The spawnDaemon helper `exec`s into a dedicated entry:

```
tsx --env-file=.env src/cli-daemon.ts <workflow> [args...]
```

Which:

1. Validates env
2. Loads the workflow's module by name (via a small `WORKFLOW_MAP`)
3. Calls `runWorkflowDaemon(wf)` which enters the main loop above

Why a separate entry (not `src/cli.ts`)? Because `cli.ts` is Commander-driven; daemons need a non-Commander bootstrap that's predictable and doesn't accidentally inherit parent process args.

### Integration with existing kernel invariants

| Invariant | Behavior in daemon mode |
|---|---|
| `withBatchLifecycle` emits ONE `workflow_start` + ONE `workflow_end` per batch | Emits one pair per daemon lifetime (entire daemon = one "batch"). Matches "one SessionPanel row per batch" UX. |
| `runOneItem` wraps each item in `withTrackedWorkflow` + `withLogContext` | Unchanged. Each claimed item goes through existing wrapping. |
| `authTimings` are injected as synthetic `auth:<id>` tracker rows | Captured at daemon boot. Each item receives the same auth timings. Mid-life re-auths (from keepalive) emit fresh `auth:<id>` rows tagged with that item's runId — visible in dashboard. |
| `preAssignedInstance` + `preAssignedRunId` | Daemon allocates one instance name at boot; `runOneItem` threads it into every item's tracker emissions. |
| `SIGINT` handler writes `failed` tracker rows for un-terminated items | Daemon's SIGINT handler: (a) emits `unclaim` for any in-flight item, (b) `withBatchLifecycle` closes with `failed` status, (c) `session.close()`, (d) unlinks lockfile. |
| Step-cache (`stepCacheGet`/`stepCacheSet`) | Unchanged. Keyed on `(workflow, itemId, step)` — hits cross daemons since the `.tracker/step-cache/` dir is shared. Re-running an item that crashed mid-flow picks up cache hits regardless of which daemon processes it. |
| Idempotency (`hasRecentlySucceeded`) | Unchanged. Per-transaction idempotency keys are in the shared idempotency JSONL. |
| Dashboard SSE / JSONL events | Unchanged. Daemon writes the same `pending`/`running`/`done`/`failed` events to `{workflow}-{date}.jsonl` that batch mode does. Dashboard has no concept of "daemon mode" — just sees items flowing. |

### CLI surface (per converted workflow)

Using separations as the example; every converted workflow follows the same template:

```
npm run separation <docId>                      default = enqueue or spawn
npm run separation <docId> --new                spawn an extra daemon + enqueue
npm run separation <doc...> --parallel 4        ensure 4 daemons, enqueue
npm run separation --daemon-status              print registry + queue state
npm run separation:attach                       tail logs of all alive daemons
npm run separation:stop                         soft-stop all daemons
npm run separation:stop -- --force              force-stop (mark in-flight as failed)
```

## Error handling + edge cases

### Multi-invocation races

- **Two CLI clients enqueue simultaneously**: both `appendFile` calls are atomic at POSIX level; both events land. Daemons pick them up independently. No corruption.
- **Two CLI clients both find zero alive daemons and both spawn**: both daemons come up, both write their own lockfile (atomic via tmp+rename, `wx` flag), both process the queue. User ends up with 2 daemons where they expected 1. This is benign — same as `--parallel 2`. Documented in CLAUDE.md as expected when invoking in parallel terminals; suppression would require a file-level spawn mutex, which we don't add in v1.
- **Two daemons try to claim the same item**: mkdir-mutex resolves. Only one wins.

### Daemon death

- **Graceful (SIGINT or `:stop`)**: cleanup as described above. Lockfile removed. In-flight item re-queued (soft) or failed (force).
- **Ungraceful (SIGKILL, OOM, crash, terminal-closed-while-Duo-hanging)**: lockfile stays, in-flight claim orphaned. Next CLI invocation's `findAliveDaemons` detects dead PID via `process.kill(pid, 0)` → ESRCH → unlinks lockfile. Next alive daemon's next keepalive cycle detects the orphaned claim → emits `unclaim(reason: 'recovered')`. If no alive daemons remain when the next enqueue happens, the client spawns a fresh daemon, which runs orphan recovery on startup.
- **Port stolen** (rare; ephemeral port reused by unrelated process): handshake `GET /whoami` response mismatch → lockfile unlinked → treated as dead.

### Auth failures

- **Initial auth fails** (user denies Duo, creds wrong, etc.): `loginWithRetry` exhausts attempts → `Session.launch` throws → `withBatchLifecycle`'s auth-failure fanout marks any enqueued items as failed with `auth:<systemId>` step → daemon exits. The CLI client waits 5min for lockfile-with-handshake; sees lockfile doesn't appear; reports "daemon failed to start — check {log path}". User retries.
- **Mid-life re-auth fails** (session expired during long idle, re-auth's Duo denied): daemon logs the failure, emits a visible `log.error` + a fresh failed `auth:<systemId>` row, and transitions into an "auth-degraded" state where it refuses to claim new items until re-auth succeeds. Next 15-min cycle retries auth. The user can also `:stop` and respawn to get a fresh auth.

### Queue file corruption

Each line is self-describing JSON. A malformed line is logged (`log.warn('[DaemonQueue] bad line ...')`) and skipped during fold. A truncated trailing line (partial write) is treated the same. No daemon depends on the file being parseable-in-full; the fold tolerates gaps.

### Compaction race

When the queue JSONL exceeds 10,000 events, a compactor (whichever daemon wins a `compaction.lock/` mkdir-mutex) rewrites the file: `tmp-write fresh JSONL with only latest-per-id events → rename over original → rmdir mutex`. Concurrent appenders that wrote between our fold and our rename have their events in the original file, which is replaced. Loss window: tens of milliseconds. Mitigation for v1: compaction ONLY happens if `queuedCount === 0 && claimedCount === 0` (quiescent queue). If never quiescent, file grows — acceptable up to megabytes; at hundreds of megabytes add a "force compact on next restart" mode. Documented but not v1-urgent.

## Testing strategy

### Unit tests (required in Commit A)

1. **`daemon-registry.test.ts`** — isolated tmp dir per test:
   - Lockfile write is atomic (crash-between-tmp-and-rename leaves no half-state).
   - `findAliveDaemons` skips dead-PID lockfiles, handshake-mismatch, unparseable files.
   - Dead-daemon cleanup removes stale lockfiles.

2. **`daemon-queue.test.ts`** — isolated tmp dir per test:
   - Append is atomic (concurrent `appendFileSync` from two processes both land).
   - State fold respects event ordering (latest-per-id wins).
   - `claimNextItem` under contention: 10 mock daemons racing for 1 item — exactly one wins.
   - `recoverOrphanedClaims` re-queues claims whose claimedBy is not in alive list.
   - Malformed JSONL lines don't crash the fold.

3. **`daemon-client.test.ts`** — with mocked `spawnDaemon` and `findAliveDaemons`:
   - Default flags, zero alive → spawns 1.
   - Default flags, ≥1 alive → spawns 0.
   - `--new` → always spawns 1 extra.
   - `--parallel 4`, 2 alive → spawns 2.
   - `--parallel 4 --new`, 2 alive → spawns 2 (deficit already covers "at least one new").
   - `--parallel 4 --new`, 6 alive → spawns 1 (deficit 0, `--new` forces at least one fresh).
   - Enqueue emits correct number of queue events; returns correct positions.

4. **`daemon.test.ts`** — `trackerStub: true`, mocked Session:
   - Main loop claims → processes → marks done → claims again.
   - Empty queue → idle → wake event resumes loop.
   - 15-min keepalive fires healthCheck on all systems.
   - SIGINT: in-flight claim re-queued (soft) or failed (force).
   - Orphan recovery on startup re-queues stale claims.

### Integration tests (Commit B — separations + work-study)

5. **`tests/unit/workflows/separations/daemon-flow.test.ts`** — fully mocked Session:
   - `ensureDaemonsAndEnqueue` followed by `runWorkflowDaemon` processes the item.
   - Dashboard JSONL emits match today's `runSeparationBatch` shape byte-for-byte (per-item pending → running → done).

### Manual smoke (not automatable — requires real Duo)

- Fresh run `npm run separation 3939` → daemon spawns → 4 Duos → doc processes → daemon stays alive.
- `npm run separation 3940` in a second terminal → enqueue-only (no Duo) → processes.
- `npm run separation:status` → shows 1 daemon, queue depth 0.
- `npm run separation 3941 3942 --parallel 2` → spawns 1 extra daemon (4 more Duos) → both process in parallel.
- `npm run separation:stop` → soft stop; daemons exit after finishing in-flight.
- Kill daemon with `kill -9` → verify next enqueue cleans the lockfile and spawns fresh.
- Leave daemon idle >15 min → verify keepalive log line; test with UCPath that would've session-expired → verify re-auth succeeds.

## Risks

- **Complexity of filesystem-level coordination.** Directory-mutex, atomic renames, PID probes — not rocket science but easy to get subtle bugs in. Heavy unit-test emphasis mitigates. Every primitive has a dedicated unit test.
- **`fs.watch` not used, but polling isn't either.** Wake notifications go through HTTP `POST /wake`; daemons don't poll the queue file. If a wake POST is lost (network flake? localhost doesn't really have this, but), the 15-min keepalive picks it up — worst case latency is 15 min. For CLI-driven workflows, if a user enqueues and nothing happens for more than a few seconds, they can just re-enqueue or `:status`. Acceptable.
- **Browser session longevity.** The kernel's `loginWithRetry` handles re-auth, but we haven't stress-tested 6-hour-idle sessions. The 15-min keepalive's `healthCheck` + re-auth is the defense. If real-world Kuali / Kronos / UCPath session handling has a quirk we don't know about, first round of daemon use will surface it. Mitigation: prominent `log.error` + auth-degraded state so operator knows to `:stop` + respawn.
- **Detached spawn cross-platform.** Node `child_process.spawn({ detached: true })` + `child.unref()` works identically on macOS and Linux. Windows has weirder semantics; we don't support it (project is darwin-only per user env).
- **Two simultaneous terminals both spawning a daemon.** Benign (they both succeed, end up with 2 daemons). Documented.
- **Log file growth.** `.tracker/daemons/{workflow}-*.log` grows while daemon runs. V1: no rotation. Mitigation: existing `npm run clean:tracker` prunes `.tracker/` files >7 days. Daemons live days max in practice. Log rotation is a documented follow-up.
- **Existing tests referencing `runSeparationBatch` behavior.** All existing tests that call `runSeparationBatch` / `runOnboardingBatch` / etc. directly continue to work — we don't modify those functions. Only the CLI-level handlers switch to daemon mode.

## Rollout

### Commit A — Kernel infrastructure

Files: `src/core/daemon-{registry,queue,types,client,}.ts` + `src/core/index.ts` re-exports + unit tests + root CLAUDE.md + `src/core/CLAUDE.md` + `src/workflows/CLAUDE.md` (conversion template section).

### Commit B — Workflow CLI adapters (separations + work-study)

Files: `src/workflows/separations/workflow.ts` (add `runSeparationCli`), `src/workflows/work-study/workflow.ts` (add `runWorkStudyCli`), `src/workflows/separations/index.ts`, `src/workflows/work-study/index.ts`, `src/workflows/separations/CLAUDE.md`, `src/workflows/work-study/CLAUDE.md`, integration tests.

### Commit C — CLI entry point + daemon entry

Files: `src/cli.ts` (rewrite `separation` + `work-study` commands, add `:attach` / `:stop` / `--daemon-status` subcommands via a generic factory), `src/cli-daemon.ts` (new daemon entry point), `package.json` (new npm scripts).

### Commit D — Documentation polish (same session if time permits)

Verify every touched CLAUDE.md is internally consistent and reflects post-change reality. Update root CLAUDE.md "Commands" section with daemon-mode examples.

### Documented follow-ups (NOT this session)

- Convert onboarding, emergency-contact, kronos-reports, eid-lookup CLI adapters. Pattern is identical — 30 min per workflow.
- Dashboard queue-add UI: adds a "+" button in `QueuePanel.tsx` that POSTs directly to a daemon's HTTP port. Backend proxy unnecessary — dashboard HTML can `fetch('http://127.0.0.1:<port>/...')` from the same origin it already hits.
- Log rotation for `.tracker/daemons/*.log`.
- Queue compaction under load (non-quiescent).

## Lessons-Learned anchor

Future sessions should know:

- Daemon-mode is the default CLI path; existing batch/pool modes are still callable directly but not used by CLI.
- `src/core/daemon-queue.ts` is the ONLY place that appends to / claims from the queue JSONL. Never inline that.
- Every new kernel workflow gets daemon-mode for free by using the `ensureDaemonsAndEnqueue` adapter template in `src/workflows/CLAUDE.md`.
- Dashboard integration adds a queue-UI panel later; all the plumbing required is already on each daemon's HTTP port.
