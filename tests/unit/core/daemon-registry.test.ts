import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  findAliveDaemons,
  writeLockfile,
  readLockfile,
  lockfilePath,
  daemonsDir,
  ensureDaemonsDir,
  isProcessAlive,
  randomInstanceId,
} from '../../../src/core/daemon-registry.js'
import type { DaemonLockfile } from '../../../src/core/daemon-types.js'

const TMP = (): string => mkdtempSync(join(tmpdir(), 'daemon-reg-'))

test('writeLockfile creates atomic lockfile readable by readLockfile', () => {
  const dir = TMP()
  try {
    const lock: DaemonLockfile = {
      workflow: 'wftest',
      instanceId: 'abc',
      pid: process.pid,
      port: 8080,
      startedAt: '2026-04-22T00:00:00Z',
      hostname: 'host',
      version: 1,
    }
    const path = lockfilePath('wftest', 'abc', dir)
    writeLockfile(lock, path)
    assert.equal(existsSync(path), true)
    assert.deepEqual(readLockfile(path), lock)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('readLockfile returns null for missing file', () => {
  const dir = TMP()
  try {
    assert.equal(readLockfile(lockfilePath('wftest', 'missing', dir)), null)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('readLockfile returns null for malformed JSON', () => {
  const dir = TMP()
  try {
    ensureDaemonsDir(dir)
    const path = lockfilePath('wftest', 'bad', dir)
    writeFileSync(path, '{not valid json')
    assert.equal(readLockfile(path), null)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('readLockfile returns null for wrong version', () => {
  const dir = TMP()
  try {
    ensureDaemonsDir(dir)
    const path = lockfilePath('wftest', 'v2', dir)
    writeFileSync(path, JSON.stringify({ version: 2, workflow: 'wftest', instanceId: 'v2', pid: 1, port: 1, startedAt: 'x', hostname: 'h' }))
    assert.equal(readLockfile(path), null)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('isProcessAlive returns true for own PID', () => {
  assert.equal(isProcessAlive(process.pid), true)
})

test('isProcessAlive returns false for unlikely-used PID', () => {
  // PIDs above 4M are impossibly high on macOS/Linux default configs.
  assert.equal(isProcessAlive(9_999_999), false)
})

test('findAliveDaemons returns empty when no lockfiles', async () => {
  const dir = TMP()
  try {
    const alive = await findAliveDaemons('none', dir)
    assert.deepEqual(alive, [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('findAliveDaemons unlinks lockfile for dead PID', async () => {
  const dir = TMP()
  try {
    const path = lockfilePath('wftest', 'dead', dir)
    writeLockfile(
      { workflow: 'wftest', instanceId: 'dead', pid: 9_999_999, port: 1, startedAt: 'x', hostname: 'h', version: 1 },
      path,
    )
    const alive = await findAliveDaemons('wftest', dir)
    assert.deepEqual(alive, [])
    assert.equal(existsSync(path), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('findAliveDaemons preserves lockfile when /whoami is unreachable but PID is alive', async () => {
  const dir = TMP()
  try {
    // Port 1 is virtually guaranteed to fail HTTP connect (unreachable); the
    // PID is our own (alive). Under the previous contract this unlinked the
    // lockfile aggressively — which orphaned healthy daemons whose event loop
    // was momentarily busy (e.g. mid-keepalive sync write), causing
    // enqueueFromHttp to spawn duplicates. New contract: only unlink on
    // dead-PID OR positive identity mismatch from /whoami. An unreachable
    // probe with an alive PID is treated as "transiently busy, trust the
    // lockfile."
    const path = lockfilePath('wftest', 'stolen', dir)
    writeLockfile(
      { workflow: 'wftest', instanceId: 'stolen', pid: process.pid, port: 1, startedAt: 'x', hostname: 'h', version: 1 },
      path,
    )
    const alive = await findAliveDaemons('wftest', dir)
    assert.equal(alive.length, 1)
    assert.equal(alive[0].instanceId, 'stolen')
    assert.equal(existsSync(path), true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('findAliveDaemons unlinks lockfile when /whoami returns a mismatched identity', async () => {
  const dir = TMP()
  try {
    // Spin up a real HTTP server on an ephemeral port that responds to
    // /whoami with a DIFFERENT workflow/instanceId — simulates the "port
    // stolen by an unrelated daemon" case. This is the only scenario where
    // unlinking a lockfile-with-alive-PID is correct: the lockfile points
    // at a port whose resident is provably not us.
    const { createServer } = await import('node:http')
    const server = createServer((req, res) => {
      if (req.url === '/whoami') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ workflow: 'someoneElse', instanceId: 'other' }))
        return
      }
      res.writeHead(404)
      res.end()
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const addr = server.address()
    const port = typeof addr === 'object' && addr ? addr.port : 0
    try {
      const path = lockfilePath('wftest', 'mismatched', dir)
      writeLockfile(
        { workflow: 'wftest', instanceId: 'mismatched', pid: process.pid, port, startedAt: 'x', hostname: 'h', version: 1 },
        path,
      )
      const alive = await findAliveDaemons('wftest', dir)
      assert.deepEqual(alive, [])
      assert.equal(existsSync(path), false)
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('findAliveDaemons filters by workflow name', async () => {
  const dir = TMP()
  try {
    const a = lockfilePath('wfA', 'one', dir)
    writeLockfile(
      { workflow: 'wfA', instanceId: 'one', pid: 9_999_999, port: 1, startedAt: 'x', hostname: 'h', version: 1 },
      a,
    )
    const b = lockfilePath('wfB', 'one', dir)
    writeLockfile(
      { workflow: 'wfB', instanceId: 'one', pid: 9_999_999, port: 1, startedAt: 'x', hostname: 'h', version: 1 },
      b,
    )
    await findAliveDaemons('wfA', dir)
    // Both are dead; both unlinked, but ONLY those matching the requested workflow were checked.
    // Cross-workflow lockfile should still exist since findAliveDaemons('wfA') doesn't touch wfB files.
    assert.equal(existsSync(b), true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('randomInstanceId produces workflow-prefixed short hex', () => {
  const id = randomInstanceId('separations')
  assert.match(id, /^sep-[0-9a-f]{4}$/)
})

test('randomInstanceId handles short or non-alpha workflow names', () => {
  assert.match(randomInstanceId('a'), /^a-[0-9a-f]{4}$/)
  assert.match(randomInstanceId('123'), /^wf-[0-9a-f]{4}$/)
})

test('daemonsDir returns .tracker/daemons by default', () => {
  assert.equal(daemonsDir(), '.tracker/daemons')
})

test('daemonsDir respects trackerDir override', () => {
  assert.equal(daemonsDir('/tmp/custom'), '/tmp/custom/daemons')
})
