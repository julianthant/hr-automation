import { randomUUID } from 'node:crypto'
import { findAliveDaemons, spawnDaemon } from './daemon-registry.js'
import { enqueueItems } from './daemon-queue.js'
import { deriveItemId } from './workflow.js'
import { log } from '../utils/log.js'
import type { Daemon, DaemonFlags, EnqueueResult } from './daemon-types.js'
import type { RegisteredWorkflow } from './types.js'

/**
 * Optional caller-provided callback fired once per input AFTER the enqueue
 * event has been appended but BEFORE any spawn/auth work begins. Mirrors
 * `RunOpts.onPreEmitPending` from `runWorkflowBatch`: lets CLI adapters emit
 * a `pending` tracker row per item so the dashboard's queue panel populates
 * instantly (instead of waiting for the daemon to finish Duo + claim + emit
 * its own pending row). The runId passed here matches the enqueue event's
 * pre-assigned runId, so downstream tracker rows (running/done) pair 1:1
 * with the pre-emitted row.
 */
export type OnPreEmitPending<TData> = (input: TData, runId: string) => void

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
     * Caller-provided hook fired per item IMMEDIATELY after the enqueue event
     * is written, BEFORE any spawn/auth work. Lets CLI adapters emit a
     * `pending` tracker row so the dashboard queue panel populates instantly.
     * Exceptions thrown by this callback are caught and logged so a bad
     * adapter can't break the enqueue flow.
     */
    onPreEmitPending?: OnPreEmitPending<TData>
    /**
     * Optional item-ID deriver. Defaults to the kernel's built-in `deriveItemId`
     * (walks top-level `emplId` / `docId` / `email`) with a UUID fallback.
     * Use this when the input's identifier is nested (e.g.
     * `input.employee.employeeId`) or follows a composite shape (e.g.
     * `p{NN}-{emplId}`). The returned id is used both as the queue item id
     * and the `runId`-pairing anchor for `onPreEmitPending`.
     */
    deriveItemId?: (input: TData) => string
  } = {},
): Promise<EnqueueResult> {
  const { trackerDir, quiet, onPreEmitPending } = opts

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

  // ---------------------------------------------------------------------
  // Step 1: enqueue FIRST (before spawn). Queue append is a file write and
  // takes <10ms — the dashboard and any alive daemon see the items
  // immediately. Daemons that need to be spawned will claim from the
  // already-populated queue as soon as their auth chain finishes.
  //
  // This order was flipped as of 2026-04-22: the prior order was
  // `spawn → enqueue → wake`, which (a) made the CLI wait up to 5min for
  // Duo approval before writing anything to the queue, and (b) hid all the
  // items from the dashboard queue panel during that wait. The new order
  // is `enqueue → wake alive → spawn new → (newly-spawned daemons self-claim)`.
  // ---------------------------------------------------------------------

  const idFn = (input: TData, idx: number): string => {
    if (opts.deriveItemId) return opts.deriveItemId(input)
    const fallback = `${Date.now()}-${idx}-${randomUUID().slice(0, 8)}`
    return deriveItemId(input, fallback)
  }

  const enqueued = await enqueueItems(wf.config.name, inputs, idFn, trackerDir)

  if (onPreEmitPending) {
    for (let i = 0; i < inputs.length; i++) {
      try {
        onPreEmitPending(inputs[i], enqueued[i].runId)
      } catch (err) {
        log.warn(
          `ensureDaemonsAndEnqueue: onPreEmitPending threw for '${enqueued[i].id}': ${
            err instanceof Error ? err.message : String(err)
          }`,
        )
      }
    }
  }

  if (!quiet) {
    for (const { id, position } of enqueued) {
      log.success(`Queued ${wf.config.name} '${id}' (position ${position}).`)
    }
  }

  // ---------------------------------------------------------------------
  // Step 2: wake every ALREADY-ALIVE daemon so they re-check the queue on
  // the next event-loop tick. Fire-and-forget: a dead daemon's wake fails
  // silently, and the newly-appended item will still be claimed by any
  // other alive daemon (or a newly-spawned one below).
  // ---------------------------------------------------------------------
  await Promise.all(
    alive.map((d) =>
      fetch(`http://127.0.0.1:${d.port}/wake`, { method: 'POST' }).catch(() => {
        /* ignore — wake is best-effort */
      }),
    ),
  )

  // ---------------------------------------------------------------------
  // Step 3: spawn additional daemons if needed (serial — Duo can't be
  // approved in parallel). Each new daemon's claim loop starts naturally
  // after Session.launch, so we don't need to wake them explicitly.
  //
  // We await the spawns so the CLI only exits after every requested daemon
  // is at least lockfile-registered — gives callers a chance to see spawn
  // failures instead of the process silently returning while items sit
  // un-processable in the queue.
  // ---------------------------------------------------------------------
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

  if (!quiet) {
    log.step(`${daemons.length} daemon(s) processing.`)
  }

  return { enqueued, daemons }
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
