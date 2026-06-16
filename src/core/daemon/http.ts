import { createServer, type Server } from 'node:http'
import { setTimeout as sleep } from 'node:timers/promises'
import type { DaemonPhase } from './daemon.js'
import type { Session } from '../kernel/session.js'
import type { ControlWorkerStore } from './worker-store.js'
import { log } from '../../utils/log.js'

export interface DaemonHttpOpts {
  workflowName: string
  instanceId: string
  getPhase: () => DaemonPhase
  getQueueDepthCache: () => number
  getInFlight: () => { itemId: string; runId: string; taskId?: string; attemptId?: string } | null
  getLastActivity: () => number
  /**
   * Whether this daemon is tearing down (received `/stop`, a stop worker
   * command, or SIGINT/SIGTERM/SIGHUP). Reported in `/whoami` so a PEER
   * deciding whether to leave its queued/in-flight work "for this daemon"
   * can tell a genuinely-surviving daemon from one that is ALSO dying — the
   * happens-before edge that closes the simultaneous-stop-all queued-orphan
   * race (E2E-105): the dashboard's workflow-scoped stop sets `shuttingDown`
   * synchronously in EVERY daemon's `/stop` handler before that handler
   * responds, so by the time any daemon runs its teardown sweep, a peer that
   * received `/stop` already reports `shuttingDown: true` and is NOT counted
   * as an available hand-off target.
   */
  getShuttingDown: () => boolean
  getActiveSession: () => Session | null
  getWorkerStore: () => ControlWorkerStore | null
  setCancelTarget: (target: { itemId: string; runId: string } | null) => void
  setForceShutdown: (value: boolean) => void
  setDrainOnlyShutdown: (value: boolean) => void
  setShuttingDown: (value: boolean) => void
  setReassignInFlight: (value: boolean) => void
  resolveWake: () => void
  resolveShutdown: () => void
  abortLaunchAndKillSession: (reason: string) => void
}

export interface DaemonHttpHandle {
  port: number
  stop(): Promise<void>
}

export function startDaemonHttpServer(opts: DaemonHttpOpts): { server: Server; listenPromise: Promise<DaemonHttpHandle> } {
  const {
    workflowName,
    instanceId,
    getPhase,
    getQueueDepthCache,
    getInFlight,
    getLastActivity,
    getShuttingDown,
    getActiveSession,
    getWorkerStore,
    setCancelTarget,
    setForceShutdown,
    setDrainOnlyShutdown,
    setShuttingDown,
    setReassignInFlight,
    resolveWake,
    resolveShutdown,
    abortLaunchAndKillSession,
  } = opts

  const server: Server = createServer((req, res) => {
    const url = req.url ?? '/'
    if (req.method === 'GET' && url === '/whoami') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          workflow: workflowName,
          instanceId,
          pid: process.pid,
          // E2E-105: a peer deciding whether to leave queued/in-flight work
          // "for this daemon" must not pick one that is ALSO tearing down.
          shuttingDown: getShuttingDown(),
          version: 1,
        }),
      )
      return
    }
    if (req.method === 'GET' && url === '/status') {
      const inFlight = getInFlight()
      const activeSession = getActiveSession()
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          workflow: workflowName,
          instanceId,
          phase: getPhase(),
          queueDepth: getQueueDepthCache(),
          inFlight: inFlight?.itemId ?? null,
          inFlightRunId: inFlight?.runId ?? null,
          lastActivity: new Date(getLastActivity()).toISOString(),
          // chromePids is best-effort: undefined during phase === 'launching'
          // (session not yet allocated) and on win32 (defaultLaunchOne's
          // pgrep diff returns no children). Spawn pre-check tolerates both.
          chromePids: activeSession ? Object.values(activeSession.chromePids) : [],
        }),
      )
      return
    }
    if (req.method === 'POST' && url === '/wake') {
      resolveWake()
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
        const inFlight = getInFlight()
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
        setCancelTarget({ itemId: reqItemId, runId: reqRunId })
        const workerStore = getWorkerStore()
        if (workerStore && inFlight.taskId) {
          workerStore.enqueueWorkerCommand({
            commandType: 'cancel_task',
            workflow: workflowName,
            targetWorkerId: instanceId,
            targetTaskId: inFlight.taskId,
            payload: { itemId: reqItemId, runId: reqRunId, source: 'http-compat' },
            ...(inFlight.attemptId ? { targetAttemptId: inFlight.attemptId } : {}),
          })
        }
        log.warn(
          `[Daemon ${workflowName}/${instanceId}] cancel-current accepted for item=${reqItemId} runId=${reqRunId}`,
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
        // Body: `{ force?: boolean, reassign?: boolean }`.
        //
        // `force` is parsed but the teardown is always force semantics
        // (chrome SIGTERM → SIGKILL, daemon exits). What `reassign` controls
        // is the IN-FLIGHT item's fate (2026-06-07 — supersedes the 2026-04-28
        // "always fail, never requeue" direction now that the operator runs a
        // POOL of daemons):
        //   - `reassign: true` (dashboard session-card PER-INSTANCE stop) AND
        //     another daemon for this workflow is still alive → the in-flight
        //     item is un-claimed and a surviving daemon finishes it; nothing
        //     fails. If this is the LAST daemon, it falls through to fail.
        //   - omitted/false (workflow-scoped "stop all", SIGINT/SIGTERM) → the
        //     in-flight + queued items fail (red), as before — no spare to hand
        //     off to, or the operator is tearing everything down.
        // `/cancel-current` is unaffected (it never sets reassign and leaves
        // the daemon alive), so cancelling one item still renders Cancelled.
        let reassign = false
        try {
          if (body) {
            const parsed = JSON.parse(body) as { reassign?: unknown }
            reassign = parsed.reassign === true
          }
        } catch {
          /* ignore malformed body — defaults to fail-on-stop */
        }
        setReassignInFlight(reassign)
        setForceShutdown(true)
        setDrainOnlyShutdown(false)
        setShuttingDown(true)
        const workerStore = getWorkerStore()
        if (workerStore) {
          workerStore.enqueueWorkerCommand({
            commandType: 'stop_worker',
            workflow: workflowName,
            targetWorkerId: instanceId,
            payload: { source: 'http-compat' },
            state: 'completed',
          })
          workerStore.markWorkerStatus({ workerId: instanceId, status: 'draining', phase: 'draining' })
        }
        resolveShutdown()
        resolveWake()
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end('{"ok":true}')
        // Kill tracked chromium PIDs (SIGTERM + 2s grace + SIGKILL). With
        // chrome dead, any pending Playwright awaits in `Session.launch`
        // or in-flight handlers reject immediately with "browser closed",
        // unwinding the natural shutdown path. The outer-finally cleanup
        // then marks in-flight failed, marks queued failed, unlinks the
        // lockfile, and the daemon function returns. We deliberately do
        // NOT call `process.exit(1)` here — natural shutdown is enough
        // and matches the test runner's expectations (tests inject a
        // stub `sessionLaunchFn` and await the daemon promise).
        ;(async (): Promise<void> => {
          // 50ms grace so the HTTP response fully flushes before we tear
          // chrome down (otherwise the caller might see an aborted socket
          // even though the kill went through cleanly).
          await sleep(50)
          abortLaunchAndKillSession('Daemon stop requested')
        })().catch(() => {
          /* best-effort — the natural shutdown path runs regardless */
        })
      })
      return
    }
    res.writeHead(404)
    res.end()
  })

  const listenPromise = new Promise<DaemonHttpHandle>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      resolve({
        port,
        stop: () => new Promise<void>((res) => server.close(() => res())),
      })
    })
  })

  return { server, listenPromise }
}
