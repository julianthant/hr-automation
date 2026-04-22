import { randomUUID } from 'node:crypto'
import { findAliveDaemons, spawnDaemon } from './daemon-registry.js'
import { enqueueItems } from './daemon-queue.js'
import { deriveItemId } from './workflow.js'
import { log } from '../utils/log.js'
import type { Daemon, DaemonFlags, EnqueueResult } from './daemon-types.js'
import type { RegisteredWorkflow } from './types.js'

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
  opts: { trackerDir?: string; quiet?: boolean } = {},
): Promise<EnqueueResult> {
  const { trackerDir, quiet } = opts

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
    // Sequential: Duo cannot be approved in parallel reliably.
    const d = await spawnDaemon(wf.config.name, trackerDir)
    spawned.push(d)
  }

  const daemons = [...alive, ...spawned]
  if (daemons.length === 0) {
    throw new Error('ensureDaemonsAndEnqueue: expected at least one daemon after spawn phase')
  }

  const idFn = (input: TData, idx: number): string => {
    const fallback = `${Date.now()}-${idx}-${randomUUID().slice(0, 8)}`
    return deriveItemId(input, fallback)
  }

  const enqueued = await enqueueItems(wf.config.name, inputs, idFn, trackerDir)

  // Fire-and-forget wake — best-effort, ignore failures. Empty-queue daemons
  // resume their claim loop on the next event-loop tick; busy daemons naturally
  // re-check the queue when they finish their current item.
  await Promise.all(
    daemons.map((d) =>
      fetch(`http://127.0.0.1:${d.port}/wake`, { method: 'POST' }).catch(() => {
        /* ignore — wake is best-effort */
      }),
    ),
  )

  if (!quiet) {
    for (const { id, position } of enqueued) {
      log.success(`Queued ${wf.config.name} '${id}' (position ${position}).`)
    }
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
