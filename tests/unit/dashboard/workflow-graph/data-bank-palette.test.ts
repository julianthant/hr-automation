/**
 * Unit tests for the Data Bank palette's pure seam — query + kind filtering and
 * the two grouping views (by SYSTEM in catalog order, by ACTION in canonical kind
 * order), plus the available-kinds chip source and recents resolution.
 *
 * Load-bearing properties: the query AND-matches across label/summary/selector/…;
 * an empty kind set means "all"; empty groups are dropped; action view emits kinds
 * in canonical order with ops sorted by id; recents preserve request order and drop
 * unknown ids.
 */

import { test, describe } from "vitest";
import assert from "node:assert/strict";

import {
  availableKinds,
  buildPaletteGroups,
  paletteOpCount,
  resolveRecentOps,
} from "../../../../src/dashboard/components/workflow-modifier/graph/data-bank-palette.js";
import type { DataBank, DataBankOperation, SystemCatalog } from "../../../../src/domain/workflow-design/data-bank.js";

function op(id: string, over: Partial<DataBankOperation> = {}): DataBankOperation {
  return { id, kind: "click", system: "ucpath", label: id, ...over };
}

const SYSTEMS: SystemCatalog[] = [
  {
    system: "kuali",
    label: "Kuali",
    operations: [
      op("kuali.eid#fill", { kind: "fill", system: "kuali", label: "Fill EID", summary: "Type the employee ID" }),
      op("kuali.term#select", { kind: "select", system: "kuali", label: "Select termination type" }),
    ],
  },
  {
    system: "ucpath",
    label: "UCPath",
    operations: [
      op("ucpath.search#click", { kind: "click", system: "ucpath", label: "Click search" }),
      op("ucpath.status#scrape", { kind: "scrape", system: "ucpath", label: "Scrape status", outputVar: "{status}" }),
    ],
  },
];

describe("buildPaletteGroups — system view", () => {
  test("groups by system in catalog order, all ops when unfiltered", () => {
    const groups = buildPaletteGroups(SYSTEMS, { view: "system", query: "", kinds: [] });
    assert.deepEqual(
      groups.map((g) => [g.id, g.ops.length]),
      [
        ["kuali", 2],
        ["ucpath", 2],
      ],
    );
  });

  test("query AND-matches across fields and drops empty groups", () => {
    // "employee" only appears in the kuali Fill EID summary.
    const groups = buildPaletteGroups(SYSTEMS, { view: "system", query: "employee", kinds: [] });
    assert.deepEqual(
      groups.map((g) => g.id),
      ["kuali"],
    );
    assert.equal(groups[0].ops[0].id, "kuali.eid#fill");
  });

  test("kind filter narrows to the selected kinds (empty kinds = all)", () => {
    const groups = buildPaletteGroups(SYSTEMS, { view: "system", query: "", kinds: ["scrape"] });
    assert.deepEqual(
      groups.map((g) => g.id),
      ["ucpath"],
    );
    assert.equal(groups[0].ops[0].id, "ucpath.status#scrape");
  });
});

describe("buildPaletteGroups — action view", () => {
  test("groups by kind in canonical order, labelled by the kind verb", () => {
    const groups = buildPaletteGroups(SYSTEMS, { view: "action", query: "", kinds: [] });
    // canonical order: click, fill, select, scrape (navigate/upload/wait/assert/control absent)
    assert.deepEqual(
      groups.map((g) => [g.id, g.label]),
      [
        ["click", "Click"],
        ["fill", "Fill"],
        ["select", "Select"],
        ["scrape", "Scrape"],
      ],
    );
  });

  test("ops within a kind group sort by id", () => {
    const systems: SystemCatalog[] = [
      { system: "b", label: "B", operations: [op("b.z#click"), op("b.a#click")] },
      { system: "a", label: "A", operations: [op("a.m#click")] },
    ];
    const [group] = buildPaletteGroups(systems, { view: "action", query: "", kinds: [] });
    assert.deepEqual(
      group.ops.map((o) => o.id),
      ["a.m#click", "b.a#click", "b.z#click"],
    );
  });
});

describe("availableKinds / paletteOpCount / resolveRecentOps", () => {
  test("availableKinds returns present kinds in canonical order", () => {
    assert.deepEqual(availableKinds(SYSTEMS), ["click", "fill", "select", "scrape"]);
  });

  test("paletteOpCount sums every catalog; null → 0", () => {
    const bank: DataBank = { schemaVersion: 1, generatedAt: "", systems: SYSTEMS, workflows: [] };
    assert.equal(paletteOpCount(bank), 4);
    assert.equal(paletteOpCount(null), 0);
  });

  test("resolveRecentOps preserves request order and drops unknown ids", () => {
    const ops = resolveRecentOps(SYSTEMS, ["ucpath.status#scrape", "nope#click", "kuali.eid#fill"]);
    assert.deepEqual(
      ops.map((o) => o.id),
      ["ucpath.status#scrape", "kuali.eid#fill"],
    );
  });
});
