import { test } from "vitest";
import assert from "node:assert/strict";
import {
  DEMO_ROWS,
  densityRung,
  effectiveStatus,
  groupCounts,
  isSettledRow,
  orderedMemberIds,
  visibleMemberIds,
} from "../../../src/dashboard/components/dev/rebuild-demo/demo-data.js";

/**
 * How much a queue row is allowed to say turns on ONE predicate, and it lives
 * in the projection rather than in a component so a row can never show a
 * settled status over an unsettled body.
 *
 * The operator: *"for some forms, having more detail in the queue row, makes it
 * look worse and harder to read from."* A row still asking for something or
 * still moving keeps every band. A row whose outcome is settled reports the
 * outcome and stops re-explaining its own composition.
 */

test("a row that is still asking or still moving is NEVER settled", () => {
  const live = Object.values(DEMO_ROWS).filter((r) => {
    const s = effectiveStatus(r);
    return s === "waiting" || s === "failed" || s === "parked" || s === "running" || s === "queued";
  });
  assert.ok(live.length > 0);
  for (const r of live) {
    assert.equal(isSettledRow(r), false, `${r.id} (${effectiveStatus(r)}) was treated as settled`);
  }
});

test("a terminal-quiet row IS settled — including Done with warnings", () => {
  // `ec-packet` is the row the cut was made for: `doneWarnings`, six members,
  // eight bands deep, and nothing left for the operator to do about it.
  const ec = DEMO_ROWS["ec-packet"];
  assert.equal(effectiveStatus(ec), "doneWarnings");
  assert.equal(isSettledRow(ec), true);

  // Warnings and rejections do not un-settle a row — they are reported by the
  // status pill and the rejected tally, which both stay on the row.
  const counts = groupCounts("ec-packet");
  assert.ok(counts.rejected > 0, "the fixture no longer carries a rejected page");
  assert.equal(counts.waiting + counts.failed + counts.parked, 0);
});

test("a settled ROLLUP over a member that still wants something is not settled", () => {
  // The i9 roster rolls up from 50 members, one of whom is on an identity gate.
  const i9 = DEMO_ROWS["i9-batch"];
  assert.ok(groupCounts("i9-batch").waiting > 0);
  assert.equal(isSettledRow(i9), false);
});

test("a settled group above the inline rung puts NOTHING on screen to walk", () => {
  const ec = DEMO_ROWS["ec-packet"];
  const ids = orderedMemberIds(ec.id);
  assert.equal(densityRung(ids.length), "compact");

  // Collapsed (the default): no member lines at all, so the keyboard walks the
  // rows the eye sees and nothing more.
  assert.deepEqual(visibleMemberIds(ec, new Set()), []);
  // Expanded by the operator: the ladder takes over and every member is back.
  assert.deepEqual(visibleMemberIds(ec, new Set([ec.id])), ids);
});

test("at 1–3 the group IS its members, whatever its status (D11)", () => {
  const single = DEMO_ROWS["ec-single"];
  const ids = orderedMemberIds(single.id);
  assert.equal(isSettledRow(single), true);
  assert.equal(densityRung(ids.length), "inline");
  // Settled, and still fully open — shutting it would leave a row that shows a
  // count of one and nothing else.
  assert.deepEqual(visibleMemberIds(single, new Set()), ids);
});

test("an UNSETTLED group keeps the rung it always had", () => {
  // compact + unsettled → the first four, exactly as before the cut
  const sep = DEMO_ROWS["sep-list"];
  assert.equal(isSettledRow(sep), false);
  assert.equal(visibleMemberIds(sep, new Set()).length, 4);

  // well + unsettled → every line, inside the fixed-height well
  const i9 = DEMO_ROWS["i9-batch"];
  const ids = orderedMemberIds(i9.id);
  assert.equal(densityRung(ids.length), "well");
  assert.deepEqual(visibleMemberIds(i9, new Set()), ids);
});
