import { test } from "vitest";
import assert from "node:assert/strict";
import { DEMO_ROWS } from "../../../src/dashboard/components/dev/rebuild-demo/demo-data.js";

/**
 * Run-row facts are a deliberately authored queue summary, not an automatic
 * dump of every Data-ledger field. The useful contract is broader than the
 * original three specimens, but still refuses to print output a run has not
 * read yet.
 */

const FACT_RICH_RUNS = [
  "sep-maria",
  "sep-rosa",
  "pl-daniel",
  "onb-jordan",
  "kp-marcus",
  "ob-elena",
  "cd-samuel",
  "ws-priya",
  "sep-nathan",
  "pl-dana",
  "sep-dana",
  "i9l-signed",
  "i9l-unsigned",
  "i9l-no-profile",
  "pl-match-found",
  "pl-match-none",
  "pl-match-ambiguous",
  "kp-no-change",
  "cd-none",
] as const;

test("single-run rows across workflows expose compact, non-empty queue facts", () => {
  for (const id of FACT_RICH_RUNS) {
    const row = DEMO_ROWS[id];
    assert.equal(row.rowType, "run", `${id} stopped being a single-run row`);
    assert.ok(row.facts && row.facts.length > 0, `${id} lost its queue facts`);
    for (const fact of row.facts) {
      assert.ok(fact.value.trim().length > 0, `${id} has an empty fact value`);
      assert.ok(!fact.label || fact.label.trim().length > 0, `${id} has an empty fact label`);
    }
  }
});

test("a queued run shows known input, never a fabricated result", () => {
  assert.deepEqual(DEMO_ROWS["ws-priya"].facts, [
    { label: "effective", value: "07/01/2026" },
  ]);

  // This delegated lookup has not received a UCPath answer yet. Its parent
  // link and live sentence are real; a result chip would be a lie.
  assert.equal(DEMO_ROWS["pl-nathan"].facts, undefined);

  // This run stopped before touching the form, so the EID in its subtitle is
  // all the row can honestly say about data.
  assert.equal(DEMO_ROWS["ec-tomas"].facts, undefined);
});

test("uncertain or attention-bearing fact values carry warning tone", () => {
  const warningFacts = [
    ["sep-rosa", "unknown"],
    ["cd-samuel", "0 records"],
    ["pl-dana", "0 matches"],
    ["i9l-unsigned", "No"],
    ["pl-match-ambiguous", "Ambiguous"],
  ] as const;

  for (const [id, value] of warningFacts) {
    const fact = DEMO_ROWS[id].facts?.find((candidate) => candidate.value === value);
    assert.equal(fact?.warn, true, `${id} presents ${value} as a quiet fact`);
  }
});

test("sentence-like ticket timing gets a full queue-summary row", () => {
  assert.deepEqual(DEMO_ROWS["ou-packet"].facts, [
    { label: "pages", value: "6" },
    { label: "ticket", value: "filed after signing", fullRow: true },
  ]);
});
