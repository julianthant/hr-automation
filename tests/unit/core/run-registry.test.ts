import { test } from 'vitest'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createRunRegistry,
  _resetRunRegistryForTests,
  runRegistry,
  type RunHandle,
} from '../../../src/core/run-registry.js'
import type { Session } from '../../../src/core/kernel/session.js'
import { openControlDb } from '../../../src/core/control-db.js'
import { createTaskStore } from '../../../src/core/task-store/index.js'
import { createWorkerStore } from '../../../src/core/daemon/worker-store.js'

interface FakeSession {
  killChromeHard: (graceMs?: number) => Promise<number>
  killCalls: number[]
}

function makeFakeSession(opts: { throwOnKill?: boolean } = {}): FakeSession {
  const calls: number[] = []
  return {
    killCalls: calls,
    async killChromeHard(graceMs = 0) {
      calls.push(graceMs)
      if (opts.throwOnKill) throw new Error('boom')
      return calls.length
    },
  }
}

function makeHandle(opts: {
  runId?: string
  itemId?: string
  workflow?: string
  source?: 'daemon' | 'in-process'
  session?: FakeSession
} = {}): RunHandle {
  const fake = opts.session ?? makeFakeSession()
  return {
    runId: opts.runId ?? 'r1',
    itemId: opts.itemId ?? 'item-1',
    workflow: opts.workflow ?? 'wf',
    controller: new AbortController(),
    session: fake as unknown as Session,
    startedAt: Date.now(),
    source: opts.source ?? 'in-process',
  }
}

test('runRegistry: register + get + list returns the handle', () => {
  const r = createRunRegistry()
  const handle = makeHandle({ runId: 'r1' })
  r.register(handle)
  assert.equal(r.get('r1')?.runId, 'r1')
  assert.equal(r.list().length, 1)
  assert.equal(r.list()[0]?.runId, 'r1')
})

test('runRegistry: unregister removes the handle; subsequent cancel returns not-found', async () => {
  const r = createRunRegistry()
  r.register(makeHandle({ runId: 'r1' }))
  r.unregister('r1')
  assert.equal(r.get('r1'), undefined)
  assert.equal(r.list().length, 0)

  const result = await r.cancel('r1', { reason: 'test', hardKillAfterMs: 0 })
  assert.deepEqual(result, { ok: false, reason: 'not-found' })
})

test('runRegistry: cancel aborts the controller + returns hardKilled=false when run unregisters in time', async () => {
  const r = createRunRegistry()
  const fake = makeFakeSession()
  const handle = makeHandle({ runId: 'r1', session: fake })
  r.register(handle)

  // Simulate the run completing gracefully right after cancel: unregister
  // from another microtask before the watchdog fires.
  const cancelP = r.cancel('r1', { reason: 'test', hardKillAfterMs: 200 })
  setTimeout(() => r.unregister('r1'), 25)
  const result = await cancelP

  assert.deepEqual(result, { ok: true, alreadyCancelled: false, hardKilled: false })
  assert.equal(handle.controller.signal.aborted, true, 'controller aborted')
  assert.equal(fake.killCalls.length, 0, 'killChromeHard NOT called when run unregistered in time')
})

test('runRegistry: cancel triggers watchdog hard-kill when run does not unregister', async () => {
  const r = createRunRegistry()
  const fake = makeFakeSession()
  r.register(makeHandle({ runId: 'r1', session: fake }))

  const result = await r.cancel('r1', { reason: 'test', hardKillAfterMs: 50 })

  assert.deepEqual(result, { ok: true, alreadyCancelled: false, hardKilled: true })
  assert.equal(fake.killCalls.length, 1, 'killChromeHard called exactly once via watchdog')
})

test('runRegistry: hardKillAfterMs=0 disables the watchdog — returns immediately with hardKilled=false', async () => {
  const r = createRunRegistry()
  const fake = makeFakeSession()
  r.register(makeHandle({ runId: 'r1', session: fake }))

  const result = await r.cancel('r1', { reason: 'shutdown', hardKillAfterMs: 0 })

  assert.deepEqual(result, { ok: true, alreadyCancelled: false, hardKilled: false })
  assert.equal(fake.killCalls.length, 0, 'no hard-kill when watchdog is disabled')
})

test('runRegistry: second cancel is idempotent — returns alreadyCancelled=true and does not re-abort or re-kill', async () => {
  const r = createRunRegistry()
  const fake = makeFakeSession()
  const handle = makeHandle({ runId: 'r1', session: fake })
  r.register(handle)

  const first = await r.cancel('r1', { reason: 'first', hardKillAfterMs: 0 })
  assert.deepEqual(first, { ok: true, alreadyCancelled: false, hardKilled: false })

  const second = await r.cancel('r1', { reason: 'second', hardKillAfterMs: 0 })
  assert.deepEqual(second, { ok: true, alreadyCancelled: true, hardKilled: false })
  assert.equal(fake.killCalls.length, 0)
})

test('runRegistry: kill failure inside watchdog surfaces as ok=true (best-effort)', async () => {
  const r = createRunRegistry()
  const fake = makeFakeSession({ throwOnKill: true })
  r.register(makeHandle({ runId: 'r1', session: fake }))

  // Should not throw — kill failures must never propagate out of cancel.
  const result = await r.cancel('r1', { reason: 'test', hardKillAfterMs: 50 })
  assert.equal(result.ok, true)
  if (result.ok) {
    assert.equal(result.hardKilled, true)
  }
})

test('runRegistry: browserless handle (no session) aborts the controller but skips the watchdog (OCR prep)', async () => {
  // The in-process OCR prep (`/api/ocr/prepare`) registers a handle with NO
  // `session` — it runs the orchestrator in the dashboard's Node process with no
  // chromium. Cancel must still abort the controller (the orchestrator bridges
  // the signal to its prepare-abort flag), but there is nothing to hard-kill, so
  // the watchdog is skipped: cancel returns immediately with hardKilled=false even
  // though the run never unregisters within the window.
  const r = createRunRegistry()
  const handle: RunHandle = {
    runId: 'ocr-prep-1',
    itemId: 'session-1',
    workflow: 'ocr',
    controller: new AbortController(),
    startedAt: Date.now(),
    source: 'in-process',
    // no session
  }
  r.register(handle)

  // hardKillAfterMs is non-zero, yet the call returns at once (no 200ms wait)
  // because the browserless branch short-circuits before the watchdog.
  const started = Date.now()
  const result = await r.cancel('ocr-prep-1', { reason: 'dashboard_in_process', hardKillAfterMs: 200 })
  const elapsed = Date.now() - started

  assert.deepEqual(result, { ok: true, alreadyCancelled: false, hardKilled: false })
  assert.equal(handle.controller.signal.aborted, true, 'controller aborted so the orchestrator unwinds')
  assert.ok(elapsed < 150, `browserless cancel returns immediately (no watchdog wait); took ${elapsed}ms`)
})

test('runRegistry: handle keying is by runId only — same workflow+itemId with different runIds register separately', () => {
  const r = createRunRegistry()
  r.register(makeHandle({ runId: 'r1', workflow: 'wf', itemId: 'x' }))
  r.register(makeHandle({ runId: 'r2', workflow: 'wf', itemId: 'x' }))
  assert.equal(r.list().length, 2)
  r.unregister('r1')
  assert.equal(r.list().length, 1)
  assert.equal(r.list()[0]?.runId, 'r2')
})

test('runRegistry: SQLite-backed cancel marks browser rows kill_requested + enqueues kill_browser commands', async () => {
  const r = createRunRegistry()
  const dir = mkdtempSync(join(tmpdir(), 'run-registry-sqlite-'))
  try {
    const control = openControlDb({ trackerDir: dir })
    const taskStore = createTaskStore(control)
    const workerStore = createWorkerStore(control)
    workerStore.registerWorker({
      workerId: 'dashboard:123',
      workflow: 'ocr',
      kind: 'dashboard',
      pid: 123,
      hostname: 'test-host',
      phase: 'processing',
    })
    const [task] = taskStore.enqueueTasks({
      workflow: 'ocr',
      inputs: [{ sessionId: 'ocr-1' }],
      deriveItemId: () => 'ocr-1',
      runIds: ['ocr-run-1'],
    })
    taskStore.markTaskRunning({
      taskId: task.taskId,
      attemptId: task.attemptId,
      workerId: 'dashboard:123',
    })
    const browser = workerStore.upsertBrowserProcess({
      workerId: 'dashboard:123',
      workflow: 'ocr',
      taskId: task.taskId,
      attemptId: task.attemptId,
      systemId: 'sharepoint',
      browserId: 'sharepoint',
      pid: 987654,
    })
    const fake = makeFakeSession()
    r.register({
      runId: 'ocr-run-1',
      itemId: 'ocr-1',
      workflow: 'ocr',
      controller: new AbortController(),
      session: fake as unknown as Session,
      startedAt: Date.now(),
      source: 'in-process',
      control: {
        trackerDir: dir,
        workerId: 'dashboard:123',
        taskId: task.taskId,
        attemptId: task.attemptId,
        controlDb: control,
        taskStore,
        workerStore,
      },
    })

    const result = await r.cancel('ocr-run-1', { reason: 'dashboard', hardKillAfterMs: 0 })

    assert.equal(result.ok, true)
    assert.equal(workerStore.findBrowserProcessById(browser.browserProcessId)?.status, 'kill_requested')
    const commandCount = workerStore.db
      .prepare("SELECT COUNT(*) AS n FROM worker_commands WHERE command_type = 'kill_browser'")
      .get() as { n: number }
    assert.equal(commandCount.n, 1)
    const cancelCount = workerStore.db
      .prepare("SELECT COUNT(*) AS n FROM worker_commands WHERE command_type = 'cancel_task'")
      .get() as { n: number }
    assert.equal(cancelCount.n, 1, 'cancel_task audit row written')
    workerStore.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('runRegistry: cancelOrigin records the structured origin (VQ-003) — defaults to user, shutdown when passed', async () => {
  const r = createRunRegistry()
  r.register(makeHandle({ runId: 'user-run' }))
  r.register(makeHandle({ runId: 'shutdown-run' }))

  // No cancel fired yet → no recorded origin.
  assert.equal(r.cancelOrigin('user-run'), undefined)

  // Default origin is 'user' (deliberate cancel — kernel keeps its orange row).
  await r.cancel('user-run', { reason: 'http_cancel_current', hardKillAfterMs: 0 })
  assert.equal(r.cancelOrigin('user-run'), 'user')

  // Explicit 'shutdown' origin (daemon teardown — kernel suppresses its row).
  await r.cancel('shutdown-run', { reason: 'daemon_shutdown', origin: 'shutdown', hardKillAfterMs: 0 })
  assert.equal(r.cancelOrigin('shutdown-run'), 'shutdown')
})

test('runRegistry: unregister clears the recorded cancel origin so a reused runId cannot inherit it (VQ-003)', async () => {
  const r = createRunRegistry()
  r.register(makeHandle({ runId: 'reused' }))
  await r.cancel('reused', { reason: 'daemon_shutdown', origin: 'shutdown', hardKillAfterMs: 0 })
  assert.equal(r.cancelOrigin('reused'), 'shutdown')

  r.unregister('reused')
  assert.equal(r.cancelOrigin('reused'), undefined, 'origin cleared on unregister')

  // A fresh run reusing the same id starts with no origin until it cancels.
  r.register(makeHandle({ runId: 'reused' }))
  assert.equal(r.cancelOrigin('reused'), undefined, 'reused runId does not inherit the stale shutdown origin')
})

test('runRegistry: a second cancel re-records the origin even after the controller already aborted (VQ-003)', async () => {
  // The suppress check must read the correct origin even when the abort already
  // fired via another path — so cancel records the origin BEFORE the
  // already-cancelled short-circuit.
  const r = createRunRegistry()
  r.register(makeHandle({ runId: 'r1' }))

  await r.cancel('r1', { reason: 'first', origin: 'user', hardKillAfterMs: 0 })
  assert.equal(r.cancelOrigin('r1'), 'user')

  const second = await r.cancel('r1', { reason: 'second', origin: 'shutdown', hardKillAfterMs: 0 })
  assert.equal(second.ok, true)
  if (second.ok) assert.equal(second.alreadyCancelled, true)
  assert.equal(r.cancelOrigin('r1'), 'shutdown', 'origin updated on the second cancel despite already-cancelled')
})

test('runRegistry: shutdown origin is STICKY — a later user cancel does NOT downgrade it (VQ-003 reverse race)', async () => {
  // Reverse of the upgrade test: once daemon teardown claims a run (shutdown),
  // a deliberate /cancel-current (user) arriving afterward must NOT flip the
  // origin back to 'user' — otherwise the kernel would resume emitting its
  // terminal cancelled row while the daemon's teardown already owns the sole
  // terminal, re-introducing the VQ-003 double terminal.
  const r = createRunRegistry()
  r.register(makeHandle({ runId: 'r2' }))

  await r.cancel('r2', { reason: 'shutdown', origin: 'shutdown', hardKillAfterMs: 0 })
  assert.equal(r.cancelOrigin('r2'), 'shutdown')

  await r.cancel('r2', { reason: 'user-cancel', origin: 'user', hardKillAfterMs: 0 })
  assert.equal(r.cancelOrigin('r2'), 'shutdown', 'a later user cancel must not downgrade a shutdown origin')
})

test('runRegistry: module singleton is shared across imports (proves single-process scope)', () => {
  _resetRunRegistryForTests()
  runRegistry.register(makeHandle({ runId: 'global-1' }))
  assert.ok(runRegistry.get('global-1'))
  _resetRunRegistryForTests()
  assert.equal(runRegistry.get('global-1'), undefined)
})

test('runRegistry: _resetRunRegistryForTests clears entries', () => {
  runRegistry.register(makeHandle({ runId: 'reset-1' }))
  runRegistry.register(makeHandle({ runId: 'reset-2' }))
  assert.equal(runRegistry.list().length, 2)
  _resetRunRegistryForTests()
  assert.equal(runRegistry.list().length, 0)
})
