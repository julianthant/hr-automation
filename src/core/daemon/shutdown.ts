import { randomUUID } from 'node:crypto'
import { unlinkSync } from 'node:fs'
import type { RegisteredWorkflow } from '../kernel/types.js'
import { log } from '../../utils/log.js'
import { runRegistry } from '../run-registry.js'
import {
  findAliveDaemons,
  filterResponsiveDaemons,
  filterPeersAvailableForHandoff,
} from './registry.js'
import { wakeDaemonsForReleasedParents } from './client.js'
import {
  readQueueState,
  markItemCancelled,
  markItemFailed,
} from './queue.js'
import {
  emitTrackerRow,
  dateLocal,
  DEFAULT_DIR,
  findLatestEntryForRunOnDate,
  isTerminalTrackerEntryStatus,
  type StampedData,
} from '../../tracker/jsonl.js'
import { isStateDbReady, openStateDb } from '../../tracker/state/db.js'
import type { ControlTaskStore } from '../task-store/index.js'
import { emitItemCancelled } from '../../tracker/session-events.js'
import type { Daemon } from './types.js'
import type { DaemonPhase, DaemonState } from './daemon-types.js'
import {
  buildShutdownTrackerData,
  reassignInFlightItem,
  failInFlightItem,
  SHUTDOWN_NO_DAEMON_FAIL_REASON,
  SHUTDOWN_NO_RESPONSIVE_PEER_FAIL_REASON,
  type ShutdownTrackerDataOpts,
} from './in-flight-shutdown.js'

// Re-export the row-data builder (moved to `in-flight-shutdown.ts` to break the
// shutdown ↔ in-flight-helpers module cycle) so existing importers — `daemon.ts`
// and `tests/unit/core/daemon/shutdown.test.ts` — keep importing it from here.
export { buildShutdownTrackerData }
export type { ShutdownTrackerDataOpts }

export function createAbortLaunchAndKillSession<TData, TSteps extends readonly string[]>(
  wf: RegisteredWorkflow<TData, TSteps>,
  instanceId: string,
  state: DaemonState,
): (reason: string) => void {
  return (reason: string): void => {
    if (!state.launchAbort.signal.aborted) {
      state.launchAbort.abort(new Error(reason))
    }
    // Force-stop must also abort the IN-FLIGHT run's per-run AbortController,
    // not just the launch controller + chromium below. A handler parked in a
    // NON-Playwright, signal-only await — e.g. oath-upload's `wait-approval`
    // (`subscribeToApproval`), which blocks with NO live browser because
    // ServiceNow auth is deferred until after the wait — is unreachable by the
    // chromium kill: killing chrome only unwinds handlers blocked inside a
    // Playwright call. Without this cancel, force-stopping such a daemon
    // DEADLOCKS — the claim loop stays blocked on `await runOneItem`, so it
    // never re-observes `shuttingDown` and never reaches the outer-finally
    // shutdown sweep (`runDaemonShutdownCleanup`) that would otherwise cancel
    // the run. Mirrors the browser-disconnect path, which already routes the
    // active run through `runRegistry.cancel`. `hardKillAfterMs: 0` skips the
    // registry watchdog since we tear chromium down right here.
    const activeRunId = state.activeRun?.runId
    if (activeRunId) {
      void runRegistry
        .cancel(activeRunId, {
          reason: `daemon_shutdown (${reason})`,
          // VQ-003: daemon-originated cancel — the kernel must NOT also emit
          // its terminal cancelled row; `failInFlightItem`/`reassignInFlightItem`
          // owns the sole terminal.
          origin: 'shutdown',
          hardKillAfterMs: 0,
        })
        .catch((err) => {
          log.warn(
            `[Daemon ${wf.config.name}/${instanceId}] shutdown cancel of in-flight run failed: ${
              err instanceof Error ? err.message : String(err)
            }`,
          )
        })
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
  // Walk every still-registered run and abort its controller — covers
  // any in-process delegated children that haven't unwound yet plus the
  // active claim-loop run. `hardKillAfterMs: 0` skips the watchdog
  // because `abortLaunchAndKillSession` (or the signal handler that
  // preceded us) is already tearing chromium down — the watchdog would
  // just race the natural shutdown path.
  for (const handle of runRegistry.list()) {
    void runRegistry
      // VQ-003: daemon-originated — kernel suppresses its terminal cancelled
      // row; this sweep (and the claim loop) own the sole terminal.
      .cancel(handle.runId, { reason: 'daemon_shutdown', origin: 'shutdown', hardKillAfterMs: 0 })
      .catch(() => {
        /* best-effort — shutdown writes the cancelled row below */
      })
  }
  try {
    // Snapshot the active run into a local — TypeScript's flow analysis
    // can't see assignments inside the async body callback (different
    // closure), so without the local + cast it narrows `activeRun` to
    // `null` here even though the body may have set it.
    const activeRunSnapshot = state.activeRun
    const inFlightSnapshot = activeRunSnapshot
      ? {
          itemId: activeRunSnapshot.itemId,
          runId: activeRunSnapshot.runId,
          ...(activeRunSnapshot.taskId ? { taskId: activeRunSnapshot.taskId } : {}),
          ...(activeRunSnapshot.attemptId ? { attemptId: activeRunSnapshot.attemptId } : {}),
        }
      : null

    // Peers that will OUTLIVE this daemon — computed once, before BOTH the
    // in-flight and queued handling decide reassign-vs-fail, and before the
    // lockfile unlink so self is still in the alive set (filtered out here).
    // `otherAlive.length === 0` means "this is the last daemon; nobody else
    // will process these items".
    const otherAlive = (await findAliveDaemons(wf.config.name, trackerDir)).filter(
      (d: Daemon) => d.instanceId !== instanceId,
    )

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
      // Reassign is only SAFE if a peer will ACTUALLY finish the item.
      // `otherAlive` (from findAliveDaemons) deliberately trusts an
      // unreachable-but-PID-alive lockfile — a wedged/zombie daemon whose
      // event loop never wakes to claim work. Requeuing to such a peer parks
      // the item `queued` forever. Probe each peer's `/whoami` and only
      // reassign to one that POSITIVELY responds; if none do, fall through to
      // the fail-loud branch (the operator asked to SEE work fail, not have it
      // silently stranded waiting for a dead-worker recovery sweep that may
      // never come). Only probe when reassign was actually requested.
      const responsivePeers =
        state.reassignInFlight && otherAlive.length > 0 && inFlightSnapshot.taskId
          ? await filterResponsiveDaemons(otherAlive)
          : []
      // Normalized identity for the shared reassign/fail helpers.
      const shutdownItem = {
        itemId: inFlightSnapshot.itemId,
        runId: inFlightSnapshot.runId,
        ...(inFlightSnapshot.taskId ? { taskId: inFlightSnapshot.taskId } : {}),
        input: existingTask?.input,
        ...(existingTask?.parentRunId ? { parentRunId: existingTask.parentRunId } : {}),
      }
      if (skipShutdownEmit) {
        state.activeRun = null
      } else if (
        state.reassignInFlight &&
        responsivePeers.length > 0 &&
        inFlightSnapshot.taskId
      ) {
        // Per-instance stop with a RESPONSIVE peer — hand the item back to the
        // queue so a live daemon finishes it (same runId/attempt). Safety-net
        // mirror of the claim-loop reassign path for the rare case where the
        // item is still in-flight at cleanup time. Best-effort: if the
        // re-queue throws, the item stays claimed and a peer's dead-worker
        // recovery sweep re-queues it.
        await reassignInFlightItem({
          wf,
          item: { ...shutdownItem, taskId: inFlightSnapshot.taskId },
          responsivePeers,
          taskStore,
          trackerDir,
          logTag: `Daemon ${wf.config.name}/${instanceId}`,
        })
        state.activeRun = null
      } else if (state.reassignInFlight && otherAlive.length > 0) {
        // Reassign was requested and a peer LOOKS alive (PID + lockfile), but
        // none answered `/whoami` — the peers are wedged/zombie. Fail the item
        // loudly rather than requeue it to a daemon that will never claim it.
        log.warn(
          `[Daemon ${wf.config.name}/${instanceId}] per-instance stop — ${otherAlive.length} peer(s) appeared alive but none responded to /whoami; failing in-flight item ${inFlightSnapshot.itemId} instead of parking it`,
        )
        await failInFlightItem({
          wf,
          item: shutdownItem,
          failReason: SHUTDOWN_NO_RESPONSIVE_PEER_FAIL_REASON,
          taskStore,
          trackerDir,
          bestEffort: true,
          settleDependency: false,
          claimTerminalWrite: () => runRegistry.claimTerminalWrite(inFlightSnapshot.runId),
        })
        state.activeRun = null
      } else if (state.forceShutdown) {
        // Force-stop with no spare to absorb the item (stop-all, SIGINT, or
        // the last daemon stopped per-instance). The operator asked to SEE
        // these fail — emit a real failed row (NO step:"cancelled" sentinel →
        // red Failed badge, retriable). A deliberate per-item cancel never
        // reaches this sweep (the daemon stays alive), so a non-reassign
        // force-shutdown is always a genuine failure here.
        await failInFlightItem({
          wf,
          item: shutdownItem,
          failReason: SHUTDOWN_NO_DAEMON_FAIL_REASON,
          taskStore,
          trackerDir,
          bestEffort: true,
          settleDependency: false,
          claimTerminalWrite: () => runRegistry.claimTerminalWrite(inFlightSnapshot.runId),
        })
        state.activeRun = null
      } else {
        // Non-force shutdown while processing (browser disconnect / crash).
        // Semantically a cancellation, not a deliberate fail — keep the orange
        // Cancelled badge (status:failed + step:cancelled).
        const nowIso = new Date().toISOString()
        const cancelReason = 'Daemon stopped while processing this item (browser closed or crashed).'
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
          emitTrackerRow(
            {
              workflow: wf.config.name,
              timestamp: nowIso,
              id: inFlightSnapshot.itemId,
              runId: inFlightSnapshot.runId,
              status: 'failed',
              step: 'cancelled',
              data: buildShutdownTrackerData(wf, existingTask?.input, parentRunId, {
                runId: inFlightSnapshot.runId,
                trackerDir,
              }) as StampedData,
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
        state.activeRun = null
      }
    }

    // Queued (never-claimed) items when no peer will ACTUALLY pick them up and
    // we're not draining gracefully. The gate is NOT "no peer is PID-alive"
    // (`otherAlive.length === 0`) — that orphans the queue on a simultaneous
    // workflow-scoped stop-all (E2E-105): every dying daemon sees its peers'
    // lockfiles still on disk, leaves the queued task "for a peer," and the
    // peer is ALSO dying, so nobody terminalizes it (0 daemons alive, task
    // stuck `queued`, no terminal row). Instead, probe which peers are
    // AVAILABLE FOR HAND-OFF — responsive AND not themselves shutting down
    // (`filterPeersAvailableForHandoff`, which reads `/whoami.shuttingDown`).
    // A peer that received `/stop` reports `shuttingDown: true` (set
    // synchronously in its `/stop` handler before it responded, so the signal
    // is on-disk-observable by sweep time), so it does NOT count. If NO peer is
    // available to absorb them, this daemon is effectively the last responsive
    // owner and terminalizes the queue (red) rather than leaving it for a dying
    // peer. A genuinely-surviving (not-stopped) peer still answers
    // `shuttingDown: false` and absorbs the items, so a per-instance stop /
    // partial teardown keeps "≥1 live daemon → leave queued" intact. (Multiple
    // dying daemons may each reach this sweep and elect themselves the owner;
    // the `stillQueued` re-read below plus the run-registry terminal-write
    // guard keep it to one terminal row per item.)
    const handoffPeers =
      otherAlive.length > 0 ? await filterPeersAvailableForHandoff(otherAlive) : []
    if (handoffPeers.length === 0 && !state.drainOnlyShutdown) {
      const queueState = await readQueueState(wf.config.name, trackerDir)
      if (queueState.queued.length > 0) {
        log.warn(
          `[Daemon ${wf.config.name}/${instanceId}] last daemon exiting with ${queueState.queued.length} unclaimed queue item(s); marking failed (no daemon available)`,
        )
        const nowIso = new Date().toISOString()
        const failReason =
          'No daemon available to run this item — the last daemon was stopped.'
        // Re-read the queue state right before iterating so a concurrent
        // /api/cancel-queued (which writes its own terminal tracker row)
        // wins the race: items that the user just cancelled are no longer in
        // `freshState.queued`, so we skip them and their cancel reason is
        // preserved on the dashboard.
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
            await markItemFailed(wf.config.name, item.id, failReason, runId, trackerDir)
            if (item.taskId) {
              const released = taskStore.markDependencyFromChildTerminal({
                childTaskId: item.taskId,
                childState: 'failed',
              })
              void wakeDaemonsForReleasedParents(released, trackerDir)
            }
          } catch {
            /* best-effort — queue event append; tracker row below is the user-visible signal */
          }
          try {
            // Reuse the same data-shape helper that `onPreEmitPending`
            // uses so prefilledData (edit-and-resume) gets hoisted onto
            // top-level keys. Without this, the failed row's `data`
            // would override the pending row's hoisted fields with
            // `docId` + an opaque `prefilledData` JSON blob, hiding the
            // user's edits in the dashboard detail grid.
            const data = buildShutdownTrackerData(wf, item.input, item.parentRunId, {
              runId,
              trackerDir,
            }) as StampedData
            emitTrackerRow(
              {
                workflow: wf.config.name,
                timestamp: nowIso,
                id: item.id,
                runId,
                status: 'failed',
                // No step:"cancelled" sentinel → red Failed badge.
                data,
                ...(item.parentRunId ? { parentRunId: item.parentRunId } : {}),
                error: failReason,
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
