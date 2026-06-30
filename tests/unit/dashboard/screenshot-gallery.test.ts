/**
 * Unit tests for the pure gallery logic behind the Screenshots tab. The tab is
 * an image-forward grid with filter chips, and these helpers own the data shape
 * that drives it: collapsing each capture EVENT into one grid item (a multi-
 * slice capture — e.g. 8 `-cNN` page chunks — becomes a single "folder" group,
 * cover = its first slice), building the chip set (All · Errors · Steps · per-
 * system), and filtering the grid in place. The contracts matter — the operator
 * scans to find one capture, so the newest group comes first, a folder counts
 * ONCE (it must not flood the grid), failures keep a dedicated chip, and a
 * vanished filter degrades to "All" instead of an empty grid.
 */

import { test, describe } from "vitest";
import assert from "node:assert/strict";

import {
  ALL_FILTER,
  ERRORS_FILTER,
  STEPS_FILTER,
  buildScreenshotFilters,
  buildScreenshotGroups,
  filterScreenshotGroups,
  systemFilterId,
  type ScreenshotGroup,
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

describe("buildScreenshotGroups", () => {
  test("collapses a multi-slice capture into one folder group", () => {
    const groups = buildScreenshotGroups([
      entry(100, "form", "paged", [
        { system: "KUALI" },
        { system: "KUALI" },
        { system: "KUALI" },
      ]),
    ]);
    assert.equal(groups.length, 1);
    const [folder] = groups;
    assert.equal(folder.isFolder, true);
    assert.equal(folder.fileCount, 3);
    // Cover = the first (top-of-page) slice; the folder's preview.
    assert.equal(folder.cover.path, "/shots/paged-0.png");
    // The whole capture rides along so the lightbox can page every slice.
    assert.equal(folder.entry.files.length, 3);
  });

  test("a single-file capture is a group of one (not a folder)", () => {
    const [group] = buildScreenshotGroups([
      entry(100, "form", "save", [{ system: "UCPATH" }]),
    ]);
    assert.equal(group.isFolder, false);
    assert.equal(group.fileCount, 1);
    assert.equal(group.system, "UCPATH");
  });

  test("sorts newest first across captures", () => {
    const groups = buildScreenshotGroups([
      entry(100, "form", "old", [{ system: "KUALI" }]),
      entry(300, "error", "new", [{ system: "UCPATH" }]),
      entry(200, "manual", "mid", [{ system: "CRM" }]),
    ]);
    assert.deepEqual(
      groups.map((g) => g.label),
      ["new", "mid", "old"],
    );
  });

  test("group system is the cover slice's system", () => {
    const [group] = buildScreenshotGroups([
      entry(100, "form", "paged", [{ system: "KUALI" }, { system: "KUALI" }]),
    ]);
    assert.equal(group.system, "KUALI");
  });

  test("drops a capture whose files were all cleaned off disk", () => {
    const ghost = entry(100, "form", "gone", []);
    const live = entry(200, "form", "here", [{ system: "KUALI" }]);
    const groups = buildScreenshotGroups([ghost, live]);
    assert.deepEqual(
      groups.map((g) => g.label),
      ["here"],
    );
  });

  test("produces a distinct key per group", () => {
    const groups = buildScreenshotGroups([
      entry(100, "form", "a", [{ system: "KUALI" }]),
      entry(200, "form", "b", [{ system: "UCPATH" }]),
      entry(300, "form", "c", [{ system: "CRM" }, { system: "CRM" }]),
    ]);
    assert.equal(new Set(groups.map((g) => g.key)).size, groups.length);
  });

  test("returns an empty list for no entries", () => {
    assert.deepEqual(buildScreenshotGroups([]), []);
  });
});

describe("buildScreenshotFilters", () => {
  function groupsFrom(entries: ScreenshotEntry[]): ScreenshotGroup[] {
    return buildScreenshotGroups(entries);
  }

  test("always leads with an All chip whose count is the number of tiles", () => {
    const chips = buildScreenshotFilters(
      groupsFrom([
        // A 3-slice folder must count ONCE — it renders as one tile.
        entry(100, "form", "a", [
          { system: "KUALI" },
          { system: "KUALI" },
          { system: "KUALI" },
        ]),
        entry(200, "form", "b", [{ system: "UCPATH" }]),
      ]),
    );
    assert.equal(chips[0].id, ALL_FILTER);
    assert.equal(chips[0].count, 2);
    assert.equal(chips[0].tone, "default");
  });

  test("adds an Errors chip with the error tone only when errors exist", () => {
    const withErrors = buildScreenshotFilters(
      groupsFrom([
        entry(100, "error", "boom", [{ system: "KUALI" }]),
        entry(200, "form", "ok", [{ system: "KUALI" }]),
      ]),
    );
    const errorChip = withErrors.find((c) => c.id === ERRORS_FILTER);
    assert.ok(errorChip, "Errors chip present when an error group exists");
    assert.equal(errorChip?.count, 1);
    assert.equal(errorChip?.tone, "error");

    const noErrors = buildScreenshotFilters(
      groupsFrom([entry(100, "form", "ok", [{ system: "KUALI" }])]),
    );
    assert.equal(
      noErrors.some((c) => c.id === ERRORS_FILTER),
      false,
    );
  });

  test("adds a Steps chip (default tone) only when step groups exist, after Errors and before systems", () => {
    const withSteps = buildScreenshotFilters(
      groupsFrom([
        entry(100, "step", "person-search", [{ system: "UCPATH" }]),
        entry(150, "step", "i9-creation", [{ system: "I9" }]),
        entry(200, "error", "boom", [{ system: "KUALI" }]),
        entry(300, "form", "save", [{ system: "KUALI" }]),
      ]),
    );
    const stepChip = withSteps.find((c) => c.id === STEPS_FILTER);
    assert.ok(stepChip, "Steps chip present when a step group exists");
    assert.equal(stepChip?.count, 2);
    assert.equal(stepChip?.tone, "default");
    // Ordering: All → Errors → Steps → system chips.
    const ids = withSteps.map((c) => c.id);
    assert.ok(ids.indexOf(ERRORS_FILTER) < ids.indexOf(STEPS_FILTER));
    assert.ok(
      ids.indexOf(STEPS_FILTER) <
        ids.findIndex((id) => id.startsWith("system:")),
    );

    const noSteps = buildScreenshotFilters(
      groupsFrom([entry(100, "form", "ok", [{ system: "KUALI" }])]),
    );
    assert.equal(
      noSteps.some((c) => c.id === STEPS_FILTER),
      false,
    );
  });

  test("orders system chips by count desc, then alphabetically", () => {
    const chips = buildScreenshotFilters(
      groupsFrom([
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

describe("filterScreenshotGroups", () => {
  const groups = buildScreenshotGroups([
    entry(100, "error", "boom", [{ system: "KUALI" }]),
    entry(200, "form", "save", [{ system: "UCPATH" }]),
    entry(300, "manual", "note", [{ system: "KUALI" }]),
  ]);

  test("All returns every group", () => {
    assert.equal(filterScreenshotGroups(groups, ALL_FILTER).length, 3);
  });

  test("Errors returns only error groups", () => {
    const out = filterScreenshotGroups(groups, ERRORS_FILTER);
    assert.deepEqual(
      out.map((g) => g.label),
      ["boom"],
    );
  });

  test("a system filter returns only that system's groups, newest first", () => {
    const out = filterScreenshotGroups(groups, systemFilterId("KUALI"));
    // KUALI groups are "boom" (ts 100) and "note" (ts 300) — filtering preserves
    // the newest-first order from buildScreenshotGroups.
    assert.deepEqual(
      out.map((g) => g.label),
      ["note", "boom"],
    );
  });

  test("Steps returns only step groups", () => {
    const stepGroups = buildScreenshotGroups([
      entry(100, "error", "boom", [{ system: "KUALI" }]),
      entry(200, "step", "person-search", [{ system: "UCPATH" }]),
      entry(300, "form", "save", [{ system: "KUALI" }]),
    ]);
    const out = filterScreenshotGroups(stepGroups, STEPS_FILTER);
    assert.deepEqual(
      out.map((g) => g.label),
      ["person-search"],
    );
  });

  test("an unknown filter id falls back to all groups", () => {
    assert.equal(filterScreenshotGroups(groups, "system:GONE").length, 0);
    assert.equal(filterScreenshotGroups(groups, "bogus-id").length, 3);
  });
});
