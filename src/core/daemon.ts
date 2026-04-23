import { randomUUID } from 'node:crypto'
import { hostname } from 'node:os'
import { createServer, type Server } from 'node:http'
import { unlinkSync } from 'node:fs'
import type { RegisteredWorkflow } from './types.js'
import { Session } from './session.js'
import { runOneItem } from './workflow.js'
import { withBatchLifecycle } from './batch-lifecycle.js'
import { log } from '../utils/log.js'
import {
  lockfilePath,
  randomInstanceId,
  writeLockfile,
  findAliveDaemons,
  ensureDaemonsDir,
} from './daemon-registry.js'
import {
  claimNextItem,
  markItemDone,
  markItemFailed,
  unclaimItem,
  recoverOrphanedClaims,
  readQueueState,
} from './daemon-queue.js'
import type { DaemonLockfile } from './daemon-types.js'

export interface DaemonOpts {
  trackerDir?: string
  /** Test-only override for `Session.launch` so we don't open real browsers. */
  sessionLaunchFn?: typeof Session.launch
  /** Test-only: cap the idle wait window (default 15min). */
  idleTimeoutMs?: number
}

const DEFAULT_IDLE_MS = 15 * 60 * 1000

/**
 * Long-running daemon loop. Must be invoked from a DETACHED process via
 * `src/cli-daemon.ts`. Owns:
 *   - HTTP server for /whoami /status /wake /stop
 *   - Lockfile write + cleanup on shutdown
 *   - Session lifetime (one `Session.launch` on startup, `session.close`
 *     on shutdown)
 *   - Shared-queue claim loop with 15-min keepalive + orphan recovery
 *   - SIGINT/SIGTERM handlers — in-flight item re-queued via `unclaim`
 *     (reason: 'sigint-soft') on graceful stop, or marked failed on
 *     force stop
 *
 * Does NOT install its own SIGINT handler via withBatchLifecycle —
 * we pass `ownSigint: false` so batch-lifecycle skips its
 * process.exit(130) and lets us run our own teardown first.
 */
export async function runWorkflowDaemon<TData, TSteps extends readonly string[]>(
  wf: RegisteredWorkflow<TData, TSteps>,
  opts: DaemonOpts = {},
): Promise<void> {
  const trackerDir = opts.trackerDir
  const launchFn = opts.sessionLaunchFn ?? Session.launch.bind(Session)
  const idleTimeoutMs = opts.idleTimeoutMs ?? DEFAULT_IDLE_MS

  ensureDaemonsDir(trackerDir)
  const instanceId = randomInstanceId(wf.config.name)

  let wakeResolve: (() => void) | null = null
  let shutdownResolve: (() => void) | null = null
  let forceShutdown = false
  let shuttingDown = false
  let inFlight: { itemId: string; runId: string } | null = null
  let queueDepthCache = 0
  let lastActivity = Date.now()

  const server: Server = createServer((req, res) => {
    const url = req.url ?? '/'
    if (req.method === 'GET' && url === '/whoami') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          workflow: wf.config.name,
          instanceId,
          pid: process.pid,
          version: 1,
        }),
      )
      return
    }
    if (req.method === 'GET' && url === '/status') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          workflow: wf.config.name,
          instanceId,
          queueDepth: queueDepthCache,
          inFlight: inFlight?.itemId ?? null,
          lastActivity: new Date(lastActivity).toISOString(),
        }),
      )
      return
    }
    if (req.method === 'POST' && url === '/wake') {
      wakeResolve?.()
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"ok":true}')
      return
    }
    if (req.method === 'POST' && url === '/stop') {
      let body = ''
      req.on('data', (c) => {
        body += c
      })
      req.on('end', () => {
        try {
          const parsed = body ? (JSON.parse(body) as { force?: boolean }) : {}
          forceShutdown = !!parsed.force
        } catch {
          /* ignore */
        }
        shuttingDown = true
        shutdownResolve?.()
        wakeResolve?.()
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end('{"ok":true}')
      })
      return
    }
    res.writeHead(404)
    res.end()
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0

  const lock: DaemonLockfile = {
    workflow: wf.config.name,
    instanceId,
    pid: process.pid,
    port,
    startedAt: new Date().toISOString(),
    hostname: hostname(),
    version: 1,
  }
  const lockPath = lockfilePath(wf.config.name, instanceId, trackerDir)
  writeLockfile(lock, lockPath)
  log.step(
    `[Daemon ${wf.config.name}/${instanceId}] listening on 127.0.0.1:${port} (pid=${process.pid})`,
  )

  const sigHandler = (sig: string): void => {
    log.warn(`[Daemon ${wf.config.name}/${instanceId}] received ${sig}; shutting down`)
    shuttingDown = true
    shutdownResolve?.()
    wakeResolve?.()
  }
  const onSigint = (): void => sigHandler('SIGINT')
  const onSigterm = (): void => sigHandler('SIGTERM')
  process.on('SIGINT', onSigint)
  process.on('SIGTERM', onSigterm)

  try {
    await withBatchLifecycle(
      {
        workflow: wf.config.name,
        systems: wf.config.systems,
        perItem: [],
        trackerDir,
        ownSigint: false,
      },
      async ({ instance, markTerminated, makeObserver }) => {
        const { observer, getAuthTimings } = makeObserver('1')
        const session = await launchFn(wf.config.systems, {
          authChain: wf.config.authChain,
          tiling: wf.config.tiling,
          observer,
        })
        // Awaiting each system's ready promise forces the interleaved
        // auth chain to complete before `getAuthTimings()` snapshots.
        // Rejections propagate to `withBatchLifecycle`'s catch so an
        // auth failure shuts the daemon down cleanly (lockfile unlink,
        // in-flight unclaim) instead of entering the claim loop with a
        // broken session and failing every queued item individually.
        for (const sys of wf.config.systems) {
          await session.page(sys.id)
        }
        const authTimings = wf.config.authSteps !== false ? getAuthTimings() : undefined

        // Orphan recovery on startup: include self in alive set so we don't
        // accidentally unclaim items we just claimed on a previous (crashed)
        // run in the tiny window before writing our own lockfile.
        const alive = await findAliveDaemons(wf.config.name, trackerDir)
        const aliveSet = new Set(alive.map((d) => d.instanceId))
        aliveSet.add(instanceId)
        const recovered = await recoverOrphanedClaims(wf.config.name, aliveSet, trackerDir)
        if (recovered > 0) {
          log.step(`[Daemon ${instanceId}] recovered ${recovered} orphan claim(s)`)
        }

        try {
          while (!shuttingDown) {
            const state = await readQueueState(wf.config.name, trackerDir)
            queueDepthCache = state.queued.length

            const item = await claimNextItem(
              wf.config.name,
              instanceId,
              trackerDir,
            ).catch((e) => {
              log.warn(
                `[Daemon ${instanceId}] claim error: ${e instanceof Error ? e.message : String(e)}`,
              )
              return null
            })

            if (item) {
              const runId = item.runId ?? randomUUID()
              inFlight = { itemId: item.id, runId }
              lastActivity = Date.now()
              const r = await runOneItem({
                wf,
                session,
                item: item.input as TData,
                itemId: item.id,
                runId,
                trackerDir,
                callerPreEmits: false,
                preAssignedInstance: instance,
                authTimings,
              })
              markTerminated(runId)
              if (r.ok) {
                await markItemDone(wf.config.name, item.id, runId, trackerDir)
              } else {
                await markItemFailed(wf.config.name, item.id, r.error, runId, trackerDir)
              }
              inFlight = null
              continue
            }

            // Idle: wait for wake OR keepalive OR shutdown.
            await new Promise<void>((resolve) => {
              wakeResolve = (): void => {
                wakeResolve = null
                resolve()
              }
              shutdownResolve = (): void => {
                shutdownResolve = null
                resolve()
              }
              setTimeout(() => {
                wakeResolve = null
                shutdownResolve = null
                resolve()
              }, idleTimeoutMs).unref()
            })

            if (shuttingDown) break

            // Keepalive tick: recover orphans + healthCheck each system.
            const aliveNow = await findAliveDaemons(wf.config.name, trackerDir)
            const aliveSetNow = new Set(aliveNow.map((d) => d.instanceId))
            aliveSetNow.add(instanceId)
            await recoverOrphanedClaims(wf.config.name, aliveSetNow, trackerDir)

            for (const sys of wf.config.systems) {
              try {
                const ok = await session.healthCheck(sys.id)
                if (!ok) {
                  log.warn(
                    `[Daemon ${instanceId}] healthCheck(${sys.id}) failed — next claim may re-auth`,
                  )
                }
              } catch (e) {
                log.warn(
                  `[Daemon ${instanceId}] healthCheck(${sys.id}) error: ${
                    e instanceof Error ? e.message : String(e)
                  }`,
                )
              }
            }
          }
        } finally {
          if (inFlight) {
            if (forceShutdown) {
              await markItemFailed(
                wf.config.name,
                inFlight.itemId,
                'interrupted',
                inFlight.runId,
                trackerDir,
              )
            } else {
              await unclaimItem(wf.config.name, inFlight.itemId, 'sigint-soft', trackerDir)
            }
            markTerminated(inFlight.runId)
            inFlight = null
          }
          try {
            await session.close()
          } catch {
            /* best-effort */
          }
        }
      },
    )
  } finally {
    process.off('SIGINT', onSigint)
    process.off('SIGTERM', onSigterm)
    try {
      unlinkSync(lockPath)
    } catch {
      /* best-effort */
    }
    await new Promise<void>((resolve) => server.close(() => resolve()))
    log.step(`[Daemon ${wf.config.name}/${instanceId}] exited cleanly`)
  }
}
