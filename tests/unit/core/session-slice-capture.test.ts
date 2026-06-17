import { test } from 'vitest'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Session, formatCaptureFilename } from '../../../src/core/kernel/session.js'
import { makeScreenshotFn } from '../../../src/core/kernel/screenshot.js'
import type { CaptureFileOpts } from '../../../src/core/kernel/types.js'

/**
 * A fake Playwright Page that records `screenshot` calls and writes a tiny
 * real PNG-ish byte stub to disk (so `captureAll`'s `fs.stat` sizing
 * succeeds). `evaluate` returns canned geometry / no-ops so the slice + center
 * helpers run their real control flow without a browser.
 */
function makeFakePage(opts: {
  fullHeight?: number
  width?: number
} = {}): {
  page: any
  shots: Array<{ path?: string; fullPage?: boolean; clip?: { x: number; y: number; width: number; height: number } }>
  evals: number
} {
  const shots: Array<{ path?: string; fullPage?: boolean; clip?: { x: number; y: number; width: number; height: number } }> = []
  let evals = 0
  const page = {
    async evaluate(fn: unknown): Promise<unknown> {
      evals++
      // The geometry probe is the only evaluate whose return value matters.
      // Detect it by calling the fn against a stub `window`/`document`; simpler:
      // return the canned geometry whenever a value is expected. The helpers
      // tolerate a `null` from the overflow/scroll evaluates (they're void).
      const src = String(fn)
      if (src.includes('fullHeight')) {
        return { fullHeight: opts.fullHeight ?? 2400, width: opts.width ?? 1000 }
      }
      return undefined
    },
    async waitForLoadState(): Promise<void> {},
    async waitForTimeout(): Promise<void> {},
    async setViewportSize(): Promise<void> {},
    frames(): unknown[] { return [] },
    async screenshot(o: { path?: string; fullPage?: boolean; clip?: { x: number; y: number; width: number; height: number } }): Promise<Buffer> {
      shots.push(o)
      const buf = Buffer.from('PNGSTUB')
      if (o.path) await fs.writeFile(o.path, buf)
      return buf
    },
  }
  return { page, shots, evals }
}

test('formatCaptureFilename appends -{i+1}of{total} for slices', () => {
  const fn = formatCaptureFilename({
    workflow: 'separations', itemId: '3907', kind: 'form',
    label: 'kuali-finalization-saved', system: 'kuali', ts: 1776712000000,
    sliceIndex: 0, sliceTotal: 3,
  })
  assert.equal(fn, 'separations-3907-form-kuali-finalization-saved-1of3-kuali-1776712000000.png')

  const fn3 = formatCaptureFilename({
    workflow: 'separations', itemId: '3907', kind: 'form',
    label: 'kuali-finalization-saved', system: 'kuali', ts: 1776712000000,
    sliceIndex: 2, sliceTotal: 3,
  })
  assert.equal(fn3, 'separations-3907-form-kuali-finalization-saved-3of3-kuali-1776712000000.png')
})

test('capturePageInSlices: produces N files, each a fullPage+clip shot covering top-to-bottom', async (t) => {
  const dir = await fs.mkdtemp(join(tmpdir(), 'slice-'))
  t.onTestFinished(async () => { await fs.rm(dir, { recursive: true, force: true }) })
  const { page, shots } = makeFakePage({ fullHeight: 2400, width: 1000 })

  const written = await Session.capturePageInSlices(page, 3, (i, total) =>
    join(dir, `slice-${i + 1}of${total}.png`))

  assert.equal(written.length, 3)
  assert.equal(shots.length, 3)
  // Every slice is a fullPage:true + clip shot (fullPage is load-bearing for
  // off-screen regions), x=0, full width, and the clips tile 0..2400.
  let coveredTo = 0
  for (let i = 0; i < shots.length; i++) {
    const s = shots[i]
    assert.equal(s.fullPage, true, 'slice must use fullPage:true so clip resolves against the full-page image')
    assert.ok(s.clip, 'slice must clip')
    assert.equal(s.clip!.x, 0)
    assert.equal(s.clip!.width, 1000)
    assert.equal(s.clip!.y, i * 800)
    coveredTo = s.clip!.y + s.clip!.height
  }
  assert.equal(coveredTo, 2400, 'slices must cover the full document height top-to-bottom')
})

test('capturePageInSlices: short page yields fewer slices than requested (no past-bottom reads)', async (t) => {
  const dir = await fs.mkdtemp(join(tmpdir(), 'slice-'))
  t.onTestFinished(async () => { await fs.rm(dir, { recursive: true, force: true }) })
  // fullHeight 100 with N=3 → sliceHeight=ceil(100/3)=34; slices at y=0,34,68
  // each within bounds → 3 slices, last trimmed to 32 so it never reads past 100.
  const { page, shots } = makeFakePage({ fullHeight: 100, width: 800 })
  const written = await Session.capturePageInSlices(page, 3, (i, total) =>
    join(dir, `s-${i + 1}of${total}.png`))
  assert.equal(written.length, 3)
  const last = shots[shots.length - 1]
  assert.equal(last.clip!.y + last.clip!.height, 100)
})

test('capturePageInSlices: degenerate geometry falls back to one fullPage shot', async (t) => {
  const dir = await fs.mkdtemp(join(tmpdir(), 'slice-'))
  t.onTestFinished(async () => { await fs.rm(dir, { recursive: true, force: true }) })
  const { page, shots } = makeFakePage({ fullHeight: 0, width: 0 })
  const written = await Session.capturePageInSlices(page, 3, (i, total) =>
    join(dir, `s-${i + 1}of${total}.png`))
  assert.equal(written.length, 1)
  assert.equal(shots.length, 1)
  assert.equal(shots[0].fullPage, true)
  assert.equal(shots[0].clip, undefined)
})

test('captureViewportCenteredOnElement: scrolls + captures viewport-only (NOT fullPage)', async (t) => {
  const dir = await fs.mkdtemp(join(tmpdir(), 'center-'))
  t.onTestFinished(async () => { await fs.rm(dir, { recursive: true, force: true }) })
  const { page, shots } = makeFakePage()
  const out = join(dir, 'centered.png')
  const written = await Session.captureViewportCenteredOnElement(page, '.ui-grid-viewport', out)
  assert.equal(written, out)
  assert.equal(shots.length, 1)
  // Virtual-scroll grids: must be a plain viewport shot — never fullPage.
  assert.equal(shots[0].fullPage, undefined)
  assert.equal(shots[0].clip, undefined)
})

test('captureAll: slices route emits N file metadata entries with slice labels', async (t) => {
  const dir = await fs.mkdtemp(join(tmpdir(), 'capall-'))
  t.onTestFinished(async () => { await fs.rm(dir, { recursive: true, force: true }) })
  const { page } = makeFakePage({ fullHeight: 1500, width: 900 })
  const session = Session.forTesting({
    systems: [{ id: 'kuali', login: async () => {} }],
    browsers: new Map([['kuali', { page: page as never, browser: null as never, context: null as never }]]),
    readyPromises: new Map(),
    screenshotDir: dir,
  })
  const opts: CaptureFileOpts = {
    workflow: 'separations', itemId: '3907', kind: 'form',
    label: 'kuali-finalization-saved', ts: 1776712000000,
    systems: ['kuali'], slices: 3,
  }
  const res = await session.captureAll(opts)
  assert.equal(res.length, 3)
  for (const r of res) assert.equal(r.system, 'kuali')
  const names = res.map((r) => r.path.split('/').pop())
  assert.ok(names.every((n) => /-form-kuali-finalization-saved-\dof3-kuali-/.test(n!)),
    `slice filenames must carry -Nof3- label, got ${JSON.stringify(names)}`)
})

test('makeScreenshotFn: slice capture emits one event carrying all N slice files', async () => {
  const emitted: any[] = []
  const fakeSession = {
    captureAll: async (o: CaptureFileOpts) => {
      assert.equal(o.slices, 3, 'slices option must flow through to captureAll')
      return [0, 1, 2].map((i) => ({
        system: 'kuali',
        path: `/tmp/sep-3907-form-${o.label}-${i + 1}of3-kuali-1.png`,
        bytes: 7,
      }))
    },
  }
  const fn = makeScreenshotFn({
    session: fakeSession as never,
    runId: 'run-1', workflow: 'separations', itemId: '3907',
    emit: (e) => { emitted.push(e) },
    currentStep: () => 'kuali-finalization',
  })
  const cap = await fn({ kind: 'form', label: 'kuali-finalization-saved', systems: ['kuali'], slices: 3 })
  assert.equal(cap.files.length, 3)
  assert.equal(emitted.length, 1)
  assert.equal(emitted[0].files.length, 3)
  assert.ok(emitted[0].files.map((f: { path: string }) => f.path).every((p: string) => /-\dof3-/.test(p)))
})

test('makeScreenshotFn: centerSelector flows through to captureAll', async () => {
  let seen: CaptureFileOpts | null = null
  const fakeSession = {
    captureAll: async (o: CaptureFileOpts) => { seen = o; return [{ system: 'new-kronos', path: '/tmp/x.png', bytes: 7 }] },
  }
  const fn = makeScreenshotFn({
    session: fakeSession as never,
    runId: 'r', workflow: 'separations', itemId: '3907',
    emit: () => {}, currentStep: () => null,
  })
  await fn({ kind: 'form', label: 'new-kronos-last-worked-date', systems: ['new-kronos'], centerSelector: '.ui-grid-viewport' })
  assert.equal(seen!.centerSelector, '.ui-grid-viewport')
  assert.deepEqual(seen!.systems, ['new-kronos'])
})
