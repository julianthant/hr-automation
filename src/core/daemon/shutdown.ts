import { randomUUID } from 'node:crypto'
import { unlinkSync } from 'node:fs'
import type { RegisteredWorkflow } from '../kernel/types.js'
import type { Session } from '../kernel/session.js'
import { log } from '../../utils/log.js'
import { findAliveDaemons } from './registry.js'
import {
  readQueueState,
  markItemCancelled,
} from './queue.js'
import {
  trackEvent,
  dateLocal,
  DEFAULT_DIR,
  findLatestEntryForRunOnDate,
  isTerminalTrackerEntryStatus,
} from '../../tracker/jsonl.js'
import { buildHttpPendingData, buildTrackerDataForInput } from './enqueue-dispatch.js'
import { deriveRowArchetype } from '../../domain/row-archetype.js'
import { isStateDbReady, openStateDb } from '../../tracker/state/db.js'
import type { ControlTaskStore } from '../task-store/index.js'
import { emitItemCancelled } from '../../tracker/session-events.js'
import type { Daemon } from './types.js'
import type { DaemonPhase, DaemonState } from './daemon-types.js'

export function buildShutdownTrackerData<TData, TSteps extends readonly string[]>(
  wf: RegisteredWorkflow<TData, TSteps>,
  input: unknown,
  parentRunId?: string,
): Record<string, string> {
  try {
    return buildHttpPendingData(wf, input, parentRunId)
  } catch {
    const data = buildTrackerDataForInput(input)
    data.archetype = deriveRowArchetype(wf.archetype, parentRunId)
    return data
  }
}

export function createAbortLaunchAndKillSession<TData, TSteps extends readonly string[]>(
  wf: RegisteredWorkflow<TData, TSteps>,
  instanceId: string,
  state: DaemonState,
): (reason: string) => void {
  return (reason: string): void => {
    if (!state.launchAbort.signal.aborted) {
      state.launchAbort.abort(new Error(reason))
    }
    const session = state.activeSession
    if (!session) return
    session.killChromeHard(2_000).catch((err) => {
      log.warn(
        `[Daemon ${wf.config.name}/${instanceId}] killChromeHard after abort failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      )
    })
  }
}

/**
 * Chrome-preserving interrupt of in-flight Playwright work. Navigates each
 * system's active page to about:blank, which causes any pending await
 * (click, fill, waitForSelector, navigation, etc.) to reject with a
 * navigation/closed error. Browser context (auth/cookies) survives, so
 * the daemon stays usable for the next item. Best-effort: errors
 * swallowed because the caller's only job is "do not let the in-flight
 * work continue silently."
 */
export function createInterruptInFlightWork<TData, TSteps extends readonly string[]>(
  wf: RegisteredWorkflow<TData, TSteps>,
  getActiveSession: () => Session | null,
): () => void {
  return (): void => {
    const session = getActiveSession()
    if (!session) return
    for (const sys of wf.config.systems) {
      ;(async (): Promise<void> => {
        try {
          const page = await session.page(sys.id)
          // 2s timeout — about:blank is essentially instant when chrome is
          // healthy. Longer waits hold up the cancel response unnecessarily.
          await page.goto('about:blank', { timeout: 2_000 }).catch(() => {})
        } catch {
          /* best-effort */
        }
      })().catch(() => {
        /* best-effort */
      })
    }
  }
}

export function installDaemonSignalHandlers<TData, TSteps extends readonly string[]>(
  wf: RegisteredWorkflow<TData, TSteps>,
  instanceId: string,
  state: DaemonState,
  abortLaunchAndKillSession: (reason: string) => void,
): {
  onSigint: () => void
  onSigterm: () => void
  onSighup: () => void
} {
  const sigHandler = (sig: string): void => {
    log.warn(`[Daemon ${wf.config.name}/${instanceId}] received ${sig}; shutting down`)
    state.shuttingDown = true
    state.forceShutdown = true
    state.drainOnlyShutdown = false
    abortLaunchAndKillSession(`Daemon received ${sig}`)
    state.shutdownResolve?.()
    state.wakeResolve?.()
  }
  const onSigint = (): void => sigHandler('SIGINT')
  const onSigterm = (): void => sigHandler('SIGTERM')
  // SIGHUP: closing the parent terminal sends SIGHUP to its foreground
  // process group. Detached daemons usually ignore it, but spawning
  // configurations that don't fully detach (or that share a session id)
  // will see it. Treat it identically to SIGTERM so the daemon runs its
  // teardown instead of being orphaned with stale lockfile + worker rows.
  const onSighup = (): void => sigHandler('SIGHUP')
  process.on('SIGINT', onSigint)
  process.on('SIGTERM', onSigterm)
  process.on('SIGHUP', onSighup)
  return { onSigint, onSigterm, onSighup }
}

export interface DaemonShutdownCleanupOpts<TData, TSteps extends readonly string[]> {
  wf: RegisteredWorkflow<TData, TSteps>
  instanceId: string
  trackerDir: string | undefined
  state: DaemonState
  taskStore: ControlTaskStore
  lockPath: string
  lockHealInterval: ReturnType<typeof setInterval>
  workerTickInterval: ReturnType<typeof setInterval>
  onSigint: () => void
  onSigterm: () => void
  onSighup: () => void
  httpHandle: { stop: () => Promise<void> }
  setPhase: (next: DaemonPhase) => void
}

export async function runDaemonShutdownCleanup<TData, TSteps extends readonly string[]>(
  opts: DaemonShutdownCleanupOpts<TData, TSteps>,
): Promise<void> {
  const {
    wf,
    instanceId,
    trackerDir,
    state,
    taskStore,
    lockPath,
    lockHealInterval,
    workerTickInterval,
    onSigint,
    onSigterm,
    onSighup,
    httpHandle,
    setPhase,
  } = opts

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
    const inFlightSnapshot = state.inFlight
    if (inFlightSnapshot) {
      const existingTask = inFlightSnapshot.taskId ? taskStore.getTask(inFlightSnapshot.taskId) : null
      const trackerRoot = trackerDir ?? DEFAULT_DIR
      let skipShutdownEmit = existingTask?.state === 'done'
      if (
        !skipShutdownEmit &&
        (existingTask?.state === 'cancelled' || existingTask?.state === 'failed')
      ) {
        // Prefer SQLite projection over a full-day JSONL scan: shutdown
        // runs inside the SIGINT grace window, and today's JSONL can be
        // tens of MB on a busy daemon. The indexed `run_events` query
        // returns the latest terminal status in O(log N).
        const today = dateLocal()
        let latestTerminal = false
        if (isStateDbReady(trackerRoot)) {
          try {
            const stateDb = openStateDb(trackerRoot)
            const row = stateDb.prepare(`
                SELECT status FROM run_events
                WHERE workflow = @workflow AND tracker_date = @date
                  AND item_id = @itemId AND run_id = @runId
                ORDER BY event_ms DESC, id DESC
                LIMIT 1
              `).get({
              workflow: wf.config.name,
              date: today,
              itemId: inFlightSnapshot.itemId,
              runId: inFlightSnapshot.runId,
            }) as { status?: string } | undefined
            if (row?.status === 'done' || row?.status === 'failed' || row?.status === 'skipped') {
              latestTerminal = true
            }
          } catch {
            /* fall through to JSONL */
          }
        }
        if (!latestTerminal) {
          const latest = findLatestEntryForRunOnDate(
            wf.config.name,
            inFlightSnapshot.itemId,
            inFlightSnapshot.runId,
            today,
            trackerRoot,
          )
          if (latest && isTerminalTrackerEntryStatus(latest)) latestTerminal = true
        }
        if (latestTerminal) skipShutdownEmit = true
      }
      // Successful SQLite completion (`done`): never emit shutdown cancel.
      // SQLite `cancelled` / `failed` with a terminal JSONL row for this run:
      // suppress duplicate tracker/session churn (avoid layering shutdown
      // `cancelled` on top of an authoritative failure row).
      // Otherwise emit shutdown cleanup — including repair when SQLite is
      // terminal but JSONL still shows pending/running (crash window).
      if (skipShutdownEmit) {
        state.inFlight = null
      } else {
        // Daemon shutdown while processing — mark the in-flight item as
        // cancelled (not failed). All shutdown paths are user-initiated
        // (force-stop, terminal close, SIGINT, browser disconnect), so
        // semantically these are intentional cancellations rather than
        // crashes. Cancelled rows display with the orange Cancelled badge
        // (status:failed + step:cancelled is the existing tracker
        // convention dashboards already render that way).
        const nowIso = new Date().toISOString()
        const cancelReason = state.forceShutdown
          ? 'Daemon force-stopped while processing this item.'
          : 'Daemon stopped while processing this item (browser closed or crashed).'
        try {
          await markItemCancelled(
            wf.config.name,
            inFlightSnapshot.itemId,
            cancelReason,
            inFlightSnapshot.runId,
            trackerDir,
          )
        } catch {
          /* best-effort — queue event append; tracker row below is the user-visible signal */
        }
        try {
          const parentRunId = existingTask?.parentRunId
          trackEvent(
            {
              workflow: wf.config.name,
              timestamp: nowIso,
              id: inFlightSnapshot.itemId,
              runId: inFlightSnapshot.runId,
              status: 'failed',
              step: 'cancelled',
              data: buildShutdownTrackerData(wf, existingTask?.input, parentRunId),
              ...(parentRunId ? { parentRunId } : {}),
              error: cancelReason,
            },
            trackerDir,
          )
        } catch {
          /* best-effort */
        }
        try {
          // Best-effort emit; if the daemon never reached the
          // withBatchLifecycle body (e.g. session.launch threw), the
          // closure variable was never assigned and we skip the event —
          // the tracker row above is the authoritative user-visible signal.
          if (state.workflowInstanceForCleanup) {
            emitItemCancelled(
              state.workflowInstanceForCleanup,
              inFlightSnapshot.itemId,
              cancelReason,
              trackerDir,
              inFlightSnapshot.runId,
            )
          }
        } catch {
          /* best-effort */
        }
        state.inFlight = null
      }
    }

    const otherAlive = (await findAliveDaemons(wf.config.name, trackerDir))
      .filter((d: Daemon) => d.instanceId !== instanceId)
    if (otherAlive.length === 0 && !state.drainOnlyShutdown) {
      const queueState = await readQueueState(wf.config.name, trackerDir)
      if (queueState.queued.length > 0) {
        log.warn(
          `[Daemon ${wf.config.name}/${instanceId}] last daemon exiting with ${queueState.queued.length} unclaimed queue item(s); marking cancelled`,
        )
        const nowIso = new Date().toISOString()
        const cancelReason =
          'Daemon stopped before this item could be processed (browser closed).'
        // Re-read the queue state right before iterating so a concurrent
        // /api/cancel-queued (which also writes a tracker row with
        // step="cancelled") wins the race: items that the user just
        // cancelled are no longer in `freshState.queued`, so we skip
        // them and their cancel reason is preserved on the dashboard.
        const freshState = await readQueueState(wf.config.name, trackerDir).catch(
          () => queueState,
        )
        const stillQueued = new Set(freshState.queued.map((q) => q.id))
        for (const item of queueState.queued) {
          if (!stillQueued.has(item.id)) {
            // Concurrent cancel-queued already terminated this item.
            // Don't overwrite — the cancel handler's tracker row stays
            // as the latest authoritative status.
            continue
          }
          const runId = item.runId ?? randomUUID()
          try {
            await markItemCancelled(wf.config.name, item.id, cancelReason, runId, trackerDir)
            if (item.taskId) {
              taskStore.markDependencyFromChildTerminal({
                childTaskId: item.taskId,
                childState: 'cancelled',
              })
            }
          } catch {
            /* best-effort — queue event append; tracker row below is the user-visible signal */
          }
          try {
            // Reuse the same data-shape helper that `onPreEmitPending`
            // uses so prefilledData (edit-and-resume) gets hoisted onto
            // top-level keys. Without this, the cancelled row's `data`
            // would override the pending row's hoisted fields with
            // `docId` + an opaque `prefilledData` JSON blob, hiding the
            // user's edits in the dashboard detail grid.
            const data = buildShutdownTrackerData(wf, item.input, item.parentRunId)
            trackEvent(
              {
                workflow: wf.config.name,
                timestamp: nowIso,
                id: item.id,
                runId,
                status: 'failed',
                step: 'cancelled',
                data,
                ...(item.parentRunId ? { parentRunId: item.parentRunId } : {}),
                error: cancelReason,
              },
              trackerDir,
            )
          } catch {
            /* best-effort */
          }
          try {
            if (state.workflowInstanceForCleanup) {
              emitItemCancelled(
                state.workflowInstanceForCleanup,
                item.id,
                cancelReason,
                trackerDir,
                runId,
              )
            }
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
  process.off('SIGHUP', onSighup)
  clearInterval(lockHealInterval)
  clearInterval(workerTickInterval)
  try {
    unlinkSync(lockPath)
  } catch {
    /* best-effort */
  }
  await httpHandle.stop()
  setPhase('exited')
  try {
    state.workerStore?.markWorkerStatus({
      workerId: instanceId,
      status: state.forceShutdown || state.exitError ? 'dead' : 'stopped',
      phase: 'exited',
    })
  } catch {
    /* best-effort */
  }
  log.step(`[Daemon ${wf.config.name}/${instanceId}] exited cleanly`)
}
