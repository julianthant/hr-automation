import { randomUUID, type UUID } from 'node:crypto'
import { findAliveDaemons, killOrphanedChromiumProcesses, spawnDaemon } from './daemon-registry.js'
import { enqueueItems } from './daemon-queue.js'
import { deriveItemId } from './workflow.js'
import { log } from '../utils/log.js'
import type { Daemon, DaemonFlags, EnqueueResult } from './daemon-types.js'
import type { RegisteredWorkflow } from './types.js'

/**
 * Optional caller-provided callback fired once per input IMMEDIATELY at the
 * top of `ensureDaemonsAndEnqueue`, BEFORE any spawn or queue-file write.
 * Lets CLI adapters / HTTP handlers emit a `pending` tracker row per item
 * so the dashboard's queue panel populates instantly (in <100ms) — even
 * during the 5-10s lockfile-registration window of a fresh daemon spawn.
 *
 * The runId passed here is pre-assigned (UUID v4) and is forwarded to the
 * queue file's `enqueue` event verbatim, so downstream `claim`/`running`/
 * `done`/`failed` events pair 1:1 with this pre-emitted row.
 *
 * Pre-emit timing changed 2026-04-28 (Cluster A spec). Prior versions
 * fired this AFTER queue write; the reorder is what lets the orphan sweep
 * tighten to 0 grace — every queue-file entry now has a registered daemon
 * by construction.
 */
export type OnPreEmitPending<TData> = (input: TData, runId: string) => void

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
export type OnPreEmitFailed<TData> = (input: TData, runId: string, error: string) => void

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
 * The ONE function every daemon-mode CLI adapter calls.
 *
 * Discovers alive daemons, validates inputs, spawns additional daemons as
 * dictated by flags, appends enqueue events to the shared queue, and wakes
 * every alive daemon via `POST /wake`.
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
 * Spawns are serialized: Duo cannot be approved in parallel, so back-to-back
 * spawns match the existing `--parallel` pool mode behaviour where each
 * worker's auth chain runs sequentially.
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
     * function, BEFORE any spawn or queue-file write. Lets CLI adapters /
     * HTTP handlers emit a `pending` tracker row so the dashboard queue panel
     * populates within ~100ms — even during a 5-10s spawn-lockfile window.
     * Exceptions thrown by this callback are caught and logged so a bad
     * adapter can't break the enqueue flow.
     */
    onPreEmitPending?: OnPreEmitPending<TData>
    /**
     * Caller-provided hook fired per item when pre-emit succeeded but spawn
     * (or queue-write) subsequently failed. Lets the caller mark the
     * stranded `pending` tracker row as `failed` so the dashboard doesn't
     * show ghost entries.
     */
    onPreEmitFailed?: OnPreEmitFailed<TData>
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
  } = {},
): Promise<EnqueueResult> {
  const { trackerDir, quiet, onPreEmitPending, onPreEmitFailed, parentRunId } = opts

  if (inputs.length === 0) {
    throw new Error('ensureDaemonsAndEnqueue: inputs[] must not be empty')
  }

  // Fail-fast input validation via workflow schema — consistent with runWorkflow.
  for (const input of inputs) {
    try {
      wf.config.schema.parse(input)
    } catch (err) {
      throw new Error(`validation error: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  const alive = await findAliveDaemons(wf.config.name, trackerDir)
  const spawnCount = computeSpawnPlan(alive.length, flags)

  const idFn = (input: TData, idx: number): string => {
    if (opts.deriveItemId) return opts.deriveItemId(input)
    const fallback = `${Date.now()}-${idx}-${randomUUID().slice(0, 8)}`
    return deriveItemId(input, fallback)
  }

  // ---------------------------------------------------------------------
  // Order (2026-04-28 reorder per Cluster A spec):
  //   1. Pre-assign runIds for every input
  //   2. FIRE onPreEmitPending (dashboard sees pending rows in <100ms)
  //   3. Cleanup orphan chromium processes if we're about to spawn (so
  //      a fresh daemon doesn't pile chrome on top of leaked tabs from
  //      a SIGKILLed predecessor)
  //   4. Spawn new daemons (await lockfile registration, ~5-10s)
  //   5. Wake every alive daemon (now includes spawned ones)
  //   6. Append items to queue file — ONLY after a daemon is registered,
  //      so the orphan sweep can be aggressive (5s/0-grace) without
  //      false-positives during a spawn-in-flight window.
  //
  // Failure handling: if step 4 throws, we fire onPreEmitFailed for
  // every pre-emitted runId so the caller can mark the stranded
  // `pending` tracker rows as `failed`. The queue file is never touched
  // on this path → the orphan sweep doesn't see anything to fail.
  // ---------------------------------------------------------------------

  // Step 1: pre-assign runIds. Generated synchronously so step 2 has them.
  const ids = inputs.map(idFn)
  const runIds: UUID[] = inputs.map(() => randomUUID())

  // Step 2: pre-emit (dashboard pending rows visible immediately).
  if (onPreEmitPending) {
    for (let i = 0; i < inputs.length; i++) {
      try {
        onPreEmitPending(inputs[i], runIds[i])
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
  // can mark the pending rows as failed (no queue-file entry exists yet).
  const handleSpawnFailure = (err: unknown): never => {
    const message = err instanceof Error ? err.message : String(err)
    if (onPreEmitFailed) {
      for (let i = 0; i < inputs.length; i++) {
        try {
          onPreEmitFailed(inputs[i], runIds[i], message)
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
    // Step 3: kill orphan chromium before spawning. Cheap no-op when
    // spawnCount === 0 (no orphans expected to interfere) — but always
    // worth doing once per session to clean up stale state.
    if (spawnCount > 0) {
      try {
        const killed = await killOrphanedChromiumProcesses()
        if (killed > 0 && !quiet) {
          log.step(`[Daemon] Killed ${killed} orphaned Chromium process(es) before spawn.`)
        }
      } catch (err) {
        // Non-fatal: orphan cleanup is best-effort. A failure here would
        // typically be a missing pgrep/ps binary; the daemon spawn is
        // still attempted so the user isn't blocked.
        log.warn(
          `[Daemon] Orphan-chromium cleanup failed (continuing): ${
            err instanceof Error ? err.message : String(err)
          }`,
        )
      }
    }

    // Step 4: spawn additional daemons if needed (serial — Duo can't be
    // approved in parallel). After this step every requested daemon is
    // lockfile-registered (spawnDaemon blocks until /whoami responds).
    if (!quiet && spawnCount > 0) {
      const why =
        flags.parallel !== undefined
          ? flags.new
            ? `--parallel ${flags.parallel} --new (${alive.length} alive)`
            : `--parallel ${flags.parallel} (${alive.length} alive)`
          : flags.new
            ? `--new (${alive.length} alive)`
            : `no alive daemons`
      log.step(`[Daemon] Spawning ${spawnCount} new ${wf.config.name} daemon(s) (${why}).`)
      log.step('[Daemon] Approve Duo(s) in the new browser window(s); this takes 30s–2min.')
    }

    const spawned: Daemon[] = []
    for (let i = 0; i < spawnCount; i++) {
      const d = await spawnDaemon(wf.config.name, trackerDir)
      spawned.push(d)
    }

    const daemons = [...alive, ...spawned]
    if (daemons.length === 0) {
      throw new Error('ensureDaemonsAndEnqueue: expected at least one daemon after spawn phase')
    }

    // Step 5: wake every alive daemon (alive ∪ spawned). Fire-and-forget;
    // a wake failure on one daemon doesn't block the others.
    await Promise.all(
      daemons.map((d) =>
        fetch(`http://127.0.0.1:${d.port}/wake`, { method: 'POST' }).catch(() => {
          /* ignore — wake is best-effort */
        }),
      ),
    )

    // Step 6: write queue file. Now safe — at least one daemon is registered
    // for this workflow, so the orphan sweep won't false-positive on these
    // items in the spawn-in-flight window.
    const enqueued = await enqueueItems(
      wf.config.name,
      inputs,
      idFn,
      trackerDir,
      runIds,
      parentRunId ? inputs.map(() => parentRunId) : undefined,
    )

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
  await Promise.all(
    alive.map((d) =>
      fetch(`http://127.0.0.1:${d.port}/stop`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ force }),
      }).catch(() => {
        /* ignore — the daemon may already be tearing down */
      }),
    ),
  )
  return alive.length
}
