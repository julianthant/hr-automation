import { describe, it } from "vitest";
import assert from "node:assert/strict";
import {
  columnCountFor,
  sliceLayout,
} from "../../../src/dashboard/components/shared/SlicedScreenshot";

// A typical laptop lightbox box (90vw × 85vh of ~1512×982).
const BOX = { w: 1360, h: 835 };

describe("columnCountFor", () => {
  it("keeps a single column for wide / landscape captures", () => {
    assert.equal(columnCountFor({ w: 1600, h: 900 }, BOX, 4), 1);
  });

  it("keeps a single column for a roughly square capture", () => {
    assert.equal(columnCountFor({ w: 1000, h: 1000 }, BOX, 4), 1);
  });

  it("slices a tall record into multiple columns", () => {
    // ~600×2400 full PeopleSoft/CRM record (aspect 4).
    const n = columnCountFor({ w: 600, h: 2400 }, BOX, 4);
    assert.ok(n >= 2, `expected >=2 columns, got ${n}`);
  });

  it("adds more columns as the capture gets taller", () => {
    const tall = columnCountFor({ w: 600, h: 2400 }, BOX, 4);
    const taller = columnCountFor({ w: 600, h: 6000 }, BOX, 4);
    assert.ok(taller >= tall);
  });

  it("never exceeds maxColumns", () => {
    assert.equal(columnCountFor({ w: 300, h: 30000 }, BOX, 3), 3);
  });

  it("falls back to one column on degenerate dimensions", () => {
    assert.equal(columnCountFor({ w: 0, h: 0 }, BOX, 4), 1);
    assert.equal(columnCountFor({ w: 600, h: 2400 }, { w: 0, h: 0 }, 4), 1);
  });
});

describe("sliceLayout", () => {
  const natural = { w: 600, h: 2400 }; // aspect 4
  const columns = 2;
  const layout = sliceLayout(natural, BOX, columns);

  it("preserves the image aspect ratio in each rendered slice", () => {
    // fullH is the full image scaled to colW — ratio must match natural.
    assert.ok(Math.abs(layout.fullH / layout.colW - natural.h / natural.w) < 1e-6);
  });

  it("divides the full height evenly across columns", () => {
    assert.ok(Math.abs(layout.colH * columns - layout.fullH) < 1e-6);
  });

  it("fits the slice grid (incl. header strips) within the available box", () => {
    const totalW = columns * layout.colW + (columns - 1) * layout.gap;
    const totalH = layout.colH + layout.headerH;
    assert.ok(totalW <= BOX.w + 1e-6, `grid width ${totalW} exceeds box ${BOX.w}`);
    assert.ok(totalH <= BOX.h + 1e-6, `column height ${totalH} exceeds box ${BOX.h}`);
  });

  it("uses more of the width than a single fit-to-height image would", () => {
    // Single image fit to height: width = box.h / aspect.
    const singleWidth = BOX.h / (natural.h / natural.w);
    const slicedWidth = columns * layout.colW + (columns - 1) * layout.gap;
    assert.ok(slicedWidth > singleWidth);
  });
});
