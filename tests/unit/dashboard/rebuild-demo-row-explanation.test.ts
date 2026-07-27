import { test } from "vitest";
import assert from "node:assert/strict";
import {
  ROW_VARIANTS,
  panelKindOf,
  rowExplanationOf,
  rowVariantOf,
  rowsForVariant,
  type RowVariant,
} from "../../../src/dashboard/components/dev/rebuild-demo/demo-catalog.js";
import { DEMO_ROWS, densityRung } from "../../../src/dashboard/components/dev/rebuild-demo/demo-data.js";

/**
 * The ⓘ on every queue row is DERIVED from the catalog's naming layer, never
 * authored per fixture — that is the whole reason it can be trusted: a new
 * fixture inherits a correct sentence, and the copy cannot drift from the row
 * it describes.
 *
 * These pin the two properties that make it useful. Every one of the eight row
 * variants must produce a COMPLETE explanation (a blank sentence is worse than
 * no affordance — it teaches the operator the ⓘ is not worth pressing), and
 * every one must produce a DISTINCT one (if two shapes read the same, the row
 * has been named without being explained).
 */

const VARIANT_KEYS: RowVariant[] = [
  "person-run",
  "document-run",
  "review-run",
  "catalog-run",
  "packet-group",
  "roster-group",
  "person-member",
  "rejected-member",
];

/** the catalog's own example row for a variant — the demo's canonical instance */
function exampleRow(key: RowVariant) {
  const spec = ROW_VARIANTS.find((v) => v.key === key);
  assert.ok(spec, `no catalog spec for ${key}`);
  assert.ok(spec.exampleId, `catalog spec ${key} names no example row`);
  const row = DEMO_ROWS[spec.exampleId];
  assert.ok(row, `${key} names example row ${spec.exampleId}, which does not exist`);
  return row;
}

test("the catalog names all eight row variants and every one has a live example", () => {
  assert.deepEqual(
    ROW_VARIANTS.map((v) => v.key),
    VARIANT_KEYS,
  );
  for (const key of VARIANT_KEYS) {
    assert.equal(rowVariantOf(exampleRow(key)), key, `${key}'s example row does not derive back to ${key}`);
    assert.ok(rowsForVariant(key).length > 0, `no demo row renders as ${key}`);
  }
});

test("every row variant yields a complete explanation — all three sentences, none empty", () => {
  for (const key of VARIANT_KEYS) {
    const ex = rowExplanationOf(exampleRow(key));
    for (const [field, sentence] of Object.entries(ex)) {
      assert.ok(sentence.trim().length > 0, `${key}.${field} is empty`);
      // a sentence, not a label — the affordance exists because a two-word
      // caption is what the row already had and did not answer
      assert.ok(sentence.trim().length > 24, `${key}.${field} is too short to explain anything: ${sentence}`);
      assert.ok(sentence.trim().endsWith("."), `${key}.${field} is not a sentence: ${sentence}`);
    }
  }
});

test("every row variant reads DIFFERENTLY — no two shapes share an explanation", () => {
  const seen = new Map<string, RowVariant>();
  for (const key of VARIANT_KEYS) {
    const ex = rowExplanationOf(exampleRow(key));
    const whole = `${ex.doing}|${ex.panel}|${ex.why}`;
    const clash = seen.get(whole);
    assert.equal(clash, undefined, `${key} reads identically to ${clash}`);
    seen.set(whole, key);
  }
  assert.equal(seen.size, VARIANT_KEYS.length);
});

test("the four shapes an operator confuses each say something different about what they ARE", () => {
  // a delegated OCR review row · an operation coordinator · a typed-list group
  // member · a standalone helper run
  const doing = [
    rowExplanationOf(exampleRow("review-run")).doing,
    rowExplanationOf(exampleRow("packet-group")).doing,
    rowExplanationOf(exampleRow("person-member")).doing,
    rowExplanationOf(exampleRow("person-run")).doing,
  ];
  assert.equal(new Set(doing).size, 4);
});

test("the panel sentence is derived from the PANEL KIND, so it matches what opening the row shows", () => {
  const byKind = new Map<string, string>();
  for (const key of VARIANT_KEYS) {
    const row = exampleRow(key);
    const kind = panelKindOf(row);
    const panel = rowExplanationOf(row).panel;
    const prior = byKind.get(kind);
    if (prior === undefined) byKind.set(kind, panel);
    else assert.equal(panel, prior, `two ${kind} panels are described differently`);
  }
  // all four panel kinds are covered by the eight variants
  assert.deepEqual([...byKind.keys()].sort(), ["group", "member", "review", "run"]);
  // and no two panel kinds describe themselves the same way
  assert.equal(new Set(byKind.values()).size, 4);
});

test("SCOPE changes the review row's reason: a standalone OCR run has nothing to approve", () => {
  const delegated = Object.values(DEMO_ROWS).find((r) => rowVariantOf(r) === "review-run" && Boolean(r.reviewOf));
  const standalone = Object.values(DEMO_ROWS).find((r) => rowVariantOf(r) === "review-run" && !r.reviewOf);
  assert.ok(delegated, "no delegated OCR review row in the corpus");
  assert.ok(standalone, "no standalone OCR review row in the corpus");

  const a = rowExplanationOf(delegated);
  const b = rowExplanationOf(standalone);
  // same shape, so the same work and the same panel …
  assert.equal(a.doing, b.doing);
  assert.equal(a.panel, b.panel);
  // … but not the same reason to exist
  assert.notEqual(a.why, b.why);
});

/**
 * The density ladder stops at the scroll well. The 41+ status matrix was
 * removed because it made a 50-person group read as a different KIND of row
 * than an 18-person one — so the property under test is that no member count
 * produces a rung the eighteen-person group does not also produce.
 */
test("the density ladder has three rungs and nothing above twelve changes shape", () => {
  assert.equal(densityRung(1), "inline");
  assert.equal(densityRung(3), "inline");
  assert.equal(densityRung(4), "compact");
  assert.equal(densityRung(12), "compact");
  assert.equal(densityRung(13), "well");
  for (const n of [18, 40, 41, 50, 200]) {
    assert.equal(densityRung(n), "well", `${n} members changed the row's shape`);
  }
});
