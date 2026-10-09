import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { PNG } from "pngjs";

import { Session } from "../../src/core/kernel/session.js";

/**
 * REAL-DOM capture regression — the antidote to the bug that broke every prior
 * Kuali-screenshot fix.
 *
 * Why it lives in the LIVE pool and not `tests/unit`: the main `npm test` lane
 * is deliberately browser-free (the `MIN_OVERFLOW` `page.evaluate` inside
 * `planScrollCapture` is STUBBED by the fake page in
 * `tests/unit/core/session-capture-routing.test.ts`, which returns a canned
 * `{ mode, scrollHeight }` and never runs the real DOM selection). That stub is
 * exactly why a broken `planScrollCapture` kept passing CI while shooting the
 * wrong page live. This test runs the REAL selection logic against a REAL
 * Chromium DOM. It needs a browser but NO network/SSO, so it has no creds guard
 * — only a Chromium-present guard.
 *
 * The shape it reproduces (measured live on a real Kuali Build separation doc,
 * 2026-06-30): the Kuali apps catalog stays MOUNTED in the DOM behind an open
 * document view — a ~16000px-tall `overflow:auto` container painted BEHIND the
 * shorter, visible document-form scroll container. `planScrollCapture` ranked
 * scroll targets by raw hidden overflow, so the tall HIDDEN catalog won and the
 * audit screenshot walked 30 slices of the wrong page. The fix rejects a
 * scroll container that is fully OCCLUDED (never the top painted element), so
 * the visible form wins regardless of the background's overflow.
 *
 * `#catalog` (red, 8000px, behind) must be rejected; `#form` (green, 2400px,
 * on top) must be captured.
 */
const chromiumPresent = (() => {
  try {
    return existsSync(chromium.executablePath());
  } catch {
    return false;
  }
})();

describe("captureFullPage occlusion (real DOM)", () => {
  it.skipIf(!chromiumPresent)(
    "rejects an occluded tall scroll container and captures the visible form",
    async (t) => {
      const browser = await chromium.launch({ headless: true });
      t.onTestFinished(async () => {
        await browser.close().catch(() => {});
      });
      const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

      // Two same-size, same-position overflow:auto containers. #catalog (red) is
      // far taller but sits BEHIND #form (green, z-index 2) which covers the
      // viewport — exactly the Kuali "launcher mounted behind the document"
      // layout. By raw overflow the catalog wins; only the occlusion guard keeps
      // the capture on the visible form.
      await page.setContent(`
        <style>
          html,body{margin:0;padding:0;height:100vh;overflow:hidden;background:#fff}
          #catalog{position:absolute;top:0;left:0;width:1280px;height:760px;overflow:auto;z-index:1}
          #catalog .inner{height:8000px;background:rgb(200,30,30)}
          #form{position:absolute;top:0;left:0;width:1280px;height:760px;overflow:auto;z-index:2}
          #form .inner{height:2400px;background:rgb(30,170,30)}
        </style>
        <div id="catalog"><div class="inner"></div></div>
        <div id="form"><div class="inner"></div></div>
      `);

      const dir = await fs.mkdtemp(join(tmpdir(), "capture-occlusion-"));
      t.onTestFinished(async () => {
        await fs.rm(dir, { recursive: true, force: true });
      });
      const base = join(dir, "kuali-form.png");
      const slicePath = (chunk: number | null): string =>
        chunk === null ? base : base.replace(/\.png$/, `-c${String(chunk + 1).padStart(2, "0")}.png`);

      // stitch:true → one composited image (the separations Kuali capture mode).
      const written = await Session.captureFullPage(page, slicePath, { stitch: true });
      assert.equal(written.length, 1, "stitched into a single image");

      const png = PNG.sync.read(await fs.readFile(written[0]));

      // Height decisively separates the two targets: the visible form is ~2400px
      // of content; the occluded catalog is ~8000px. Pre-fix this image was the
      // 8000px catalog.
      assert.ok(
        png.height < 4000,
        `captured the visible form (~2400px), not the occluded 8000px catalog (got ${png.height}px tall)`,
      );

      // …and every sampled row down the centre column is the form's GREEN, never
      // the catalog's RED.
      for (const frac of [0.1, 0.5, 0.9]) {
        const x = Math.floor(png.width / 2);
        const y = Math.floor(png.height * frac);
        const idx = (png.width * y + x) * 4;
        const r = png.data[idx];
        const g = png.data[idx + 1];
        const b = png.data[idx + 2];
        assert.ok(
          g > 120 && g > r + 40,
          `pixel @${frac} of the stitched image is the visible green form, not the hidden red catalog (rgb ${r},${g},${b})`,
        );
      }
    },
  );
});
