import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { defineWorkflow } from '../../../src/core/workflow.js'
import { clear } from '../../../src/core/registry.js'
import { runWorkflowDaemon } from '../../../src/core/daemon.js'
import { Session } from '../../../src/core/session.js'
import { enqueueItems, readQueueState } from '../../../src/core/daemon-queue.js'
import { findAliveDaemons } from '../../../src/core/daemon-registry.js'

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
      const st = await readQueueState('dint-b', dir)
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
      const st = await readQueueState('dint-c', dir)
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
