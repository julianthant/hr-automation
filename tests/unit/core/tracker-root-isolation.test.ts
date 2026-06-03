import { test, vi } from 'vitest'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { defineWorkflow } from '../../../src/core/kernel/workflow.js'
import { clear } from '../../../src/core/kernel/registry.js'
import { runWorkflowDaemon } from '../../../src/core/daemon/daemon.js'
import { Session } from '../../../src/core/kernel/session.js'
import {
  enqueueItems,
  readQueueStateIncludingTerminals,
} from '../../../src/core/daemon/queue.js'
import { findAliveDaemons } from '../../../src/core/daemon/registry.js'
import { closeStateDbForTests } from '../../../src/tracker/state/db.js'
import { rowsDir, screenshotsDir } from '../../../src/tracker/paths.js'
import type { SystemConfig } from '../../../src/core/kernel/types.js'

// Fake Session with no browsers — the test workflow uses `systems: []`, so
// nothing calls `page()` / `healthCheck()`. Mirrors `stubLaunch` in daemon.test.ts.
function stubLaunch(): typeof Session.launch {
  return (async () =>
    Session.forTesting({
      systems: [],
      browsers: new Map(),
      readyPromises: new Map(),
    })) as unknown as typeof Session.launch
}

function waitForDaemon(
  workflow: string,
  dir: string,
  timeoutMs = 5000,
): Promise<{ port: number }> {
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

async function waitFor(
  pred: () => boolean | Promise<boolean>,
  timeoutMs = 10_000,
): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (await pred()) return
    await new Promise((r) => setTimeout(r, 25))
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`)
}

const REAL_TRACKER_DIR = '.tracker'

/** Snapshot the real `.tracker/` top-level listing (or null if it doesn't exist). */
function snapshotRealTracker(): string[] | null {
  if (!existsSync(REAL_TRACKER_DIR)) return null
  return readdirSync(REAL_TRACKER_DIR).sort()
}

// ─── (a) Whole-run isolation through the REAL daemon, in-process ────────────
// Proves both halves of the contract at once:
//   1. A real daemon driven at a temp `trackerDir` writes its entire run
//      footprint (rows/, state.db, daemons/) UNDER that temp dir.
//   2. The real `.tracker/` receives NO new files from the test — captured
//      before/after and asserted unchanged (covers "no real-tracker writes").
test('daemon run at a temp trackerDir lands entirely there + leaves .tracker untouched', async () => {
  clear()
  const dir = mkdtempSync(join(tmpdir(), 'tracker-root-iso-'))
  // Capture the real `.tracker/` listing (or its non-existence) BEFORE the run.
  const before = snapshotRealTracker()

  let ran = false
  try {
    const wf = defineWorkflow({
      name: 'troot-iso',
      schema: z.object({ id: z.string() }),
      steps: ['run'],
      systems: [],
      authSteps: false,
      getId: (d) => (d as { id: string }).id,
      handler: async (ctx) => {
        await ctx.step('run', async () => {
          ran = true
        })
      },
    })

    // Enqueue BEFORE starting the daemon so the first claim sees work.
    await enqueueItems<{ id: string }>(
      'troot-iso',
      [{ id: 'only' }],
      (d) => d.id,
      dir,
    )

    const runPromise = runWorkflowDaemon(wf, {
      trackerDir: dir,
      sessionLaunchFn: stubLaunch(),
      idleTimeoutMs: 200,
      heartbeatIntervalMs: 50,
      lockHealIntervalMs: 100,
    })

    const { port } = await waitForDaemon('troot-iso', dir)

    await waitFor(async () => {
      const st = await readQueueStateIncludingTerminals('troot-iso', dir)
      return st.done.length === 1
    })

    assert.equal(ran, true, 'handler step executed')

    await fetch(`http://127.0.0.1:${port}/stop`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })
    await runPromise

    // ── The whole run footprint is UNDER the temp dir ──
    // rows/ has a done row for our workflow.
    const rowsForWf = readdirSync(rowsDir(dir)).filter((f) =>
      f.startsWith('troot-iso-'),
    )
    assert.equal(rowsForWf.length >= 1, true, 'rows/ has a troot-iso row file')
    // SQLite state.db lives at the temp root.
    assert.equal(existsSync(join(dir, 'state.db')), true, 'state.db at temp root')
    // daemon lockfile/log artifacts under daemons/.
    assert.equal(existsSync(join(dir, 'daemons')), true, 'daemons/ at temp root')
    assert.equal(
      readdirSync(join(dir, 'daemons')).length > 0,
      true,
      'daemons/ has artifacts',
    )

    // ── The real `.tracker/` is UNCHANGED by this test ──
    const after = snapshotRealTracker()
    assert.deepEqual(
      after,
      before,
      'real .tracker/ top-level listing must be identical before/after the isolated run',
    )
  } finally {
    closeStateDbForTests(dir)
    rmSync(dir, { recursive: true, force: true })
  }
})

// ─── (b1) Screenshot seam: Session.launch({ screenshotDir }) wins ───────────
// Proves the NEW `LaunchOpts.screenshotDir` flows into `state.screenshotDir`,
// which `screenshotAll`/`captureAll` honor over `PATHS.screenshotDir`.
test('Session.launch({ screenshotDir }) routes screenshots to the given dir, not PATHS.screenshotDir', async () => {
  const shotDir = mkdtempSync(join(tmpdir(), 'launch-shots-'))
  try {
    const mkPage = () =>
      ({
        isClosed: () => false,
        bringToFront: async () => undefined,
        evaluate: async (_fn: unknown) => undefined,
        waitForTimeout: async (_ms: number) => undefined,
        screenshot: async (_opts: { path: string }) => undefined,
      }) as unknown as import('playwright').Page

    const systems: SystemConfig[] = [{ id: 'ucpath', login: async () => {} }]

    const session = await Session.launch(systems, {
      screenshotDir: shotDir,
      // Stub launch so no real browser opens; return a slot with a mock page.
      launchFn: async ({ system }) => ({
        page: mkPage(),
        browser: null as never,
        context: null as never,
      }),
    })

    const paths = await session.screenshotAll('iso-prefix')
    assert.equal(paths.length, 1, 'one open page → one screenshot path')
    assert.equal(
      paths[0].startsWith(`${shotDir}/`),
      true,
      `screenshot path ${paths[0]} must sit under the launch-supplied dir`,
    )
    // And NOT under the real PATHS.screenshotDir.
    const { PATHS } = await import('../../../src/config.js')
    assert.equal(
      paths[0].startsWith(`${PATHS.screenshotDir}/`),
      false,
      'screenshot must NOT land under PATHS.screenshotDir',
    )
  } finally {
    rmSync(shotDir, { recursive: true, force: true })
  }
})

// ─── (b2) Env seam: HRAUTO_TRACKER_DIR steers PATHS at module load ──────────
// Proves config.ts now reads the env the daemon spawner sets. Uses
// vi.resetModules() + a fresh dynamic import so the singleton PATHS for other
// tests is never corrupted (cache-bust pattern from tests/CLAUDE.md).
test('HRAUTO_TRACKER_DIR steers PATHS.trackerDir/screenshotDir; unset → .tracker', async () => {
  const root = '/tmp/hrauto-iso-root'
  const prev = process.env.HRAUTO_TRACKER_DIR
  try {
    // ── Env SET → PATHS follow it ──
    vi.resetModules()
    process.env.HRAUTO_TRACKER_DIR = root
    const setMod = await import('../../../src/config.js')
    assert.equal(setMod.PATHS.trackerDir, root, 'PATHS.trackerDir follows env')
    assert.equal(
      setMod.PATHS.screenshotDir,
      screenshotsDir(root),
      'PATHS.screenshotDir derives from the env root',
    )

    // ── Env UNSET → back to `.tracker` (backward compat) ──
    vi.resetModules()
    delete process.env.HRAUTO_TRACKER_DIR
    const unsetMod = await import('../../../src/config.js')
    assert.equal(unsetMod.PATHS.trackerDir, '.tracker', 'unset → .tracker')
    assert.equal(
      unsetMod.PATHS.screenshotDir,
      screenshotsDir('.tracker'),
      'unset → .tracker/screenshots',
    )
  } finally {
    // Restore env + module registry so the singleton PATHS other tests see is
    // the real `.tracker`-backed one.
    if (prev === undefined) delete process.env.HRAUTO_TRACKER_DIR
    else process.env.HRAUTO_TRACKER_DIR = prev
    vi.resetModules()
  }
})
