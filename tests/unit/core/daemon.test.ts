import { test } from 'vitest'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { z } from 'zod'
import { defineWorkflow } from '../../../src/core/kernel/workflow.js'
import { clear } from '../../../src/core/kernel/registry.js'
import { runWorkflowDaemon } from '../../../src/core/daemon/daemon.js'
import { Session } from '../../../src/core/kernel/session.js'
import { enqueueItems, readQueueStateIncludingTerminals } from '../../../src/core/daemon/queue.js'
import { ensureDaemonsAndEnqueue } from '../../../src/core/daemon/client.js'
import {
  findAliveDaemons,
  ensureDaemonsDir,
  randomInstanceId,
  writeLockfile,
  lockfilePath,
  invalidateAliveDaemonsCache,
  scanAliveDaemonInstanceNames,
} from '../../../src/core/daemon/registry.js'
import { readSessionEvents } from '../../../src/tracker/session-events.js'
import { openControlDb } from '../../../src/core/control-db.js'
import { createTaskStore } from '../../../src/core/task-store/index.js'
import { createWorkerStore } from '../../../src/core/daemon/worker-store.js'
import { dateLocal } from '../../../src/tracker/jsonl.js'
import { rowFilePath } from '../../../src/tracker/paths.js'
import type { SystemConfig } from '../../../src/core/kernel/types.js'

// Fake Session that has no browsers — works fine because our test workflow
// uses `systems: []` so nothing calls `page()` / `healthCheck()`.
function stubLaunch(): typeof Session.launch {
  return (async () => {
    return Session.forTesting({
      systems: [],
      browsers: new Map(),
      readyPromises: new Map(),
    })
  }) as unknown as typeof Session.launch
}

function stubLaunchWithChromePid(systemId: string, chromiumPid: number): typeof Session.launch {
  return (async (systems: SystemConfig[]) => {
    const fakePage = { close: async () => {}, isClosed: () => false } as unknown as import('playwright').Page
    const fakeContext = { close: async () => {} } as unknown as import('playwright').BrowserContext
    return Session.forTesting({
      systems,
      browsers: new Map([
        [systemId, { page: fakePage, browser: null as never, context: fakeContext, chromiumPid }],
      ]),
      readyPromises: new Map([[systemId, Promise.resolve()]]),
    })
  }) as unknown as typeof Session.launch
}

function deferred<T = void>(): {
  promise: Promise<T>
  resolve: (value?: T | PromiseLike<T>) => void
  reject: (reason?: unknown) => void
} {
  let resolve!: (value?: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = (value?: T | PromiseLike<T>) => res(value as T | PromiseLike<T>)
    reject = rej
  })
  return { promise, resolve, reject }
}

function waitForDaemon(workflow: string, dir: string, timeoutMs = 5000): Promise<{ port: number }> {
  return new Promise((resolve, reject) => {
    const start = Date.now()
    const tick = async (): Promise<void> => {
      const alive = await findAliveDaemons(workflow, dir)
      if (alive.length > 0) {
        resolve({ port: alive[0].port })
        return
      }
      if (Date.now() - start > timeoutMs) {
        reject(new Error(`daemon did not register within ${timeoutMs}ms`))
        return
      }
      setTimeout(tick, 25)
    }
    void tick()
  })
}

async function waitFor(pred: () => boolean | Promise<boolean>, timeoutMs = 3000): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (await pred()) return
    await new Promise((r) => setTimeout(r, 25))
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`)
}

/**
 * Stand up a minimal `/whoami` HTTP server that positively identifies as the
 * given (workflow, instanceId) — i.e. a RESPONSIVE peer daemon. The shutdown
 * reassign path now health-checks peers before requeuing to one, so a fake
 * lockfile alone (PID alive, port dead) no longer counts as a usable peer; the
 * peer must actually answer `/whoami`.
 */
async function startWhoamiServer(
  workflow: string,
  instanceId: string,
): Promise<{ server: Server; port: number }> {
  const server = createServer((req, res) => {
    if (req.url !== '/whoami') {
      res.writeHead(404)
      res.end()
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ workflow, instanceId }))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as AddressInfo
  return { server, port: address.port }
}

test('runWorkflowDaemon: /whoami handshake + graceful /stop removes lockfile', async () => {
  clear()
  const dir = mkdtempSync(join(tmpdir(), 'daemon-int-whoami-'))
  try {
    const wf = defineWorkflow({
      name: 'dint-a',
      schema: z.object({ id: z.string() }),
      steps: ['a'],
      systems: [],
      authSteps: false,
      handler: async () => {},
    })

    const runPromise = runWorkflowDaemon(wf, {
      trackerDir: dir,
      sessionLaunchFn: stubLaunch(),
    })

    const { port } = await waitForDaemon('dint-a', dir)

    const who = await fetch(`http://127.0.0.1:${port}/whoami`).then((r) => r.json())
    assert.equal(who.workflow, 'dint-a')
    assert.equal(typeof who.instanceId, 'string')
    assert.equal(who.pid, process.pid)

    await fetch(`http://127.0.0.1:${port}/stop`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ force: false }),
    })

    await runPromise

    // Lockfile should be gone after graceful shutdown.
    const entries = readdirSync(join(dir, 'daemons')).filter((f) =>
      f.startsWith('dint-a-') && f.endsWith('.lock.json'),
    )
    assert.equal(entries.length, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('runWorkflowDaemon: /stop during launch/auth aborts session launch and fails queued work', async () => {
  clear()
  const dir = mkdtempSync(join(tmpdir(), 'daemon-int-stop-during-auth-'))
  try {
    let abortObserved = false
    const wf = defineWorkflow({
      name: 'dint-stop-auth',
      schema: z.object({ id: z.string() }),
      steps: ['run'],
      systems: [{ id: 'ucpath', login: async () => {} }],
      authSteps: false,
      getId: (d) => (d as { id: string }).id,
      handler: async () => {},
    })
    await enqueueItems<{ id: string }>('dint-stop-auth', [{ id: 'held' }], (d) => d.id, dir)

    const launchFn = (async (systems: SystemConfig[], opts?: Parameters<typeof Session.launch>[1]) => {
      const fakePage = { close: async () => {}, isClosed: () => false } as unknown as import('playwright').Page
      const fakeContext = { close: async () => {} } as unknown as import('playwright').BrowserContext
      const session = Session.forTesting({
        systems,
        browsers: new Map([
          ['ucpath', { page: fakePage, browser: null as never, context: fakeContext, chromiumPid: 424243 }],
        ]),
        readyPromises: new Map([['ucpath', new Promise(() => {})]]),
      })
      opts?.onReady?.(session)
      await new Promise<void>((_resolve, reject) => {
        opts?.abortSignal?.addEventListener('abort', () => {
          abortObserved = true
          reject(new Error('launch aborted by daemon stop'))
        }, { once: true })
        setTimeout(() => reject(new Error('test cleanup timeout: launch was not aborted')), 1_000)
      })
      return session
    }) as unknown as typeof Session.launch

    const runPromise = runWorkflowDaemon(wf, {
      trackerDir: dir,
      sessionLaunchFn: launchFn,
      idleTimeoutMs: 10_000,
    })
    const { port } = await waitForDaemon('dint-stop-auth', dir)

    await fetch(`http://127.0.0.1:${port}/stop`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ force: true }),
    })

    await Promise.race([
      runPromise,
      new Promise((_, reject) => setTimeout(() => reject(new Error('daemon did not stop during auth')), 1_500)),
    ])
    assert.equal(abortObserved, true)
    const state = await readQueueStateIncludingTerminals('dint-stop-auth', dir)
    assert.equal(state.failed.length, 1)
    assert.equal(state.failed[0].id, 'held')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('runWorkflowDaemon: queued shutdown-cancel rows preserve title and row archetype', async () => {
  clear()
  const dir = mkdtempSync(join(tmpdir(), 'daemon-int-stop-queued-display-'))
  try {
    const parentRunId = 'ocr-parent-run-123'
    const wf = defineWorkflow({
      name: 'dint-stop-queued-display',
      schema: z.object({
        emplId: z.string(),
        parentSubject: z.string().optional(),
      }),
      steps: ['run'],
      systems: [{ id: 'ucpath', login: async () => {} }],
      authSteps: false,
      archetype: 'single',
      getId: (d) => (d as { emplId: string }).emplId,
      getName: (d) => (d as { emplId?: string; searchName?: string }).searchName ?? (d as { emplId: string }).emplId,
      initialData: (d) => ({ searchName: d.emplId, emplId: d.emplId }),
      queueTitle: { kind: 'single' },
      handler: async () => {},
    })
    await enqueueItems(
      'dint-stop-queued-display',
      [{ emplId: '10424984', parentSubject: 'Oath · 4248' }],
      (d) => d.emplId,
      dir,
      undefined,
      [parentRunId],
    )

    const launchFn = (async (_systems: SystemConfig[], opts?: Parameters<typeof Session.launch>[1]) => {
      const fakePage = { close: async () => {}, isClosed: () => false } as unknown as import('playwright').Page
      const fakeContext = { close: async () => {} } as unknown as import('playwright').BrowserContext
      const session = Session.forTesting({
        systems: [{ id: 'ucpath', login: async () => {} }],
        browsers: new Map([
          ['ucpath', { page: fakePage, browser: null as never, context: fakeContext, chromiumPid: 424245 }],
        ]),
        readyPromises: new Map([['ucpath', new Promise(() => {})]]),
      })
      opts?.onReady?.(session)
      await new Promise<void>((_resolve, reject) => {
        opts?.abortSignal?.addEventListener('abort', () => {
          reject(new Error('launch aborted by daemon stop'))
        }, { once: true })
        setTimeout(() => reject(new Error('test cleanup timeout: launch was not aborted')), 1_000)
      })
      return session
    }) as unknown as typeof Session.launch

    const runPromise = runWorkflowDaemon(wf, {
      trackerDir: dir,
      sessionLaunchFn: launchFn,
      idleTimeoutMs: 10_000,
    })
    const { port } = await waitForDaemon('dint-stop-queued-display', dir)

    await fetch(`http://127.0.0.1:${port}/stop`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ force: true }),
    })
    await runPromise

    const date = dateLocal()
    const jsonlPath = rowFilePath('dint-stop-queued-display', date, dir)
    const rows = readFileSync(jsonlPath, 'utf-8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { id?: string; status?: string; parentRunId?: string; data?: Record<string, unknown> })
    const cancelled = rows.find((row) => row.id === '10424984' && row.status === 'failed')
    assert.ok(cancelled, 'expected cancelled tracker row')
    assert.equal(cancelled.parentRunId, parentRunId)
    assert.equal(cancelled.data?.__name, '10424984')
    assert.equal(cancelled.data?.__queueTitle, '10424984')
    assert.equal(cancelled.data?.archetype, 'single')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('runWorkflowDaemon: processes queued items via claim loop', async () => {
  clear()
  const dir = mkdtempSync(join(tmpdir(), 'daemon-int-claim-'))
  try {
    const seen: string[] = []
    const wf = defineWorkflow({
      name: 'dint-b',
      schema: z.object({ id: z.string() }),
      steps: ['run'],
      systems: [],
      authSteps: false,
      getId: (d) => (d as { id: string }).id,
      handler: async (ctx, data) => {
        await ctx.step('run', async () => {
          seen.push((data as { id: string }).id)
        })
      },
    })

    // Enqueue BEFORE starting the daemon so the first readQueueState sees work.
    await enqueueItems<{ id: string }>(
      'dint-b',
      [{ id: 'one' }, { id: 'two' }],
      (d) => d.id,
      dir,
    )

    const runPromise = runWorkflowDaemon(wf, {
      trackerDir: dir,
      sessionLaunchFn: stubLaunch(),
      idleTimeoutMs: 200,
    })

    const { port } = await waitForDaemon('dint-b', dir)

    await waitFor(async () => {
      const st = await readQueueStateIncludingTerminals('dint-b', dir)
      return st.done.length === 2
    }, 10_000)

    assert.deepEqual(seen.sort(), ['one', 'two'])

    await fetch(`http://127.0.0.1:${port}/stop`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })
    await runPromise
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('runWorkflowDaemon: records worker ownership, heartbeats, browser pids, and cancel_task commands', async () => {
  clear()
  const dir = mkdtempSync(join(tmpdir(), 'daemon-int-worker-'))
  const control = openControlDb({ trackerDir: dir })
  const taskStore = createTaskStore(control)
  const workerStore = createWorkerStore(control)
  try {
    const started = deferred()
    const releaseHold = deferred()
    let afterRan = false
    const wf = defineWorkflow({
      name: 'dint-worker',
      schema: z.object({ id: z.string() }),
      steps: ['hold', 'after'],
      systems: [{ id: 'ucpath', login: async () => {} }],
      authSteps: false,
      getId: (d) => (d as { id: string }).id,
      handler: async (ctx) => {
        await ctx.step('hold', async () => {
          started.resolve()
          await releaseHold.promise
        })
        await ctx.step('after', async () => {
          afterRan = true
        })
      },
    })

    await enqueueItems<{ id: string }>('dint-worker', [{ id: 'held' }], (d) => d.id, dir)
    const runPromise = runWorkflowDaemon(wf, {
      trackerDir: dir,
      sessionLaunchFn: stubLaunchWithChromePid('ucpath', 424242),
      idleTimeoutMs: 10_000,
      heartbeatIntervalMs: 50,
      commandPollIntervalMs: 50,
    })
    const { port } = await waitForDaemon('dint-worker', dir)

    await started.promise
    const worker = await waitFor(async () => workerStore.listWorkers('dint-worker').length === 1)
      .then(() => workerStore.listWorkers('dint-worker')[0])
    assert.equal(worker.kind, 'daemon')
    assert.equal(worker.instanceId, worker.workerId)

    const task = await waitFor(async () => {
      const row = taskStore.listTasksForWorkflow('dint-worker')[0]
      return row?.state === 'running' && row.claimedByWorkerId === worker.workerId
    }).then(() => taskStore.listTasksForWorkflow('dint-worker')[0])
    assert.equal(task.claimedByWorkerId, worker.workerId)
    assert.ok(task.currentAttemptId)

    await waitFor(() => {
      const row = workerStore.getWorker(worker.workerId)
      return row?.currentTaskId === task.taskId && row.currentAttemptId === task.currentAttemptId
    })

    const browsers = workerStore.listBrowserProcessesForWorker(worker.workerId)
    assert.equal(browsers.length, 1)
    assert.equal(browsers[0].pid, 424242)
    assert.equal(browsers[0].systemId, 'ucpath')
    assert.equal(browsers[0].taskId, task.taskId)
    assert.equal(browsers[0].attemptId, task.currentAttemptId)

    const commandId = workerStore.enqueueWorkerCommand({
      commandType: 'cancel_task',
      workflow: 'dint-worker',
      targetWorkerId: worker.workerId,
      targetTaskId: task.taskId,
      targetAttemptId: task.currentAttemptId,
    })
    await waitFor(() => workerStore.getCommand(commandId)?.state === 'completed')

    releaseHold.resolve()
    await waitFor(() => taskStore.getTask(task.taskId)?.state === 'cancelled', 5_000)
    assert.equal(afterRan, false)

    await waitFor(() => {
      const phases = workerStore.listHeartbeats(worker.workerId).map((h) => h.phase)
      return phases.includes('processing') && phases.includes('idle')
    })

    await fetch(`http://127.0.0.1:${port}/stop`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })
    await runPromise
  } finally {
    workerStore.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('runWorkflowDaemon: browser disconnect cancels in-flight step errors', async () => {
  clear()
  const dir = mkdtempSync(join(tmpdir(), 'daemon-int-browser-disconnect-'))
  const control = openControlDb({ trackerDir: dir })
  const taskStore = createTaskStore(control)
  try {
    const started = deferred()
    const releaseAfterDisconnect = deferred()
    let browser: EventEmitter & { close: () => Promise<void> }
    const wf = defineWorkflow({
      name: 'dint-browser-disconnect',
      schema: z.object({ id: z.string() }),
      steps: ['work'],
      systems: [{ id: 'ucpath', login: async () => {} }],
      authSteps: false,
      getId: (d) => (d as { id: string }).id,
      handler: async (ctx) => {
        await ctx.step('work', async () => {
          started.resolve()
          await releaseAfterDisconnect.promise
          throw new Error('Target page, context or browser has been closed')
        })
      },
    })

    const launchFn = (async (systems: SystemConfig[]) => {
      browser = Object.assign(new EventEmitter(), { close: async () => {} })
      const fakePage = { close: async () => {}, isClosed: () => false } as unknown as import('playwright').Page
      const fakeContext = { close: async () => {}, newPage: async () => fakePage } as unknown as import('playwright').BrowserContext
      return Session.forTesting({
        systems,
        browsers: new Map([
          ['ucpath', { page: fakePage, browser: browser as unknown as import('playwright').Browser, context: fakeContext, chromiumPid: 424244 }],
        ]),
        readyPromises: new Map([['ucpath', Promise.resolve()]]),
      })
    }) as unknown as typeof Session.launch

    await enqueueItems<{ id: string }>('dint-browser-disconnect', [{ id: 'held' }], (d) => d.id, dir)
    const runPromise = runWorkflowDaemon(wf, {
      trackerDir: dir,
      sessionLaunchFn: launchFn,
      idleTimeoutMs: 10_000,
    })
    await waitForDaemon('dint-browser-disconnect', dir)
    await started.promise

    browser!.emit('disconnected')
    releaseAfterDisconnect.resolve()
    await runPromise

    const [task] = taskStore.listTasksForWorkflow('dint-browser-disconnect')
    assert.equal(task.state, 'cancelled')
  } finally {
    taskStore.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('runWorkflowDaemon: /stop force-cancels an in-flight handler parked in a signal-only wait (no live browser)', async () => {
  // Regression: oath-upload's `wait-approval` step parks the handler in
  // `subscribeToApproval` — a NON-Playwright, signal-only await — with NO
  // live browser (ServiceNow auth is deferred until after the wait). A
  // force-stop tears the daemon down by aborting the LAUNCH controller and
  // killing chromium, but neither unblocks a signal-only await. Pre-fix the
  // force-stop never aborted the in-flight run's per-run AbortController, so
  // the claim loop stayed blocked on `await runOneItem`, never re-observed
  // `shuttingDown`, and never reached the outer-finally shutdown sweep — a
  // deadlock: the daemon stayed alive forever and the row stayed "running".
  clear()
  const dir = mkdtempSync(join(tmpdir(), 'daemon-int-stop-signal-wait-'))
  const control = openControlDb({ trackerDir: dir })
  const taskStore = createTaskStore(control)
  let port: number | undefined
  let inFlight: { itemId: string; runId: string } | null = null
  let runPromise: Promise<void> | undefined
  try {
    const started = deferred()
    const wf = defineWorkflow({
      name: 'dint-stop-signal-wait',
      schema: z.object({ id: z.string() }),
      steps: ['wait-approval'],
      systems: [],
      authSteps: false,
      getId: (d) => (d as { id: string }).id,
      handler: async (ctx) => {
        await ctx.step('wait-approval', async () => {
          started.resolve()
          // Signal-only await: resolves only when ctx.signal aborts. No
          // Playwright call, no browser — killing chromium does nothing.
          await new Promise<void>((_resolve, reject) => {
            if (ctx.signal.aborted) {
              reject(new Error('aborted before wait'))
              return
            }
            ctx.signal.addEventListener(
              'abort',
              () => reject(new Error('approval wait aborted')),
              { once: true },
            )
          })
        })
      },
    })

    await enqueueItems<{ id: string }>('dint-stop-signal-wait', [{ id: 'held' }], (d) => d.id, dir)
    runPromise = runWorkflowDaemon(wf, {
      trackerDir: dir,
      sessionLaunchFn: stubLaunch(),
      idleTimeoutMs: 10_000,
    })
    ;({ port } = await waitForDaemon('dint-stop-signal-wait', dir))
    await started.promise

    const status = (await fetch(`http://127.0.0.1:${port}/status`).then((r) => r.json())) as {
      inFlight: string | null
      inFlightRunId: string | null
    }
    if (status.inFlight && status.inFlightRunId) {
      inFlight = { itemId: status.inFlight, runId: status.inFlightRunId }
    }

    await fetch(`http://127.0.0.1:${port}/stop`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ force: true }),
    })

    // The daemon MUST exit. Pre-fix this races to the timeout (deadlock).
    await Promise.race([
      runPromise,
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error('daemon did not stop while parked in a signal-only wait (deadlock)')),
          4_000,
        ),
      ),
    ])

    const [task] = taskStore.listTasksForWorkflow('dint-stop-signal-wait')
    // Single daemon, force `/stop` with no `reassign` and no surviving peer →
    // the in-flight item FAILS (red), per the 2026-06-07 reassign-or-fail
    // model. (A per-instance stop with a live peer would re-queue it instead.)
    assert.equal(task.state, 'failed')
  } finally {
    // Best-effort: if the daemon is still parked (fix absent → /stop
    // deadlocked), /cancel-current DOES abort ctx.signal and unblocks the
    // handler, so the leaked daemon exits instead of hanging the runner.
    if (port !== undefined && inFlight) {
      await fetch(`http://127.0.0.1:${port}/cancel-current`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(inFlight),
      }).catch(() => {})
    }
    if (runPromise) {
      await Promise.race([
        runPromise.catch(() => {}),
        new Promise((r) => setTimeout(r, 2_000)),
      ])
    }
    taskStore.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('runWorkflowDaemon: force-/stop of an in-flight signal-only wait writes EXACTLY ONE terminal row (failed, NO step:cancelled) — VQ-003', async () => {
  // VQ-003 regression. Pre-fix, a force-shutdown of a daemon parked in a
  // signal-only wait DOUBLE-terminalized the one in-flight run:
  //   1. `withTrackedWorkflow`'s catch emitted a `failed/step:cancelled` row
  //      when the abort unwound the handler (the kernel's cancelled terminal).
  //   2. `failInFlightItem` then emitted the canonical
  //      `failed` (no step:cancelled) row from the daemon teardown.
  // Latest-wins landed the right red FAILED, but the transient orange
  // Cancelled chip + "Cancelled by user" cause polluted the row history. The
  // fix threads `origin:'shutdown'` through `runRegistry.cancel` so the kernel
  // suppresses its terminal cancelled row for daemon-originated cancels,
  // leaving the daemon's `failInFlightItem` the SOLE terminal emitter.
  clear()
  const dir = mkdtempSync(join(tmpdir(), 'daemon-int-vq003-'))
  const control = openControlDb({ trackerDir: dir })
  const taskStore = createTaskStore(control)
  let port: number | undefined
  let inFlight: { itemId: string; runId: string } | null = null
  let runPromise: Promise<void> | undefined
  try {
    const started = deferred()
    const wf = defineWorkflow({
      name: 'dint-vq003',
      schema: z.object({ id: z.string() }),
      steps: ['wait-approval'],
      systems: [],
      authSteps: false,
      getId: (d) => (d as { id: string }).id,
      handler: async (ctx) => {
        await ctx.step('wait-approval', async () => {
          started.resolve()
          await new Promise<void>((_resolve, reject) => {
            if (ctx.signal.aborted) {
              reject(new Error('aborted before wait'))
              return
            }
            ctx.signal.addEventListener(
              'abort',
              () => reject(new Error('approval wait aborted')),
              { once: true },
            )
          })
        })
      },
    })

    await enqueueItems<{ id: string }>('dint-vq003', [{ id: 'held' }], (d) => d.id, dir)
    runPromise = runWorkflowDaemon(wf, {
      trackerDir: dir,
      sessionLaunchFn: stubLaunch(),
      idleTimeoutMs: 10_000,
    })
    ;({ port } = await waitForDaemon('dint-vq003', dir))
    await started.promise

    const status = (await fetch(`http://127.0.0.1:${port}/status`).then((r) => r.json())) as {
      inFlight: string | null
      inFlightRunId: string | null
    }
    if (status.inFlight && status.inFlightRunId) {
      inFlight = { itemId: status.inFlight, runId: status.inFlightRunId }
    }
    assert.ok(inFlight, 'precondition: daemon reports an in-flight run')
    const runId = inFlight.runId

    // Workflow-scoped Stop-All: force, no reassign, no peer → in-flight FAILS.
    await fetch(`http://127.0.0.1:${port}/stop`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ force: true }),
    })

    await Promise.race([
      runPromise,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('daemon did not stop (deadlock)')), 4_000),
      ),
    ])

    const [task] = taskStore.listTasksForWorkflow('dint-vq003')
    assert.equal(task.state, 'failed', 'in-flight item fails for a lone-daemon force-stop')

    // Inspect the JSONL row history for THIS run. The contract: exactly ONE
    // terminal row for the run — status `failed`, NO `step:"cancelled"` — and
    // NO transient `failed/step:cancelled` row written before it.
    const date = dateLocal()
    const jsonlPath = rowFilePath('dint-vq003', date, dir)
    const rows = readFileSync(jsonlPath, 'utf-8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { id?: string; runId?: string; status?: string; step?: string; error?: string })
      .filter((row) => row.runId === runId)

    const cancelledRows = rows.filter((r) => r.status === 'failed' && r.step === 'cancelled')
    assert.equal(
      cancelledRows.length,
      0,
      `expected NO failed/step:cancelled kernel row for the shutdown-aborted run; got ${cancelledRows.length}`,
    )

    const terminalFailed = rows.filter((r) => r.status === 'failed' && r.step !== 'cancelled')
    assert.equal(
      terminalFailed.length,
      1,
      `expected EXACTLY ONE terminal failed row; got ${terminalFailed.length}`,
    )
    assert.equal(
      terminalFailed[0].error,
      'Daemon stopped and no other daemon is available to finish this item.',
      'the sole terminal row carries the no-daemon fail reason, not "Cancelled by user"',
    )
  } finally {
    if (port !== undefined && inFlight) {
      await fetch(`http://127.0.0.1:${port}/cancel-current`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(inFlight),
      }).catch(() => {})
    }
    if (runPromise) {
      await Promise.race([runPromise.catch(() => {}), new Promise((r) => setTimeout(r, 2_000))])
    }
    taskStore.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('runWorkflowDaemon: deliberate /cancel-current of an in-flight signal-only wait writes EXACTLY ONE terminal row (failed/step:cancelled) — E2E-101', async () => {
  // E2E-101 regression. A deliberate `/cancel-current` of an oath-upload-style
  // ticket parked in a SIGNAL-ONLY wait (wait-approval) DOUBLE-terminalized the
  // one in-flight run:
  //   1. `withTrackedWorkflow`'s catch emitted a `failed/step:cancelled` row
  //      (the kernel's terminal cancelled row) when the abort unwound the
  //      handler — NOT suppressed for a deliberate cancel (origin:'user').
  //   2. the daemon's deliberate-cancel branch ALSO emitted its own
  //      `failed/step:cancelled` row.
  // Both rows are CONSISTENT (one orange surface after latest-wins), so the
  // display is correct — but the "exactly one terminal write per run" invariant
  // was violated (two rows ~32ms apart). The fix: a terminal-write guard keyed
  // by runId makes the daemon's deliberate-cancel branch a no-op once the kernel
  // already wrote the run's terminal row (and vice-versa), so the run keeps its
  // single orange `failed/step:cancelled` terminal. Unlike VQ-003 (shutdown
  // origin → kernel SUPPRESSES, daemon owns), a deliberate cancel keeps the
  // kernel row and the daemon defers — net exactly one in both cases.
  clear()
  const dir = mkdtempSync(join(tmpdir(), 'daemon-int-e2e101-'))
  const control = openControlDb({ trackerDir: dir })
  const taskStore = createTaskStore(control)
  let port: number | undefined
  let inFlight: { itemId: string; runId: string } | null = null
  let runPromise: Promise<void> | undefined
  try {
    const started = deferred()
    const wf = defineWorkflow({
      name: 'dint-e2e101',
      schema: z.object({ id: z.string() }),
      steps: ['wait-approval'],
      systems: [],
      authSteps: false,
      getId: (d) => (d as { id: string }).id,
      handler: async (ctx) => {
        await ctx.step('wait-approval', async () => {
          started.resolve()
          await new Promise<void>((_resolve, reject) => {
            if (ctx.signal.aborted) {
              reject(new Error('aborted before wait'))
              return
            }
            ctx.signal.addEventListener(
              'abort',
              () => reject(new Error('approval wait aborted')),
              { once: true },
            )
          })
        })
      },
    })

    await enqueueItems<{ id: string }>('dint-e2e101', [{ id: 'held' }], (d) => d.id, dir)
    runPromise = runWorkflowDaemon(wf, {
      trackerDir: dir,
      sessionLaunchFn: stubLaunch(),
      idleTimeoutMs: 10_000,
    })
    ;({ port } = await waitForDaemon('dint-e2e101', dir))
    await started.promise

    const status = (await fetch(`http://127.0.0.1:${port}/status`).then((r) => r.json())) as {
      inFlight: string | null
      inFlightRunId: string | null
    }
    if (status.inFlight && status.inFlightRunId) {
      inFlight = { itemId: status.inFlight, runId: status.inFlightRunId }
    }
    assert.ok(inFlight, 'precondition: daemon reports an in-flight run')
    const runId = inFlight.runId

    // Deliberate per-item cancel — the daemon STAYS alive (no force, no
    // reassign). Renders Cancelled (orange) via `step:"cancelled"`.
    const cancelRes = await fetch(`http://127.0.0.1:${port}/cancel-current`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(inFlight),
    })
    assert.equal(cancelRes.status, 200, 'cancel-current accepted')

    // The task settles cancelled (deliberate cancel keeps the daemon alive, so
    // it claims nothing else — but the item is terminalized).
    await waitFor(
      () => taskStore.getTaskByRunId(runId)?.state === 'cancelled',
      6_000,
    )
    inFlight = null // cancelled — no best-effort cleanup needed in finally

    // EXACTLY ONE terminal row for the run: status `failed`, step `cancelled`
    // (the orange Cancelled badge). Pre-fix there were TWO (kernel + daemon),
    // ~32ms apart.
    const date = dateLocal()
    const jsonlPath = rowFilePath('dint-e2e101', date, dir)
    const rows = readFileSync(jsonlPath, 'utf-8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { id?: string; runId?: string; status?: string; step?: string })
      .filter((row) => row.runId === runId)

    const cancelledTerminals = rows.filter((r) => r.status === 'failed' && r.step === 'cancelled')
    assert.equal(
      cancelledTerminals.length,
      1,
      `expected EXACTLY ONE failed/step:cancelled terminal row; got ${cancelledTerminals.length}: ${JSON.stringify(cancelledTerminals)}`,
    )
    // And no OTHER terminal (no stray plain failed/done) for the run.
    const otherTerminals = rows.filter(
      (r) => (r.status === 'failed' && r.step !== 'cancelled') || r.status === 'done',
    )
    assert.equal(
      otherTerminals.length,
      0,
      `expected NO non-cancelled terminal row for a deliberate cancel; got ${otherTerminals.length}: ${JSON.stringify(otherTerminals)}`,
    )
  } finally {
    if (port !== undefined && inFlight) {
      await fetch(`http://127.0.0.1:${port}/cancel-current`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(inFlight),
      }).catch(() => {})
    }
    // Deliberate cancel leaves the daemon alive — stop it so the runner exits.
    if (port !== undefined) {
      await fetch(`http://127.0.0.1:${port}/stop`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ force: true }),
      }).catch(() => {})
    }
    if (runPromise) {
      await Promise.race([runPromise.catch(() => {}), new Promise((r) => setTimeout(r, 2_000))])
    }
    taskStore.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('runWorkflowDaemon: per-instance /stop with a RESPONSIVE surviving peer RE-QUEUES the in-flight item (no fail)', async () => {
  // Per-instance stop (dashboard session card) sends `/stop { reassign: true }`.
  // When another daemon for the workflow is still alive AND responds to
  // `/whoami`, the daemon hands its in-flight item back to the queue
  // (returnTaskToQueued) instead of failing it, so a surviving peer finishes
  // the work. Asserts the task lands back in 'queued' (not terminal).
  // (2026-06-07 reassign-or-fail; 2026-06-07 F5 peer health-check.)
  clear()
  const dir = mkdtempSync(join(tmpdir(), 'daemon-int-stop-reassign-'))
  const control = openControlDb({ trackerDir: dir })
  const taskStore = createTaskStore(control)
  let port: number | undefined
  let inFlight: { itemId: string; runId: string } | null = null
  let runPromise: Promise<void> | undefined
  let peerServer: Server | undefined
  try {
    const started = deferred()
    const wf = defineWorkflow({
      name: 'dint-stop-reassign',
      schema: z.object({ id: z.string() }),
      steps: ['wait-approval'],
      systems: [],
      authSteps: false,
      getId: (d) => (d as { id: string }).id,
      handler: async (ctx) => {
        await ctx.step('wait-approval', async () => {
          started.resolve()
          await new Promise<void>((_resolve, reject) => {
            if (ctx.signal.aborted) {
              reject(new Error('aborted before wait'))
              return
            }
            ctx.signal.addEventListener('abort', () => reject(new Error('approval wait aborted')), {
              once: true,
            })
          })
        })
      },
    })

    await enqueueItems<{ id: string }>('dint-stop-reassign', [{ id: 'held' }], (d) => d.id, dir)
    runPromise = runWorkflowDaemon(wf, {
      trackerDir: dir,
      sessionLaunchFn: stubLaunch(),
      idleTimeoutMs: 10_000,
    })
    ;({ port } = await waitForDaemon('dint-stop-reassign', dir))
    await started.promise

    // A surviving, RESPONSIVE peer: a lockfile with a live pid (this process)
    // AND a real `/whoami` server that identity-matches. The shutdown reassign
    // path health-checks peers (F5) before requeuing, so the peer must answer
    // `/whoami` — a dead port would now fail-loud instead. Written AFTER
    // waitForDaemon so the test's own /status + /stop fetches target the real
    // daemon's port (not the peer's); the cache is invalidated so the daemon's
    // reassign-time findAliveDaemons re-probes and includes the peer (the
    // daemon runs in-process, sharing this module's alive-daemons cache).
    ensureDaemonsDir(dir)
    const peerInstanceId = randomInstanceId('dint-stop-reassign')
    ;({ server: peerServer } = await startWhoamiServer('dint-stop-reassign', peerInstanceId))
    const peerPort = (peerServer.address() as AddressInfo).port
    writeLockfile(
      {
        workflow: 'dint-stop-reassign',
        instanceId: peerInstanceId,
        pid: process.pid,
        port: peerPort,
        startedAt: new Date().toISOString(),
        hostname: 'test-peer',
        version: 1,
      },
      lockfilePath('dint-stop-reassign', peerInstanceId, dir),
    )
    invalidateAliveDaemonsCache('dint-stop-reassign', dir)

    const status = (await fetch(`http://127.0.0.1:${port}/status`).then((r) => r.json())) as {
      inFlight: string | null
      inFlightRunId: string | null
    }
    if (status.inFlight && status.inFlightRunId) {
      inFlight = { itemId: status.inFlight, runId: status.inFlightRunId }
    }

    await fetch(`http://127.0.0.1:${port}/stop`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ force: true, reassign: true }),
    })

    await Promise.race([
      runPromise,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('daemon did not stop on per-instance /stop')), 4_000),
      ),
    ])

    const [task] = taskStore.listTasksForWorkflow('dint-stop-reassign')
    // Re-queued for the surviving peer — un-claimed, NOT terminal.
    assert.equal(task.state, 'queued')
  } finally {
    if (port !== undefined && inFlight) {
      await fetch(`http://127.0.0.1:${port}/cancel-current`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(inFlight),
      }).catch(() => {})
    }
    if (runPromise) {
      await Promise.race([runPromise.catch(() => {}), new Promise((r) => setTimeout(r, 2_000))])
    }
    if (peerServer) await new Promise<void>((resolve) => peerServer!.close(() => resolve()))
    taskStore.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('runWorkflowDaemon: per-instance /stop with an UNRESPONSIVE peer FAILS the in-flight item (fail-loud, F5)', async () => {
  // Reassign was requested AND a peer lockfile looks alive (live PID), but the
  // peer's port answers nothing — a wedged/zombie daemon. `findAliveDaemons`
  // trusts it ("unreachable + PID alive"), so the old code would requeue the
  // item to it and it would sit `queued` forever. F5: the shutdown path
  // health-checks the peer with `/whoami`; when none respond it FAILS the
  // in-flight item loudly (terminal `failed`) instead of parking it.
  clear()
  const dir = mkdtempSync(join(tmpdir(), 'daemon-int-stop-reassign-zombie-'))
  const control = openControlDb({ trackerDir: dir })
  const taskStore = createTaskStore(control)
  let port: number | undefined
  let runPromise: Promise<void> | undefined
  try {
    const started = deferred()
    const wf = defineWorkflow({
      name: 'dint-stop-zombie-peer',
      schema: z.object({ id: z.string() }),
      steps: ['wait-approval'],
      systems: [],
      authSteps: false,
      getId: (d) => (d as { id: string }).id,
      handler: async (ctx) => {
        await ctx.step('wait-approval', async () => {
          started.resolve()
          await new Promise<void>((_resolve, reject) => {
            if (ctx.signal.aborted) {
              reject(new Error('aborted before wait'))
              return
            }
            ctx.signal.addEventListener('abort', () => reject(new Error('approval wait aborted')), {
              once: true,
            })
          })
        })
      },
    })

    await enqueueItems<{ id: string }>('dint-stop-zombie-peer', [{ id: 'held' }], (d) => d.id, dir)
    runPromise = runWorkflowDaemon(wf, {
      trackerDir: dir,
      sessionLaunchFn: stubLaunch(),
      idleTimeoutMs: 10_000,
    })
    ;({ port } = await waitForDaemon('dint-stop-zombie-peer', dir))
    await started.promise

    // A WEDGED peer: live PID, but port 59999 answers nothing — `/whoami`
    // times out → 'unreachable'. `findAliveDaemons` keeps it; F5's strict
    // health-check rejects it.
    ensureDaemonsDir(dir)
    const peerInstanceId = randomInstanceId('dint-stop-zombie-peer')
    writeLockfile(
      {
        workflow: 'dint-stop-zombie-peer',
        instanceId: peerInstanceId,
        pid: process.pid,
        port: 59999,
        startedAt: new Date().toISOString(),
        hostname: 'test-peer',
        version: 1,
      },
      lockfilePath('dint-stop-zombie-peer', peerInstanceId, dir),
    )
    invalidateAliveDaemonsCache('dint-stop-zombie-peer', dir)

    await fetch(`http://127.0.0.1:${port}/stop`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ force: true, reassign: true }),
    })

    await Promise.race([
      runPromise,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('daemon did not stop on per-instance /stop')), 6_000),
      ),
    ])

    const [task] = taskStore.listTasksForWorkflow('dint-stop-zombie-peer')
    // Failed loud (terminal), NOT re-queued to a peer that will never claim it.
    assert.equal(task.state, 'failed')
  } finally {
    if (runPromise) {
      await Promise.race([runPromise.catch(() => {}), new Promise((r) => setTimeout(r, 2_000))])
    }
    taskStore.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('runWorkflowDaemon: in-flight shutdown-cancel rows preserve title and row archetype', async () => {
  clear()
  const dir = mkdtempSync(join(tmpdir(), 'daemon-int-stop-running-display-'))
  const control = openControlDb({ trackerDir: dir })
  const taskStore = createTaskStore(control)
  try {
    const parentRunId = 'ocr-parent-run-running'
    const started = deferred()
    const releaseAfterDisconnect = deferred()
    let browser: EventEmitter & { close: () => Promise<void> }
    const wf = defineWorkflow({
      name: 'dint-stop-running-display',
      schema: z.object({
        emplId: z.string(),
        parentSubject: z.string().optional(),
      }),
      steps: ['work'],
      systems: [{ id: 'ucpath', login: async () => {} }],
      authSteps: false,
      archetype: 'single',
      getId: (d) => (d as { emplId: string }).emplId,
      getName: (d) => (d as { emplId?: string; searchName?: string }).searchName ?? (d as { emplId: string }).emplId,
      initialData: (d) => ({ searchName: d.emplId, emplId: d.emplId }),
      queueTitle: { kind: 'single' },
      handler: async (ctx) => {
        await ctx.step('work', async () => {
          started.resolve()
          await releaseAfterDisconnect.promise
          throw new Error('Target page, context or browser has been closed')
        })
      },
    })

    const launchFn = (async (systems: SystemConfig[]) => {
      browser = Object.assign(new EventEmitter(), { close: async () => {} })
      const fakePage = { close: async () => {}, isClosed: () => false } as unknown as import('playwright').Page
      const fakeContext = { close: async () => {}, newPage: async () => fakePage } as unknown as import('playwright').BrowserContext
      return Session.forTesting({
        systems,
        browsers: new Map([
          ['ucpath', { page: fakePage, browser: browser as unknown as import('playwright').Browser, context: fakeContext, chromiumPid: 424246 }],
        ]),
        readyPromises: new Map([['ucpath', Promise.resolve()]]),
      })
    }) as unknown as typeof Session.launch

    await enqueueItems(
      'dint-stop-running-display',
      [{ emplId: '10424984', parentSubject: 'Oath · 4248' }],
      (d) => d.emplId,
      dir,
      undefined,
      [parentRunId],
    )
    const runPromise = runWorkflowDaemon(wf, {
      trackerDir: dir,
      sessionLaunchFn: launchFn,
      idleTimeoutMs: 10_000,
    })
    await waitForDaemon('dint-stop-running-display', dir)
    await started.promise

    browser!.emit('disconnected')
    releaseAfterDisconnect.resolve()
    await runPromise

    const [task] = taskStore.listTasksForWorkflow('dint-stop-running-display')
    assert.equal(task.state, 'cancelled')

    const date = dateLocal()
    const jsonlPath = rowFilePath('dint-stop-running-display', date, dir)
    const rows = readFileSync(jsonlPath, 'utf-8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { id?: string; status?: string; step?: string; parentRunId?: string; data?: Record<string, unknown> })
    const cancelled = rows.find((row) => row.id === '10424984' && row.status === 'failed' && row.step === 'cancelled')
    assert.ok(cancelled, 'expected cancelled tracker row')
    assert.equal(cancelled.parentRunId, parentRunId)
    assert.equal(cancelled.data?.__name, '10424984')
    assert.equal(cancelled.data?.__queueTitle, '10424984')
    assert.equal(cancelled.data?.archetype, 'single')
  } finally {
    taskStore.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('runWorkflowDaemon: /wake after idle resumes and processes new enqueue', async () => {
  clear()
  const dir = mkdtempSync(join(tmpdir(), 'daemon-int-wake-'))
  try {
    const seen: string[] = []
    const wf = defineWorkflow({
      name: 'dint-c',
      schema: z.object({ id: z.string() }),
      steps: ['run'],
      systems: [],
      authSteps: false,
      getId: (d) => (d as { id: string }).id,
      handler: async (ctx, data) => {
        await ctx.step('run', async () => {
          seen.push((data as { id: string }).id)
        })
      },
    })

    const runPromise = runWorkflowDaemon(wf, {
      trackerDir: dir,
      sessionLaunchFn: stubLaunch(),
      idleTimeoutMs: 10_000, // long enough that only /wake unblocks
    })

    const { port } = await waitForDaemon('dint-c', dir)

    // Let the daemon enter the idle wait.
    await new Promise((r) => setTimeout(r, 200))

    await enqueueItems<{ id: string }>('dint-c', [{ id: 'late' }], (d) => d.id, dir)
    await fetch(`http://127.0.0.1:${port}/wake`, { method: 'POST' })

    await waitFor(async () => {
      const st = await readQueueStateIncludingTerminals('dint-c', dir)
      return st.done.length === 1
    }, 5_000)

    assert.deepEqual(seen, ['late'])

    await fetch(`http://127.0.0.1:${port}/stop`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })
    await runPromise
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('runWorkflowDaemon: drain_worker command exits through the natural path', async () => {
  clear()
  const dir = mkdtempSync(join(tmpdir(), 'daemon-int-drain-'))
  const control = openControlDb({ trackerDir: dir })
  const workerStore = createWorkerStore(control)
  try {
    const wf = defineWorkflow({
      name: 'dint-drain',
      schema: z.object({ id: z.string() }),
      steps: ['run'],
      systems: [],
      authSteps: false,
      handler: async () => {},
    })

    const runPromise = runWorkflowDaemon(wf, {
      trackerDir: dir,
      sessionLaunchFn: stubLaunch(),
      idleTimeoutMs: 10_000,
      heartbeatIntervalMs: 50,
      commandPollIntervalMs: 50,
    })

    await waitForDaemon('dint-drain', dir)
    await waitFor(() => workerStore.listWorkers('dint-drain').length === 1)
    const worker = workerStore.listWorkers('dint-drain')[0]
    const commandId = workerStore.enqueueWorkerCommand({
      commandType: 'drain_worker',
      workflow: 'dint-drain',
      targetWorkerId: worker.workerId,
    })

    await runPromise
    assert.equal(workerStore.getCommand(commandId)?.state, 'completed')
    assert.equal(workerStore.getWorker(worker.workerId)?.status, 'stopped')
  } finally {
    workerStore.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('runWorkflowDaemon: stop_worker command exits as hard stop', async () => {
  clear()
  const dir = mkdtempSync(join(tmpdir(), 'daemon-int-stop-command-'))
  const control = openControlDb({ trackerDir: dir })
  const workerStore = createWorkerStore(control)
  try {
    const wf = defineWorkflow({
      name: 'dint-stop-command',
      schema: z.object({ id: z.string() }),
      steps: ['run'],
      systems: [],
      authSteps: false,
      handler: async () => {},
    })

    const runPromise = runWorkflowDaemon(wf, {
      trackerDir: dir,
      sessionLaunchFn: stubLaunch(),
      idleTimeoutMs: 10_000,
      heartbeatIntervalMs: 50,
      commandPollIntervalMs: 50,
    })

    await waitForDaemon('dint-stop-command', dir)
    await waitFor(() => workerStore.listWorkers('dint-stop-command').length === 1)
    const worker = workerStore.listWorkers('dint-stop-command')[0]
    const commandId = workerStore.enqueueWorkerCommand({
      commandType: 'stop_worker',
      workflow: 'dint-stop-command',
      targetWorkerId: worker.workerId,
    })

    await runPromise
    assert.equal(workerStore.getCommand(commandId)?.state, 'completed')
    assert.equal(workerStore.getWorker(worker.workerId)?.status, 'dead')
  } finally {
    workerStore.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('runWorkflowDaemon: /status surfaces queue depth and lastActivity', async () => {
  clear()
  const dir = mkdtempSync(join(tmpdir(), 'daemon-int-status-'))
  try {
    const wf = defineWorkflow({
      name: 'dint-d',
      schema: z.object({ id: z.string() }),
      steps: ['run'],
      systems: [],
      authSteps: false,
      getId: (d) => (d as { id: string }).id,
      handler: async () => {},
    })

    const runPromise = runWorkflowDaemon(wf, {
      trackerDir: dir,
      sessionLaunchFn: stubLaunch(),
      idleTimeoutMs: 10_000,
    })

    const { port } = await waitForDaemon('dint-d', dir)

    const s1 = (await fetch(`http://127.0.0.1:${port}/status`).then((r) => r.json())) as {
      queueDepth: number
      inFlight: string | null
      workflow: string
      instanceId: string
    }
    assert.equal(s1.workflow, 'dint-d')
    assert.equal(s1.inFlight, null)

    await fetch(`http://127.0.0.1:${port}/stop`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })
    await runPromise
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('runWorkflowDaemon: cleans up lockfile even when idle is interrupted', async () => {
  clear()
  const dir = mkdtempSync(join(tmpdir(), 'daemon-int-cleanup-'))
  try {
    const wf = defineWorkflow({
      name: 'dint-e',
      schema: z.object({ id: z.string() }),
      steps: ['a'],
      systems: [],
      authSteps: false,
      handler: async () => {},
    })

    const runPromise = runWorkflowDaemon(wf, {
      trackerDir: dir,
      sessionLaunchFn: stubLaunch(),
      idleTimeoutMs: 10_000,
    })

    const { port } = await waitForDaemon('dint-e', dir)
    const daemonsDir = join(dir, 'daemons')
    const lockfilesBeforeStop = readdirSync(daemonsDir).filter((f) =>
      f.startsWith('dint-e-') && f.endsWith('.lock.json'),
    )
    assert.equal(lockfilesBeforeStop.length, 1)

    await fetch(`http://127.0.0.1:${port}/stop`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })
    await runPromise

    assert.equal(existsSync(join(daemonsDir, lockfilesBeforeStop[0])), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('runWorkflowDaemon: self-heals lockfile when externally deleted', async () => {
  clear()
  const dir = mkdtempSync(join(tmpdir(), 'daemon-int-heal-'))
  try {
    const wf = defineWorkflow({
      name: 'dint-heal',
      schema: z.object({ id: z.string() }),
      steps: ['a'],
      systems: [],
      authSteps: false,
      handler: async () => {},
    })

    const runPromise = runWorkflowDaemon(wf, {
      trackerDir: dir,
      sessionLaunchFn: stubLaunch(),
      idleTimeoutMs: 10_000,
      lockHealIntervalMs: 50,
    })

    const { port } = await waitForDaemon('dint-heal', dir)
    const daemonsSubdir = join(dir, 'daemons')
    const lockfileName = readdirSync(daemonsSubdir).find((f) =>
      f.startsWith('dint-heal-') && f.endsWith('.lock.json'),
    )!
    const lockPath = join(daemonsSubdir, lockfileName)
    assert.ok(existsSync(lockPath), 'lockfile should exist after start')

    // Simulate the bug: something external removes the lockfile while
    // the daemon is healthy. findAliveDaemons would return 0 and trigger
    // a duplicate spawn. The self-heal should rewrite the lockfile within
    // one heal-interval tick.
    rmSync(lockPath)
    assert.equal(existsSync(lockPath), false)

    await waitFor(() => existsSync(lockPath), 2000)
    assert.ok(existsSync(lockPath), 'lockfile should be restored by self-heal')

    // findAliveDaemons must now see the daemon again.
    const alive = await findAliveDaemons('dint-heal', dir)
    assert.equal(alive.length, 1)
    assert.equal(alive[0].port, port)

    await fetch(`http://127.0.0.1:${port}/stop`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })
    await runPromise

    assert.equal(existsSync(lockPath), false, 'lockfile removed on graceful stop')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('runWorkflowDaemon: forwards QueueItem.parentRunId into runOneItem so tracker rows carry it', async () => {
  clear()
  const dir = mkdtempSync(join(tmpdir(), 'daemon-int-parent-'))
  try {
    const wf = defineWorkflow({
      name: 'dint-parent',
      schema: z.object({ id: z.string() }),
      steps: ['run'],
      systems: [],
      authSteps: false,
      getId: (d) => (d as { id: string }).id,
      handler: async (ctx, _data) => {
        await ctx.step('run', async () => {
          // empty
        })
      },
    })

    const parentRunId = 'parent-from-test-12345'
    await enqueueItems<{ id: string }>(
      'dint-parent',
      [{ id: 'child-1' }],
      (d) => d.id,
      dir,
      undefined,
      [parentRunId],
    )

    const runPromise = runWorkflowDaemon(wf, {
      trackerDir: dir,
      sessionLaunchFn: stubLaunch(),
      idleTimeoutMs: 200,
    })
    const { port } = await waitForDaemon('dint-parent', dir)

    await waitFor(async () => {
      const st = await readQueueStateIncludingTerminals('dint-parent', dir)
      return st.done.length === 1
    }, 10_000)

    // Verify tracker JSONL rows for this item carry parentRunId.
    const date = dateLocal()
    const jsonlPath = rowFilePath('dint-parent', date, dir)
    const raw = readFileSync(jsonlPath, 'utf-8')
    const rows = raw
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { id?: string; parentRunId?: string })
    const childRows = rows.filter((r) => r.id === 'child-1')
    assert.ok(childRows.length >= 1, 'expected at least one tracker row for child-1')
    for (const r of childRows) {
      assert.equal(r.parentRunId, parentRunId, `tracker row for child-1 missing parentRunId: ${JSON.stringify(r)}`)
    }

    await fetch(`http://127.0.0.1:${port}/stop`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })
    await runPromise
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('ensureDaemonsAndEnqueue wakes an idle daemon after enqueue (no manual /wake) — ISS-001', async () => {
  clear()
  const dir = mkdtempSync(join(tmpdir(), 'daemon-int-iss001-'))
  try {
    const seen: string[] = []
    const wf = defineWorkflow({
      name: 'dint-iss001',
      schema: z.object({ id: z.string() }),
      steps: ['run'],
      systems: [],
      authSteps: false,
      getId: (d) => (d as { id: string }).id,
      handler: async (ctx, data) => {
        await ctx.step('run', async () => {
          seen.push((data as { id: string }).id)
        })
      },
    })

    const runPromise = runWorkflowDaemon(wf, {
      trackerDir: dir,
      sessionLaunchFn: stubLaunch(),
      idleTimeoutMs: 10_000, // long enough that only /wake unblocks
    })

    await waitForDaemon('dint-iss001', dir)

    // Let the daemon enter the idle wait — no work is queued yet.
    await new Promise((r) => setTimeout(r, 200))

    // Call ensureDaemonsAndEnqueue with NO manual /wake afterward.
    // The fix (ISS-001) ensures the daemon is woken AFTER task rows are
    // written, so the claim loop finds claimable work on its first re-poll.
    await ensureDaemonsAndEnqueue(wf, [{ id: 'late' }], {}, { trackerDir: dir, quiet: true })

    // The daemon must claim and complete the item driven solely by the
    // internal wake fired by ensureDaemonsAndEnqueue — no /wake from us.
    await waitFor(async () => {
      const st = await readQueueStateIncludingTerminals('dint-iss001', dir)
      return st.done.length === 1
    }, 6_000)

    assert.deepEqual(seen, ['late'])

    const { port } = await waitForDaemon('dint-iss001', dir)
    await fetch(`http://127.0.0.1:${port}/stop`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })
    await runPromise
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('runWorkflowDaemon: two daemons spawned serially get DISTINCT instance names (VS-003)', async () => {
  clear()
  const dir = mkdtempSync(join(tmpdir(), 'daemon-int-distinct-names-'))
  try {
    const wf = defineWorkflow({
      name: 'dint-distinct',
      schema: z.object({ id: z.string() }),
      steps: ['a'],
      systems: [],
      authSteps: false,
      handler: async () => {},
    })

    // Daemon A: start and wait until its lockfile (carrying instanceName) is
    // on disk — mirroring the serial spawn the parent does (it only spawns the
    // next daemon AFTER the prior one's lockfile + /whoami are up).
    const runA = runWorkflowDaemon(wf, {
      trackerDir: dir,
      sessionLaunchFn: stubLaunch(),
      idleTimeoutMs: 10_000,
    })
    const a = await waitForDaemon('dint-distinct', dir)

    // Daemon B: start in the SAME trackerDir. Because A's lockfile already
    // exists, B's lockfile-time scan sees A's claimed name and skips it.
    const runB = runWorkflowDaemon(wf, {
      trackerDir: dir,
      sessionLaunchFn: stubLaunch(),
      idleTimeoutMs: 10_000,
    })
    // Wait for two distinct daemons (two alive lockfiles).
    await waitFor(async () => {
      const alive = await findAliveDaemons('dint-distinct', dir)
      return alive.length === 2
    }, 5_000)

    // The two lockfiles must carry DISTINCT instance names "<wf> 1" / "<wf> 2".
    const reserved = scanAliveDaemonInstanceNames('dint-distinct', dir)
    assert.deepEqual(
      [...reserved].sort(),
      ['dint-distinct 1', 'dint-distinct 2'],
      'two concurrently-alive daemons claim distinct lockfile instanceNames',
    )

    // The session events must show two distinct session_create instances —
    // proving the distinct name flowed through preAssignedInstance into
    // withBatchLifecycle (not just the lockfile).
    await waitFor(() => {
      const created = new Set(
        readSessionEvents(dir)
          .filter((e) => e.type === 'session_create')
          .map((e) => e.workflowInstance),
      )
      return created.size === 2
    }, 5_000)
    const createdInstances = new Set(
      readSessionEvents(dir)
        .filter((e) => e.type === 'session_create')
        .map((e) => e.workflowInstance),
    )
    assert.deepEqual(
      [...createdInstances].sort(),
      ['dint-distinct 1', 'dint-distinct 2'],
      'each daemon emitted session_create under its OWN distinct instance name',
    )

    // Stop both daemons.
    const alive = await findAliveDaemons('dint-distinct', dir)
    for (const d of alive) {
      await fetch(`http://127.0.0.1:${d.port}/stop`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ force: false }),
      }).catch(() => {})
    }
    // Touch the start handles so they don't dangle if a /stop above missed.
    void a
    await Promise.all([runA, runB])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('runWorkflowDaemon: allocates from the lockfile scan in the pre-workflow_start race window (VS-003 root)', async () => {
  clear()
  const dir = mkdtempSync(join(tmpdir(), 'daemon-int-race-window-'))
  try {
    const wf = defineWorkflow({
      name: 'dint-race',
      schema: z.object({ id: z.string() }),
      steps: ['a'],
      systems: [],
      authSteps: false,
      handler: async () => {},
    })

    // Simulate the EXACT race: a peer daemon (A) whose lockfile is on disk
    // (carrying its allocated `instanceName`) but which has NOT yet emitted its
    // `workflow_start` session event. This is the window between the peer
    // writing its lockfile (daemon.ts ~242) and `withBatchLifecycle` emitting
    // `workflow_start` (after /whoami comes up). A session-event-only allocator
    // would see ZERO starts here and pick "dint-race 1" — colliding with the
    // peer. The lockfile scan is the only artifact that closes this gap.
    ensureDaemonsDir(dir)
    writeLockfile(
      {
        workflow: 'dint-race',
        instanceId: 'din-peer',
        pid: process.pid, // alive, so the scan counts it
        port: 59999, // never probed by the sync scan
        instanceName: 'dint-race 1',
        startedAt: new Date().toISOString(),
        hostname: 'test',
        version: 1,
      },
      lockfilePath('dint-race', 'din-peer', dir),
    )
    invalidateAliveDaemonsCache('dint-race', dir)

    // Sanity: no session events exist yet — a pure event-count allocator is blind.
    assert.equal(
      readSessionEvents(dir).filter((e) => e.type === 'workflow_start').length,
      0,
      'no workflow_start on disk — the peer is in its pre-start window',
    )

    // Start the real daemon (B). With the fix it scans the peer lockfile, sees
    // "dint-race 1" reserved, and picks "dint-race 2".
    const runB = runWorkflowDaemon(wf, {
      trackerDir: dir,
      sessionLaunchFn: stubLaunch(),
      idleTimeoutMs: 10_000,
    })
    // Wait until B's own lockfile is written with an instanceName.
    await waitFor(() => {
      const names = scanAliveDaemonInstanceNames('dint-race', dir)
      return names.size === 2
    }, 5_000)

    const reserved = scanAliveDaemonInstanceNames('dint-race', dir)
    assert.deepEqual(
      [...reserved].sort(),
      ['dint-race 1', 'dint-race 2'],
      'daemon B picked "dint-race 2" from the peer lockfile scan, NOT a colliding "dint-race 1"',
    )

    // B must also emit its session_create under the distinct name (preAssignedInstance).
    await waitFor(() => {
      return readSessionEvents(dir).some(
        (e) => e.type === 'session_create' && e.workflowInstance === 'dint-race 2',
      )
    }, 5_000)

    const aliveB = (await findAliveDaemons('dint-race', dir)).find((d) => d.instanceId !== 'din-peer')
    if (aliveB) {
      await fetch(`http://127.0.0.1:${aliveB.port}/stop`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ force: false }),
      }).catch(() => {})
    }
    await runB
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
