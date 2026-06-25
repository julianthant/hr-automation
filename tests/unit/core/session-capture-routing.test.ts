import { test } from 'vitest'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Session, formatCaptureFilename } from '../../../src/core/kernel/session.js'
import { makeScreenshotFn } from '../../../src/core/kernel/screenshot.js'
import type { CaptureFileOpts } from '../../../src/core/kernel/types.js'

type Shot = { path?: string; fullPage?: boolean; clip?: { x: number; y: number; width: number; height: number } }

/**
 * A fake Playwright Page that records page-level `screenshot` calls and writes a
 * tiny byte stub to disk (so `captureAll`'s `fs.stat` sizing succeeds). The
 * capture control flow runs without a browser; `evaluate` is disambiguated by
 * the source of the passed fn so the real routing runs:
 *  - contains `scrollIntoView` → the centerSelector scroll (flags `centered`)
 *  - contains `scrollTo`       → DOM-mutating evals (expand overflow / grow
 *    iframes / their restores) — return undefined
 *  - contains `innerWidth`     → viewport metrics for the content-fit widen probe
 *  - contains `querySelectorAll` → other DOM-mutating evals — return undefined
 */
function makeFakePage(opts: { docWidth?: number } = {}): {
  page: any
  shots: Shot[]
  state: { centered: boolean }
} {
  const shots: Shot[] = []
  const state = { centered: false }
  const write = async (o: { path?: string }): Promise<Buffer> => {
    const buf = Buffer.from('PNGSTUB')
    if (o.path) await fs.writeFile(o.path, buf)
    return buf
  }
  const page = {
    async evaluate(fn: unknown): Promise<unknown> {
      const src = String(fn)
      if (src.includes('scrollIntoView')) { state.centered = true; return undefined }
      if (src.includes('scrollTo')) return undefined
      if (src.includes('innerWidth')) {
        return { innerWidth: 960, innerHeight: 620, docWidth: opts.docWidth ?? 960 }
      }
      if (src.includes('querySelectorAll')) return undefined
      if (src.includes('scrollHeight')) return 2400
      return undefined
    },
    async waitForLoadState(): Promise<void> {},
    async waitForTimeout(): Promise<void> {},
    async setViewportSize(): Promise<void> {},
    frames(): unknown[] { return [] },
    async screenshot(o: Shot): Promise<Buffer> {
      shots.push(o)
      return write(o)
    },
  }
  return { page, shots, state }
}

test('formatCaptureFilename builds the canonical, single-file name', () => {
  const fn = formatCaptureFilename({
    workflow: 'separations', itemId: '3907', kind: 'form',
    label: 'kuali-finalization-saved', system: 'kuali', ts: 1776712000000,
  })
  assert.equal(fn, 'separations-3907-form-kuali-finalization-saved-kuali-1776712000000.png')
})

test('captureFullPage: the unified whole-page shot is ONE fullPage screenshot', async (t) => {
  const dir = await fs.mkdtemp(join(tmpdir(), 'full-'))
  t.onTestFinished(async () => { await fs.rm(dir, { recursive: true, force: true }) })
  const { page, shots } = makeFakePage({ docWidth: 2200 }) // wide content → content-fit widen
  const out = join(dir, 'full.png')

  const buf = await Session.captureFullPage(page, out)

  assert.ok(buf.byteLength > 0)
  assert.equal(shots.length, 1, 'exactly one page-level shot')
  assert.equal(shots[0].fullPage, true, 'whole page, not a clip/ribbon')
  assert.equal(shots[0].clip, undefined, 'never clipped — the entire page/form is in frame')
  assert.equal(shots[0].path, out)
})

test('captureViewportCenteredOnElement: scrolls + captures viewport-only (NOT fullPage)', async (t) => {
  const dir = await fs.mkdtemp(join(tmpdir(), 'center-'))
  t.onTestFinished(async () => { await fs.rm(dir, { recursive: true, force: true }) })
  const { page, shots, state } = makeFakePage()
  const out = join(dir, 'centered.png')

  const written = await Session.captureViewportCenteredOnElement(page, '.ui-grid-viewport', out)

  assert.equal(written, out)
  assert.ok(state.centered, 'scrolled the target element to center')
  assert.equal(shots.length, 1)
  // The Kronos virtual-scroll exception: a plain viewport shot — never fullPage.
  assert.equal(shots[0].fullPage, undefined)
  assert.equal(shots[0].clip, undefined)
})

test('captureAll: the default route is the unified fullPage shot — ONE file, canonical name', async (t) => {
  const dir = await fs.mkdtemp(join(tmpdir(), 'capall-'))
  t.onTestFinished(async () => { await fs.rm(dir, { recursive: true, force: true }) })
  const { page, shots } = makeFakePage({ docWidth: 1800 })
  const session = Session.forTesting({
    systems: [{ id: 'ucpath', login: async () => {} }],
    browsers: new Map([['ucpath', { page: page as never, browser: null as never, context: null as never }]]),
    readyPromises: new Map(),
    screenshotDir: dir,
  })
  const opts: CaptureFileOpts = {
    workflow: 'separations', itemId: '3907', kind: 'form',
    label: 'ucpath-transaction-submitted', ts: 1776712000000,
    systems: ['ucpath'],
  }
  const res = await session.captureAll(opts)
  assert.equal(res.length, 1, 'one file per page')
  assert.equal(res[0].system, 'ucpath')
  assert.match(res[0].path, /-form-ucpath-transaction-submitted-ucpath-\d+\.png$/)
  assert.equal(shots.length, 1)
  assert.equal(shots[0].fullPage, true)
})

test('captureAll: centerSelector route emits ONE viewport-only file (the Kronos exception)', async (t) => {
  const dir = await fs.mkdtemp(join(tmpdir(), 'capall-'))
  t.onTestFinished(async () => { await fs.rm(dir, { recursive: true, force: true }) })
  const { page, shots, state } = makeFakePage()
  const session = Session.forTesting({
    systems: [{ id: 'new-kronos', login: async () => {} }],
    browsers: new Map([['new-kronos', { page: page as never, browser: null as never, context: null as never }]]),
    readyPromises: new Map(),
    screenshotDir: dir,
  })
  const res = await session.captureAll({
    workflow: 'separations', itemId: '3907', kind: 'form',
    label: 'new-kronos-last-worked-date', ts: 1776712000000,
    systems: ['new-kronos'], centerSelector: '.ui-grid-viewport',
  })
  assert.equal(res.length, 1)
  assert.match(res[0].path, /-form-new-kronos-last-worked-date-new-kronos-\d+\.png$/)
  assert.ok(state.centered)
  assert.equal(shots[0].fullPage, undefined, 'viewport-only — not fullPage')
})

test('makeScreenshotFn: default (no opts) forwards no capture-mode fields', async () => {
  let seen: CaptureFileOpts | null = null
  const fakeSession = {
    captureAll: async (o: CaptureFileOpts) => { seen = o; return [{ system: 'kuali', path: '/tmp/x.png', bytes: 7 }] },
  }
  const fn = makeScreenshotFn({
    session: fakeSession as never,
    runId: 'r', workflow: 'separations', itemId: '3907',
    emit: () => {}, currentStep: () => null,
  })
  const cap = await fn({ kind: 'form', label: 'kuali-finalization-saved', systems: ['kuali'] })
  assert.deepEqual(seen!.systems, ['kuali'])
  assert.equal(seen!.centerSelector, undefined)
  // No legacy mode fields survive on the forwarded opts.
  assert.equal((seen as unknown as Record<string, unknown>).paged, undefined)
  assert.equal((seen as unknown as Record<string, unknown>).region, undefined)
  assert.equal((seen as unknown as Record<string, unknown>).bounded, undefined)
  assert.equal(cap.files.length, 1)
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
