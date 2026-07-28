import { describe, expect, it } from "vitest";
import {
  attentionAcrossWorkflows,
  countRows,
  countRowsByWorkflow,
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
 * Both now derive from `countRowsByWorkflow`. The launcher renders the rail's
 * own PAIR summed down its length — `3 | 5`, attention of total — which is a
 * different SHAPE from the Status Bar's `Needs you 1`, so the two can no longer
 * be read as one quantity rendered twice. These tests are what holds that,
 * instead of the sentence in the rail's footer that used to assert it.
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

    it(`the launcher's pair is the rail's own badges, summed (${day})`, () => {
      const rows = topLevelRows(day);
      const launcher = attentionAcrossWorkflows(rows);
      // Down the rail, entry by entry — the launcher stands in for exactly this
      // when the rail is minimised, so it may not be a second tally.
      let needsYou = 0;
      let all = 0;
      for (const w of DEMO_WORKFLOW_LIST) {
        const scoped = countRows(rowsForWorkflow(rows, w.label));
        needsYou += scoped.needsYou;
        all += scoped.all;
      }
      expect(launcher.needsYou).toBe(needsYou);
      expect(launcher.all).toBe(all);
    });

    it(`the launcher's attention never exceeds its own total (${day})`, () => {
      const { needsYou, all } = attentionAcrossWorkflows(topLevelRows(day));
      expect(needsYou).toBeLessThanOrEqual(all);
      expect(needsYou).toBeGreaterThanOrEqual(0);
    });
  }

  it("the launcher's pair is a different quantity from the panel's own pill", () => {
    const rows = topLevelRows();
    const launcher = attentionAcrossWorkflows(rows);
    // Separations holds attention of its own on the demo day. The launcher's
    // first number spans every workflow, so it is strictly larger than the
    // Status Bar's scoped one — the pair is not the pill repeated.
    const here = countRows(rowsForWorkflow(rows, "Separations")).needsYou;
    expect(here).toBeGreaterThan(0);
    expect(launcher.needsYou).toBeGreaterThan(here);
  });
});
