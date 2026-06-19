import { describe, it, beforeEach, afterEach, vi } from "vitest";
import assert from "node:assert/strict";

// ISS-002 (e2e run 20260618-2146): capture photo/PDF dirs were hardcoded
// `.tracker/captures` / `.tracker/uploads` string literals, ignoring
// HRAUTO_TRACKER_DIR. In the e2e stub lane (and any non-default tracker dir) this
// leaked capture artifacts into the REAL `.tracker/` and broke the capture->OCR
// handoff (the bundled PDF landed where OCR prepare couldn't see it). The two
// constants must derive from the active tracker root (PATHS.trackerDir).
//
// These constants are evaluated at module load from PATHS.trackerDir, which reads
// process.env.HRAUTO_TRACKER_DIR at config load — so we set the env, reset the
// module cache, and dynamically re-import to observe the resolved values.
describe("capture dirs honor HRAUTO_TRACKER_DIR (ISS-002)", () => {
  let orig: string | undefined;
  beforeEach(() => {
    orig = process.env.HRAUTO_TRACKER_DIR;
  });
  afterEach(() => {
    if (orig === undefined) delete process.env.HRAUTO_TRACKER_DIR;
    else process.env.HRAUTO_TRACKER_DIR = orig;
    vi.resetModules();
  });

  it("CAPTURE_PHOTOS_DIR + CAPTURE_UPLOADS_DIR sit under the configured tracker dir, not a hardcoded .tracker", async () => {
    process.env.HRAUTO_TRACKER_DIR = "/tmp/e2e-iso-tracker";
    vi.resetModules();
    const { CAPTURE_PHOTOS_DIR, CAPTURE_UPLOADS_DIR } = await import(
      "../../../src/tracker/dashboard/capture-state.js"
    );
    assert.equal(CAPTURE_PHOTOS_DIR, "/tmp/e2e-iso-tracker/captures");
    assert.equal(CAPTURE_UPLOADS_DIR, "/tmp/e2e-iso-tracker/uploads");
  });

  it("paths helpers compose the captures/uploads subdirs off an arbitrary tracker dir", async () => {
    const { capturesDir, uploadsDir } = await import("../../../src/tracker/paths.js");
    assert.equal(capturesDir("/srv/foo"), "/srv/foo/captures");
    assert.equal(uploadsDir("/srv/foo"), "/srv/foo/uploads");
  });
});
