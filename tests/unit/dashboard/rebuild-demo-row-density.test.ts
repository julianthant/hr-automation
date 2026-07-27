import { test } from "vitest";
import assert from "node:assert/strict";
import {
  DEMO_ROWS,
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
 *
 * **There is no density ladder any more (D11, amended 2026-07-27).** Shown a
 * 2-member group drawn as full inline cards beside a 6-member group drawn as
 * compact lines, the operator asked *"why are some like this and some like
 * that? keep the design like above. ditch the bottom design completely."* —
 * the third and last rung to go, all three cut for the same reason: a change of
 * SHAPE reads as a change of KIND, so the same object must not appear to be two
 * objects depending on how many people are in it.
 *
 * So the property under test is now stronger than "the ladder is correct": it
 * is that MEMBER COUNT IS NOT AN INPUT AT ALL. `visibleMemberIds` branches on
 * settlement and nothing else, at 1 member and at 50.
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

test("a settled group puts NOTHING on screen to walk, at every member count", () => {
  const settled = Object.values(DEMO_ROWS).filter((r) => r.rowType === "group" && isSettledRow(r));
  assert.ok(settled.length > 0, "the corpus holds no settled group");
  // The small group and the large group must behave IDENTICALLY — that pair is
  // exactly what the operator was shown rendering two different ways.
  const sizes = new Set(settled.map((r) => orderedMemberIds(r.id).length));
  assert.ok(sizes.size > 1, "every settled group is the same size — this test needs the spread");

  for (const row of settled) {
    const ids = orderedMemberIds(row.id);
    // Collapsed (the default): no member lines at all, so the keyboard walks
    // the rows the eye sees and nothing more.
    assert.deepEqual(visibleMemberIds(row, new Set()), [], `${row.id} left members on screen while shut`);
    // Expanded by the operator: EVERY member is back — never a truncated peek,
    // because the well is what caps the height now.
    assert.deepEqual(visibleMemberIds(row, new Set([row.id])), ids, `${row.id} truncated its expanded list`);
  }
});

test("an UNSETTLED group shows every member, whatever its size (the one shape)", () => {
  const unsettled = Object.values(DEMO_ROWS).filter((r) => r.rowType === "group" && !isSettledRow(r));
  assert.ok(unsettled.length > 0);
  const sizes = new Set(unsettled.map((r) => orderedMemberIds(r.id).length));
  assert.ok(sizes.size > 1, "every unsettled group is the same size — this test needs the spread");

  for (const row of unsettled) {
    const ids = orderedMemberIds(row.id);
    // No `slice(0, 4)`, no rung: the 5-member typed list and the 50-member
    // roster both put their whole member set in the well.
    assert.deepEqual(visibleMemberIds(row, new Set()), ids, `${row.id} truncated its member list`);
    assert.deepEqual(visibleMemberIds(row, new Set([row.id])), ids, `${row.id} changed on expand`);
  }
});

test("member COUNT is not an input — the smallest and the largest group agree", () => {
  const groups = Object.values(DEMO_ROWS).filter((r) => r.rowType === "group");
  const bySize = [...groups].sort((a, b) => orderedMemberIds(a.id).length - orderedMemberIds(b.id).length);
  const smallest = bySize[0];
  const largest = bySize[bySize.length - 1];
  assert.ok(orderedMemberIds(smallest.id).length < orderedMemberIds(largest.id).length);

  // The one honest way to state "one shape at every count": the visible set is
  // a pure function of settlement, so given the same settlement both ends of
  // the corpus answer with their WHOLE member set.
  for (const row of [smallest, largest]) {
    assert.deepEqual(visibleMemberIds(row, new Set([row.id])), orderedMemberIds(row.id));
  }
});
