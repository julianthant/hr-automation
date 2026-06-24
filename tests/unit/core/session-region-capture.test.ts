import { test } from 'vitest'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Session, formatCaptureFilename, BOUNDED_CAPTURE_WIDTH, CAPTURE } from '../../../src/core/kernel/session.js'
import { makeScreenshotFn } from '../../../src/core/kernel/screenshot.js'
import type { CaptureFileOpts } from '../../../src/core/kernel/types.js'

type Shot = { path?: string; fullPage?: boolean; clip?: { x: number; y: number; width: number; height: number } }

/**
 * A fake Playwright Page that records page-level + locator-level `screenshot`
 * calls and writes a tiny byte stub to disk (so `captureAll`'s `fs.stat` sizing
 * succeeds). `evaluate` is disambiguated by the source of the passed fn so the
 * real capture control flow runs without a browser:
 *  - contains `innerWidth`     → viewport metrics for setCaptureViewportWidth
 *  - contains `querySelectorAll` → DOM-mutating evals (expand overflow / grow
 *    iframes / their restores) — return undefined
 *  - contains `scrollHeight`   → the bounded full-page height probe (a number)
 */
function makeFakePage(opts: { fullHeight?: number; regionThrows?: boolean } = {}): {
  page: any
  shots: Shot[]
  regionShots: Array<{ path?: string }>
  scrolls: number[]
} {
  const shots: Shot[] = []
  const regionShots: Array<{ path?: string }> = []
  const scrolls: number[] = []
  const write = async (o: { path?: string }): Promise<Buffer> => {
    const buf = Buffer.from('PNGSTUB')
    if (o.path) await fs.writeFile(o.path, buf)
    return buf
  }
  const page = {
    async evaluate(fn: unknown, arg?: unknown): Promise<unknown> {
      const src = String(fn)
      if (src.includes('scrollTo')) {
        if (typeof arg === 'number') scrolls.push(arg)
        return undefined
      }
      if (src.includes('innerWidth')) return { iw: 960, ih: 620 }
      if (src.includes('querySelectorAll')) return undefined
      if (src.includes('scrollHeight')) return opts.fullHeight ?? 2400
      return undefined
    },
    async waitForLoadState(): Promise<void> {},
    async waitForTimeout(): Promise<void> {},
    async setViewportSize(): Promise<void> {},
    frames(): unknown[] { return [] },
    locator(_sel: string) {
      return {
        first() {
          return {
            async screenshot(o: { path?: string }): Promise<Buffer> {
              if (opts.regionThrows) throw new Error('locator screenshot: Timeout')
              regionShots.push({ path: o.path })
              return write(o)
            },
          }
        },
      }
    },
    async screenshot(o: Shot): Promise<Buffer> {
      shots.push(o)
      return write(o)
    },
  }
  return { page, shots, regionShots, scrolls }
}

test('formatCaptureFilename builds the canonical name (no chunk suffix)', () => {
  const fn = formatCaptureFilename({
    workflow: 'separations', itemId: '3907', kind: 'form',
    label: 'kuali-finalization-saved', system: 'kuali', ts: 1776712000000,
  })
  assert.equal(fn, 'separations-3907-form-kuali-finalization-saved-kuali-1776712000000.png')
})

test('formatCaptureFilename appends a zero-padded -cNN suffix for paged chunks', () => {
  const base = {
    workflow: 'separations', itemId: '3907', kind: 'form' as const,
    label: 'kuali-finalization-saved', system: 'kuali', ts: 1776712000000,
  }
  // chunk index is zero-based; the suffix is 1-based + padded so the N files
  // sort in scroll order (c01 < c02 < … < c10).
  assert.equal(formatCaptureFilename({ ...base, chunk: 0 }),
    'separations-3907-form-kuali-finalization-saved-kuali-1776712000000-c01.png')
  assert.equal(formatCaptureFilename({ ...base, chunk: 9 }),
    'separations-3907-form-kuali-finalization-saved-kuali-1776712000000-c10.png')
})

test('capturePagedFullPage: scrolls top→bottom, one VIEWPORT shot per chunk (never fullPage)', async (t) => {
  const dir = await fs.mkdtemp(join(tmpdir(), 'paged-'))
  t.onTestFinished(async () => { await fs.rm(dir, { recursive: true, force: true }) })
  const { page, shots, scrolls } = makeFakePage({ fullHeight: 2400 })
  const chunkPath = (chunk: number): string => join(dir, `kuali-c${String(chunk + 1).padStart(2, '0')}.png`)

  const written = await Session.capturePagedFullPage(page, chunkPath)

  // step = chunkHeight - overlap; chunks until a chunk's bottom reaches fullHeight.
  const step = CAPTURE.chunkHeight - CAPTURE.chunkOverlap
  let expected = 0
  for (let c = 0; c < CAPTURE.maxChunks; c++) {
    const y = c * step
    if (c > 0 && y >= 2400) break
    expected++
    if (y + CAPTURE.chunkHeight >= 2400) break
  }
  assert.equal(written.length, expected, 'one file per scrolled chunk')
  assert.equal(shots.length, expected, 'one screenshot per chunk')
  // Every chunk is a PLAIN viewport shot — never fullPage, never clip.
  assert.ok(shots.every((s) => s.fullPage === undefined && s.clip === undefined))
  // Distinct, scroll-ordered chunk paths.
  assert.deepEqual(written, written.map((_, i) => chunkPath(i)))
  // It actually scrolled DOWN through the page (the optimization the user asked
  // for) — strictly increasing scroll offsets, starting at the top.
  const downScrolls = scrolls.filter((y, i) => i === 0 || y > scrolls[i - 1] || y === 0)
  assert.equal(downScrolls[0], 0, 'first chunk is the top of the page')
  assert.ok(scrolls.some((y) => y > 0), 'scrolled past the first fold')
})

test('capturePagedFullPage: a short page yields exactly one chunk', async (t) => {
  const dir = await fs.mkdtemp(join(tmpdir(), 'paged-'))
  t.onTestFinished(async () => { await fs.rm(dir, { recursive: true, force: true }) })
  const { page, shots } = makeFakePage({ fullHeight: 500 }) // < chunkHeight
  const chunkPath = (chunk: number): string => join(dir, `s-c${String(chunk + 1).padStart(2, '0')}.png`)
  const written = await Session.capturePagedFullPage(page, chunkPath)
  assert.equal(written.length, 1)
  assert.equal(shots.length, 1)
})

test('capturePagedFullPage: a page just over one viewport yields ONE chunk, not a clamped near-duplicate', async (t) => {
  // Regression: the Kuali finalization page (le-dylan run) measured ~one
  // viewport + a sliver of chrome (fullHeight just above chunkHeight). The OLD
  // loop computed the 2nd chunk's scroll as the UNCLAMPED `chunk * step`, which
  // the browser clamped back to ~the first chunk's position → the operator got
  // "the same one twice". When the strip still below the first fold fits within
  // the overlap seam, there must be exactly ONE chunk.
  const dir = await fs.mkdtemp(join(tmpdir(), 'paged-'))
  t.onTestFinished(async () => { await fs.rm(dir, { recursive: true, force: true }) })
  // fullHeight − chunkHeight = 50 ≤ chunkOverlap (72): a 2nd chunk would only
  // re-show content already readable in the first.
  const fullHeight = CAPTURE.chunkHeight + 50
  const { page, shots } = makeFakePage({ fullHeight })
  const chunkPath = (chunk: number): string => join(dir, `d-c${String(chunk + 1).padStart(2, '0')}.png`)
  const written = await Session.capturePagedFullPage(page, chunkPath)
  assert.equal(written.length, 1, 'one chunk — no clamped near-duplicate')
  assert.equal(shots.length, 1)
})

test('capturePagedFullPage: never scrolls past maxScroll (clamped, distinct chunk positions)', async (t) => {
  // A page genuinely needing a 2nd chunk (the below-fold strip exceeds the
  // overlap seam) still must clamp the scroll target to maxScroll — the OLD
  // loop intended `chunk * step` (928), far past this page's 200px maxScroll,
  // so the clamped 2nd shot near-duplicated the first.
  const dir = await fs.mkdtemp(join(tmpdir(), 'paged-'))
  t.onTestFinished(async () => { await fs.rm(dir, { recursive: true, force: true }) })
  const fullHeight = CAPTURE.chunkHeight + 200 // maxScroll = 200 (> chunkOverlap)
  const maxScroll = fullHeight - CAPTURE.chunkHeight
  const { page, shots, scrolls } = makeFakePage({ fullHeight })
  const chunkPath = (chunk: number): string => join(dir, `m-c${String(chunk + 1).padStart(2, '0')}.png`)
  const written = await Session.capturePagedFullPage(page, chunkPath)
  assert.equal(written.length, 2, 'two chunks: the top fold + the bottom strip')
  assert.equal(shots.length, 2)
  // No scroll target ever exceeds maxScroll (the browser would clamp it anyway,
  // and the unclamped target is what produced the duplicate). The trailing 0 is
  // the finally reset-to-top.
  assert.ok(scrolls.every((y) => y <= maxScroll), `scrolls clamped ≤ ${maxScroll}: ${scrolls}`)
  // The two chunks are at distinct scroll positions (top, then the bottom).
  assert.deepEqual(scrolls.filter((y, i) => i === 0 || y !== scrolls[i - 1]).slice(0, 2), [0, maxScroll])
})

test('captureAll: paged route emits N chunk files (the whole page, in order)', async (t) => {
  const dir = await fs.mkdtemp(join(tmpdir(), 'capall-'))
  t.onTestFinished(async () => { await fs.rm(dir, { recursive: true, force: true }) })
  const { page } = makeFakePage({ fullHeight: 2400 })
  const session = Session.forTesting({
    systems: [{ id: 'kuali', login: async () => {} }],
    browsers: new Map([['kuali', { page: page as never, browser: null as never, context: null as never }]]),
    readyPromises: new Map(),
    screenshotDir: dir,
  })
  const res = await session.captureAll({
    workflow: 'separations', itemId: '3907', kind: 'form',
    label: 'kuali-finalization-saved', ts: 1776712000000,
    systems: ['kuali'], paged: true,
  })
  assert.ok(res.length >= 2, 'a tall page produces multiple chunk files')
  // Every chunk carries the chunk suffix + the same system/label.
  assert.ok(res.every((f) => f.system === 'kuali'))
  assert.ok(res.every((f) => /-kuali-finalization-saved-kuali-\d+-c\d{2}\.png$/.test(f.path)))
  // Sorted in scroll order (c01, c02, …).
  const suffixes = res.map((f) => f.path.match(/-c(\d{2})\.png$/)![1])
  assert.deepEqual(suffixes, [...suffixes].sort())
})

test('captureRegion: captures ONLY the element via locator.screenshot, returns path', async (t) => {
  const dir = await fs.mkdtemp(join(tmpdir(), 'region-'))
  t.onTestFinished(async () => { await fs.rm(dir, { recursive: true, force: true }) })
  const { page, shots, regionShots } = makeFakePage()
  const out = join(dir, 'region.png')

  const written = await Session.captureRegion(page, '#finalization-modal', out)

  assert.equal(written, out)
  // Element-scoped capture — NOT a page-level fullPage shot.
  assert.equal(regionShots.length, 1)
  assert.equal(regionShots[0].path, out)
  assert.equal(shots.length, 0, 'region must not take a page-level screenshot')
})

test('captureRegion: missing/timeout element returns null (caller falls back)', async (t) => {
  const dir = await fs.mkdtemp(join(tmpdir(), 'region-'))
  t.onTestFinished(async () => { await fs.rm(dir, { recursive: true, force: true }) })
  const { page } = makeFakePage({ regionThrows: true })
  const written = await Session.captureRegion(page, '#missing', join(dir, 'x.png'))
  assert.equal(written, null)
})

test('captureBoundedFullPage: one fullPage shot clipped to the FIXED width (no ribbon)', async (t) => {
  const dir = await fs.mkdtemp(join(tmpdir(), 'bounded-'))
  t.onTestFinished(async () => { await fs.rm(dir, { recursive: true, force: true }) })
  const { page, shots } = makeFakePage({ fullHeight: 2400 })
  const out = join(dir, 'bounded.png')

  const written = await Session.captureBoundedFullPage(page, out)

  assert.equal(written, out)
  assert.equal(shots.length, 1)
  const s = shots[0]
  assert.equal(s.fullPage, true, 'bounded uses fullPage:true so the clip resolves against the full-page image')
  assert.ok(s.clip, 'bounded must clip')
  assert.equal(s.clip!.x, 0)
  assert.equal(s.clip!.y, 0)
  assert.equal(s.clip!.width, BOUNDED_CAPTURE_WIDTH, 'width is fixed (not content-fit widened) so it never becomes a ribbon')
  assert.equal(s.clip!.height, 2400, 'height covers the full document')
})

test('captureBoundedFullPage: degenerate geometry falls back to a plain fullPage', async (t) => {
  const dir = await fs.mkdtemp(join(tmpdir(), 'bounded-'))
  t.onTestFinished(async () => { await fs.rm(dir, { recursive: true, force: true }) })
  const { page, shots } = makeFakePage({ fullHeight: 0 })
  const written = await Session.captureBoundedFullPage(page, join(dir, 'x.png'))
  assert.ok(written)
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

test('captureAll: region route emits ONE file with the plain label', async (t) => {
  const dir = await fs.mkdtemp(join(tmpdir(), 'capall-'))
  t.onTestFinished(async () => { await fs.rm(dir, { recursive: true, force: true }) })
  const { page } = makeFakePage()
  const session = Session.forTesting({
    systems: [{ id: 'ucpath', login: async () => {} }],
    browsers: new Map([['ucpath', { page: page as never, browser: null as never, context: null as never }]]),
    readyPromises: new Map(),
    screenshotDir: dir,
  })
  const opts: CaptureFileOpts = {
    workflow: 'separations', itemId: '3907', kind: 'form',
    label: 'ucpath-transaction-submitted', ts: 1776712000000,
    systems: ['ucpath'], region: '#main_target_win0',
  }
  const res = await session.captureAll(opts)
  assert.equal(res.length, 1)
  assert.equal(res[0].system, 'ucpath')
  assert.match(res[0].path, /-form-ucpath-transaction-submitted-ucpath-/)
})

test('captureAll: region MISSING falls back to a bounded full-page shot (capture never vanishes)', async (t) => {
  const dir = await fs.mkdtemp(join(tmpdir(), 'capall-'))
  t.onTestFinished(async () => { await fs.rm(dir, { recursive: true, force: true }) })
  const { page, shots } = makeFakePage({ regionThrows: true, fullHeight: 1800 })
  const session = Session.forTesting({
    systems: [{ id: 'ucpath', login: async () => {} }],
    browsers: new Map([['ucpath', { page: page as never, browser: null as never, context: null as never }]]),
    readyPromises: new Map(),
    screenshotDir: dir,
  })
  const res = await session.captureAll({
    workflow: 'separations', itemId: '3907', kind: 'form',
    label: 'ucpath-transaction-submitted', ts: 1776712000000,
    systems: ['ucpath'], region: '#main_target_win0',
  })
  assert.equal(res.length, 1, 'fallback still produces one file')
  // The fallback is a bounded fullPage clip shot.
  assert.ok(shots.some((s) => s.fullPage === true && s.clip?.width === BOUNDED_CAPTURE_WIDTH))
})

test('captureAll: bounded route emits ONE full-page file with the plain label', async (t) => {
  const dir = await fs.mkdtemp(join(tmpdir(), 'capall-'))
  t.onTestFinished(async () => { await fs.rm(dir, { recursive: true, force: true }) })
  const { page } = makeFakePage({ fullHeight: 1500 })
  const session = Session.forTesting({
    systems: [{ id: 'kuali', login: async () => {} }],
    browsers: new Map([['kuali', { page: page as never, browser: null as never, context: null as never }]]),
    readyPromises: new Map(),
    screenshotDir: dir,
  })
  const res = await session.captureAll({
    workflow: 'separations', itemId: '3907', kind: 'form',
    label: 'kuali-finalization-saved', ts: 1776712000000,
    systems: ['kuali'], bounded: true,
  })
  assert.equal(res.length, 1)
  assert.match(res[0].path, /-form-kuali-finalization-saved-kuali-/)
})

test('makeScreenshotFn: region flows through to captureAll', async () => {
  let seen: CaptureFileOpts | null = null
  const fakeSession = {
    captureAll: async (o: CaptureFileOpts) => { seen = o; return [{ system: 'ucpath', path: '/tmp/x.png', bytes: 7 }] },
  }
  const fn = makeScreenshotFn({
    session: fakeSession as never,
    runId: 'r', workflow: 'separations', itemId: '3907',
    emit: () => {}, currentStep: () => null,
  })
  await fn({ kind: 'form', label: 'ucpath-transaction-submitted', systems: ['ucpath'], region: '#main_target_win0' })
  assert.equal(seen!.region, '#main_target_win0')
  assert.deepEqual(seen!.systems, ['ucpath'])
})

test('makeScreenshotFn: bounded + centerSelector flow through to captureAll', async () => {
  const seen: CaptureFileOpts[] = []
  const fakeSession = {
    captureAll: async (o: CaptureFileOpts) => { seen.push(o); return [{ system: 's', path: '/tmp/x.png', bytes: 7 }] },
  }
  const fn = makeScreenshotFn({
    session: fakeSession as never,
    runId: 'r', workflow: 'separations', itemId: '3907',
    emit: () => {}, currentStep: () => null,
  })
  await fn({ kind: 'form', label: 'kuali-finalization-saved', systems: ['kuali'], bounded: true })
  await fn({ kind: 'form', label: 'new-kronos-last-worked-date', systems: ['new-kronos'], centerSelector: '.ui-grid-viewport' })
  assert.equal(seen[0].bounded, true)
  assert.equal(seen[1].centerSelector, '.ui-grid-viewport')
})

test('makeScreenshotFn: paged flows through to captureAll', async () => {
  let seen: CaptureFileOpts | null = null
  const fakeSession = {
    captureAll: async (o: CaptureFileOpts) => {
      seen = o
      return [
        { system: 'kuali', path: '/tmp/x-c01.png', bytes: 7 },
        { system: 'kuali', path: '/tmp/x-c02.png', bytes: 7 },
      ]
    },
  }
  const fn = makeScreenshotFn({
    session: fakeSession as never,
    runId: 'r', workflow: 'separations', itemId: '3907',
    emit: () => {}, currentStep: () => null,
  })
  const cap = await fn({ kind: 'form', label: 'kuali-finalization-saved', systems: ['kuali'], paged: true })
  assert.equal(seen!.paged, true)
  // The capture event lists every chunk file, so all chunks land in the panel.
  assert.equal(cap.files.length, 2)
})
