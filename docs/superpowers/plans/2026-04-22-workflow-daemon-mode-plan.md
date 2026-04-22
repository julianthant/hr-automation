# Workflow Daemon Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a new kernel run mode (`runWorkflowDaemon`) that keeps a long-lived `Session` alive and consumes items from a shared on-disk queue, letting subsequent CLI invocations of the same workflow enqueue instead of re-paying the Duo/browser-launch cost. Multi-daemon dispatch via atomic filesystem mutex — peers, no coordinator.

**Architecture:** Five new files in `src/core/` (`daemon-types.ts`, `daemon-registry.ts`, `daemon-queue.ts`, `daemon-client.ts`, `daemon.ts`) + one new entry point (`src/cli-daemon.ts`) + surgical edits to `src/cli.ts`, `src/core/batch-lifecycle.ts` (add `ownSigint` flag), and separations + work-study workflow adapters. Existing `runWorkflow` / `runWorkflowBatch` / `runWorkflowPool` / `runWorkflowSharedContextPool` are untouched — daemon mode is additive.

**Tech Stack:** TypeScript, Node 20+, Playwright (unchanged), Vitest. No new runtime deps. Filesystem coordination via `fs.mkdir` (atomic directory-mutex) + `fs.appendFile` (atomic POSIX appends) + `fs.rename` (atomic lockfile writes). Local HTTP IPC via Node's built-in `http` module.

**Reference:** Full design rationale in `docs/superpowers/specs/2026-04-22-workflow-daemon-mode-design.md`. Subagents should read that spec BEFORE starting any task.

---

## Task 1: Define shared types

**Files:**
- Create: `src/core/daemon-types.ts`

- [ ] **Step 1: Create the types module**

```ts
// src/core/daemon-types.ts

/**
 * On-disk shape of a daemon lockfile. Written atomically via tmp + rename.
 * One file per alive daemon: `.tracker/daemons/{workflow}-{instanceId}.lock.json`.
 */
export interface DaemonLockfile {
  workflow: string
  /** Short random hex, e.g. "w1-4a8e". Distinct per daemon for the same workflow. */
  instanceId: string
  pid: number
  /** HTTP listener port (from `server.address()`). */
  port: number
  startedAt: string
  hostname: string
  version: 1
}

/**
 * Hydrated daemon after liveness probe passes. Includes lockfile path for
 * cleanup when the daemon exits or is found dead.
 */
export interface Daemon {
  workflow: string
  instanceId: string
  pid: number
  port: number
  startedAt: string
  lockfilePath: string
}

/**
 * Shared-queue JSONL event shapes. Latest event per `id` wins during fold.
 */
export type QueueEvent =
  | { type: 'enqueue'; id: string; workflow: string; input: unknown; enqueuedAt: string; enqueuedBy: string }
  | { type: 'claim';   id: string; claimedBy: string; claimedAt: string; runId: string }
  | { type: 'unclaim'; id: string; reason: 'recovered' | 'sigint-soft' | 'voluntary'; ts: string }
  | { type: 'done';    id: string; completedAt: string; runId: string }
  | { type: 'failed';  id: string; failedAt: string; runId: string; error: string }

/** A queue item in its current folded state. */
export interface QueueItem {
  id: string
  workflow: string
  input: unknown
  enqueuedAt: string
  state: 'queued' | 'claimed' | 'done' | 'failed'
  claimedBy?: string
  claimedAt?: string
  completedAt?: string
  failedAt?: string
  runId?: string
  error?: string
}

/** Output of `readQueueState`. */
export interface QueueState {
  queued: QueueItem[]
  claimed: QueueItem[]
  done: QueueItem[]
  failed: QueueItem[]
}

/** CLI flags that drive daemon spawn decisions. */
export interface DaemonFlags {
  new?: boolean
  parallel?: number
}

/** Result of `ensureDaemonsAndEnqueue`. */
export interface EnqueueResult {
  enqueued: Array<{ id: string; position: number }>
  daemons: Daemon[]
}
```

- [ ] **Step 2: Commit**

```bash
git add src/core/daemon-types.ts
git commit -m "core(daemon): add shared type definitions for daemon-mode primitives"
```

---

## Task 2: Daemon registry — lockfiles + discovery + spawning

**Files:**
- Create: `src/core/daemon-registry.ts`
- Create: `tests/unit/core/daemon-registry.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
// tests/unit/core/daemon-registry.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  findAliveDaemons,
  writeLockfile,
  readLockfile,
  lockfilePath,
  daemonsDir,
  isProcessAlive,
  randomInstanceId,
} from '../../../src/core/daemon-registry.js'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'daemon-reg-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

describe('daemon-registry lockfile atomicity', () => {
  it('writeLockfile creates the file atomically via tmp+rename', () => {
    const lock = { workflow: 'test', instanceId: 'abc', pid: process.pid, port: 8080, startedAt: '2026-04-22T00:00:00Z', hostname: 'host', version: 1 as const }
    const path = lockfilePath('test', 'abc', dir)
    writeLockfile(lock, path)
    expect(existsSync(path)).toBe(true)
    expect(readLockfile(path)).toEqual(lock)
  })

  it('readLockfile returns null for missing files', () => {
    expect(readLockfile(lockfilePath('test', 'missing', dir))).toBeNull()
  })

  it('readLockfile returns null for malformed JSON', () => {
    const path = lockfilePath('test', 'bad', dir)
    writeFileSync(path, '{not valid json')
    expect(readLockfile(path)).toBeNull()
  })
})

describe('daemon-registry PID liveness', () => {
  it('isProcessAlive returns true for own PID', () => {
    expect(isProcessAlive(process.pid)).toBe(true)
  })
  it('isProcessAlive returns false for unlikely-used PID', () => {
    // PIDs above 4M are impossibly high on macOS/Linux default configs.
    expect(isProcessAlive(9_999_999)).toBe(false)
  })
})

describe('daemon-registry findAliveDaemons', () => {
  it('returns empty array when no lockfiles', async () => {
    expect(await findAliveDaemons('test', dir)).toEqual([])
  })

  it('skips and unlinks lockfiles for dead PIDs', async () => {
    const path = lockfilePath('test', 'dead', dir)
    writeLockfile({ workflow: 'test', instanceId: 'dead', pid: 9_999_999, port: 1, startedAt: 'x', hostname: 'h', version: 1 }, path)
    expect(await findAliveDaemons('test', dir)).toEqual([])
    expect(existsSync(path)).toBe(false)
  })

  it('skips lockfiles whose /whoami handshake fails (port stolen)', async () => {
    // Port 1 is virtually guaranteed to fail HTTP connect.
    const path = lockfilePath('test', 'stolen', dir)
    writeLockfile({ workflow: 'test', instanceId: 'stolen', pid: process.pid, port: 1, startedAt: 'x', hostname: 'h', version: 1 }, path)
    expect(await findAliveDaemons('test', dir)).toEqual([])
    expect(existsSync(path)).toBe(false)
  })
})

describe('daemon-registry randomInstanceId', () => {
  it('produces workflow-prefixed short hex', () => {
    const id = randomInstanceId('separations')
    expect(id).toMatch(/^sep-[0-9a-f]{4,}$/)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npm test -- tests/unit/core/daemon-registry.test.ts
```
Expected: FAIL with "cannot find module" or similar.

- [ ] **Step 3: Implement `src/core/daemon-registry.ts`**

```ts
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import { openSync } from 'node:fs'
import type { Daemon, DaemonLockfile } from './daemon-types.js'

const DEFAULT_DIR = '.tracker/daemons'

export function daemonsDir(trackerDir?: string): string {
  return trackerDir ? join(trackerDir, 'daemons') : DEFAULT_DIR
}

export function lockfilePath(workflow: string, instanceId: string, trackerDir?: string): string {
  return join(daemonsDir(trackerDir), `${workflow}-${instanceId}.lock.json`)
}

export function ensureDaemonsDir(trackerDir?: string): void {
  mkdirSync(daemonsDir(trackerDir), { recursive: true })
}

export function randomInstanceId(workflow: string): string {
  const prefix = workflow.slice(0, 3).toLowerCase().replace(/[^a-z]/g, '') || 'wf'
  return `${prefix}-${randomBytes(2).toString('hex')}`
}

export function writeLockfile(lock: DaemonLockfile, path: string): void {
  mkdirSync(join(path, '..'), { recursive: true })
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`
  writeFileSync(tmp, JSON.stringify(lock))
  renameSync(tmp, path)
}

export function readLockfile(path: string): DaemonLockfile | null {
  try {
    const text = readFileSync(path, 'utf8')
    const parsed = JSON.parse(text) as DaemonLockfile
    if (!parsed || typeof parsed !== 'object') return null
    if (parsed.version !== 1) return null
    if (typeof parsed.pid !== 'number' || typeof parsed.port !== 'number') return null
    return parsed
  } catch {
    return null
  }
}

export function isProcessAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true }
  catch { return false }
}

async function probeWhoami(port: number, expected: { workflow: string; instanceId: string }): Promise<boolean> {
  try {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), 500)
    const res = await fetch(`http://127.0.0.1:${port}/whoami`, { signal: ctrl.signal })
    clearTimeout(t)
    if (!res.ok) return false
    const body = await res.json() as { workflow?: string; instanceId?: string }
    return body.workflow === expected.workflow && body.instanceId === expected.instanceId
  } catch { return false }
}

export async function findAliveDaemons(workflow: string, trackerDir?: string): Promise<Daemon[]> {
  const dir = daemonsDir(trackerDir)
  if (!existsSync(dir)) return []
  const prefix = `${workflow}-`
  const entries = readdirSync(dir).filter((f) => f.startsWith(prefix) && f.endsWith('.lock.json'))
  const alive: Daemon[] = []
  for (const entry of entries) {
    const path = join(dir, entry)
    const lock = readLockfile(path)
    if (!lock || lock.workflow !== workflow) { safeUnlink(path); continue }
    if (!isProcessAlive(lock.pid)) { safeUnlink(path); continue }
    const ok = await probeWhoami(lock.port, { workflow: lock.workflow, instanceId: lock.instanceId })
    if (!ok) { safeUnlink(path); continue }
    alive.push({
      workflow: lock.workflow, instanceId: lock.instanceId, pid: lock.pid,
      port: lock.port, startedAt: lock.startedAt, lockfilePath: path,
    })
  }
  alive.sort((a, b) => a.startedAt.localeCompare(b.startedAt))
  return alive
}

function safeUnlink(path: string): void {
  try { unlinkSync(path) } catch { /* best-effort */ }
}

/**
 * Spawn a detached daemon via `tsx src/cli-daemon.ts <workflow>`.
 * Waits up to 5min for the daemon's lockfile + /whoami handshake.
 */
export async function spawnDaemon(workflow: string, trackerDir?: string): Promise<Daemon> {
  ensureDaemonsDir(trackerDir)
  const logPath = join(daemonsDir(trackerDir), `${workflow}-${new Date().toISOString().replace(/[:.]/g, '-')}.log`)
  const logFd = openSync(logPath, 'a')

  const cmd = 'npx'
  const args = ['tsx', 'src/cli-daemon.ts', workflow]
  const env = { ...process.env }
  if (trackerDir) env.TRACKER_DIR = resolve(trackerDir)

  const child: ChildProcess = spawn(cmd, args, {
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env,
  })
  child.unref()

  // Poll for lockfile-with-handshake. The daemon writes its lockfile AFTER
  // its HTTP server is listening and auth completes; we expect 30s–2min.
  const deadline = Date.now() + 5 * 60 * 1000
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`daemon process exited (code ${child.exitCode}) before ready — check ${logPath}`)
    }
    const candidates = await findAliveDaemons(workflow, trackerDir)
    // Find the daemon matching our child pid.
    const ours = candidates.find((d) => d.pid === child.pid)
    if (ours) return ours
    await delay(500)
  }
  throw new Error(`daemon failed to start within 5min — check ${logPath}`)
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
```

- [ ] **Step 4: Re-run tests to verify they pass**

```bash
npm test -- tests/unit/core/daemon-registry.test.ts
```
Expected: PASS for write/read/atomic/liveness/findAlive. The `spawnDaemon` function is exercised in later integration tests — not here.

- [ ] **Step 5: Commit**

```bash
git add src/core/daemon-registry.ts tests/unit/core/daemon-registry.test.ts
git commit -m "core(daemon): add registry — lockfile atomicity + PID probes + discovery"
```

---

## Task 3: Daemon queue — shared JSONL + atomic claim

**Files:**
- Create: `src/core/daemon-queue.ts`
- Create: `tests/unit/core/daemon-queue.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
// tests/unit/core/daemon-queue.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  enqueueItems,
  claimNextItem,
  markItemDone,
  markItemFailed,
  unclaimItem,
  recoverOrphanedClaims,
  readQueueState,
  queueFilePath,
} from '../../../src/core/daemon-queue.js'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'daemon-q-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

describe('daemon-queue enqueue + fold', () => {
  it('enqueue creates queue file and assigns positions', async () => {
    const ids = ['a', 'b', 'c']
    const result = await enqueueItems('wf', [{ x: 1 }, { x: 2 }, { x: 3 }], (_, i) => ids[i], dir)
    expect(result).toEqual([
      { id: 'a', position: 1 },
      { id: 'b', position: 2 },
      { id: 'c', position: 3 },
    ])
    const state = await readQueueState('wf', dir)
    expect(state.queued.map((q) => q.id)).toEqual(['a', 'b', 'c'])
  })

  it('fold returns latest state per id', async () => {
    await enqueueItems('wf', [{}], () => 'a', dir)
    const claimed = await claimNextItem('wf', 'worker1', dir)
    expect(claimed?.id).toBe('a')
    await markItemDone('wf', 'a', claimed!.runId!, dir)
    const state = await readQueueState('wf', dir)
    expect(state.queued).toHaveLength(0)
    expect(state.claimed).toHaveLength(0)
    expect(state.done.map((q) => q.id)).toEqual(['a'])
  })

  it('claim returns null when queue empty', async () => {
    expect(await claimNextItem('wf', 'worker1', dir)).toBeNull()
  })
})

describe('daemon-queue claim exclusivity', () => {
  it('parallel claims for same item — exactly one wins', async () => {
    await enqueueItems('wf', [{}], () => 'only', dir)
    const attempts = await Promise.all([
      claimNextItem('wf', 'w1', dir),
      claimNextItem('wf', 'w2', dir),
      claimNextItem('wf', 'w3', dir),
    ])
    const wins = attempts.filter((c) => c !== null)
    expect(wins).toHaveLength(1)
  })

  it('claim skips already-claimed items', async () => {
    await enqueueItems('wf', [{}, {}], (_, i) => ['a', 'b'][i], dir)
    const first = await claimNextItem('wf', 'w1', dir)
    const second = await claimNextItem('wf', 'w2', dir)
    expect(first?.id).toBe('a')
    expect(second?.id).toBe('b')
  })
})

describe('daemon-queue recovery', () => {
  it('recoverOrphanedClaims re-queues claims whose owner is not alive', async () => {
    await enqueueItems('wf', [{}], () => 'orphan', dir)
    await claimNextItem('wf', 'dead-worker', dir)
    const count = await recoverOrphanedClaims('wf', new Set(['live-worker']), dir)
    expect(count).toBe(1)
    const state = await readQueueState('wf', dir)
    expect(state.queued.map((q) => q.id)).toEqual(['orphan'])
    expect(state.claimed).toHaveLength(0)
  })

  it('recoverOrphanedClaims leaves claims by alive workers alone', async () => {
    await enqueueItems('wf', [{}], () => 'mine', dir)
    await claimNextItem('wf', 'live-worker', dir)
    const count = await recoverOrphanedClaims('wf', new Set(['live-worker']), dir)
    expect(count).toBe(0)
    const state = await readQueueState('wf', dir)
    expect(state.claimed).toHaveLength(1)
  })
})

describe('daemon-queue markItemFailed', () => {
  it('marks item as failed in state fold', async () => {
    await enqueueItems('wf', [{}], () => 'x', dir)
    const c = await claimNextItem('wf', 'w1', dir)
    await markItemFailed('wf', 'x', 'boom', c!.runId!, dir)
    const state = await readQueueState('wf', dir)
    expect(state.failed.map((q) => q.id)).toEqual(['x'])
  })
})

describe('daemon-queue malformed line tolerance', () => {
  it('skips malformed lines during fold', async () => {
    const { appendFileSync } = await import('node:fs')
    await enqueueItems('wf', [{}], () => 'a', dir)
    appendFileSync(queueFilePath('wf', dir), 'not valid json\n')
    const state = await readQueueState('wf', dir)
    expect(state.queued.map((q) => q.id)).toEqual(['a'])
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npm test -- tests/unit/core/daemon-queue.test.ts
```
Expected: FAIL with "cannot find module".

- [ ] **Step 3: Implement `src/core/daemon-queue.ts`**

Key implementation notes (subagent: read the spec sections "The shared-queue protocol" and "Error handling + edge cases" in full before writing):

1. `queueFilePath(workflow, trackerDir?)` returns `{daemonsDir}/{workflow}.queue.jsonl`.
2. `queueLockDirPath(workflow, trackerDir?)` returns `{daemonsDir}/{workflow}.queue.lock`.
3. `enqueueItems` appends `{ type: 'enqueue', ... }` events one-per-line via `appendFileSync(path, line + '\n')`. Generates a `runId`-free id from the caller-supplied `idFn(input, index) → string` (defaults to `crypto.randomUUID()` if not provided). Position returned is 1-indexed in the current queued list (fold, then `queued.length`).
4. `claimNextItem(workflow, instanceId, trackerDir?)`:
   - Acquire mkdir-mutex with retry: up to 20 attempts with exponential backoff (1ms, 2ms, 4ms, ..., capped at 100ms per sleep; jitter ±30%). If all fail (total budget ~3s), throw a descriptive error that daemon logs + continues.
   - While holding mutex: read queue file, fold, find first `queued` item, write `{ type: 'claim', id, claimedBy: instanceId, claimedAt: ISO, runId: crypto.randomUUID() }` as a new line.
   - Release mutex with `rmdirSync`. Release in finally even on error.
   - Return the claimed item (with `runId` populated) or null if no queued items.
   - Stale-mutex defense: if mkdir fails EEXIST AND the mutex dir's mtime is >5 s in the past, force-remove via `rmdirSync` and retry once. Wrap in try/catch — concurrent removals are benign.
5. `markItemDone` / `markItemFailed` / `unclaimItem`: append a single event line. No mutex (appends are atomic).
6. `recoverOrphanedClaims(workflow, aliveInstanceIds, trackerDir?)`: read state, for each `claimed` item whose `claimedBy` is NOT in the alive set, append `{ type: 'unclaim', reason: 'recovered', ... }`. Returns the count recovered. (Note: this walks `state.claimed` without the mutex — safe because the fold is idempotent and appends are atomic; even if a legitimate daemon claims between our read and our unclaim append, the unclaim-after-reclaim is visible as a later-wins state that any daemon re-folds correctly; worst case is a redundant unclaim, never a lost item.)
7. `readQueueState(workflow, trackerDir?)`: reads file, splits on `\n`, for each line try-parse JSON, silently skip malformed. Fold: walk events in file order; per id, keep the last event's implied state. If `enqueue` is the only event → `queued`. `enqueue` + `claim` → `claimed` (with claimedBy + claimedAt). `enqueue` + `claim` + `unclaim` → `queued` (no claimedBy). `enqueue` + ... + `done` → `done`. `enqueue` + ... + `failed` → `failed`.

Write the full TS file implementing the above. Export every function tested above.

- [ ] **Step 4: Re-run tests, iterate until passing**

```bash
npm test -- tests/unit/core/daemon-queue.test.ts
```
Expected: all assertions pass.

- [ ] **Step 5: Commit**

```bash
git add src/core/daemon-queue.ts tests/unit/core/daemon-queue.test.ts
git commit -m "core(daemon): add shared JSONL queue with atomic directory-mutex claim"
```

---

## Task 4: Daemon client — ensureDaemonsAndEnqueue

**Files:**
- Create: `src/core/daemon-client.ts`
- Create: `tests/unit/core/daemon-client.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
// tests/unit/core/daemon-client.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { defineWorkflow } from '../../../src/core/workflow.js'
import { ensureDaemonsAndEnqueue } from '../../../src/core/daemon-client.js'
import * as registry from '../../../src/core/daemon-registry.js'
import * as queue from '../../../src/core/daemon-queue.js'
import type { Daemon } from '../../../src/core/daemon-types.js'

let dir: string
const mkFakeDaemon = (overrides: Partial<Daemon> = {}): Daemon => ({
  workflow: 'fake', instanceId: 'fake-01', pid: 1, port: 1, startedAt: '2026-04-22T00:00:00Z',
  lockfilePath: '', ...overrides,
})

// Create a throwaway fake workflow for routing tests. Handler is irrelevant —
// client never calls it; it just uses wf.config.name + schema.
const fakeWf = defineWorkflow({
  name: 'fake',
  schema: z.object({ docId: z.string() }),
  steps: ['a'],
  systems: [],
  authSteps: false,
  handler: async () => {},
})

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'daemon-client-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }); vi.restoreAllMocks() })

describe('ensureDaemonsAndEnqueue routing', () => {
  it('no flags, 0 alive → spawns 1', async () => {
    const spy = vi.spyOn(registry, 'findAliveDaemons').mockResolvedValue([])
    const spawn = vi.spyOn(registry, 'spawnDaemon').mockResolvedValue(mkFakeDaemon())
    vi.spyOn(queue, 'enqueueItems').mockResolvedValue([{ id: '1', position: 1 }])
    // Stub the wake POST — no daemon is actually listening.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}')))
    await ensureDaemonsAndEnqueue(fakeWf, [{ docId: '1' }], {}, { trackerDir: dir })
    expect(spawn).toHaveBeenCalledTimes(1)
  })

  it('no flags, 2 alive → spawns 0', async () => {
    vi.spyOn(registry, 'findAliveDaemons').mockResolvedValue([mkFakeDaemon(), mkFakeDaemon({ instanceId: 'b' })])
    const spawn = vi.spyOn(registry, 'spawnDaemon')
    vi.spyOn(queue, 'enqueueItems').mockResolvedValue([{ id: '1', position: 1 }])
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}')))
    await ensureDaemonsAndEnqueue(fakeWf, [{ docId: '1' }], {}, { trackerDir: dir })
    expect(spawn).not.toHaveBeenCalled()
  })

  it('--new, 3 alive → spawns 1', async () => {
    vi.spyOn(registry, 'findAliveDaemons').mockResolvedValue([mkFakeDaemon(), mkFakeDaemon({ instanceId: 'b' }), mkFakeDaemon({ instanceId: 'c' })])
    const spawn = vi.spyOn(registry, 'spawnDaemon').mockResolvedValue(mkFakeDaemon({ instanceId: 'd' }))
    vi.spyOn(queue, 'enqueueItems').mockResolvedValue([{ id: '1', position: 1 }])
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}')))
    await ensureDaemonsAndEnqueue(fakeWf, [{ docId: '1' }], { new: true }, { trackerDir: dir })
    expect(spawn).toHaveBeenCalledTimes(1)
  })

  it('--parallel 4, 2 alive → spawns 2', async () => {
    vi.spyOn(registry, 'findAliveDaemons').mockResolvedValue([mkFakeDaemon(), mkFakeDaemon({ instanceId: 'b' })])
    const spawn = vi.spyOn(registry, 'spawnDaemon').mockResolvedValue(mkFakeDaemon({ instanceId: 'c' }))
    vi.spyOn(queue, 'enqueueItems').mockResolvedValue([{ id: '1', position: 1 }])
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}')))
    await ensureDaemonsAndEnqueue(fakeWf, [{ docId: '1' }], { parallel: 4 }, { trackerDir: dir })
    expect(spawn).toHaveBeenCalledTimes(2)
  })

  it('--parallel 4 --new, 6 alive → spawns 1', async () => {
    const alive = Array.from({ length: 6 }, (_, i) => mkFakeDaemon({ instanceId: `a${i}` }))
    vi.spyOn(registry, 'findAliveDaemons').mockResolvedValue(alive)
    const spawn = vi.spyOn(registry, 'spawnDaemon').mockResolvedValue(mkFakeDaemon({ instanceId: 'new' }))
    vi.spyOn(queue, 'enqueueItems').mockResolvedValue([{ id: '1', position: 1 }])
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}')))
    await ensureDaemonsAndEnqueue(fakeWf, [{ docId: '1' }], { new: true, parallel: 4 }, { trackerDir: dir })
    expect(spawn).toHaveBeenCalledTimes(1)
  })

  it('returns correct enqueue positions', async () => {
    vi.spyOn(registry, 'findAliveDaemons').mockResolvedValue([mkFakeDaemon()])
    vi.spyOn(queue, 'enqueueItems').mockResolvedValue([
      { id: 'a', position: 1 }, { id: 'b', position: 2 },
    ])
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}')))
    const r = await ensureDaemonsAndEnqueue(fakeWf, [{ docId: 'a' }, { docId: 'b' }], {}, { trackerDir: dir })
    expect(r.enqueued).toEqual([{ id: 'a', position: 1 }, { id: 'b', position: 2 }])
    expect(r.daemons).toHaveLength(1)
  })
})
```

- [ ] **Step 2: Run tests to verify failures**

```bash
npm test -- tests/unit/core/daemon-client.test.ts
```
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `src/core/daemon-client.ts`**

```ts
import { findAliveDaemons, spawnDaemon } from './daemon-registry.js'
import { enqueueItems } from './daemon-queue.js'
import type { Daemon, DaemonFlags, EnqueueResult } from './daemon-types.js'
import type { RegisteredWorkflow } from './types.js'
import { deriveItemId } from './workflow.js'
import { randomUUID } from 'node:crypto'
import { log } from '../utils/log.js'

/**
 * The ONE function every daemon-mode CLI adapter calls. Discovers alive
 * daemons, validates inputs, spawns additional daemons as dictated by flags,
 * appends enqueue events to the shared queue, and wakes every alive daemon.
 *
 * Spawn math:
 *   const desired = flags.parallel ?? 1
 *   const deficit = max(0, desired - aliveCount)
 *   spawnCount = flags.new ? max(1, deficit) : deficit
 *
 * `flags.new` guarantees at least one brand-new daemon after return;
 * `flags.parallel = N` guarantees at least N daemons alive after return.
 */
export async function ensureDaemonsAndEnqueue<TData, TSteps extends readonly string[]>(
  wf: RegisteredWorkflow<TData, TSteps>,
  inputs: TData[],
  flags: DaemonFlags = {},
  opts: { trackerDir?: string; quiet?: boolean } = {},
): Promise<EnqueueResult> {
  const { trackerDir, quiet } = opts

  // Validate inputs via workflow schema — fail fast, consistent with runWorkflow.
  for (const input of inputs) {
    try { wf.config.schema.parse(input) }
    catch (err) {
      throw new Error(`validation error: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  const alive = await findAliveDaemons(wf.config.name, trackerDir)
  const desired = flags.parallel ?? 1
  const deficit = Math.max(0, desired - alive.length)
  const spawnCount = flags.new ? Math.max(1, deficit) : deficit

  if (!quiet && spawnCount > 0) {
    const why = flags.new
      ? `--new requested${flags.parallel ? ` + --parallel ${flags.parallel}` : ''}`
      : `--parallel ${desired} with ${alive.length} alive`
    log.step(`[Daemon] Spawning ${spawnCount} new ${wf.config.name} daemon(s) (${why}).`)
    log.step('[Daemon] Approve Duos in the new browser windows; this can take 30s–2min.')
  }

  const spawned: Daemon[] = []
  for (let i = 0; i < spawnCount; i++) {
    // Spawn sequentially because Duo cannot be approved in parallel in practice.
    const d = await spawnDaemon(wf.config.name, trackerDir)
    spawned.push(d)
  }

  const daemons = [...alive, ...spawned]
  if (daemons.length === 0) {
    throw new Error('ensureDaemonsAndEnqueue: expected at least one daemon after spawn phase')
  }

  // Derive item id per input: use workflow's deriveItemId if defined on config,
  // else the standard deriveItemId (emplId → docId → email → UUID fallback).
  const idFn = (input: TData, idx: number): string => {
    const fallback = `${Date.now()}-${idx}-${randomUUID().slice(0, 8)}`
    return deriveItemId(input, fallback)
  }

  const enqueued = await enqueueItems(wf.config.name, inputs, idFn, trackerDir)

  // Fire-and-forget wake — best-effort, ignore failures. Empty-queue daemons
  // resume their claim loop. Busy daemons naturally loop when they finish.
  await Promise.all(
    daemons.map((d) =>
      fetch(`http://127.0.0.1:${d.port}/wake`, { method: 'POST' }).catch(() => { /* ignore */ }),
    ),
  )

  if (!quiet) {
    for (const { id, position } of enqueued) {
      log.success(`Queued ${wf.config.name} '${id}' (position ${position} in queue).`)
    }
    log.step(`${daemons.length} daemon(s) processing.`)
  }

  return { enqueued, daemons }
}

/**
 * Soft-stop (or force-stop) every alive daemon for a workflow. Returns the
 * number of daemons we successfully asked to stop (not guaranteed they
 * actually exited — `findAliveDaemons` on a subsequent call verifies).
 */
export async function stopDaemons(
  workflow: string,
  force: boolean,
  trackerDir?: string,
): Promise<number> {
  const alive = await findAliveDaemons(workflow, trackerDir)
  await Promise.all(
    alive.map((d) =>
      fetch(`http://127.0.0.1:${d.port}/stop`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ force }),
      }).catch(() => { /* ignore */ }),
    ),
  )
  return alive.length
}
```

- [ ] **Step 4: Re-run tests, verify PASS**

```bash
npm test -- tests/unit/core/daemon-client.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add src/core/daemon-client.ts tests/unit/core/daemon-client.test.ts
git commit -m "core(daemon): add client helper — unified spawn/enqueue/wake for CLI adapters"
```

---

## Task 5: `ownSigint` flag for withBatchLifecycle

**Files:**
- Modify: `src/core/batch-lifecycle.ts`
- Modify: `tests/unit/core/batch-lifecycle.test.ts` (if exists — check first)

- [ ] **Step 1: Add the option to `BatchLifecycleOpts`**

```ts
// in src/core/batch-lifecycle.ts — extend BatchLifecycleOpts:
export interface BatchLifecycleOpts<TData> {
  workflow: string
  systems?: SystemConfig[]
  perItem: Array<{ item: unknown; itemId: string; runId: string }>
  trackerDir?: string
  /**
   * When `true` (default), the lifecycle installs its own SIGINT handler that
   * fans out `failed` rows for every non-terminated `perItem` entry and calls
   * `process.exit(130)`. Daemon mode passes `false` because it owns SIGINT
   * (it needs to unclaim the one in-flight item + close the Session cleanly
   * before exiting). When `false`, the body is still wrapped in the try/catch
   * that writes `failed` rows on thrown errors — only the signal handler is
   * skipped.
   */
  ownSigint?: boolean
}
```

- [ ] **Step 2: Branch on the flag inside `withBatchLifecycle`**

Modify the `withBatchLifecycle` function so the `process.on('SIGINT', sigintHandler)` and `process.off(...)` calls are conditional on `opts.ownSigint !== false`. Default behavior unchanged for existing callers.

```ts
// inside withBatchLifecycle:
const ownSigint = opts.ownSigint !== false

const sigintHandler = ownSigint ? (): void => {
  fanoutFailed('Process terminated (SIGINT)')
  closeWorkflow('failed')
  process.exit(130)
} : null

if (sigintHandler) process.on('SIGINT', sigintHandler)

try {
  // ... body as before
} finally {
  if (sigintHandler) process.off('SIGINT', sigintHandler)
}
```

- [ ] **Step 3: Verify existing batch-lifecycle tests still pass**

```bash
npm test -- tests/unit/core/batch-lifecycle.test.ts
```
Expected: PASS.

- [ ] **Step 4: Add a test for `ownSigint: false`**

Append to the existing `batch-lifecycle.test.ts`:

```ts
it('does NOT install SIGINT handler when ownSigint is false', async () => {
  const before = process.listenerCount('SIGINT')
  await withBatchLifecycle(
    { workflow: 'test', perItem: [], ownSigint: false, trackerDir: testDir },
    async () => {
      expect(process.listenerCount('SIGINT')).toBe(before)
    },
  )
})
```

- [ ] **Step 5: Run tests, commit**

```bash
npm test -- tests/unit/core/batch-lifecycle.test.ts
git add src/core/batch-lifecycle.ts tests/unit/core/batch-lifecycle.test.ts
git commit -m "core(batch-lifecycle): add ownSigint flag so daemon mode can own signal handling"
```

---

## Task 6: The main daemon loop — `runWorkflowDaemon`

**Files:**
- Create: `src/core/daemon.ts`
- Create: `tests/unit/core/daemon.test.ts`

**IMPORTANT (subagent):** Read the spec section "Core daemon lifecycle" in full before writing this task. It describes the exact loop structure, keepalive cadence, SIGINT semantics, and orphan recovery. Deviate only for clear bugs.

- [ ] **Step 1: Write the main loop**

```ts
// src/core/daemon.ts
import { randomUUID } from 'node:crypto'
import { hostname } from 'node:os'
import { createServer, type Server } from 'node:http'
import type { RegisteredWorkflow } from './types.js'
import { Session } from './session.js'
import { runOneItem, buildSessionObserver } from './workflow.js'
import { withBatchLifecycle } from './batch-lifecycle.js'
import { log } from '../utils/log.js'
import {
  daemonsDir,
  lockfilePath,
  randomInstanceId,
  writeLockfile,
  findAliveDaemons,
  ensureDaemonsDir,
} from './daemon-registry.js'
import {
  claimNextItem,
  markItemDone,
  markItemFailed,
  unclaimItem,
  recoverOrphanedClaims,
  readQueueState,
} from './daemon-queue.js'
import type { DaemonLockfile } from './daemon-types.js'
import { unlinkSync } from 'node:fs'
import { makeScreenshotFn } from './screenshot.js'
import { emitScreenshotEvent } from '../tracker/jsonl.js'

export interface DaemonOpts {
  trackerDir?: string
}

/**
 * Long-running daemon loop. Must be invoked from a DETACHED process via
 * `src/cli-daemon.ts` (not from the main CLI). Owns:
 *   - HTTP server for /whoami /status /wake /stop
 *   - Lockfile write + cleanup
 *   - Session lifetime
 *   - Shared-queue claim loop with 15-min keepalive + orphan recovery
 *   - SIGINT/SIGTERM handlers (process.exit(0) on graceful; in-flight item
 *     re-queued via unclaim(reason: 'sigint-soft') OR marked failed on force)
 */
export async function runWorkflowDaemon<TData, TSteps extends readonly string[]>(
  wf: RegisteredWorkflow<TData, TSteps>,
  opts: DaemonOpts = {},
): Promise<void> {
  const trackerDir = opts.trackerDir
  ensureDaemonsDir(trackerDir)
  const instanceId = randomInstanceId(wf.config.name)

  // ---- HTTP server + wake event ----
  let wakeResolve: (() => void) | null = null
  let shutdownResolve: (() => void) | null = null
  let forceShutdown = false
  let shuttingDown = false
  let inFlight: { itemId: string; runId: string } | null = null
  let queueDepthCache = 0
  let lastActivity = Date.now()

  const server: Server = createServer((req, res) => {
    const url = req.url ?? '/'
    if (req.method === 'GET' && url === '/whoami') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ workflow: wf.config.name, instanceId, pid: process.pid, version: 1 }))
      return
    }
    if (req.method === 'GET' && url === '/status') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        workflow: wf.config.name,
        instanceId,
        queueDepth: queueDepthCache,
        inFlight: inFlight?.itemId ?? null,
        lastActivity: new Date(lastActivity).toISOString(),
      }))
      return
    }
    if (req.method === 'POST' && url === '/wake') {
      wakeResolve?.()
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"ok":true}')
      return
    }
    if (req.method === 'POST' && url === '/stop') {
      let body = ''
      req.on('data', (c) => { body += c })
      req.on('end', () => {
        try {
          const parsed = body ? JSON.parse(body) as { force?: boolean } : {}
          forceShutdown = !!parsed.force
        } catch { /* ignore */ }
        shuttingDown = true
        shutdownResolve?.()
        wakeResolve?.()
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end('{"ok":true}')
      })
      return
    }
    res.writeHead(404); res.end()
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0

  // ---- Write lockfile ----
  const lock: DaemonLockfile = {
    workflow: wf.config.name,
    instanceId,
    pid: process.pid,
    port,
    startedAt: new Date().toISOString(),
    hostname: hostname(),
    version: 1,
  }
  const lockPath = lockfilePath(wf.config.name, instanceId, trackerDir)
  writeLockfile(lock, lockPath)
  log.step(`[Daemon ${wf.config.name}/${instanceId}] listening on 127.0.0.1:${port} (pid=${process.pid})`)

  // ---- SIGINT/SIGTERM handlers ----
  const sigHandler = (sig: string): void => {
    log.warn(`[Daemon ${wf.config.name}/${instanceId}] received ${sig}; shutting down`)
    shuttingDown = true
    shutdownResolve?.()
    wakeResolve?.()
  }
  process.on('SIGINT', () => sigHandler('SIGINT'))
  process.on('SIGTERM', () => sigHandler('SIGTERM'))

  // ---- Launch session via withBatchLifecycle (ownSigint: false) ----
  await withBatchLifecycle(
    {
      workflow: wf.config.name,
      systems: wf.config.systems,
      perItem: [],  // daemon-mode: items arrive dynamically; no upfront fanout needed
      trackerDir,
      ownSigint: false,
    },
    async ({ instance, markTerminated, makeObserver }) => {
      const { observer, getAuthTimings } = makeObserver('1')
      const session = await Session.launch(wf.config.systems, {
        authChain: wf.config.authChain,
        tiling: wf.config.tiling,
        observer,
      })
      for (const sys of wf.config.systems) {
        try { await session.page(sys.id) } catch { /* auth failure surfaces via withBatchLifecycle */ }
      }
      const authTimings = wf.config.authSteps !== false ? getAuthTimings() : undefined

      // Orphan recovery on startup: re-queue claims owned by dead instances.
      const alive = await findAliveDaemons(wf.config.name, trackerDir)
      const aliveSet = new Set(alive.map((d) => d.instanceId))
      aliveSet.add(instanceId)
      const recovered = await recoverOrphanedClaims(wf.config.name, aliveSet, trackerDir)
      if (recovered > 0) log.step(`[Daemon ${instanceId}] recovered ${recovered} orphan claim(s)`)

      // ---- Main claim loop ----
      try {
        while (!shuttingDown) {
          const state = await readQueueState(wf.config.name, trackerDir)
          queueDepthCache = state.queued.length

          const item = await claimNextItem(wf.config.name, instanceId, trackerDir).catch((e) => {
            log.warn(`[Daemon ${instanceId}] claim error: ${e instanceof Error ? e.message : String(e)}`)
            return null
          })

          if (item) {
            inFlight = { itemId: item.id, runId: item.runId ?? randomUUID() }
            lastActivity = Date.now()
            const r = await runOneItem({
              wf,
              session,
              item: item.input as TData,
              itemId: item.id,
              runId: inFlight.runId,
              trackerDir,
              callerPreEmits: false,
              preAssignedInstance: instance,
              authTimings,
            })
            markTerminated(inFlight.runId)
            if (r.ok) await markItemDone(wf.config.name, item.id, inFlight.runId, trackerDir)
            else await markItemFailed(wf.config.name, item.id, r.error, inFlight.runId, trackerDir)
            inFlight = null
            continue
          }

          // Idle: wait for wake OR 15-min keepalive OR shutdown.
          await new Promise<void>((resolve) => {
            wakeResolve = (): void => { wakeResolve = null; resolve() }
            shutdownResolve = (): void => { shutdownResolve = null; resolve() }
            setTimeout(() => {
              wakeResolve = null; shutdownResolve = null; resolve()
            }, 15 * 60 * 1000).unref()
          })

          if (shuttingDown) break

          // Keepalive: healthCheck each system, re-auth failed ones silently.
          // Re-auth emits fresh `auth:<id>` timings via observer hooks (they're
          // routed by createBatchObserver into `timings[]` — we don't snapshot
          // mid-daemon; each item just uses the initial authTimings). Losing
          // track of re-auth timings in the dashboard is acceptable — next
          // item's chips show the initial auth durations; re-auth itself is
          // visible via log.
          const aliveNow = await findAliveDaemons(wf.config.name, trackerDir)
          const aliveSetNow = new Set(aliveNow.map((d) => d.instanceId))
          aliveSetNow.add(instanceId)
          await recoverOrphanedClaims(wf.config.name, aliveSetNow, trackerDir)

          for (const sys of wf.config.systems) {
            try {
              const ok = await session.healthCheck(sys.id)
              if (!ok) log.warn(`[Daemon ${instanceId}] healthCheck(${sys.id}) failed — next claim may re-auth`)
            } catch (e) {
              log.warn(`[Daemon ${instanceId}] healthCheck(${sys.id}) error: ${e instanceof Error ? e.message : String(e)}`)
            }
          }
        }
      } finally {
        // ---- Graceful shutdown ----
        if (inFlight) {
          // Soft: re-queue. Force: mark failed with `interrupted` reason.
          if (forceShutdown) {
            await markItemFailed(wf.config.name, inFlight.itemId, 'interrupted', inFlight.runId, trackerDir)
          } else {
            await unclaimItem(wf.config.name, inFlight.itemId, 'sigint-soft', trackerDir)
          }
          markTerminated(inFlight.runId)
          inFlight = null
        }
        try { await session.close() } catch { /* best-effort */ }
      }
    },
  )

  // ---- Cleanup ----
  try { unlinkSync(lockPath) } catch { /* best-effort */ }
  await new Promise<void>((resolve) => server.close(() => resolve()))
  log.step(`[Daemon ${wf.config.name}/${instanceId}] exited cleanly`)
}
```

- [ ] **Step 2: Unit tests with mocked Session**

Subagent: write `tests/unit/core/daemon.test.ts` that:
1. Uses `trackerStub: true` indirectly by constructing a workflow with a handler that records calls to a shared array.
2. Mocks `Session.launch` via a local stub that returns an object with `page()`, `healthCheck()`, `close()` no-ops.
3. Spawns `runWorkflowDaemon` in-process on a tmp trackerDir, exercises:
   - Claim loop processes enqueued items in order
   - Queue drains → daemon idles → POST /wake resumes
   - Queue stays empty after wake → daemon idles again
   - POST /stop (no force) → daemon exits; lockfile unlinked; in-flight item (if any) unclaimed
   - POST /stop (force=true) → daemon exits; in-flight item marked failed
4. Use a queue+tracker dir per test via `mkdtempSync`.

Because writing a clean full test for `runWorkflowDaemon` requires stubbing `Session.launch` at module load time, the simplest approach is vi.mock for `./session.js` within the test file. Write at minimum:
- Test: "processes queued items via claim loop".
- Test: "POST /stop cleanly exits and removes lockfile".
- Test: "POST /wake after idle resumes the loop".

- [ ] **Step 3: Run tests + commit**

```bash
npm test -- tests/unit/core/daemon.test.ts
git add src/core/daemon.ts tests/unit/core/daemon.test.ts
git commit -m "core(daemon): add runWorkflowDaemon main loop with HTTP ctrl + keepalive"
```

---

## Task 7: Re-export from kernel index + commit A wrap-up

**Files:**
- Modify: `src/core/index.ts`

- [ ] **Step 1: Add re-exports**

```ts
// append to src/core/index.ts:
export {
  findAliveDaemons,
  spawnDaemon,
  randomInstanceId,
  lockfilePath,
  daemonsDir,
  ensureDaemonsDir,
  writeLockfile,
  readLockfile,
  isProcessAlive,
} from './daemon-registry.js'
export {
  enqueueItems,
  claimNextItem,
  markItemDone,
  markItemFailed,
  unclaimItem,
  recoverOrphanedClaims,
  readQueueState,
  queueFilePath,
} from './daemon-queue.js'
export {
  ensureDaemonsAndEnqueue,
  stopDaemons,
} from './daemon-client.js'
export { runWorkflowDaemon } from './daemon.js'
export type {
  Daemon,
  DaemonLockfile,
  DaemonFlags,
  EnqueueResult,
  QueueEvent,
  QueueItem,
  QueueState,
} from './daemon-types.js'
```

- [ ] **Step 2: Verify typecheck + all existing tests still pass**

```bash
npm run typecheck
npm test
```
Expected: 0 errors, all green.

- [ ] **Step 3: Commit**

```bash
git add src/core/index.ts
git commit -m "core(daemon): re-export daemon primitives from kernel barrel"
```

---

## Task 8: Convert separations CLI adapter

**Files:**
- Modify: `src/workflows/separations/workflow.ts`
- Modify: `src/workflows/separations/index.ts`

- [ ] **Step 1: Add `runSeparationCli` to `src/workflows/separations/workflow.ts`**

Find the existing `runSeparation` / `runSeparationBatch` exports (leave untouched). Below them, add:

```ts
import { ensureDaemonsAndEnqueue } from '../../core/daemon-client.js'
import { log } from '../../utils/log.js'

/**
 * Daemon-mode CLI entry point for separations. Used by `src/cli.ts` for
 * `npm run separation` invocations.
 *
 * Existing `runSeparation` (single-item direct run) and `runSeparationBatch`
 * (direct sequential batch) remain available for tests and scripting.
 */
export async function runSeparationCli(
  docIds: string[],
  options: { dryRun?: boolean; new?: boolean; parallel?: number } = {},
): Promise<void> {
  if (docIds.length === 0) {
    log.error('runSeparationCli: no doc IDs provided')
    process.exitCode = 1
    return
  }
  if (options.dryRun) {
    for (const id of docIds) previewSeparationPipeline(id)
    return
  }
  const inputs = docIds.map((docId) => ({ docId }))
  await ensureDaemonsAndEnqueue(separationsWorkflow, inputs, {
    new: options.new,
    parallel: options.parallel,
  })
}
```

- [ ] **Step 2: Barrel export**

```ts
// src/workflows/separations/index.ts — add to existing re-exports:
export { runSeparationCli } from './workflow.js'
```

- [ ] **Step 3: Typecheck + commit**

```bash
npm run typecheck
git add src/workflows/separations/workflow.ts src/workflows/separations/index.ts
git commit -m "workflow(separations): add runSeparationCli daemon-mode adapter"
```

---

## Task 9: Convert work-study CLI adapter

**Files:**
- Modify: `src/workflows/work-study/workflow.ts`
- Modify: `src/workflows/work-study/index.ts`

Same pattern as Task 8. Read current `src/workflows/work-study/workflow.ts`, identify the existing `runWorkStudy` export, add a `runWorkStudyCli` that parses positional CLI args (`emplId`, `effectiveDate`) into the workflow input shape, calls `ensureDaemonsAndEnqueue(workStudyWorkflow, [input], flags)`. Barrel export.

- [ ] **Step 1: Inspect current workflow exports**

```bash
cat src/workflows/work-study/workflow.ts | head -40
cat src/workflows/work-study/index.ts
```

- [ ] **Step 2: Add `runWorkStudyCli`** matching the pattern from Task 8:

```ts
export async function runWorkStudyCli(
  emplId: string,
  effectiveDate: string,
  options: { new?: boolean; parallel?: number } = {},
): Promise<void> {
  if (!emplId || !effectiveDate) {
    log.error('runWorkStudyCli: emplId and effectiveDate are required')
    process.exitCode = 1
    return
  }
  await ensureDaemonsAndEnqueue(workStudyWorkflow, [{ emplId, effectiveDate }], {
    new: options.new,
    parallel: options.parallel,
  })
}
```

- [ ] **Step 3: Barrel + commit**

```bash
npm run typecheck
git add src/workflows/work-study/workflow.ts src/workflows/work-study/index.ts
git commit -m "workflow(work-study): add runWorkStudyCli daemon-mode adapter"
```

---

## Task 10: Daemon entry point

**Files:**
- Create: `src/cli-daemon.ts`

- [ ] **Step 1: Write the entry**

```ts
// src/cli-daemon.ts
/**
 * Daemon entry point, exec'd by `src/core/daemon-registry.ts::spawnDaemon`.
 * Expected argv: `tsx src/cli-daemon.ts <workflow>`. Loads the named
 * workflow, runs `runWorkflowDaemon(wf)`, exits 0 on clean shutdown, 1
 * on error. Stdout/stderr are redirected to a log file by the spawner.
 */
import { runWorkflowDaemon } from './core/daemon.js'
import { log } from './utils/log.js'

// Workflow name → lazy loader that returns the registered workflow.
const WORKFLOWS: Record<string, () => Promise<{ workflow: unknown; name: string }>> = {
  separations: async () => {
    const mod = await import('./workflows/separations/index.js')
    return { workflow: mod.separationsWorkflow, name: 'separations' }
  },
  'work-study': async () => {
    const mod = await import('./workflows/work-study/index.js')
    return { workflow: mod.workStudyWorkflow, name: 'work-study' }
  },
  // Future workflows register here.
}

async function main(): Promise<void> {
  const workflowName = process.argv[2]
  if (!workflowName) {
    log.error('cli-daemon: missing workflow name argument')
    process.exit(1)
  }
  const loader = WORKFLOWS[workflowName]
  if (!loader) {
    log.error(`cli-daemon: unknown workflow '${workflowName}' (registered: ${Object.keys(WORKFLOWS).join(', ')})`)
    process.exit(1)
  }
  const { workflow } = await loader()
  await runWorkflowDaemon(workflow as Parameters<typeof runWorkflowDaemon>[0])
  process.exit(0)
}

main().catch((err) => {
  log.error(`cli-daemon: fatal ${err instanceof Error ? err.message : String(err)}`)
  if (err instanceof Error && err.stack) log.error(err.stack)
  process.exit(1)
})
```

Subagent: verify that `separationsWorkflow` and `workStudyWorkflow` are exported from their respective `index.ts` files. If the export name differs, update the loader accordingly.

- [ ] **Step 2: Smoke-test the entry parses without crashing**

```bash
npx tsx --version   # confirm tsx installed
npx tsc --noEmit src/cli-daemon.ts   # or full typecheck
npm run typecheck
```

- [ ] **Step 3: Commit**

```bash
git add src/cli-daemon.ts
git commit -m "core(daemon): add cli-daemon.ts entry point for detached spawns"
```

---

## Task 11: Rewrite CLI top-level handlers for separations + work-study

**Files:**
- Modify: `src/cli.ts`

**IMPORTANT (subagent):** Read the full `src/cli.ts` file first to understand the Commander structure and existing command registrations. Match that style.

- [ ] **Step 1: Update `separation` and `separations` commands**

Find the existing `program.command('separation')` / `program.command('separations')` handlers (both routes point to separations today). Rewrite their actions to call `runSeparationCli(docIds, { new, parallel, dryRun })`. Preserve the `--dry-run` flag behavior. Add `--new` and `--parallel <N>` flags (Commander's `.option('-n, --new')` and `.option('-p, --parallel <n>', ..., parseInt)`).

Template:

```ts
program
  .command('separation <docIds...>')
  .alias('separations')
  .description('Process one or more separations — spawns a daemon or enqueues to existing daemon(s)')
  .option('--dry-run', 'preview the pipeline without launching browsers')
  .option('-n, --new', 'spawn an additional daemon even if others are alive')
  .option('-p, --parallel <count>', 'ensure N daemons are alive', (v) => parseInt(v, 10))
  .action(async (docIds: string[], opts) => {
    const { runSeparationCli } = await import('./workflows/separations/index.js')
    await runSeparationCli(docIds, {
      dryRun: opts.dryRun, new: opts.new, parallel: opts.parallel,
    })
  })
```

- [ ] **Step 2: Update `work-study` command**

Follow the same pattern, invoking `runWorkStudyCli(emplId, effectiveDate, { new, parallel })`.

- [ ] **Step 3: Add generic `:status` / `:attach` / `:stop` subcommands**

Add at the bottom of the command block:

```ts
// --- Daemon lifecycle commands (applies to any converted workflow) ---

program
  .command('daemon-status [workflow]')
  .description('Show alive daemons and queue state. If no workflow specified, shows all.')
  .action(async (workflow?: string) => {
    const { findAliveDaemons, readQueueState } = await import('./core/index.js')
    const workflows = workflow ? [workflow] : ['separations', 'work-study']
    for (const wf of workflows) {
      const alive = await findAliveDaemons(wf)
      const state = await readQueueState(wf).catch(() => null)
      console.log(`\n[${wf}]`)
      if (alive.length === 0) console.log('  no alive daemons')
      for (const d of alive) console.log(`  ${d.instanceId}  pid=${d.pid}  port=${d.port}  startedAt=${d.startedAt}`)
      if (state) {
        console.log(`  queue: queued=${state.queued.length} claimed=${state.claimed.length} done=${state.done.length} failed=${state.failed.length}`)
      }
    }
  })

program
  .command('daemon-stop <workflow>')
  .description('Stop all alive daemons for a workflow. Default: soft (drain in-flight).')
  .option('-f, --force', 'mark in-flight items as failed instead of re-queueing')
  .action(async (workflow: string, opts) => {
    const { stopDaemons } = await import('./core/index.js')
    const n = await stopDaemons(workflow, !!opts.force)
    console.log(`Sent stop to ${n} daemon(s) for '${workflow}'.`)
  })

program
  .command('daemon-attach <workflow>')
  .description('Tail logs of all alive daemons for a workflow (Ctrl+C to detach; daemons keep running).')
  .action(async (workflow: string) => {
    const { findAliveDaemons, daemonsDir } = await import('./core/index.js')
    const alive = await findAliveDaemons(workflow)
    if (alive.length === 0) { console.log(`No alive daemons for '${workflow}'.`); return }
    const { spawn } = await import('node:child_process')
    const { existsSync, readdirSync } = await import('node:fs')
    const dir = daemonsDir()
    if (!existsSync(dir)) { console.log('no .tracker/daemons dir'); return }
    const logs = readdirSync(dir).filter((f) => f.startsWith(`${workflow}-`) && f.endsWith('.log'))
    if (logs.length === 0) { console.log(`no log files in ${dir}`); return }
    const tail = spawn('tail', ['-f', ...logs.map((l) => `${dir}/${l}`)], { stdio: 'inherit' })
    tail.on('exit', () => process.exit(0))
  })
```

- [ ] **Step 4: Typecheck + commit**

```bash
npm run typecheck
git add src/cli.ts
git commit -m "cli(daemon): route separation + work-study through daemon mode; add status/stop/attach"
```

---

## Task 12: npm scripts

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Add scripts**

Add under `scripts` (keeping existing scripts intact):

```json
"separation:status": "tsx src/cli.ts daemon-status separations",
"separation:stop": "tsx src/cli.ts daemon-stop separations",
"separation:attach": "tsx src/cli.ts daemon-attach separations",
"work-study:status": "tsx src/cli.ts daemon-status work-study",
"work-study:stop": "tsx src/cli.ts daemon-stop work-study",
"work-study:attach": "tsx src/cli.ts daemon-attach work-study",
"daemons:status": "tsx src/cli.ts daemon-status"
```

Subagent: read the existing `package.json`'s `scripts` block. Only add new keys; do NOT modify existing `separation` / `separations` / `work-study` scripts — those still invoke `src/cli.ts separation ...` which now routes through daemon mode automatically.

- [ ] **Step 2: Commit**

```bash
git add package.json
git commit -m "scripts(daemon): add :status :stop :attach shorthands for separations + work-study"
```

---

## Task 13: Update CLAUDE.md files

**Files:**
- Modify: `CLAUDE.md` (root)
- Modify: `src/core/CLAUDE.md`
- Modify: `src/workflows/CLAUDE.md`
- Modify: `src/workflows/separations/CLAUDE.md`
- Modify: `src/workflows/work-study/CLAUDE.md`

Subagent: read each file fully, then add/update the sections described below. Each file's edits go in ONE commit at the end of this task.

- [ ] **Step 1: Root `CLAUDE.md`**

Add a new section "Daemon mode (persistent workflow processes)" immediately AFTER the existing "Kernel primer" section. Content:

```md
### Daemon mode (persistent workflow processes)

Kernel workflows run via CLI (`npm run separation <id>`, `npm run work-study <emplId> <date>`) now default to **daemon mode**:

- First invocation with no alive daemon → spawns one detached daemon, waits for auth, enqueues the item. Daemon stays alive after processing.
- Subsequent invocations → append to the shared queue; any alive daemon picks up the item. No re-Duo.
- Flags:
  - `--new` → also spawn one extra daemon.
  - `--parallel N` → ensure at least N daemons are alive before enqueueing.
- Multi-daemon dispatch: all alive daemons share one on-disk queue (`.tracker/daemons/{workflow}.queue.jsonl`) and race to claim items via an atomic mkdir-mutex. Whichever daemon finishes its current item first grabs the next queued one.
- Lifecycle commands:
  - `npm run daemons:status` or `npm run separation:status`
  - `npm run separation:stop` (soft — drains in-flight) / `npm run separation:stop -- --force` (marks in-flight as failed)
  - `npm run separation:attach` (tails logs; Ctrl+C detaches, daemons keep running)

Converted workflows: separations, work-study. Conversion pattern is documented in `src/workflows/CLAUDE.md`; follow-up workflows (onboarding, emergency-contact, kronos-reports, eid-lookup) are mechanical.

Implementation: `src/core/daemon-{types,registry,queue,client}.ts` + `src/core/daemon.ts` (main loop) + `src/cli-daemon.ts` (entry). Full design: `docs/superpowers/specs/2026-04-22-workflow-daemon-mode-design.md`.
```

Also update the existing "Deferred follow-ups" or similar section to mark "Replacement workflow launcher" DONE.

- [ ] **Step 2: `src/core/CLAUDE.md`**

Extend the "Files" bullet list with:
- `daemon-types.ts` — shared types: `DaemonLockfile`, `Daemon`, `QueueEvent`, `QueueItem`, `QueueState`, `DaemonFlags`, `EnqueueResult`.
- `daemon-registry.ts` — lockfile read/write, PID + `/whoami` probes, `findAliveDaemons`, `spawnDaemon` (detached child via `tsx src/cli-daemon.ts`).
- `daemon-queue.ts` — shared-queue JSONL: `enqueueItems`, `claimNextItem` (mkdir-mutex), `markItemDone`/`Failed`/`unclaimItem`, `recoverOrphanedClaims`, `readQueueState`.
- `daemon-client.ts` — `ensureDaemonsAndEnqueue` + `stopDaemons`. The ONE function every CLI adapter calls.
- `daemon.ts` — `runWorkflowDaemon`: main loop + HTTP server + 15-min keepalive.
- `batch-lifecycle.ts` — now supports `ownSigint: false` for daemon mode.

Append a new "Design invariants" bullet:

```md
- **Daemon mode is peer-to-peer.** There is NO coordinator daemon and NO leader election. All alive daemons for a workflow share one JSONL queue and race to claim items via `fs.mkdir` atomicity. Dynamic load balancing is emergent: whichever daemon becomes idle first wins the next claim. Do not add a central "primary" daemon concept — that path has been considered and explicitly rejected in the design spec (2026-04-22).
- **Two queue invariants.** (1) Every claim goes through `claimNextItem` (it owns the mkdir-mutex); never inline-claim by hand-writing events. (2) Every `done`/`failed`/`unclaim` event is a simple append (POSIX-atomic for sub-PIPE_BUF writes); no lock needed. If you invent a new event shape, add it to `QueueEvent` and update the state fold in `readQueueState` — do not bypass.
- **Daemon SIGINT is daemon-owned.** `withBatchLifecycle` accepts `ownSigint: false` for daemon callers. The daemon installs its own handler that unclaims the in-flight item (soft) or marks it failed (force), closes the Session, unlinks the lockfile, and exits 0. Don't re-install SIGINT elsewhere when writing new daemon-only code.
```

- [ ] **Step 3: `src/workflows/CLAUDE.md`**

Add a new section at the end titled "Daemon-mode conversion template" that shows, for a generic workflow `foo`:

```md
### Daemon-mode conversion template

To convert `foo` workflow's CLI to daemon mode:

1. In `src/workflows/foo/workflow.ts`, add a `runFooCli(inputs, options)` function that validates args, short-circuits `--dry-run`, then calls `ensureDaemonsAndEnqueue(fooWorkflow, inputsAsObjects, { new, parallel })`. Leave existing `runFoo` / `runFooBatch` exports untouched for direct use.
2. In `src/workflows/foo/index.ts`, re-export `runFooCli`.
3. In `src/cli-daemon.ts`, register `foo` in the `WORKFLOWS` map:
   ```ts
   'foo': async () => {
     const mod = await import('./workflows/foo/index.js')
     return { workflow: mod.fooWorkflow, name: 'foo' }
   },
   ```
4. In `src/cli.ts`, replace the existing `foo` command's action with one that calls `runFooCli(...)`. Add `--new` and `--parallel <n>` options.
5. In `package.json`, add `foo:status`, `foo:stop`, `foo:attach` shorthand scripts.
6. In `src/workflows/foo/CLAUDE.md`, add a "Daemon mode" section matching the pattern in `separations/CLAUDE.md`.

Reference implementations: `src/workflows/separations/*`, `src/workflows/work-study/*`.
```

- [ ] **Step 4: `src/workflows/separations/CLAUDE.md`**

Add a "Daemon mode" section near the top (after Purpose / Entry points):

```md
### Daemon mode

`npm run separation <docIds...>` now runs in daemon mode by default. First invocation spawns a detached daemon (full 4-system auth chain); subsequent invocations append to `.tracker/daemons/separations.queue.jsonl` and wake any alive daemon. Flags:
- `--new`: spawn one extra daemon in addition to existing ones.
- `--parallel N`: ensure ≥N daemons alive.
- `--dry-run`: preview pipeline; no daemon spawned.

Lifecycle:
- `npm run separation:status` — show alive daemons + queue state.
- `npm run separation:stop` — soft-stop (drain in-flight).
- `npm run separation:stop -- --force` — mark in-flight as failed, exit immediately.
- `npm run separation:attach` — tail daemon logs.

The existing `runSeparation` / `runSeparationBatch` functions remain available for tests and scripting — daemon mode is a CLI-only surface.
```

- [ ] **Step 5: `src/workflows/work-study/CLAUDE.md`**

Add a "Daemon mode" section with the analogous content for work-study (single-item entry, 1 Duo).

- [ ] **Step 6: Typecheck + commit all docs together**

```bash
npm run typecheck
npm test
git add CLAUDE.md src/core/CLAUDE.md src/workflows/CLAUDE.md src/workflows/separations/CLAUDE.md src/workflows/work-study/CLAUDE.md
git commit -m "docs(daemon): document daemon mode at root + core + workflows + separations + work-study"
```

---

## Task 14: Final verification

- [ ] **Step 1: Full test suite**

```bash
npm test
```
Expected: all tests pass. If any regressions, fix before merging.

- [ ] **Step 2: Typecheck**

```bash
npm run typecheck
```
Expected: 0 errors.

- [ ] **Step 3: Confirm git state clean for daemon work**

```bash
git status
git log --oneline -20
```
Expected: 10-13 commits from this session, working tree clean (except pre-existing unrelated dashboard changes which were intentionally left alone).

---

## Self-review checklist (completed during planning — do not re-run)

- **Spec coverage:**
  - Architecture → Task 6 (main loop) + Task 1 (types) + Task 2 (registry) + Task 3 (queue).
  - CLI flag semantics → Task 4 (client) + Task 11 (CLI routing).
  - Daemon lifecycle → Task 6.
  - Shared-queue protocol → Task 3.
  - Registry discovery → Task 2.
  - Integration with existing invariants → Task 5 (ownSigint), referenced from Task 6.
  - Error handling + edge cases → Tasks 2, 3, 6 via tests and code comments.
  - Testing strategy → unit tests in Tasks 2, 3, 4, 6; verification in Task 14.
  - Rollout plan → commit structure matches Tasks 1–13.
- **Placeholder scan:** no "TBD" / "implement later" / unclosed code blocks. Every test includes the assertion and every implementation step includes the actual code or a pointer to the exact section of the spec.
- **Type consistency:** Types defined in Task 1 are consumed by Tasks 2, 3, 4, 6. Function names match across tasks (`findAliveDaemons`, `claimNextItem`, `ensureDaemonsAndEnqueue`).
