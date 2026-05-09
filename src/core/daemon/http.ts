import { createServer, type Server } from 'node:http'
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
  getActiveSession: () => Session | null
  getWorkerStore: () => ControlWorkerStore | null
  setCancelTarget: (target: { itemId: string; runId: string } | null) => void
  setForceShutdown: (value: boolean) => void
  setDrainOnlyShutdown: (value: boolean) => void
  setShuttingDown: (value: boolean) => void
  resolveWake: () => void
  resolveShutdown: () => void
  abortLaunchAndKillSession: (reason: string) => void
  /**
   * Interrupt any in-flight Playwright work for the current item without
   * killing chrome. Implementation navigates each system's active page to
   * `about:blank`, which causes pending awaits (clicks, fills, waits,
   * navigations) to reject. Browser context, cookies, and auth state are
   * preserved — the daemon's existing post-cancel `session.reset(sysId)`
   * loop restores the page to its resetUrl before the next claim.
   * Best-effort: errors are swallowed by the implementation.
   */
  interruptInFlightWork: () => void
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
    getActiveSession,
    getWorkerStore,
    setCancelTarget,
    setForceShutdown,
    setDrainOnlyShutdown,
    setShuttingDown,
    resolveWake,
    resolveShutdown,
    abortLaunchAndKillSession,
    interruptInFlightWork,
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
    if (req.method === 'POST' && url === '/force-current') {
      let body = ''
      req.on('data', (c) => {
        body += c
      })
      req.on('end', () => {
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
        // Chrome-preserving force-cancel: set cooperative-cancel flag AND
        // immediately interrupt in-flight Playwright awaits by navigating
        // each system's page to about:blank. The browser stays alive (auth
        // / cookies preserved), the daemon stays alive, the current item
        // gets reclassified as cancelled by the Stepper's catch block, and
        // the claim loop continues with the next queued item. No
        // forceShutdown / shuttingDown — those paths are reserved for
        // /stop (full daemon shutdown).
        setCancelTarget({ itemId: reqItemId, runId: reqRunId })
        log.warn(
          `[Daemon ${workflowName}/${instanceId}] force-current accepted for item=${reqItemId} runId=${reqRunId} (interrupting work, chrome preserved)`,
        )
        try {
          interruptInFlightWork()
        } catch (err) {
          log.warn(
            `[Daemon ${workflowName}/${instanceId}] force-current interrupt failed: ${
              err instanceof Error ? err.message : String(err)
            }`,
          )
        }
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
        // The `force` body field is parsed but IGNORED as of the 2026-04-28
        // Cluster A spec. Every /stop is now force semantics: in-flight item
        // marked failed (not re-queued), queued items marked failed, chrome
        // SIGTERM → SIGKILL, daemon exits. Per user direction: "I don't want
        // graceful. I don't want the requeue. I want to see it fail when
        // daemon dies because I already have the retry buttons for that. I
        // don't want unfinished business."
        try {
          // Tolerate malformed bodies — the field is no-op anyway.
          if (body) JSON.parse(body)
        } catch {
          /* ignore */
        }
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
          await new Promise((r) => setTimeout(r, 50))
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

  const listenPromise = new Promise<DaemonHttpHandle>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
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
