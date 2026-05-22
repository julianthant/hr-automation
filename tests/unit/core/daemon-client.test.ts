import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { defineWorkflow } from '../../../src/core/kernel/workflow.js'
import { clear } from '../../../src/core/kernel/registry.js'
import {
  computeSpawnPlan,
  ensureDaemonsAndEnqueue,
  __setSpawnDaemonImplForTests,
  __resetDaemonSpawnLocksForTests,
} from '../../../src/core/daemon/client.js'
import { readQueueState } from '../../../src/core/daemon/queue.js'
import { openControlDb } from '../../../src/core/control-db.js'

// ---- computeSpawnPlan routing rule ----

test('computeSpawnPlan: no flags, 0 alive → 1', () => {
  assert.equal(computeSpawnPlan(0, {}), 1)
})

test('computeSpawnPlan: no flags, 1 alive → 0 (enqueue only)', () => {
  assert.equal(computeSpawnPlan(1, {}), 0)
})

test('computeSpawnPlan: no flags, 3 alive → 0', () => {
  assert.equal(computeSpawnPlan(3, {}), 0)
})

test('computeSpawnPlan: --new, 0 alive → 1', () => {
  assert.equal(computeSpawnPlan(0, { new: true }), 1)
})

test('computeSpawnPlan: --new, 3 alive → 1 (always at least one fresh)', () => {
  assert.equal(computeSpawnPlan(3, { new: true }), 1)
})

test('computeSpawnPlan: --parallel 4, 0 alive → 4', () => {
  assert.equal(computeSpawnPlan(0, { parallel: 4 }), 4)
})

test('computeSpawnPlan: --parallel 4, 2 alive → 2', () => {
  assert.equal(computeSpawnPlan(2, { parallel: 4 }), 2)
})

test('computeSpawnPlan: --parallel 4, 4 alive → 0', () => {
  assert.equal(computeSpawnPlan(4, { parallel: 4 }), 0)
})

test('computeSpawnPlan: --parallel 4, 5 alive → 0', () => {
  assert.equal(computeSpawnPlan(5, { parallel: 4 }), 0)
})

test('computeSpawnPlan: --parallel 4 --new, 2 alive → 2 (deficit covers "at least 1 new")', () => {
  assert.equal(computeSpawnPlan(2, { parallel: 4, new: true }), 2)
})

test('computeSpawnPlan: --parallel 4 --new, 4 alive → 1 (no deficit, but --new forces one fresh)', () => {
  assert.equal(computeSpawnPlan(4, { parallel: 4, new: true }), 1)
})

test('computeSpawnPlan: --parallel 4 --new, 6 alive → 1', () => {
  assert.equal(computeSpawnPlan(6, { parallel: 4, new: true }), 1)
})

// ---- ensureDaemonsAndEnqueue validation ----

test('ensureDaemonsAndEnqueue: empty inputs throws', async () => {
  clear()
  const wf = defineWorkflow({
    name: 'val-empty',
    schema: z.object({ id: z.string() }),
    steps: ['a'],
    systems: [],
    authSteps: false,
    handler: async () => {},
  })
  await assert.rejects(
    ensureDaemonsAndEnqueue(wf, [], {}, { trackerDir: '/tmp/unused' }),
    /must not be empty/,
  )
})

test('ensureDaemonsAndEnqueue: schema-failing input rejects with validation error', async () => {
  clear()
  const wf = defineWorkflow({
    name: 'val-bad',
    schema: z.object({ id: z.string() }),
    steps: ['a'],
    systems: [],
    authSteps: false,
    handler: async () => {},
  })
  await assert.rejects(
    ensureDaemonsAndEnqueue(wf, [{ id: 123 as unknown as string }], {}, { trackerDir: '/tmp/unused' }),
    /validation error/,
  )
})

// Integration-ish: when we stub out registry + spawn via an isolated dir where
// findAliveDaemons returns 0 but spawnDaemon is dangerous to actually call, we
// can't easily test the full flow without subprocess. Instead, verify that the
// enqueue side-effect happens correctly by pre-seeding a "fake alive" daemon
// via a running stub HTTP server + lockfile, so spawnCount=0.

test('ensureDaemonsAndEnqueue: 1 live stub daemon → spawnCount=0, items enqueued + wake attempted', async () => {
  clear()
  const dir = mkdtempSync(join(tmpdir(), 'daemon-client-int-'))
  try {
    const { createServer } = await import('node:http')
    let wakeCount = 0
    const server = createServer((req, res) => {
      if (req.url === '/whoami' && req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ workflow: 'stub-wf', instanceId: 'stub-01', pid: process.pid, version: 1 }))
        return
      }
      if (req.url === '/wake' && req.method === 'POST') {
        wakeCount++
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end('{"ok":true}')
        return
      }
      res.writeHead(404)
      res.end()
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
    const addr = server.address()
    const port = typeof addr === 'object' && addr ? addr.port : 0

    // Write a matching lockfile so findAliveDaemons picks the stub up.
    const { writeLockfile, lockfilePath, ensureDaemonsDir } = await import('../../../src/core/daemon/registry.js')
    ensureDaemonsDir(dir)
    const lp = lockfilePath('stub-wf', 'stub-01', dir)
    writeLockfile(
      {
        workflow: 'stub-wf',
        instanceId: 'stub-01',
        pid: process.pid,
        port,
        startedAt: new Date().toISOString(),
        hostname: 'host',
        version: 1,
      },
      lp,
    )

    const wf = defineWorkflow({
      name: 'stub-wf',
      schema: z.object({ id: z.string() }),
      steps: ['a'],
      systems: [],
      authSteps: false,
      handler: async () => {},
    })

    const result = await ensureDaemonsAndEnqueue(
      wf,
      [{ id: 'item-1' }, { id: 'item-2' }],
      {},
      { trackerDir: dir, quiet: true },
    )

    assert.equal(result.daemons.length, 1, 'used stub daemon, did not spawn a real one')
    assert.equal(result.enqueued.length, 2)
    assert.equal(result.enqueued[0].position, 1)
    assert.ok(result.enqueued[0].taskId)
    assert.match(result.enqueued[0].runId ?? '', /^[0-9a-f-]{36}$/)
    assert.equal(result.enqueued[1].position, 2)
    assert.equal(wakeCount, 1, 'POST /wake hit the stub daemon once')

    const state = await readQueueState('stub-wf', dir)
    assert.equal(state.queued.length, 2)

    await new Promise<void>((r) => server.close(() => r()))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('ensureDaemonsAndEnqueue: forwards parentRunId opt onto every queued item', async () => {
  clear()
  const dir = mkdtempSync(join(tmpdir(), 'daemon-client-parent-'))
  try {
    const { createServer } = await import('node:http')
    const server = createServer((req, res) => {
      if (req.url === '/whoami' && req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ workflow: 'parent-wf', instanceId: 'pwf-01', pid: process.pid, version: 1 }))
        return
      }
      if (req.url === '/wake' && req.method === 'POST') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end('{"ok":true}')
        return
      }
      res.writeHead(404); res.end()
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
    const addr = server.address()
    const port = typeof addr === 'object' && addr ? addr.port : 0

    const { writeLockfile, lockfilePath, ensureDaemonsDir } = await import('../../../src/core/daemon/registry.js')
    ensureDaemonsDir(dir)
    const lp = lockfilePath('parent-wf', 'pwf-01', dir)
    writeLockfile(
      { workflow: 'parent-wf', instanceId: 'pwf-01', pid: process.pid, port, startedAt: new Date().toISOString(), hostname: 'host', version: 1 },
      lp,
    )

    const wf = defineWorkflow({
      name: 'parent-wf',
      schema: z.object({ id: z.string() }),
      steps: ['a'],
      systems: [],
      authSteps: false,
      handler: async () => {},
    })

    const parentRunId = 'parent-test-abc'
    await ensureDaemonsAndEnqueue(
      wf,
      [{ id: 'a' }, { id: 'b' }],
      {},
      { trackerDir: dir, quiet: true, parentRunId },
    )

    const state = await readQueueState('parent-wf', dir)
    assert.equal(state.queued.length, 2)
    assert.equal(state.queued[0].parentRunId, parentRunId)
    assert.equal(state.queued[1].parentRunId, parentRunId)
    const ctl = openControlDb({ trackerDir: dir })
    const rows = ctl.db.prepare(`
      SELECT parent_run_id
      FROM tasks
      WHERE workflow = 'parent-wf'
      ORDER BY rowid ASC
    `).all() as Array<{ parent_run_id: string | null }>
    assert.deepEqual(rows.map((row) => row.parent_run_id), [parentRunId, parentRunId])

    await new Promise<void>((r) => server.close(() => r()))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('ensureDaemonsAndEnqueue: omits parentRunId when not in opts (back-compat)', async () => {
  clear()
  const dir = mkdtempSync(join(tmpdir(), 'daemon-client-noparent-'))
  try {
    const { createServer } = await import('node:http')
    const server = createServer((req, res) => {
      if (req.url === '/whoami' && req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ workflow: 'noparent-wf', instanceId: 'np-01', pid: process.pid, version: 1 }))
        return
      }
      if (req.url === '/wake' && req.method === 'POST') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end('{"ok":true}')
        return
      }
      res.writeHead(404); res.end()
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
    const addr = server.address()
    const port = typeof addr === 'object' && addr ? addr.port : 0
    const { writeLockfile, lockfilePath, ensureDaemonsDir } = await import('../../../src/core/daemon/registry.js')
    ensureDaemonsDir(dir)
    writeLockfile(
      { workflow: 'noparent-wf', instanceId: 'np-01', pid: process.pid, port, startedAt: new Date().toISOString(), hostname: 'host', version: 1 },
      lockfilePath('noparent-wf', 'np-01', dir),
    )
    const wf = defineWorkflow({
      name: 'noparent-wf',
      schema: z.object({ id: z.string() }),
      steps: ['a'],
      systems: [],
      authSteps: false,
      handler: async () => {},
    })
    await ensureDaemonsAndEnqueue(wf, [{ id: 'a' }], {}, { trackerDir: dir, quiet: true })
    const state = await readQueueState('noparent-wf', dir)
    assert.equal(state.queued[0].parentRunId, undefined)
    await new Promise<void>((r) => server.close(() => r()))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('ensureDaemonsAndEnqueue: concurrent same-workflow enqueues spawn only ONE daemon', async () => {
  clear()
  const dir = mkdtempSync(join(tmpdir(), 'daemon-client-race-'))
  const servers: Array<() => Promise<void>> = []
  let spawnCalls = 0
  try {
    const { createServer } = await import('node:http')
    const { writeLockfile, lockfilePath, ensureDaemonsDir } = await import(
      '../../../src/core/daemon/registry.js'
    )
    ensureDaemonsDir(dir)

    // Fake spawn: stand up a stub /whoami+/wake server and write a matching
    // lockfile so the "spawned" daemon is discoverable by findAliveDaemons —
    // mimics a real spawn without the subprocess. Counts invocations.
    __setSpawnDaemonImplForTests(async (workflow, trackerDir) => {
      spawnCalls++
      const instanceId = `race-0${spawnCalls}`
      const server = createServer((req, res) => {
        if (req.url === '/whoami' && req.method === 'GET') {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ workflow, instanceId, pid: process.pid, version: 1 }))
          return
        }
        if (req.url === '/wake' && req.method === 'POST') {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end('{"ok":true}')
          return
        }
        res.writeHead(404)
        res.end()
      })
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
      servers.push(() => new Promise<void>((r) => server.close(() => r())))
      const addr = server.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      const startedAt = new Date().toISOString()
      const lp = lockfilePath(workflow, instanceId, trackerDir)
      writeLockfile(
        { workflow, instanceId, pid: process.pid, port, startedAt, hostname: 'host', version: 1 },
        lp,
      )
      return { workflow, instanceId, pid: process.pid, port, startedAt, lockfilePath: lp }
    })

    const wf = defineWorkflow({
      name: 'race-wf',
      schema: z.object({ id: z.string() }),
      steps: ['a'],
      systems: [],
      authSteps: false,
      handler: async () => {},
    })

    // Two enqueues fired concurrently with no daemon alive. Pre-fix, both
    // observe 0 alive in the discover→spawn race and each spawn → spawnCalls===2.
    const [r1, r2] = await Promise.all([
      ensureDaemonsAndEnqueue(wf, [{ id: 'x' }], {}, { trackerDir: dir, quiet: true }),
      ensureDaemonsAndEnqueue(wf, [{ id: 'y' }], {}, { trackerDir: dir, quiet: true }),
    ])

    assert.equal(spawnCalls, 1, 'exactly one daemon spawned despite two concurrent enqueues')
    assert.equal(r1.daemons.length, 1)
    assert.equal(r2.daemons.length, 1)
    assert.equal(
      r1.daemons[0].instanceId,
      r2.daemons[0].instanceId,
      'both enqueues resolve to the same daemon',
    )

    const state = await readQueueState('race-wf', dir)
    assert.equal(state.queued.length, 2, 'both items enqueued onto the shared queue')
  } finally {
    __setSpawnDaemonImplForTests(null)
    __resetDaemonSpawnLocksForTests()
    for (const close of servers) await close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('ensureDaemonsAndEnqueue: calls onPreparedItems with stable ids and runIds before enqueue', async () => {
  clear()
  const dir = mkdtempSync(join(tmpdir(), 'daemon-client-prepared-'))
  try {
    const { createServer } = await import('node:http')
    const server = createServer((req, res) => {
      if (req.url === '/whoami' && req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ workflow: 'prepared-wf', instanceId: 'prep-01', pid: process.pid, version: 1 }))
        return
      }
      if (req.url === '/wake' && req.method === 'POST') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end('{"ok":true}')
        return
      }
      res.writeHead(404)
      res.end()
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const addr = server.address()
    const port = typeof addr === 'object' && addr ? addr.port : 0

    const { writeLockfile, lockfilePath, ensureDaemonsDir } = await import('../../../src/core/daemon/registry.js')
    ensureDaemonsDir(dir)
    writeLockfile(
      { workflow: 'prepared-wf', instanceId: 'prep-01', pid: process.pid, port, startedAt: new Date().toISOString(), hostname: 'host', version: 1 },
      lockfilePath('prepared-wf', 'prep-01', dir),
    )

    const wf = defineWorkflow({
      name: 'prepared-wf',
      schema: z.object({ label: z.string() }),
      steps: ['a'],
      systems: [],
      authSteps: false,
      handler: async () => {},
    })

    const preparedCalls: unknown[] = []
    const pendingCalls: unknown[] = []
    await ensureDaemonsAndEnqueue(
      wf,
      [{ label: 'one' }, { label: 'two' }],
      {},
      {
        trackerDir: dir,
        quiet: true,
        deriveItemId: (item) => `id-${(item as { label: string }).label}`,
        onPreparedItems: (items) => {
          preparedCalls.push(items.map((item) => ({ itemId: item.itemId, runId: item.runId })))
        },
        onPreEmitPending: (_input, runId, _parentRunId, itemId) => {
          pendingCalls.push({ itemId, runId })
        },
      },
    )

    assert.equal(preparedCalls.length, 1)
    assert.deepEqual((preparedCalls[0] as Array<{ itemId: string }>).map((x) => x.itemId), ['id-one', 'id-two'])
    assert.deepEqual(
      pendingCalls,
      preparedCalls[0],
      'pending callback should receive the same ids/runIds prepared for dependency creation',
    )

    await new Promise<void>((resolve) => server.close(() => resolve()))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
