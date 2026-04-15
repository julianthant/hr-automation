import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { computeTileLayout } from "../../../src/browser/tiling.js";

describe("computeTileLayout", () => {
  it("tiles 4 windows in 2x2 grid", () => {
    const screen = { width: 2560, height: 1440 };
    const t0 = computeTileLayout(0, 4, screen);
    const t3 = computeTileLayout(3, 4, screen);
    assert.deepEqual(t0.position, { x: 0, y: 0 });
    assert.equal(t0.size.width, 1280);
    assert.equal(t0.size.height, 720);
    assert.deepEqual(t3.position, { x: 1280, y: 720 });
  });

  it("tiles 1 window as fullscreen", () => {
    const screen = { width: 2560, height: 1440 };
    const t = computeTileLayout(0, 1, screen);
    assert.equal(t.size.width, 2560);
    assert.equal(t.size.height, 1440);
  });

  it("tiles 9 windows in 3x3 grid", () => {
    const screen = { width: 2700, height: 1350 };
    const t = computeTileLayout(0, 9, screen);
    assert.equal(t.size.width, 900);
    assert.equal(t.size.height, 450);
  });

  it("returns correct chromium args", () => {
    const t = computeTileLayout(1, 4, { width: 2560, height: 1440 });
    assert.ok(t.args.includes("--window-position=1280,0"));
    assert.ok(t.args.includes("--window-size=1280,720"));
  });

  it("returns viewport smaller than window for chrome decorations", () => {
    const t = computeTileLayout(0, 4, { width: 2560, height: 1440 });
    assert.ok(t.viewport.width < t.size.width);
    assert.ok(t.viewport.height < t.size.height);
  });
});
