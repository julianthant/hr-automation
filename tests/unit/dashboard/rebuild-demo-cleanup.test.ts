import { test } from "vitest";
import assert from "node:assert/strict";
import {
  DEMO_DAY,
  plural,
  tabsForPanelKind,
  TAB_LABEL,
  type PanelKind,
} from "../../../src/dashboard/components/dev/rebuild-demo/demo-wire.js";
import { DS_STATUS } from "../../../src/dashboard/components/dev/rebuild-demo/ds/primitives-status.js";
import { PANEL_KINDS, tabNamesForPanelKind } from "../../../src/dashboard/components/dev/rebuild-demo/demo-catalog.js";
import {
  buildActivityReport,
  outstandingRows,
  REPORT_DAY_SPAN,
  reportSpansForDay,
} from "../../../src/dashboard/components/dev/rebuild-demo/demo-report-wire.js";
import { ALL_DEMO_ROWS, DEMO_DAYS, topLevelRowsForDay } from "../../../src/dashboard/components/dev/rebuild-demo/demo-days.js";

/**
 * The pinnable half of wave 16 — the three defects whose fix is a DERIVATION
 * rather than a layout, plus the grammar rule that turned out to be a class of
 * bug rather than one instance of it.
 *
 * Each of these was a surface quietly disagreeing with another surface about
 * the same fact: a receipt naming a verdict differently from the chip beside
 * it, a report answering for a day the nav was not on, a catalog documenting a
 * tab set the panel no longer has. Layout defects are checked by driving the
 * page; these are checked here, because they are single-sourcing rules and a
 * single-sourcing rule that is not tested is a rule that lasts one wave.
 */

// ---------------------------------------------------------------------------
// 1 — one word for one verdict
// ---------------------------------------------------------------------------

test("the quiet terminal status is `Done`, and nothing in the corpus says `Verified done`", () => {
  assert.equal(DS_STATUS.verifiedDone.label, "Done");
  assert.equal(DS_STATUS.doneWarnings.label, "Done with warnings");

  // The receipt reads its verdict word off `DS_STATUS`, so the fixtures are the
  // only place the retired label could still be written down.
  const offenders: string[] = [];
  for (const row of Object.values(ALL_DEMO_ROWS)) {
    const haystack = [row.receipt?.headline, row.receipt?.note, row.outcome.text, ...(row.lines ?? []).map((l) => l.text)];
    for (const text of haystack) {
      if (typeof text === "string" && text.includes("Verified done")) offenders.push(`${row.id}: ${text}`);
    }
  }
  assert.deepEqual(offenders, []);
});

// ---------------------------------------------------------------------------
// 2 — the report answers for the day the nav is on
// ---------------------------------------------------------------------------

test("the report's single-day span is the day it is given, not the live day", () => {
  for (const day of DEMO_DAYS) {
    const spans = reportSpansForDay(day);
    assert.equal(spans[0].key, REPORT_DAY_SPAN);
    assert.deepEqual(spans[0].days, [day], `the day span for ${day} must hold exactly that day`);
  }
  // the regression itself: an older day must NOT resolve to today's corpus
  const older = DEMO_DAYS[0];
  assert.notEqual(older, DEMO_DAY);
  assert.notDeepEqual(reportSpansForDay(older)[0].days, reportSpansForDay(DEMO_DAY)[0].days);
});

test("every report total comes off the same day partition the queue reads", () => {
  for (const day of DEMO_DAYS) {
    const span = reportSpansForDay(day)[0];
    const report = buildActivityReport(span, "12:00 PM");
    const rows = topLevelRowsForDay(day);
    assert.equal(report.totals.runs, rows.length, `${day}: the report and the queue must count the same rows`);
    // the per-workflow table is the same set, re-bucketed — it cannot hold more
    assert.equal(
      report.byWorkflow.reduce((n, line) => n + line.runs, 0),
      rows.length,
    );
    // outstanding is a subset of that same day, never of another one
    for (const row of outstandingRows(span)) {
      assert.ok(rows.some((r) => r.id === row.id), `${day}: ${row.id} is outstanding but not on this day`);
    }
  }
});

// ---------------------------------------------------------------------------
// 3 — the catalog documents the panel that exists
// ---------------------------------------------------------------------------

test("the catalog's tab lists ARE the panel's own derivation", () => {
  for (const spec of PANEL_KINDS) {
    assert.deepEqual(
      [...spec.tabs],
      tabsForPanelKind(spec.key).map((tab) => TAB_LABEL[tab]),
      `${spec.name} must render the tabs the panel derives`,
    );
  }
});

test("no panel kind serves a Data tab, and none of them can", () => {
  const kinds: PanelKind[] = ["run", "review", "group", "member"];
  for (const kind of kinds) {
    const names = tabNamesForPanelKind(kind);
    assert.ok(!names.includes("Data"), `${kind} must not offer a Data tab — Data is a context-rail section`);
    assert.ok(!names.includes("Screenshots"), `${kind} must not offer a Screenshots tab — evidence is a rail section`);
  }
  // Review is the one panel that owns records, and the only one that reviews.
  assert.deepEqual(kinds.filter((k) => tabNamesForPanelKind(k).includes("Review")), ["review"]);
  assert.deepEqual(kinds.filter((k) => tabNamesForPanelKind(k).includes("People")), ["group"]);
});

test("nothing deleted from the panel is listed as always visible", () => {
  // `pinned` is the ALWAYS-VISIBLE list, so it is the one place a band the
  // panel no longer draws would read as a claim rather than as a note. The
  // `specifics` may still NAME a deleted band, and one deliberately does — "there
  // is no gate banner" is the answer to "where did it go".
  const alwaysVisible = PANEL_KINDS.flatMap((spec) => spec.pinned).join(" ");
  assert.ok(!/gate banner/i.test(alwaysVisible), "the gate banner was deleted in wave 6 — the decision is inline in the stream");
  assert.ok(!/evidence bar/i.test(alwaysVisible), "evidence is a context-rail section, not a bar above the tabs");
  assert.ok(!/\bData tab\b/i.test(alwaysVisible), "Data is a context-rail section, not a tab");
});

// ---------------------------------------------------------------------------
// 7 — a count agrees with its noun
// ---------------------------------------------------------------------------

test("plural() never prints `1 nodes`", () => {
  assert.equal(plural(1, "node"), "1 node");
  assert.equal(plural(0, "node"), "0 nodes");
  assert.equal(plural(2, "node"), "2 nodes");
  assert.equal(plural(1, "person", "people"), "1 person");
  assert.equal(plural(0, "person", "people"), "0 people");
  assert.equal(plural(7, "person", "people"), "7 people");
  assert.equal(plural(1, "match", "matches"), "1 match");
  // a phrase counts too — the noun is the last word, and the `s` lands there
  assert.equal(plural(1, "delegated person lookup"), "1 delegated person lookup");
  assert.equal(plural(3, "delegated person lookup"), "3 delegated person lookups");
});
