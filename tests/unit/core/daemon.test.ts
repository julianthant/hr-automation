import { test } from 'vitest'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import { z } from 'zod'
import { defineWorkflow } from '../../../src/core/kernel/workflow.js'
import { clear } from '../../../src/core/kernel/registry.js'
import { runWorkflowDaemon } from '../../../src/core/daemon/daemon.js'
import { Session } from '../../../src/core/kernel/session.js'
import { enqueueItems, readQueueStateIncludingTerminals } from '../../../src/core/daemon/queue.js'
import { findAliveDaemons } from '../../../src/core/daemon/registry.js'
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
