import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import os from "node:os";
import { bundlePhotosToPdf } from "../../../src/capture/pdf-bundle.js";

// Note on testing scope: pdf-lib's image embedders (UPNG, JpegEmbedder) reject
// the minimum-viable hex test fixtures we can build inline. Generating real
// JPEGs/PNGs at test time would require pulling in `sharp` or `canvas` — both
// heavy native deps for an upstream-trusted code path. Instead we test the
// shape of `bundlePhotosToPdf` (empty input, parent-dir creation, missing-file
// behavior) and rely on end-to-end manual smoke for the actual JPEG/PNG embed
// path. The image-bundling tests will be added once a real fixture is checked
// into `tests/fixtures/`.

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

  it("zero photos produces a one-page empty PDF (caller decides what to do)", async () => {
    const out = join(tmp, "out.pdf");
    await bundlePhotosToPdf([], out);
    assert.equal(existsSync(out), true);
  });

  it("creates parent directory if missing (with empty input)", async () => {
    const out = join(tmp, "deep/nested/out.pdf");
    await bundlePhotosToPdf([], out);
    assert.equal(existsSync(out), true);
  });

  it("throws clearly when an image file is missing", async () => {
    const out = join(tmp, "out.pdf");
    await assert.rejects(
      bundlePhotosToPdf([join(tmp, "nope.jpg")], out),
      /ENOENT|no such file/i,
    );
  });

  it("output starts with %PDF magic header", async () => {
    const { readFileSync } = await import("node:fs");
    const out = join(tmp, "out.pdf");
    await bundlePhotosToPdf([], out);
    const bytes = readFileSync(out);
    assert.equal(bytes.slice(0, 4).toString("ascii"), "%PDF");
  });
});
