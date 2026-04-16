import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { computeTileLayout } from "../../../src/browser/tiling.js";

describe("computeTileLayout", () => {
  it("returns fullscreen layout for all windows", () => {
    const screen = { width: 1440, height: 900 };
    const t0 = computeTileLayout(0, 3, screen);
    const t1 = computeTileLayout(1, 3, screen);
    const t2 = computeTileLayout(2, 3, screen);
    assert.deepEqual(t0.position, { x: 0, y: 0 });
    assert.deepEqual(t1.position, { x: 0, y: 0 });
    assert.deepEqual(t2.position, { x: 0, y: 0 });
    assert.equal(t0.size.width, 1440);
    assert.equal(t0.size.height, 900);
  });

  it("returns viewport smaller than window for chrome decorations", () => {
    const t = computeTileLayout(0, 3, { width: 1440, height: 900 });
    assert.ok(t.viewport.width < t.size.width);
    assert.ok(t.viewport.height < t.size.height);
  });

  it("returns correct chromium args", () => {
    const t = computeTileLayout(0, 1, { width: 1440, height: 900 });
    assert.ok(t.args.includes("--window-position=0,0"));
    assert.ok(t.args.includes("--window-size=1440,900"));
  });
});
