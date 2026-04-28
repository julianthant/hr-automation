import { randomUUID } from 'node:crypto'
import { hostname } from 'node:os'
import { createServer, type Server } from 'node:http'
import { existsSync, unlinkSync } from 'node:fs'
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
import { emitItemStart, emitItemComplete } from '../tracker/session-events.js'
import { trackEvent } from '../tracker/jsonl.js'
import { buildTrackerDataForInput } from './enqueue-dispatch.js'

export interface DaemonOpts {
  trackerDir?: string
  /** Test-only override for `Session.launch` so we don't open real browsers. */
  sessionLaunchFn?: typeof Session.launch
  /** Test-only: cap the idle wait window (default 15min). */
  idleTimeoutMs?: number
  /** Test-only: cap the lockfile self-heal interval (default 10s). */
  lockHealIntervalMs?: number
}

const DEFAULT_IDLE_MS = 15 * 60 * 1000
const DEFAULT_LOCK_HEAL_MS = 10_000

/**
 * Daemon lifecycle phases — exposed via /status so CLI callers and
 * `npm run daemon-attach` can see what the daemon is doing at any moment.
 * Helps diagnose "browsers don't launch" (stuck in `authenticating`) vs
 * "queue isn't processing" (stuck in `idle` with queueDepth > 0) vs
 * "healthCheck hung" (stuck in `keepalive`).
 */
export type DaemonPhase =
  | 'launching'      // before session.launch
  | 'authenticating' // during session.launch + per-system page() waits
  | 'idle'           // claim loop, no item in flight
  | 'processing'     // runOneItem in progress
  | 'keepalive'      // 15min idle tick: healthCheck + orphan recovery
  | 'draining'       // shutdown, finishing in-flight teardown
  | 'exited'         // terminal

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
  let phase: DaemonPhase = 'launching'
  // Session reference exposed to the /status handler so the dashboard
  // (and the spawn pre-check in `daemon-registry`) can inventory which
  // chromium PIDs belong to this daemon. Assigned inside the
  // `withBatchLifecycle` body once `Session.launch` resolves; remains
  // null during `phase === 'launching'`. Force-stop paths can also read
  // it to SIGTERM/SIGKILL chromium directly.
  let activeSession: Session | null = null
  // Cooperative-cancel signal for the in-flight item. Set by the
  // POST /cancel-current handler when itemId+runId match the current
  // in-flight item; cleared after the next item starts. Stepper checks
  // this at every step boundary and throws CancelledError.
  let cancelTarget: { itemId: string; runId: string } | null = null
  const setPhase = (next: DaemonPhase): void => {
    if (phase === next) return
    const prev = phase
    phase = next
    log.step(`[Daemon ${wf.config.name}/${instanceId}] phase: ${prev} → ${next}`)
  }

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
          phase,
          queueDepth: queueDepthCache,
          inFlight: inFlight?.itemId ?? null,
          inFlightRunId: inFlight?.runId ?? null,
          lastActivity: new Date(lastActivity).toISOString(),
          // chromePids is best-effort: undefined during phase === 'launching'
          // (session not yet allocated) and on win32 (defaultLaunchOne's
          // pgrep diff returns no children). Spawn pre-check tolerates both.
          chromePids: activeSession ? Object.values(activeSession.chromePids) : [],
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
    if (req.method === 'POST' && url === '/cancel-current') {
      let body = ''
      req.on('data', (c) => {
        body += c
      })
      req.on('end', () => {
        // Body shape: `{ itemId: string, runId: string }`. Match against
        // the in-flight tuple to avoid cancelling an unrelated next item
        // if the user clicked stale UI. Any mismatch → 409.
        let parsed: { itemId?: unknown; runId?: unknown } = {}
        try {
          parsed = body ? (JSON.parse(body) as { itemId?: unknown; runId?: unknown }) : {}
        } catch {
          /* malformed body — fall through to 400 below */
        }
        if (typeof parsed.itemId !== 'string' || typeof parsed.runId !== 'string') {
          res.writeHead(400, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ ok: false, error: 'itemId and runId are required strings' }))
          return
        }
        const reqItemId = parsed.itemId
        const reqRunId = parsed.runId
        if (!inFlight || inFlight.itemId !== reqItemId || inFlight.runId !== reqRunId) {
          res.writeHead(409, { 'content-type': 'application/json' })
          res.end(
            JSON.stringify({
              ok: false,
              error: 'no matching in-flight item — already finished or claim has rotated',
            }),
          )
          return
        }
        // Set the cooperative-cancel flag. Stepper's next step boundary
        // throws CancelledError, claim loop catches kind='cancelled',
        // resets pages, claims next item.
        cancelTarget = { itemId: reqItemId, runId: reqRunId }
        log.warn(
          `[Daemon ${wf.config.name}/${instanceId}] cancel-current accepted for item=${reqItemId} runId=${reqRunId}`,
        )
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true, accepted: true }))
      })
      return
    }
    if (req.method === 'POST' && url === '/stop') {
      let body = ''
      req.on('data', (c) => {
        body += c
      })
      req.on('end', () => {
        let force = false
        try {
          const parsed = body ? (JSON.parse(body) as { force?: boolean }) : {}
          force = !!parsed.force
        } catch {
          /* ignore */
        }
        forceShutdown = force
        shuttingDown = true
        shutdownResolve?.()
        wakeResolve?.()
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end('{"ok":true}')
        if (force) {
          // Soft-stop flags don't interrupt a blocking Session.launch (Duo
          // auth, browser launch retries). Give the response 50ms to flush
          // then hard-exit so the wedged daemon + its Playwright children
          // really die. The OS reaps orphaned Chromium processes via SIGHUP
          // when the parent exits, and the lockfile's `isPidAlive` check
          // will report the daemon as dead on the next discovery pass.
          setTimeout(() => process.exit(1), 50)
        }
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

  // Self-heal: if anything (force-stop bypassing the unlink-via-finally,
  // an external cleanup script, a misbehaving sweep) deletes our lockfile
  // while we're still alive, rewrite it on the next tick. Without this, a
  // subsequent dashboard `findAliveDaemons` returns 0, `computeSpawnPlan`
  // recommends a fresh spawn, and the user ends up with a duplicate daemon
  // alongside this one (browsers x2, Duo x2, "Separation 1" recycled).
  // 10s is fast enough that the next dashboard retry sees a restored
  // lockfile within a beat; the writeLockfile cost is ~1KB synchronous
  // disk I/O on a 10s cadence — negligible.
  const lockHealInterval = setInterval(() => {
    if (shuttingDown) return
    try {
      if (!existsSync(lockPath)) {
        log.warn(
          `[Daemon ${wf.config.name}/${instanceId}] lockfile missing — restoring`,
        )
        writeLockfile(lock, lockPath)
      }
    } catch (err) {
      log.warn(
        `[Daemon ${wf.config.name}/${instanceId}] lockfile heal failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      )
    }
  }, opts.lockHealIntervalMs ?? DEFAULT_LOCK_HEAL_MS)
  lockHealInterval.unref()

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
        setPhase('authenticating')
        let session: Session
        try {
          session = await launchFn(wf.config.systems, {
            authChain: wf.config.authChain,
            observer,
          })
          // Expose to the /status handler + force-stop path. Cleared in
          // the outer `finally` to avoid a stale reference outliving the
          // session's lifetime.
          activeSession = session
          // Force every system's auth to complete at daemon startup so the
          // claim loop doesn't race with in-progress Duo prompts. Rejections
          // propagate to `withBatchLifecycle`'s catch so an auth failure
          // shuts the daemon down cleanly (lockfile unlink, in-flight
          // unclaim) instead of entering the claim loop with a broken
          // session and failing every queued item individually.
          for (const sys of wf.config.systems) {
            await session.page(sys.id)
          }
        } catch (e) {
          // Surface the failure with structured context so `npm run <wf>:attach`
          // shows an actionable line instead of a silent daemon exit. Classify
          // via the Playwright error taxonomy when the error looks like a browser
          // launch fault (ProcessSingleton, etc.).
          const summary = e instanceof Error ? (e.message ?? String(e)) : String(e)
          log.error(
            `[Daemon ${wf.config.name}/${instanceId}] auth/launch failed during phase='${phase}' — ${summary}`,
          )
          throw e
        }

        // Snapshot the real auth timings now that every system has finished
        // authenticating. We inject these into the FIRST queued item only so
        // its step pipeline shows the actual per-system Duo durations. Every
        // subsequent item gets synthesized zero-duration timings anchored at
        // its own claim time — auth really was free for those items (the
        // daemon reuses the session), so "Authenticating (4) — 0s" is the
        // truthful display. Passing the real startup timings to item #N would
        // re-stamp synthetic auth rows at daemon-start time and drag the
        // entry's firstLogTs minutes/hours into the past, inflating its
        // elapsed timer by the full queue-wait gap.
        const startupAuthTimings = wf.config.authSteps !== false ? getAuthTimings() : undefined
        let firstItemClaimed = false

        // Closing any window (user intent) or a browser crash should terminate
        // the daemon — a daemon whose browsers are gone can't serve queued
        // items anyway. Mirrors SIGTERM: set shuttingDown, resolve the idle
        // waiters so the loop exits. In-flight teardown runs in `finally`.
        const unsubscribeDisconnect = session.onBrowserDisconnect((systemId) => {
          if (shuttingDown) return
          log.warn(
            `[Daemon ${wf.config.name}/${instanceId}] browser disconnected (${systemId}); shutting down`,
          )
          shuttingDown = true
          shutdownResolve?.()
          wakeResolve?.()
        })

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
          setPhase('idle')
          while (!shuttingDown) {
            const state = await readQueueState(wf.config.name, trackerDir)
            queueDepthCache = state.queued.length

            const item = shuttingDown
              ? null
              : await claimNextItem(
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
              setPhase('processing')
              const runId = item.runId ?? randomUUID()
              inFlight = { itemId: item.id, runId }
              lastActivity = Date.now()
              // First item gets the real startup auth timings; subsequent
              // items get zero-duration synthetic timings anchored at claim
              // time so the step pipeline tiles "Authenticating (4) — 0s"
              // instead of "—" without dragging the entry's anchor back to
              // daemon-start.
              let itemAuthTimings = startupAuthTimings
              if (firstItemClaimed && wf.config.authSteps !== false) {
                const claimTs = Date.now()
                itemAuthTimings = wf.config.systems.map((sys) => ({
                  systemId: sys.id,
                  startTs: claimTs,
                  endTs: claimTs,
                }))
              }
              firstItemClaimed = true
              emitItemStart(instance, item.id, trackerDir)
              const r = await runOneItem({
                wf,
                session,
                item: item.input as TData,
                itemId: item.id,
                runId,
                trackerDir,
                callerPreEmits: false,
                preAssignedInstance: instance,
                authTimings: itemAuthTimings,
                isCancelRequested: () =>
                  cancelTarget?.itemId === item.id && cancelTarget?.runId === runId,
              })
              emitItemComplete(instance, item.id, trackerDir)
              markTerminated(runId)
              if (r.ok) {
                await markItemDone(wf.config.name, item.id, runId, trackerDir)
              } else {
                await markItemFailed(wf.config.name, item.id, r.error, runId, trackerDir)
              }
              // Reset every system's page to its `resetUrl` after a
              // cancelled item — leaves the daemon's auth intact but
              // returns the workflow surface to a clean starting state
              // for the next claim. Reset failures are best-effort: a
              // failed reset won't block the next item from claiming.
              if (r.ok === false && r.kind === 'cancelled') {
                for (const sys of wf.config.systems) {
                  try {
                    await session.reset(sys.id)
                  } catch (resetErr) {
                    log.warn(
                      `[Daemon ${instanceId}] post-cancel reset(${sys.id}) failed: ${
                        resetErr instanceof Error ? resetErr.message : String(resetErr)
                      }`,
                    )
                  }
                }
              }
              cancelTarget = null
              inFlight = null
              setPhase('idle')
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
            setPhase('keepalive')
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
            setPhase('idle')
          }
        } finally {
          setPhase('draining')
          unsubscribeDisconnect()
          try {
            await session.close()
          } catch {
            /* best-effort */
          }
        }
      },
    )
  } finally {
    // Orphan-queue cleanup runs here (outer finally) instead of inside the
    // body so it executes on EVERY exit path, including when `Session.launch`
    // throws before the claim loop even starts (user closes browser during
    // Duo, ProcessSingleton collision, etc.). Previously this only ran when
    // the body's inner try/finally was reached, so launch-phase failures left
    // pre-emitted `pending` tracker rows hanging forever.
    //
    // Order matters: cleanup BEFORE lockfile unlink so `findAliveDaemons`
    // still includes self in the alive set — `otherAlive.length === 0`
    // correctly identifies "this is the last alive daemon, no one else will
    // process these items".
    try {
      // Snapshot inFlight into a local — TypeScript's flow analysis can't
      // see assignments inside the async body callback (different closure),
      // so without the local + cast it narrows `inFlight` to `null` here
      // even though the body may have set it.
      const inFlightSnapshot = inFlight as { itemId: string; runId: string } | null
      if (inFlightSnapshot) {
        const nowIso = new Date().toISOString()
        const failError = forceShutdown
          ? 'Daemon force-stopped while processing this item.'
          : 'Daemon stopped while processing this item (browsers closed or crashed).'
        try {
          if (forceShutdown) {
            await markItemFailed(
              wf.config.name,
              inFlightSnapshot.itemId,
              failError,
              inFlightSnapshot.runId,
              trackerDir,
            )
          } else {
            // Soft stop: re-queue so a future daemon can pick up.
            await unclaimItem(wf.config.name, inFlightSnapshot.itemId, 'sigint-soft', trackerDir)
          }
        } catch {
          /* best-effort */
        }
        // Always write a tracker `failed` row for force shutdowns so the
        // dashboard doesn't show the item stuck in `running` state. Soft
        // shutdowns leave the tracker as-is — the unclaim returns the item
        // to `queued` and the orphan-queue sweep below handles it if no
        // other daemons are alive to claim it.
        if (forceShutdown) {
          try {
            trackEvent(
              {
                workflow: wf.config.name,
                timestamp: nowIso,
                id: inFlightSnapshot.itemId,
                runId: inFlightSnapshot.runId,
                status: 'failed',
                error: failError,
              },
              trackerDir,
            )
          } catch {
            /* best-effort */
          }
        }
        inFlight = null
      }

      const otherAlive = (await findAliveDaemons(wf.config.name, trackerDir))
        .filter((d) => d.instanceId !== instanceId)
      if (otherAlive.length === 0) {
        const state = await readQueueState(wf.config.name, trackerDir)
        if (state.queued.length > 0) {
          log.warn(
            `[Daemon ${wf.config.name}/${instanceId}] last daemon exiting with ${state.queued.length} unclaimed queue item(s); marking failed`,
          )
          const nowIso = new Date().toISOString()
          const failError =
            'Daemon stopped before this item could be processed (browsers closed).'
          for (const item of state.queued) {
            const runId = item.runId ?? randomUUID()
            try {
              await markItemFailed(wf.config.name, item.id, failError, runId, trackerDir)
            } catch {
              /* best-effort — queue event append; tracker row below is the user-visible signal */
            }
            try {
              // Reuse the same data-shape helper that `onPreEmitPending`
              // uses so prefilledData (edit-and-resume) gets hoisted onto
              // top-level keys. Without this, the failed row's `data` would
              // override the pending row's hoisted fields with `docId` +
              // an opaque `prefilledData` JSON blob, hiding the user's
              // edits in the dashboard detail grid.
              const data = buildTrackerDataForInput(item.input)
              trackEvent(
                {
                  workflow: wf.config.name,
                  timestamp: nowIso,
                  id: item.id,
                  runId,
                  status: 'failed',
                  data,
                  error: failError,
                },
                trackerDir,
              )
            } catch {
              /* best-effort */
            }
          }
        }
      }
    } catch (e) {
      log.warn(
        `[Daemon ${wf.config.name}/${instanceId}] orphan-queue cleanup failed: ${
          e instanceof Error ? e.message : String(e)
        }`,
      )
    }

    process.off('SIGINT', onSigint)
    process.off('SIGTERM', onSigterm)
    clearInterval(lockHealInterval)
    try {
      unlinkSync(lockPath)
    } catch {
      /* best-effort */
    }
    await new Promise<void>((resolve) => server.close(() => resolve()))
    setPhase('exited')
    log.step(`[Daemon ${wf.config.name}/${instanceId}] exited cleanly`)
  }
}
