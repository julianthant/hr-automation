import { test } from 'vitest'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PNG } from 'pngjs'
import { Session, formatCaptureFilename, computeSliceOffsets, shouldAutoStitchOffsets, CAPTURE } from '../../../src/core/kernel/session.js'
import { makeScreenshotFn } from '../../../src/core/kernel/screenshot.js'
import type { CaptureFileOpts } from '../../../src/core/kernel/types.js'

type Shot = { path?: string; fullPage?: boolean; clip?: { x: number; y: number; width: number; height: number } }

/**
 * A fake Playwright Page that records page-level `screenshot` calls and writes a
 * tiny byte stub to disk (so `captureAll`'s `fs.stat` sizing succeeds). The
 * scroll-and-capture control flow runs without a browser; `evaluate` is
 * disambiguated by a UNIQUE token in the source of the passed fn:
 *  - `scrollIntoView` → the centerSelector scroll (flags `centered`)
 *  - `docWidth`       → the width-pin probe → { innerWidth, innerHeight, docWidth }
 *  - `MIN_OVERFLOW`   → planScrollCapture → { mode, scrollHeight, clientHeight }
 *  - `contentWindow`  → scrollCaptureTo (records the scroll offset) → clip rect
 *  - `__hrcapRestore` → the restore wrapper → undefined
 * `scrollOffsets` records the Y offsets passed to `scrollCaptureTo`, in order.
 */
function makeFakePage(opts: { fullHeight?: number; docWidth?: number; clientHeight?: number; mode?: 'window' | 'element' | 'iframe' } = {}): {
  page: any
  shots: Shot[]
  state: { centered: boolean }
  scrollOffsets: number[]
} {
  const shots: Shot[] = []
  const state = { centered: false }
  const scrollOffsets: number[] = []
  const fullHeight = opts.fullHeight ?? 600
  const width = opts.docWidth ?? 1280
  const clientHeight = opts.clientHeight ?? 1200
  const mode = opts.mode ?? 'window'
  const write = async (o: { path?: string }): Promise<Buffer> => {
    const buf = Buffer.from('PNGSTUB')
    if (o.path) await fs.writeFile(o.path, buf)
    return buf
  }
  const page = {
    async evaluate(fn: unknown, arg?: unknown): Promise<unknown> {
      const src = String(fn)
      if (src.includes('scrollIntoView')) { state.centered = true; return undefined }
      if (src.includes('docWidth')) return { innerWidth: width, innerHeight: 900, docWidth: width }
      if (src.includes('MIN_OVERFLOW')) return { mode, scrollHeight: fullHeight, clientHeight }
      if (src.includes('contentWindow')) {
        scrollOffsets.push(arg as number)
        return { x: 0, y: 0, width, height: clientHeight }
      }
      if (src.includes('__hrcapRestore')) return undefined
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
  return { page, shots, state, scrollOffsets }
}

/**
 * Like `makeFakePage`, but `screenshot` returns a REAL solid-color PNG sized to
 * the requested clip — so `stitch:true` can actually decode + composite the
 * bands (the PNGSTUB fake above only exercises the decode-failure degrade path).
 */
function makeRealPngFakePage(opts: { fullHeight?: number; docWidth?: number; clientHeight?: number; mode?: 'window' | 'iframe' } = {}): {
  page: any
  shots: Shot[]
} {
  const shots: Shot[] = []
  const fullHeight = opts.fullHeight ?? 3000
  const width = opts.docWidth ?? 1280
  const clientHeight = opts.clientHeight ?? 1200
  const mode = opts.mode ?? 'window'
  const solid = (w: number, h: number): Buffer => {
    const png = new PNG({ width: w, height: h })
    png.data.fill(0x80)
    return PNG.sync.write(png)
  }
  const page = {
    async evaluate(fn: unknown, arg?: unknown): Promise<unknown> {
      const src = String(fn)
      if (src.includes('scrollIntoView')) return undefined
      if (src.includes('docWidth')) return { innerWidth: width, innerHeight: 900, docWidth: width }
      if (src.includes('MIN_OVERFLOW')) return { mode, scrollHeight: fullHeight, clientHeight }
      if (src.includes('contentWindow')) return { x: 0, y: 0, width, height: clientHeight }
      if (src.includes('__hrcapRestore')) return undefined
      return undefined
    },
    async waitForLoadState(): Promise<void> {},
    async waitForTimeout(): Promise<void> {},
    async setViewportSize(): Promise<void> {},
    frames(): unknown[] { return [] },
    async screenshot(o: Shot): Promise<Buffer> {
      shots.push(o)
      const buf = o.clip ? solid(o.clip.width, o.clip.height) : solid(width, clientHeight)
      if (o.path) await fs.writeFile(o.path, buf)
      return buf
    },
  }
  return { page, shots }
}

test('formatCaptureFilename: canonical single-file name, and -cNN for a page slice', () => {
  const base = {
    workflow: 'separations', itemId: '3907', kind: 'form' as const,
    label: 'kuali-finalization-saved', system: 'kuali', ts: 1776712000000,
  }
  assert.equal(formatCaptureFilename(base),
    'separations-3907-form-kuali-finalization-saved-kuali-1776712000000.png')
  assert.equal(formatCaptureFilename({ ...base, chunk: 0 }),
    'separations-3907-form-kuali-finalization-saved-kuali-1776712000000-c01.png')
  assert.equal(formatCaptureFilename({ ...base, chunk: 9 }),
    'separations-3907-form-kuali-finalization-saved-kuali-1776712000000-c10.png')
})

test('computeSliceOffsets: short page → one slice; tall page → clamped top→bottom offsets', () => {
  // Fits one slice → single image.
  assert.deepEqual(computeSliceOffsets(600, 1200, 120, 30), [0])
  assert.deepEqual(computeSliceOffsets(1200, 1200, 120, 30), [0])
  // Tall page: step = 1200 - 120 = 1080; last offset clamped to fullHeight - sliceHeight.
  assert.deepEqual(computeSliceOffsets(3000, 1200, 120, 30), [0, 1080, 1800])
  // Each slice covers the whole page (last anchored to the bottom, no gap, no dup).
  const ys = computeSliceOffsets(3000, 1200, 120, 30)
  assert.equal(ys[0], 0, 'first slice is the top')
  assert.equal(ys[ys.length - 1], 3000 - 1200, 'last slice reaches the bottom')
  // Runaway guard.
  assert.equal(computeSliceOffsets(100000, 1200, 120, 5).length, 5)
  // Degenerate geometry → one slice.
  assert.deepEqual(computeSliceOffsets(0, 1200, 120, 30), [0])
  assert.deepEqual(computeSliceOffsets(Number.NaN, 1200, 120, 30), [0])
})

test('shouldAutoStitchOffsets: over-overlapped final band → true; designed overlap → false; single → false', () => {
  const bandHeight = 1200
  const overlap = 120
  const designStep = bandHeight - overlap

  // Slightly taller than one band — second offset clamped to maxY, ~92% overlap.
  assert.equal(shouldAutoStitchOffsets([0, 100], bandHeight, overlap), true)

  // Tall page with interior full steps — keep slicing despite bottom-clamped last gap.
  assert.equal(shouldAutoStitchOffsets([0, designStep, designStep * 2], bandHeight, overlap), false)
  const even = computeSliceOffsets(4440, bandHeight, overlap, 30)
  assert.equal(shouldAutoStitchOffsets(even, bandHeight, overlap), false)

  // One slice — nothing to stitch.
  assert.equal(shouldAutoStitchOffsets([0], bandHeight, overlap), false)
})

test('captureFullPage: auto-stitches a slightly-tall page into ONE image (no -cNN)', async (t) => {
  const dir = await fs.mkdtemp(join(tmpdir(), 'auto-stitch-'))
  t.onTestFinished(async () => { await fs.rm(dir, { recursive: true, force: true }) })
  // 1300px content in a 1200px band → two heavily-overlapping offsets without stitch opt.
  const fullHeight = 1300
  const clientHeight = 1200
  const { page, shots } = makeRealPngFakePage({ fullHeight, docWidth: 1280, clientHeight, mode: 'window' })
  const base = join(dir, 'slightly-tall.png')
  const slicePath = (chunk: number | null): string =>
    chunk === null ? base : base.replace(/\.png$/, `-c${String(chunk + 1).padStart(2, '0')}.png`)

  const written = await Session.captureFullPage(page, slicePath)

  assert.deepEqual(written, [base], 'auto-stitch collapses near-duplicate bands to one file')
  assert.equal(shots.length, 2, 'still scroll-captures each band before compositing')
  assert.ok(shots.every((s) => s.path === undefined && s.clip?.x === 0))
  const png = PNG.sync.read(await fs.readFile(base))
  assert.equal(png.height, fullHeight, 'stitched image spans the full page height')
})

test('captureFullPage: a SHORT window page is ONE tight single-image fullPage shot (no -cNN)', async (t) => {
  const dir = await fs.mkdtemp(join(tmpdir(), 'short-'))
  t.onTestFinished(async () => { await fs.rm(dir, { recursive: true, force: true }) })
  // fullHeight (700) fits one band (clientHeight 1200) in window mode → one tight shot.
  const { page, shots } = makeFakePage({ fullHeight: 700, docWidth: 1280, clientHeight: 1200, mode: 'window' })
  const base = join(dir, 'one.png')
  const slicePath = (chunk: number | null): string =>
    chunk === null ? base : base.replace(/\.png$/, `-c${String(chunk + 1).padStart(2, '0')}.png`)

  const written = await Session.captureFullPage(page, slicePath)

  assert.deepEqual(written, [base], 'one file, the single base name (no chunk suffix)')
  assert.equal(shots.length, 1)
  assert.equal(shots[0].fullPage, true, 'a short window page is captured tight via fullPage')
})

test('captureFullPage: a TALL page is split into N readable -cNN painted-viewport slices, top→bottom', async (t) => {
  const dir = await fs.mkdtemp(join(tmpdir(), 'tall-'))
  t.onTestFinished(async () => { await fs.rm(dir, { recursive: true, force: true }) })
  const fullHeight = 3000
  const clientHeight = 1200
  const { page, shots, scrollOffsets } = makeFakePage({ fullHeight, docWidth: 1280, clientHeight, mode: 'window' })
  const base = join(dir, 'rec.png')
  const slicePath = (chunk: number | null): string =>
    chunk === null ? base : base.replace(/\.png$/, `-c${String(chunk + 1).padStart(2, '0')}.png`)

  const written = await Session.captureFullPage(page, slicePath)

  const expectedOffsets = computeSliceOffsets(fullHeight, clientHeight, CAPTURE.sliceOverlap, CAPTURE.maxSlices)
  assert.equal(written.length, expectedOffsets.length, 'one file per slice')
  assert.ok(written.length > 1, 'a 3000px page splits into multiple slices')
  // Every slice carries a -cNN suffix and sorts top→bottom.
  assert.ok(written.every((p, i) => p.endsWith(`-c${String(i + 1).padStart(2, '0')}.png`)))
  // The target was scrolled to each expected offset, top→bottom.
  assert.deepEqual(scrollOffsets, expectedOffsets, 'scrolled to each band offset in order')
  // Each band is a painted-VIEWPORT clip shot — NOT a fullPage render.
  assert.equal(shots.length, expectedOffsets.length)
  assert.ok(shots.every((s) => s.fullPage === undefined && s.clip?.x === 0))
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
  assert.equal(shots[0].fullPage, undefined)
  assert.equal(shots[0].clip, undefined)
})

test('captureAll: the default route is the unified capture — short page → ONE file, canonical name', async (t) => {
  const dir = await fs.mkdtemp(join(tmpdir(), 'capall-'))
  t.onTestFinished(async () => { await fs.rm(dir, { recursive: true, force: true }) })
  const { page, shots } = makeFakePage({ fullHeight: 800, docWidth: 1280 })
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
  assert.equal(res.length, 1)
  assert.equal(res[0].system, 'ucpath')
  assert.match(res[0].path, /-form-ucpath-transaction-submitted-ucpath-\d+\.png$/)
  assert.equal(shots[0].fullPage, true)
})

test('captureAll: a TALL page emits N -cNN slice files, in scroll order', async (t) => {
  const dir = await fs.mkdtemp(join(tmpdir(), 'capall-tall-'))
  t.onTestFinished(async () => { await fs.rm(dir, { recursive: true, force: true }) })
  const { page } = makeFakePage({ fullHeight: 4000, docWidth: 1280 })
  const session = Session.forTesting({
    systems: [{ id: 'crm', login: async () => {} }],
    browsers: new Map([['crm', { page: page as never, browser: null as never, context: null as never }]]),
    readyPromises: new Map(),
    screenshotDir: dir,
  })
  const res = await session.captureAll({
    workflow: 'person-lookup', itemId: 'Jane', kind: 'form',
    label: 'crm-record', ts: 1776712000000, systems: ['crm'],
  })
  assert.ok(res.length >= 2, 'a 4000px page produces multiple slice files')
  assert.ok(res.every((f) => /-crm-record-crm-\d+-c\d{2}\.png$/.test(f.path)))
  const suffixes = res.map((f) => f.path.match(/-c(\d{2})\.png$/)![1])
  assert.deepEqual(suffixes, [...suffixes].sort(), 'slices sort top→bottom')
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
  assert.equal((seen as unknown as Record<string, unknown>).paged, undefined)
  assert.equal((seen as unknown as Record<string, unknown>).region, undefined)
  assert.equal((seen as unknown as Record<string, unknown>).bounded, undefined)
  assert.equal(cap.files.length, 1)
})

test('makeScreenshotFn: centerSelector flows through, and the event lists every slice file', async () => {
  let seen: CaptureFileOpts | null = null
  const fakeSession = {
    captureAll: async (o: CaptureFileOpts) => {
      seen = o
      // A tall page returns multiple slice files; the capture event must list them all.
      return [
        { system: 'crm', path: '/tmp/x-c01.png', bytes: 7 },
        { system: 'crm', path: '/tmp/x-c02.png', bytes: 7 },
      ]
    },
  }
  const fn = makeScreenshotFn({
    session: fakeSession as never,
    runId: 'r', workflow: 'person-lookup', itemId: 'Jane',
    emit: () => {}, currentStep: () => null,
  })
  const cap = await fn({ kind: 'form', label: 'crm-record', systems: ['crm'], centerSelector: '.x' })
  assert.equal(seen!.centerSelector, '.x')
  assert.equal(cap.files.length, 2, 'every slice file lands in the capture event')
})

test('captureFullPage stitch:true — a TALL page becomes ONE composited image (no -cNN)', async (t) => {
  const dir = await fs.mkdtemp(join(tmpdir(), 'stitch-'))
  t.onTestFinished(async () => { await fs.rm(dir, { recursive: true, force: true }) })
  const fullHeight = 3000
  const clientHeight = 1200
  const { page, shots } = makeRealPngFakePage({ fullHeight, docWidth: 1280, clientHeight, mode: 'window' })
  const base = join(dir, 'txn.png')
  const slicePath = (chunk: number | null): string =>
    chunk === null ? base : base.replace(/\.png$/, `-c${String(chunk + 1).padStart(2, '0')}.png`)

  const written = await Session.captureFullPage(page, slicePath, { stitch: true })

  // The multi-band page collapses to ONE file at the single (no-chunk) name.
  assert.deepEqual(written, [base], 'one stitched file, no -cNN suffix')
  // It captured each band as a clip buffer (no path) — the stitch loop, not the slice loop.
  const offsets = computeSliceOffsets(fullHeight, clientHeight, CAPTURE.sliceOverlap, CAPTURE.maxSlices)
  assert.equal(shots.length, offsets.length, 'one clip shot per band')
  assert.ok(shots.every((s) => s.path === undefined && s.clip?.x === 0), 'bands captured to buffers, not files')
  // The stitched PNG spans the whole page (last offset + band height) at 1× scale.
  const png = PNG.sync.read(await fs.readFile(base))
  assert.equal(png.height, offsets[offsets.length - 1] + clientHeight, 'one continuous image spanning the page')
})

test('captureFullPage stitch:true — degrades to -cNN slices when a band cannot be decoded', async (t) => {
  const dir = await fs.mkdtemp(join(tmpdir(), 'stitch-degrade-'))
  t.onTestFinished(async () => { await fs.rm(dir, { recursive: true, force: true }) })
  // The PNGSTUB fake returns invalid PNG bytes → compositing throws → fall back to slices.
  const { page } = makeFakePage({ fullHeight: 3000, docWidth: 1280, clientHeight: 1200, mode: 'window' })
  const base = join(dir, 'txn.png')
  const slicePath = (chunk: number | null): string =>
    chunk === null ? base : base.replace(/\.png$/, `-c${String(chunk + 1).padStart(2, '0')}.png`)

  const written = await Session.captureFullPage(page, slicePath, { stitch: true })

  assert.ok(written.length > 1, 'no stitched image lost — degrades to the raw slices')
  assert.ok(written.every((p, i) => p.endsWith(`-c${String(i + 1).padStart(2, '0')}.png`)), 'slice names preserved')
})

test('makeScreenshotFn: stitch flows through to captureAll', async () => {
  let seen: CaptureFileOpts | null = null
  const fakeSession = {
    captureAll: async (o: CaptureFileOpts) => { seen = o; return [{ system: 'ucpath', path: '/tmp/x.png', bytes: 7 }] },
  }
  const fn = makeScreenshotFn({
    session: fakeSession as never,
    runId: 'r', workflow: 'separations', itemId: '3907',
    emit: () => {}, currentStep: () => null,
  })
  await fn({ kind: 'form', label: 'ucpath-transaction-submitted', systems: ['ucpath'], stitch: true })
  assert.equal(seen!.stitch, true)
})
