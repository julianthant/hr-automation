import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { defineWorkflow } from '../../../src/core/workflow.js'
import { clear } from '../../../src/core/registry.js'
import { computeSpawnPlan, ensureDaemonsAndEnqueue } from '../../../src/core/daemon-client.js'
import { readQueueState } from '../../../src/core/daemon-queue.js'

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
    const { writeLockfile, lockfilePath, ensureDaemonsDir } = await import('../../../src/core/daemon-registry.js')
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
    assert.equal(result.enqueued[1].position, 2)
    assert.equal(wakeCount, 1, 'POST /wake hit the stub daemon once')

    const state = await readQueueState('stub-wf', dir)
    assert.equal(state.queued.length, 2)

    await new Promise<void>((r) => server.close(() => r()))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
