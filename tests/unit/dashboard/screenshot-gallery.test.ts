/**
 * Unit tests for the pure gallery logic behind the Screenshots tab. The tab was
 * redesigned from a one-row-per-capture list into an image-forward grid with
 * filter chips, and these helpers own the data shape that drives it: flattening
 * each entry's files into individual tiles (newest first), building the chip set
 * (All · Errors · per-system), and filtering the grid in place. The ordering and
 * fallback contracts matter — the operator scans to find one screenshot, so the
 * newest tile comes first, failures keep a dedicated chip, and a vanished filter
 * degrades to "All" instead of an empty grid.
 */

import { test, describe } from "vitest";
import assert from "node:assert/strict";

import {
  ALL_FILTER,
  ERRORS_FILTER,
  buildScreenshotFilters,
  filterScreenshotTiles,
  flattenScreenshotTiles,
  systemFilterId,
  type ScreenshotTileData,
} from "../../../src/dashboard/components/log-panel/screenshot-gallery.js";
import type { ScreenshotEntry } from "../../../src/dashboard/components/hooks/useRunScreenshots.js";

function entry(
  ts: number,
  kind: ScreenshotEntry["kind"],
  label: string,
  files: Array<{ system: string }>,
): ScreenshotEntry {
  return {
    ts,
    kind,
    label,
    step: label.toUpperCase(),
    files: files.map((f, i) => ({
      system: f.system,
      path: `/shots/${label}-${i}.png`,
      url: `/screenshots/${label}-${i}.png`,
    })),
  };
}

describe("flattenScreenshotTiles", () => {
  test("lifts each file into its own tile", () => {
    const tiles = flattenScreenshotTiles([
      entry(100, "form", "save", [{ system: "KUALI" }, { system: "UCPATH" }]),
    ]);
    assert.equal(tiles.length, 2);
    assert.deepEqual(
      tiles.map((t) => t.system),
      ["KUALI", "UCPATH"],
    );
    // Each tile keeps the coordinates the lightbox needs.
    assert.deepEqual(
      tiles.map((t) => t.fileIdx),
      [0, 1],
    );
    assert.equal(tiles[0].kind, "form");
    assert.equal(tiles[0].label, "save");
  });

  test("sorts newest first across entries", () => {
    const tiles = flattenScreenshotTiles([
      entry(100, "form", "old", [{ system: "KUALI" }]),
      entry(300, "error", "new", [{ system: "UCPATH" }]),
      entry(200, "manual", "mid", [{ system: "CRM" }]),
    ]);
    assert.deepEqual(
      tiles.map((t) => t.label),
      ["new", "mid", "old"],
    );
  });

  test("keeps declared file order within an entry (stable sort on equal ts)", () => {
    const tiles = flattenScreenshotTiles([
      entry(100, "form", "paged", [
        { system: "PAGE-A" },
        { system: "PAGE-B" },
        { system: "PAGE-C" },
      ]),
    ]);
    assert.deepEqual(
      tiles.map((t) => t.system),
      ["PAGE-A", "PAGE-B", "PAGE-C"],
    );
  });

  test("produces a distinct key per file", () => {
    const tiles = flattenScreenshotTiles([
      entry(100, "form", "save", [{ system: "KUALI" }, { system: "UCPATH" }]),
    ]);
    assert.equal(new Set(tiles.map((t) => t.key)).size, tiles.length);
  });

  test("returns an empty list for no entries", () => {
    assert.deepEqual(flattenScreenshotTiles([]), []);
  });
});

describe("buildScreenshotFilters", () => {
  function tilesFrom(entries: ScreenshotEntry[]): ScreenshotTileData[] {
    return flattenScreenshotTiles(entries);
  }

  test("always leads with an All chip carrying the total count", () => {
    const chips = buildScreenshotFilters(
      tilesFrom([
        entry(100, "form", "a", [{ system: "KUALI" }]),
        entry(200, "form", "b", [{ system: "UCPATH" }]),
      ]),
    );
    assert.equal(chips[0].id, ALL_FILTER);
    assert.equal(chips[0].count, 2);
    assert.equal(chips[0].tone, "default");
  });

  test("adds an Errors chip with the error tone only when errors exist", () => {
    const withErrors = buildScreenshotFilters(
      tilesFrom([
        entry(100, "error", "boom", [{ system: "KUALI" }]),
        entry(200, "form", "ok", [{ system: "KUALI" }]),
      ]),
    );
    const errorChip = withErrors.find((c) => c.id === ERRORS_FILTER);
    assert.ok(errorChip, "Errors chip present when an error tile exists");
    assert.equal(errorChip?.count, 1);
    assert.equal(errorChip?.tone, "error");

    const noErrors = buildScreenshotFilters(
      tilesFrom([entry(100, "form", "ok", [{ system: "KUALI" }])]),
    );
    assert.equal(
      noErrors.some((c) => c.id === ERRORS_FILTER),
      false,
    );
  });

  test("orders system chips by count desc, then alphabetically", () => {
    const chips = buildScreenshotFilters(
      tilesFrom([
        entry(100, "form", "a", [{ system: "UCPATH" }]),
        entry(200, "form", "b", [{ system: "UCPATH" }]),
        entry(300, "form", "c", [{ system: "KUALI" }]),
        entry(400, "form", "d", [{ system: "CRM" }]),
      ]),
    );
    const systems = chips
      .filter((c) => c.id.startsWith("system:"))
      .map((c) => c.label);
    // UCPATH (2) leads; CRM and KUALI tie at 1 → alphabetical.
    assert.deepEqual(systems, ["UCPATH", "CRM", "KUALI"]);
  });
});

describe("filterScreenshotTiles", () => {
  const tiles = flattenScreenshotTiles([
    entry(100, "error", "boom", [{ system: "KUALI" }]),
    entry(200, "form", "save", [{ system: "UCPATH" }]),
    entry(300, "manual", "note", [{ system: "KUALI" }]),
  ]);

  test("All returns every tile", () => {
    assert.equal(filterScreenshotTiles(tiles, ALL_FILTER).length, 3);
  });

  test("Errors returns only error tiles", () => {
    const out = filterScreenshotTiles(tiles, ERRORS_FILTER);
    assert.deepEqual(
      out.map((t) => t.label),
      ["boom"],
    );
  });

  test("a system filter returns only that system's tiles, newest first", () => {
    const out = filterScreenshotTiles(tiles, systemFilterId("KUALI"));
    // KUALI tiles are "boom" (ts 100) and "note" (ts 300) — filtering preserves
    // the newest-first order from flattenScreenshotTiles.
    assert.deepEqual(
      out.map((t) => t.label),
      ["note", "boom"],
    );
  });

  test("an unknown filter id falls back to all tiles", () => {
    assert.equal(filterScreenshotTiles(tiles, "system:GONE").length, 0);
    assert.equal(filterScreenshotTiles(tiles, "bogus-id").length, 3);
  });
});
