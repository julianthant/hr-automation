import { test } from 'vitest'
import assert from 'node:assert/strict'
import { PNG } from 'pngjs'
import { stitchCaptureBands, type CaptureBand } from '../../../src/core/kernel/capture-stitch.js'

/** A solid-color PNG buffer of the given size — a stand-in for one scroll band. */
function solidPng(width: number, height: number, r: number, g: number, b: number): Buffer {
  const png = new PNG({ width, height })
  for (let i = 0; i < width * height; i++) {
    png.data[i * 4] = r
    png.data[i * 4 + 1] = g
    png.data[i * 4 + 2] = b
    png.data[i * 4 + 3] = 255
  }
  return PNG.sync.write(png)
}

/** Decode a PNG buffer and read the RED channel of one pixel. */
function pixelR(buf: Buffer, x: number, y: number): number {
  const png = PNG.sync.read(buf)
  return png.data[(y * png.width + x) * 4]
}

function dims(buf: Buffer): { w: number; h: number } {
  const png = PNG.sync.read(buf)
  return { w: png.width, h: png.height }
}

test('stitchCaptureBands: a single band is returned unchanged', () => {
  const band: CaptureBand = { buffer: solidPng(1280, 1200, 200, 0, 0), offsetCss: 0, clipHeightCss: 1200 }
  const out = stitchCaptureBands([band])
  assert.deepEqual(dims(out), { w: 1280, h: 1200 })
})

test('stitchCaptureBands: composites bands by scroll offset, later band overwrites the overlap', () => {
  // Mirrors a tall window page: computeSliceOffsets(3000, 1200, 120, 30) = [0, 1080, 1800].
  const bands: CaptureBand[] = [
    { buffer: solidPng(1280, 1200, 255, 0, 0), offsetCss: 0, clipHeightCss: 1200 },    // red
    { buffer: solidPng(1280, 1200, 0, 255, 0), offsetCss: 1080, clipHeightCss: 1200 }, // green
    { buffer: solidPng(1280, 1200, 0, 0, 255), offsetCss: 1800, clipHeightCss: 1200 }, // blue (last, anchored)
  ]
  const out = stitchCaptureBands(bands)

  // scale = 1200/1200 = 1; tops = [0, 1080, 1800]; canvas = max(top+height) = 3000.
  assert.deepEqual(dims(out), { w: 1280, h: 3000 }, 'one continuous image spanning the whole page')
  // Band 0 owns [0, 1080) (band 1 starts at 1080), band 1 owns [1080, 1800)
  // (band 2 starts at 1800), band 2 owns [1800, 3000). Overlaps go to the later band.
  assert.equal(pixelR(out, 10, 0), 255, 'top is band 0 (red)')
  assert.equal(pixelR(out, 10, 1079), 255, 'just above band 1 is still band 0 (red)')
  assert.equal(pixelR(out, 10, 1080), 0, 'band 1 (green) takes over at its offset')
  assert.equal(pixelR(out, 10, 1799), 0, 'just above band 2 is still band 1 (green)')
  assert.equal(pixelR(out, 10, 1800), 0, 'band 2 (blue) takes over at its offset')
  assert.equal(pixelR(out, 10, 2999), 0, 'bottom is band 2 (blue)')
})

test('stitchCaptureBands: device pixel ratio is derived per-band (clip height ≠ PNG height)', () => {
  // A 2× DPR page: each band is 200 device px tall but 100 CSS px of clip.
  // scale = 200/100 = 2; band 1 at offsetCss 90 lands at device row round(90*2)=180.
  const bands: CaptureBand[] = [
    { buffer: solidPng(50, 200, 255, 0, 0), offsetCss: 0, clipHeightCss: 100 },
    { buffer: solidPng(50, 200, 0, 0, 255), offsetCss: 90, clipHeightCss: 100 },
  ]
  const out = stitchCaptureBands(bands)
  assert.deepEqual(dims(out), { w: 50, h: 380 }, 'canvas = 180 + 200')
  assert.equal(pixelR(out, 10, 0), 255, 'band 0 at top')
  assert.equal(pixelR(out, 10, 179), 255, 'band 0 up to the overlap')
  assert.equal(pixelR(out, 10, 180), 0, 'band 1 placed at offsetCss×scale')
})

test('stitchCaptureBands: throws on empty input and on an undecodable buffer', () => {
  assert.throws(() => stitchCaptureBands([]), /no bands/)
  assert.throws(() => stitchCaptureBands([
    { buffer: Buffer.from('NOT-A-PNG'), offsetCss: 0, clipHeightCss: 1200 },
    { buffer: Buffer.from('NOT-A-PNG'), offsetCss: 1080, clipHeightCss: 1200 },
  ]))
})
