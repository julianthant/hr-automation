import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { computeTileLayout } from "../../../src/browser/tiling.js";

describe("computeTileLayout", () => {
  it("cascades 3 windows with 40px offset, near-fullscreen", () => {
    const screen = { width: 2560, height: 1440 };
    const t0 = computeTileLayout(0, 3, screen);
    const t1 = computeTileLayout(1, 3, screen);
    const t2 = computeTileLayout(2, 3, screen);
    assert.deepEqual(t0.position, { x: 0, y: 0 });
    assert.deepEqual(t1.position, { x: 40, y: 40 });
    assert.deepEqual(t2.position, { x: 80, y: 80 });
    // All same size: screen minus margin for cascade
    assert.equal(t0.size.width, 2560 - 80);
    assert.equal(t0.size.height, 1440 - 80);
    assert.equal(t1.size.width, t0.size.width);
  });

  it("single window is fullscreen (no cascade margin)", () => {
    const screen = { width: 2560, height: 1440 };
    const t = computeTileLayout(0, 1, screen);
    assert.equal(t.size.width, 2560);
    assert.equal(t.size.height, 1440);
    assert.deepEqual(t.position, { x: 0, y: 0 });
  });

  it("returns correct chromium args", () => {
    const t = computeTileLayout(1, 3, { width: 2560, height: 1440 });
    assert.ok(t.args.includes("--window-position=40,40"));
    assert.ok(t.args.includes(`--window-size=${2560 - 80},${1440 - 80}`));
  });

  it("returns viewport smaller than window for chrome decorations", () => {
    const t = computeTileLayout(0, 3, { width: 2560, height: 1440 });
    assert.ok(t.viewport.width < t.size.width);
    assert.ok(t.viewport.height < t.size.height);
  });
});
