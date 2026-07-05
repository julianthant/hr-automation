import { describe, it, beforeEach, afterEach } from "vitest";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import os from "node:os";
import { bundlePhotosToPdf } from "../../../../src/services/capture/pdf-bundle.js";

// Note on testing scope: pdf-lib's image embedders (UPNG, JpegEmbedder) reject
// the minimum-viable hex test fixtures we can build inline. Generating real
// JPEGs/PNGs at test time would require pulling in `sharp` or `canvas` — both
// heavy native deps for an upstream-trusted code path. Instead we test the
// shape of `bundlePhotosToPdf` (empty-input rejection, missing-file behavior)
// and rely on end-to-end manual smoke for the actual JPEG/PNG embed path
// (parent-dir creation and the %PDF magic header need a real image and are no
// longer covered here now that empty input throws instead of producing a
// blank PDF). The image-bundling tests will be added once a real fixture is
// checked into `tests/fixtures/`.

function mkTmp(): string {
  const dir = join(os.tmpdir(), `capture-pdf-test-${Date.now()}-${Math.random()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("bundlePhotosToPdf", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkTmp();
  });
  afterEach(() => {
    if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  it("throws on zero photos instead of synthesizing a blank PDF", async () => {
    const out = join(tmp, "out.pdf");
    await assert.rejects(
      bundlePhotosToPdf([], out),
      /no photos to bundle/i,
    );
    assert.equal(existsSync(out), false);
  });

  it("throws clearly when an image file is missing", async () => {
    const out = join(tmp, "out.pdf");
    await assert.rejects(
      bundlePhotosToPdf([join(tmp, "nope.jpg")], out),
      /ENOENT|no such file/i,
    );
  });
});
