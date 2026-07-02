import { PNG } from 'pngjs'

/**
 * One scroll-captured band of a tall page, as produced by
 * `Session.captureFullPage`'s painted-pixel scroll loop.
 *
 * - `buffer` — the PNG bytes of the band (a `page.screenshot({ clip })` shot of
 *   the painted viewport at this scroll position).
 * - `offsetCss` — the vertical scroll offset (CSS px, in the scroll target's
 *   coordinate space) the band was captured at. Band 0 is always `0`; the
 *   offsets come from `computeSliceOffsets`, so they are monotonically
 *   non-decreasing and reachable (the last is clamped to `scrollHeight − band`).
 * - `clipHeightCss` — the band's on-screen clip height (CSS px). Combined with
 *   the decoded PNG height this yields the device-px-per-CSS-px scale, so we
 *   never have to assume a device pixel ratio.
 */
export interface CaptureBand {
  buffer: Buffer
  offsetCss: number
  clipHeightCss: number
}

/**
 * Hard cap on the stitched composite canvas, in total DEVICE pixels.
 *
 * Stitching decodes every band with pngjs, allocates the full-page RGBA canvas
 * (4 bytes/px), and pure-JS-deflates it — all SYNCHRONOUSLY on the daemon
 * event loop. Above this cap the transient allocation (a 2560×30k-device-px
 * page is ~300MB) and deflate stall Duo polling / health probes / abort
 * handling / session emits for seconds, so the capture degrades to the
 * existing `-cNN` band slices instead (nothing is lost — the composite is
 * simply not built).
 */
export const MAX_STITCH_PIXELS = 40_000_000 // ~2560 x 15.6k device px ≈ 160MB RGBA canvas

/**
 * Width/height straight from a PNG buffer's IHDR header — signature check plus
 * two 32-bit reads, no image-data decode. Returns null when the buffer isn't a
 * readable PNG header.
 */
function readPngHeaderSize(buffer: Buffer): { width: number; height: number } | null {
  // 8-byte signature, 4-byte IHDR length, 4-byte "IHDR", then width + height.
  if (buffer.length < 24) return null
  if (buffer[0] !== 0x89 || buffer[1] !== 0x50 || buffer[2] !== 0x4e || buffer[3] !== 0x47) return null
  const width = buffer.readUInt32BE(16)
  const height = buffer.readUInt32BE(20)
  if (!(width > 0) || !(height > 0)) return null
  return { width, height }
}

/**
 * Pure: the total device pixels the stitched composite canvas would allocate
 * for these bands — the same width/height math as {@link stitchCaptureBands}
 * (scale from band 0, geometry-placed tops), but computed from each band PNG's
 * IHDR header alone: no decode, no canvas. Returns `NaN` when a band header is
 * unreadable — the caller then attempts the stitch anyway and relies on its
 * decode-failure degrade path.
 */
export function estimateStitchedPixels(
  bands: ReadonlyArray<Pick<CaptureBand, 'buffer' | 'offsetCss' | 'clipHeightCss'>>,
): number {
  if (bands.length === 0) return Number.NaN
  const head0 = readPngHeaderSize(bands[0].buffer)
  if (!head0 || !(bands[0].clipHeightCss > 0)) return Number.NaN
  const scale = head0.height / bands[0].clipHeightCss
  const baseOffset = bands[0].offsetCss
  let canvasWidth = 0
  let canvasHeight = 0
  for (const b of bands) {
    const h = readPngHeaderSize(b.buffer)
    if (!h) return Number.NaN
    const top = Math.max(0, Math.round((b.offsetCss - baseOffset) * scale))
    canvasWidth = Math.max(canvasWidth, h.width)
    canvasHeight = Math.max(canvasHeight, top + h.height)
  }
  return canvasWidth * canvasHeight
}

/**
 * Pure decision: composite the bands into one stitched image, or degrade to
 * the `-cNN` band slices? True unless the estimated composite AFFIRMATIVELY
 * exceeds the pixel cap — an unknown estimate (`NaN`, from an unreadable band
 * header) still attempts the stitch, whose own decode-failure handling
 * degrades to slices.
 */
export function shouldStitchComposite(
  estPixels: number,
  maxPixels: number = MAX_STITCH_PIXELS,
): boolean {
  return !(Number.isFinite(estPixels) && estPixels > maxPixels)
}

/**
 * Composite scroll-captured bands of a tall page into ONE continuous PNG, with
 * the band-to-band overlap removed — the single stitched image a UCPath
 * transaction (or any `stitch:true`) capture writes instead of N `-cNN` slices.
 *
 * **Why exact geometry, not pixel correlation.** Each band's true scroll
 * position is known (`offsetCss`), so a band is placed at `offsetCss × scale`
 * device px from the top — its content lands at its real position, and the
 * overlap between consecutive bands is covered by the later band overwriting the
 * earlier (identical pixels). This *cannot* mis-align or silently drop/duplicate
 * a row, which a correlation-based stitch can do on the repetitive rows of a
 * PeopleSoft form — and an audit screenshot must be faithful.
 *
 * `scale` (device px per CSS px) is derived from band 0's decoded height ÷ its
 * `clipHeightCss` — the device pixel ratio is constant across bands, so one
 * band's scale places them all consistently (no DPR assumption).
 *
 * Throws on an undecodable buffer or empty input; the caller treats a throw as
 * "stitch failed → fall back to writing the raw slices" so a capture is never
 * lost.
 */
export function stitchCaptureBands(bands: CaptureBand[]): Buffer {
  if (bands.length === 0) throw new Error('stitchCaptureBands: no bands to stitch')
  const pngs = bands.map((b) => PNG.sync.read(b.buffer))
  if (pngs.length === 1) return PNG.sync.write(pngs[0])

  // Device-px-per-CSS-px from band 0 (constant DPR across bands).
  const scale = bands[0].clipHeightCss > 0 ? pngs[0].height / bands[0].clipHeightCss : 1
  const baseOffset = bands[0].offsetCss
  const tops = bands.map((b) => Math.max(0, Math.round((b.offsetCss - baseOffset) * scale)))

  const canvasWidth = Math.max(...pngs.map((p) => p.width))
  const canvasHeight = Math.max(...pngs.map((p, i) => tops[i] + p.height))

  const out = new PNG({ width: canvasWidth, height: canvasHeight })
  out.data.fill(0xff) // white, fully opaque — any uncovered gap reads as page background, not black

  for (let i = 0; i < pngs.length; i++) {
    const src = pngs[i]
    // Copy the whole band into the canvas at its scroll position. Later bands
    // overwrite earlier ones in the overlap region (the pixels are identical).
    // Use the STATIC bitblt — `PNG.sync.read` returns a plain object without the
    // prototype `.bitblt`, so the instance method isn't available.
    PNG.bitblt(src, out, 0, 0, src.width, src.height, 0, tops[i])
  }
  return PNG.sync.write(out)
}
