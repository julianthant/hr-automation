import { describe, expect, it } from "vitest";
import {
  countRows,
  countRowsByWorkflow,
  needsYouElsewhere,
  rowsForWorkflow,
  topLevelRows,
} from "@/components/dev/rebuild-demo/DemoShell";
import { DEMO_DAYS } from "@/components/dev/rebuild-demo/demo-days";
import { DEMO_WORKFLOW_LIST } from "@/components/dev/rebuild-demo/demo-wire";

/**
 * DEV-ONLY (`?view=rebuild-demo`) — the ATTENTION-COUNT INVARIANT.
 *
 * The bug this pins: the collapsed Workflow Panel launcher rendered `👁 6`
 * while the rail's own badges summed to 4. Neither was stale. The launcher was
 * counting the day's `Needs you` across every panel; the rail was showing each
 * workflow's QUEUED count in an unlabelled numeric chip. Two quantities, two
 * anonymous badges, and nothing on screen that added up.
 *
 * Both now derive from `countRowsByWorkflow`, and the launcher is scoped to the
 * panels the rail is not showing — so the two numbers on screen at once are
 * disjoint and additive. These tests are what holds that, instead of the
 * sentence in the rail's footer that used to assert it.
 */
describe("rebuild demo — attention counts cannot disagree", () => {
  for (const day of DEMO_DAYS) {
    it(`the rail's attention badges sum to the day's total (${day})`, () => {
      const rows = topLevelRows(day);
      const perWorkflow = countRowsByWorkflow(rows);
      const summed = [...perWorkflow.values()].reduce((n, c) => n + c.needsYou, 0);
      expect(summed).toBe(countRows(rows).needsYou);
    });

    it(`a rail badge equals the queue's own scoped count (${day})`, () => {
      const rows = topLevelRows(day);
      const perWorkflow = countRowsByWorkflow(rows);
      for (const w of DEMO_WORKFLOW_LIST) {
        const scoped = countRows(rowsForWorkflow(rows, w.label));
        const rail = perWorkflow.get(w.label);
        expect(rail?.all ?? 0).toBe(scoped.all);
        expect(rail?.needsYou ?? 0).toBe(scoped.needsYou);
      }
    });

    it(`launcher + Status Bar cover the day exactly once, from every panel (${day})`, () => {
      const rows = topLevelRows(day);
      const total = countRows(rows).needsYou;
      for (const w of DEMO_WORKFLOW_LIST) {
        const here = countRows(rowsForWorkflow(rows, w.label)).needsYou;
        // What the launcher shows, plus what the Status Bar's `Needs you` pill
        // shows for the panel you are standing in. No overlap, no gap.
        expect(needsYouElsewhere(rows, w.label) + here).toBe(total);
      }
    });
  }

  it("the launcher never repeats the count the panel you are in already shows", () => {
    const rows = topLevelRows();
    const total = countRows(rows).needsYou;
    // Separations holds attention of its own on the demo day, so a launcher
    // showing the GLOBAL number beside that panel is the original defect.
    const here = countRows(rowsForWorkflow(rows, "Separations")).needsYou;
    expect(here).toBeGreaterThan(0);
    expect(needsYouElsewhere(rows, "Separations")).toBe(total - here);
    expect(needsYouElsewhere(rows, "Separations")).not.toBe(total);
  });

  it("a panel with no attention of its own sees the whole day in the launcher", () => {
    const rows = topLevelRows();
    const quiet = DEMO_WORKFLOW_LIST.find(
      (w) => countRows(rowsForWorkflow(rows, w.label)).needsYou === 0,
    );
    expect(quiet).toBeDefined();
    expect(needsYouElsewhere(rows, quiet!.label)).toBe(countRows(rows).needsYou);
  });
});
