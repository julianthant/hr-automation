import { randomUUID, type UUID } from 'node:crypto'
import { filterDaemonsNotShuttingDown, findAliveDaemons, invalidateAliveDaemonsCache, killOrphanedChromiumProcesses, spawnDaemon } from './registry.js'
import { enqueueItems } from './queue.js'
import { deriveItemId, splitPrefilled } from '../kernel/workflow.js'
import { log } from '../../utils/log.js'
import type { Daemon, DaemonFlags, EnqueueResult } from './types.js'
import type { RegisteredWorkflow } from '../kernel/types.js'

/**
 * Optional caller-provided callback fired once per input IMMEDIATELY at the
 * top of `ensureDaemonsAndEnqueue`, BEFORE any spawn or task enqueue.
 * Lets internal adapters / HTTP handlers emit a `pending` tracker row per item
 * so the dashboard's queue panel populates instantly (in <100ms) — even
 * during the 5-10s lockfile-registration window of a fresh daemon spawn.
 *
 * The runId passed here is pre-assigned (UUID v4) and is written into the
 * SQLite task attempt plus JSONL enqueue audit, so downstream
 * `claim`/`running`/`done`/`failed` events pair 1:1 with this pre-emitted row.
 *
 * Pre-emit timing changed 2026-04-28 (Cluster A spec). Prior versions
 * fired this AFTER queue write; the reorder is what lets the orphan sweep
 * tighten to 0 grace — every queued task now has a registered daemon
 * by construction.
 */
export type OnPreEmitPending<TData> = (
  input: TData,
  runId: string,
  parentRunId: string | undefined,
  itemId: string,
) => void

/**
 * Optional caller-provided callback fired once per input when pre-emit
 * succeeded but spawn-or-enqueue subsequently failed. Lets the caller
 * mark stranded `pending` tracker rows as `failed` so the dashboard
 * doesn't show ghost entries that no daemon will ever process.
 *
 * Fired only for inputs whose `onPreEmitPending` callback already ran;
 * if pre-emit itself threw, the contract assumes the caller didn't write
 * the row to begin with and there's nothing to fail.
 */
export type OnPreEmitFailed<TData> = (input: TData, runId: string, error: string, itemId: string) => void

export interface PreparedDaemonEnqueueItem<TData> {
  input: TData
  itemId: string
  runId: string
  parentRunId?: string
}

/**
 * Pure spawn-math helper. Given the current alive-daemon count and the
 * user's flags, return how many new daemons to spawn. Extracted so the
 * routing rule can be unit-tested without mocking `spawnDaemon`.
 *
 * Rule:
 *   desired  = flags.parallel ?? 1
 *   deficit  = max(0, desired - aliveCount)
 *   spawnCount = flags.new ? max(1, deficit) : deficit
 *
 * `flags.new` guarantees ≥1 fresh daemon; `flags.parallel=N` guarantees
 * ≥N daemons alive after the call returns.
 */
export function computeSpawnPlan(aliveCount: number, flags: DaemonFlags): number {
  const desired = flags.parallel ?? 1
  const deficit = Math.max(0, desired - aliveCount)
  return flags.new ? Math.max(1, deficit) : deficit
}

/**
 * Per-workflow in-process serialization of the daemon discover→spawn
 * critical section.
 *
 * Without it, two near-simultaneous enqueues for the same workflow — e.g.
 * approving two OCR documents in quick succession, each delegating to
 * oath-signature, or two rapid dashboard Run clicks — both run
 * `findAliveDaemons` before either's `spawnDaemon` has registered a
 * lockfile, both observe 0 alive, and both spawn a daemon. That is the
 * duplicate "<Workflow> 1 / <Workflow> 2" bug.
 *
 * Callers for the same `(trackerDir, workflow)` key queue: the second
 * caller's `fn` runs only after the first's settles, so when it
 * re-discovers it sees the daemon the first caller just spawned and reuses
 * it instead of spawning a duplicate.
 *
 * The stored chain tail never rejects, so one failed spawn doesn't wedge
 * the queue for the workflow. The map entry self-deletes once its chain
 * drains, keeping the map bounded.
 */
const daemonSpawnChains = new Map<string, Promise<unknown>>()

function daemonSpawnLockKey(workflow: string, trackerDir?: string): string {
  // NUL separator (matches registry's aliveDaemonsCacheKey) -- can't appear
  // in a path or workflow name, so distinct inputs never collide.
  return `${trackerDir ?? ''}\u0000${workflow}`
}

function withDaemonSpawnLock<T>(
  workflow: string,
  trackerDir: string | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  const key = daemonSpawnLockKey(workflow, trackerDir)
  const prev = daemonSpawnChains.get(key) ?? Promise.resolve()
  // Run fn once prev settles — onFulfilled AND onRejected both run fn, so a
  // failed predecessor spawn still releases the next caller.
  const result = prev.then(fn, fn)
  // Tail swallows both outcomes so the next caller's `prev` never rejects.
  const tail = result.then(
    () => {},
    () => {},
  )
  daemonSpawnChains.set(key, tail)
  void tail.then(() => {
    if (daemonSpawnChains.get(key) === tail) daemonSpawnChains.delete(key)
  })
  return result
}

/**
 * Active daemon spawn implementation. Indirected through a module-level
 * binding so unit tests can exercise the spawn-dedup path without launching
 * a real subprocess — see `__setSpawnDaemonImplForTests`.
 */
type SpawnDaemonFn = (workflow: string, trackerDir?: string) => Promise<Daemon>
let spawnDaemonImpl: SpawnDaemonFn = spawnDaemon

/** Test-only: override the daemon spawn implementation. Pass `null` to restore. */
export function __setSpawnDaemonImplForTests(fn: SpawnDaemonFn | null): void {
  spawnDaemonImpl = fn ?? spawnDaemon
}

/** Test-only: clear the per-workflow spawn-lock chains between cases. */
export function __resetDaemonSpawnLocksForTests(): void {
  daemonSpawnChains.clear()
}

export async function wakeDaemons(daemons: Daemon[]): Promise<void> {
  await Promise.all(
    daemons.map(async (d) => {
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), 2_000)
      try {
        await fetch(`http://127.0.0.1:${d.port}/wake`, {
          method: 'POST',
          signal: ctrl.signal,
        })
      } catch {
        /* ignore — wake is best-effort (incl. AbortError on timeout) */
      } finally {
        clearTimeout(timer)
      }
    }),
  )
}

/**
 * Wake the daemons of every workflow whose parent task a dependency release
 * just flipped `waiting_dependencies → queued` (E2E-017). The flip is pure
 * SQLite; an idle daemon's claim loop only re-polls on /wake or its 15-min
 * keepalive tick, so without this an oath-upload ticket whose signers
 * finished sat queued for up to that whole window. Best-effort and
 * fire-and-forget — never throws, wakes only already-alive daemons (a
 * released task with no daemon is the orphan sweep's concern, not a reason
 * to spawn here).
 */
export async function wakeDaemonsForReleasedParents(
  released: ReadonlyArray<{ taskId: string; workflow: string }>,
  trackerDir?: string,
): Promise<void> {
  const workflows = [...new Set(released.map((r) => r.workflow))]
  await Promise.all(
    workflows.map(async (workflow) => {
      try {
        const alive = await findAliveDaemons(workflow, trackerDir)
        await wakeDaemons(alive)
      } catch {
        /* best-effort */
      }
    }),
  )
}

/**
 * Ensure at least one daemon is alive for a workflow, then wake every alive
 * daemon. Used by enqueue paths and by retry paths that requeue an existing
 * SQLite task instead of inserting a new one through ensureDaemonsAndEnqueue.
 *
 * @param opts.skipWake - When `true`, skips the final `wakeDaemons` call.
 *   Use this when the caller will write task rows AFTER this function returns
 *   and wants to wake daemons only once those rows are visible in SQLite
 *   (i.e. `ensureDaemonsAndEnqueue` passes `skipWake: true` and fires its own
 *   post-enqueue wake so an idle daemon's re-poll finds claimable work).
 *   The default (`false`) wakes immediately — correct for requeue/retry paths
 *   where the task row already exists in SQLite before this call.
 */
export async function ensureDaemonsAvailable(
  workflow: string,
  flags: DaemonFlags = {},
  opts: { trackerDir?: string; quiet?: boolean; skipWake?: boolean } = {},
): Promise<Daemon[]> {
  const { trackerDir, quiet, skipWake = false } = opts
  const daemons = await withDaemonSpawnLock(workflow, trackerDir, async () => {
    invalidateAliveDaemonsCache(workflow, trackerDir)
    const aliveRaw = await findAliveDaemons(workflow, trackerDir)
    // A daemon that POSITIVELY reports `/whoami.shuttingDown` has exited its
    // claim loop and will never pick up another queued item — counting it as a
    // live worker makes computeSpawnPlan skip the spawn, so retried/enqueued
    // tasks wedge `queued` forever behind a zombie (2026-06-22). Plan and wake
    // against the claimable subset only; an unreachable-but-PID-alive daemon is
    // KEPT (no duplicate spawn for a momentarily-busy healthy daemon).
    const alive = await filterDaemonsNotShuttingDown(aliveRaw)
    const spawnCount = computeSpawnPlan(alive.length, flags)

    if (spawnCount > 0) {
      try {
        const killed = await killOrphanedChromiumProcesses()
        if (killed > 0 && !quiet) {
          log.step(`[Daemon] Killed ${killed} orphaned Chromium process(es) before spawn.`)
        }
      } catch (err) {
        log.warn(
          `[Daemon] Orphan-chromium cleanup failed (continuing): ${
            err instanceof Error ? err.message : String(err)
          }`,
        )
      }
    }

    if (!quiet && spawnCount > 0) {
      const why =
        flags.parallel !== undefined
          ? flags.new
            ? `--parallel ${flags.parallel} --new (${alive.length} alive)`
            : `--parallel ${flags.parallel} (${alive.length} alive)`
          : flags.new
            ? `--new (${alive.length} alive)`
            : `no alive daemons`
      log.step(`[Daemon] Spawning ${spawnCount} new ${workflow} daemon(s) (${why}).`)
      // Under HRAUTO_E2E_STUBS the spawned daemons run scripted handlers with
      // `systems: []` — no browser, no Duo — so the "approve Duo" prompt is a
      // lie (T3). Checked via the env directly (matching workflow-loaders.ts) to
      // avoid importing the heavy stub-workflows module here.
      if (process.env.HRAUTO_E2E_STUBS !== '1') {
        log.step('[Daemon] Approve Duo(s) in the new browser window(s); this takes 30s–2min.')
      }
    } else if (!quiet && alive.length > 0) {
      log.step(`[Daemon] Reusing ${alive.length} alive ${workflow} daemon(s); no spawn needed.`)
    }

    const spawned: Daemon[] = []
    for (let i = 0; i < spawnCount; i++) {
      const d = await spawnDaemonImpl(workflow, trackerDir)
      spawned.push(d)
      invalidateAliveDaemonsCache(workflow, trackerDir)
    }

    return [...alive, ...spawned]
  })

  if (daemons.length === 0) {
    throw new Error('ensureDaemonsAvailable: expected at least one daemon after spawn phase')
  }
  if (!skipWake) {
    await wakeDaemons(daemons)
  }
  return daemons
}

/**
 * The ONE function every daemon-mode enqueue path calls.
 *
 * Discovers alive daemons, validates inputs, spawns additional daemons as
 * dictated by flags, writes SQLite task rows plus JSONL audit events, and
 * wakes every alive daemon via `POST /wake`.
 *
 * Spawn math (final rule):
 *   const desired = flags.parallel ?? 1
 *   const deficit = max(0, desired - alive.length)
 *   spawnCount = flags.new ? max(1, deficit) : deficit
 *
 * Semantics:
 *   - `flags.new` guarantees at least one brand-new daemon after return.
 *   - `flags.parallel = N` guarantees at least N daemons alive after return.
 *   - No flags + ≥1 alive → enqueue only, no new daemon.
 *   - No flags + 0 alive → spawn 1, then enqueue.
 *
 * Discover + spawn is serialized per workflow via `withDaemonSpawnLock` so
 * two near-simultaneous enqueues for the same workflow can't both observe
 * "0 alive" and each spawn a daemon (the duplicate "<Workflow> 1 / 2" bug).
 * The second caller waits for the first's spawn to register, re-discovers,
 * and reuses it — spawnCount drops to 0.
 *
 * Spawns within a single call iterate serially, but `spawnDaemonImpl` resolves
 * once the child's lockfile + `/whoami` are up — which happens BEFORE the child
 * authenticates (lockfile is written pre-auth, daemon.ts). So the loop
 * serializes only lockfile REGISTRATION (the happens-before edge VS-003 needs
 * for instance-name allocation), NOT Duo: the N daemons authenticate in
 * PARALLEL — which is what keeps a multi-worker start near max(auth) instead of
 * sum(auth). Concurrent Duo is safe: in production each daemon shows its own
 * phone-push prompt (approved one at a time on the phone), and hands-off
 * WebAuthn (`HR_AUTOMATION_DUO_WEBAUTHN=1`) is cross-process-serialized by
 * `acquireDuoWebAuthnLock` (`.auth/duo-webauthn.lock`) so the shared signCount
 * file never races. Do NOT "fix" this by serializing on auth — that would make
 * an N-worker cold start take N×(Duo time).
 */
export async function ensureDaemonsAndEnqueue<TData, TSteps extends readonly string[]>(
  wf: RegisteredWorkflow<TData, TSteps>,
  inputs: TData[],
  flags: DaemonFlags = {},
  opts: {
    trackerDir?: string
    quiet?: boolean
    /**
     * Caller-provided hook fired per item IMMEDIATELY at the top of this
     * function, BEFORE any spawn or task enqueue. Lets internal adapters /
     * HTTP handlers emit a `pending` tracker row so the dashboard queue panel
     * populates within ~100ms — even during a 5-10s spawn-lockfile window.
     * Exceptions thrown by this callback are caught and logged so a bad
     * adapter can't break the enqueue flow.
     */
    onPreEmitPending?: OnPreEmitPending<TData>
    /**
     * Caller-provided hook fired per item when pre-emit succeeded but spawn
     * (or task enqueue) subsequently failed. Lets the caller mark the
     * stranded `pending` tracker row as `failed` so the dashboard doesn't
     * show ghost entries.
     */
    onPreEmitFailed?: OnPreEmitFailed<TData>
    /**
     * Batch-level hook fired after stable itemIds/runIds are assigned and
     * before pre-emitting pending rows, spawning daemons, or writing task
     * rows. If this throws, no task row or queue audit event is written.
     */
    onPreparedItems?: (items: Array<PreparedDaemonEnqueueItem<TData>>) => void | Promise<void>
    /**
     * Optional item-ID deriver. Defaults to the kernel's built-in `deriveItemId`
     * (walks top-level `emplId` / `docId` / `email`) with a UUID fallback.
     * Use this when the input's identifier is nested (e.g.
     * `input.employee.employeeId`) or follows a composite shape (e.g.
     * `p{NN}-{emplId}`). The returned id is used both as the queue item id
     * and the `runId`-pairing anchor for `onPreEmitPending`.
     */
    deriveItemId?: (input: TData) => string
    /**
     * Optional parent runId for delegation. When set, every queued item is
     * stamped with this parentRunId (single value fanned across all inputs),
     * so the daemon-side claim path forwards it into runOneItem and the
     * resulting tracker rows carry parentRunId. Used by delegation parents
     * (e.g. OCR's approve handler when fanning out oath-signature children
     * of an oath-upload parent).
     */
    parentRunId?: string
    /**
     * Caller-owned stable run ids for a durable dispatch manifest. Length must
     * match `inputs`. Replaying the same manifest then adopts the exact same
     * task rows instead of minting a second child set.
     */
    runIds?: ReadonlyArray<UUID>
    existingTaskPolicy?: 'adopt' | 'idempotent'
  } = {},
): Promise<EnqueueResult> {
  const { trackerDir, quiet, onPreEmitPending, onPreEmitFailed, onPreparedItems, parentRunId } = opts

  if (inputs.length === 0) {
    throw new Error('ensureDaemonsAndEnqueue: inputs[] must not be empty')
  }

  // Fail-fast input validation via workflow schema — consistent with runWorkflow.
  for (const input of inputs) {
    try {
      const { cleaned } = splitPrefilled(input)
      wf.config.schema.parse(cleaned)
    } catch (err) {
      throw new Error(`validation error: ${err instanceof Error ? err.message : String(err)}`, { cause: err })
    }
  }

  const idFn = (input: TData, idx: number): string => {
    // Derive the item id from the LOGICAL input only. `delegateTo*` wraps every
    // input with the kernel's `__runtimeOptions` channel (rowShape / rootCode /
    // rootTracePrefix) BEFORE this runs, so a caller's `deriveItemId` — often an
    // identity-keyed map (OCR verify / i9 / force-research key by
    // `JSON.stringify(input)`) — would see a shape it never built and miss the
    // lookup, yielding an empty id. An empty id makes the row invisible (the
    // tracker validator `isTrackerEntry` rejects it) AND collides in the
    // id-keyed dedupe. Strip the kernel channels first, mirroring the HTTP
    // enqueue path (`enqueue-dispatch.ts`), so derivation sees the same input
    // the caller shaped.
    const { cleaned } = splitPrefilled(input)
    const cleanedInput = cleaned as TData
    const derived = opts.deriveItemId
      ? opts.deriveItemId(cleanedInput)
      : wf.config.deriveItemId
        ? wf.config.deriveItemId(cleanedInput)
        : deriveItemId(cleanedInput, `${Date.now()}-${idx}-${randomUUID().slice(0, 8)}`)
    if (!derived) {
      // Fail loud: an empty item id silently strands the run as an invisible,
      // collision-prone row. Surface it at the enqueue boundary instead.
      throw new Error(
        `ensureDaemonsAndEnqueue: deriveItemId produced an empty id for workflow '${wf.config.name}' (input #${idx}). ` +
          `An empty item id yields rows the tracker validator rejects and the queue can't render — ` +
          `check the workflow's or caller's deriveItemId.`,
      )
    }
    return derived
  }

  // ---------------------------------------------------------------------
  // Order (2026-04-28 reorder per Cluster A spec; discover+spawn moved
  // under withDaemonSpawnLock 2026-05-22; wake moved AFTER enqueue 2026-06-13
  // ISS-001 — idle daemon must find tasks in SQLite when its claim loop fires):
  //   1. Pre-assign runIds for every input
  //   2. FIRE onPreEmitPending (dashboard sees pending rows in <100ms)
  //   3-4. withDaemonSpawnLock — serialized per workflow:
  //      a. Discover alive daemons (cache-bypassed inside the lock)
  //      b. Cleanup orphan chromium processes if we're about to spawn (so
  //         a fresh daemon doesn't pile chrome on top of leaked tabs from
  //         a SIGKILLed predecessor)
  //      c. Spawn new daemons (await lockfile registration, ~5-10s)
  //   5. Write SQLite task rows + JSONL enqueue audit — ONLY after a daemon is registered,
  //      so the orphan sweep can be aggressive (5s/0-grace) without
  //      false-positives during a spawn-in-flight window.
  //   6. Wake every alive daemon (now includes spawned ones) — AFTER the task
  //      rows are written so an idle daemon's claim loop finds claimable work.
  //
  // Failure handling: if the spawn step throws, we fire onPreEmitFailed for
  // every pre-emitted runId so the caller can mark the stranded
  // `pending` tracker rows as `failed`. No task row or queue audit event is
  // written on this path → the orphan sweep doesn't see anything to fail.
  // ---------------------------------------------------------------------

  // Step 1: pre-assign runIds. Generated synchronously so step 2 has them.
  const ids = inputs.map(idFn)
  if (opts.runIds && opts.runIds.length !== inputs.length) {
    throw new Error(
      `ensureDaemonsAndEnqueue: runIds length ${opts.runIds.length} does not match inputs length ${inputs.length}`,
    )
  }
  const runIds: UUID[] = opts.runIds ? [...opts.runIds] : inputs.map(() => randomUUID())

  if (onPreparedItems) {
    await onPreparedItems(
      inputs.map((input, i) => ({
        input,
        itemId: ids[i],
        runId: runIds[i],
        ...(parentRunId ? { parentRunId } : {}),
      })),
    )
  }

  // Step 2: pre-emit (dashboard pending rows visible immediately).
  if (onPreEmitPending && opts.existingTaskPolicy !== 'idempotent') {
    for (let i = 0; i < inputs.length; i++) {
      try {
        onPreEmitPending(inputs[i], runIds[i], parentRunId, ids[i])
      } catch (err) {
        log.warn(
          `ensureDaemonsAndEnqueue: onPreEmitPending threw for '${ids[i]}': ${
            err instanceof Error ? err.message : String(err)
          }`,
        )
      }
    }
  }

  // From here, any thrown error MUST notify onPreEmitFailed so the caller
  // can mark the pending rows as failed (no task row exists yet).
  const handleSpawnFailure = (err: unknown): never => {
    const message = err instanceof Error ? err.message : String(err)
    if (onPreEmitFailed && opts.existingTaskPolicy !== 'idempotent') {
      for (let i = 0; i < inputs.length; i++) {
        try {
          onPreEmitFailed(inputs[i], runIds[i], message, ids[i])
        } catch (cbErr) {
          log.warn(
            `ensureDaemonsAndEnqueue: onPreEmitFailed threw for '${ids[i]}': ${
              cbErr instanceof Error ? cbErr.message : String(cbErr)
            }`,
          )
        }
      }
    }
    throw err
  }

  try {
    // Steps 3-4: discover + spawn, serialized per workflow — skipWake so the
    // idle daemon's claim loop doesn't re-poll before task rows exist in SQLite.
    //
    // The discover→spawn window is a TOCTOU race: two near-simultaneous
    // enqueues for the same workflow would both run findAliveDaemons before
    // either's spawnDaemon registered a lockfile, both see 0 alive, and both
    // spawn — the duplicate "<Workflow> 1 / <Workflow> 2" daemon bug.
    // withDaemonSpawnLock serializes the section so the second caller
    // re-discovers AFTER the first's spawn registers, finds that daemon, and
    // computeSpawnPlan returns 0 for it — it reuses the existing daemon.
    const daemons = await ensureDaemonsAvailable(wf.config.name, flags, { trackerDir, quiet, skipWake: true })

    // Step 5: write task rows + queue audit. Now safe — at least one daemon is registered
    // for this workflow, so the orphan sweep won't false-positive on these
    // items in the spawn-in-flight window.
    // Use the pre-computed ids[] rather than idFn directly — idFn's fallback
    // embeds Date.now() so calling it again here would produce different
    // timestamps than the ids[] we already passed to onPreEmitPending.
    const enqueued = await enqueueItems(
      wf.config.name,
      inputs,
      (_input, i) => ids[i],
      trackerDir,
      runIds,
      parentRunId ? inputs.map(() => parentRunId) : undefined,
      opts.existingTaskPolicy,
    )

    // Idempotent approval recovery must discover whether each stable run id
    // already exists before emitting. Emit only genuinely new tasks; reused
    // terminal tasks retain their terminal projection and original audit.
    if (onPreEmitPending && opts.existingTaskPolicy === 'idempotent') {
      for (let i = 0; i < enqueued.length; i++) {
        if (enqueued[i].reused) continue
        try {
          onPreEmitPending(inputs[i], runIds[i], parentRunId, ids[i])
        } catch (err) {
          // The SQLite task commit above is authoritative. A projection
          // callback must never turn committed work into a reported enqueue
          // failure (OCR approval recovery would otherwise durably fail after
          // its stable child task already exists).
          log.warn(
            `ensureDaemonsAndEnqueue: post-commit onPreEmitPending threw for '${ids[i]}': ${
              err instanceof Error ? err.message : String(err)
            }`,
          )
        }
      }
    }

    // Step 6: wake daemons AFTER task rows are committed so an idle daemon's
    // claim loop finds claimable work on its first re-poll (ISS-001 fix).
    try {
      await wakeDaemons(daemons)
    } catch (err) {
      // Wake is a latency optimization after the durable enqueue commit. The
      // daemon poll loop will still discover the task, so preserve and return
      // the committed enqueue result.
      log.warn(
        `ensureDaemonsAndEnqueue: post-commit daemon wake failed for '${wf.config.name}': ${
          err instanceof Error ? err.message : String(err)
        }`,
      )
    }

    if (!quiet) {
      for (const { id, position } of enqueued) {
        log.success(`Queued ${wf.config.name} '${id}' (position ${position}).`)
      }
      log.step(`${daemons.length} daemon(s) processing.`)
    }

    return { enqueued, daemons }
  } catch (err) {
    return handleSpawnFailure(err)
  }
}

/**
 * Send a single daemon its `/stop`. Best-effort: the daemon may already be
 * tearing down. The daemon's own shutdown cleanup decides what happens to its
 * in-flight item (see `runDaemonShutdownCleanup`):
 *   - `reassign: true` (per-instance card stop) → hand the item to a surviving
 *     peer if one exists; fail it only when this is the last daemon.
 *   - `reassign: false` (workflow-scoped "stop all") → fail the in-flight item.
 * Caller is responsible for invalidating the alive-daemons cache afterward
 * when stopping a known set.
 */
export async function stopDaemon(daemon: Daemon, force: boolean, reassign = false): Promise<void> {
  // Manual AbortController + clearTimeout (not AbortSignal.timeout) so the
  // timer can't fire after the response completes — see "abort race" lesson.
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 5_000)
  try {
    await fetch(`http://127.0.0.1:${daemon.port}/stop`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ force, reassign }),
      signal: ctrl.signal,
    })
  } catch {
    /* ignore — the daemon may already be tearing down (incl. AbortError) */
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Soft-stop (or force-stop) every alive daemon for a workflow. Returns the
 * number of daemons we sent a /stop to. Callers can verify actual exit by
 * calling `findAliveDaemons` again — daemons may take seconds to drain.
 */
export async function stopDaemons(
  workflow: string,
  force: boolean,
  trackerDir?: string,
): Promise<number> {
  const alive = await findAliveDaemons(workflow, trackerDir)
  await Promise.all(alive.map((d) => stopDaemon(d, force)))
  invalidateAliveDaemonsCache(workflow, trackerDir)
  return alive.length
}
