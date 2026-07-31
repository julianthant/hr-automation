import { describe, expect, it } from "vitest";
import {
  attentionAcrossWorkflows,
  countRows,
  countRowsByWorkflow,
  railEntryCounts,
  rowsForWorkflow,
  topLevelRows,
} from "@/components/dev/rebuild-demo/DemoShell";
import { DEMO_DAYS } from "@/components/dev/rebuild-demo/demo-days";
import { DEMO_WORKFLOW_LIST } from "@/components/dev/rebuild-demo/demo-wire";

/**
 * DEV-ONLY (`?view=rebuild-demo`) — the RAIL / LAUNCHER COUNT INVARIANT.
 *
 * The rail's `active │ all` column is queued + running over everything today.
 * The collapsed launcher badge is that same `active` total. They used to
 * disagree: the launcher showed `Needs you` (waiting + parked) in amber while
 * the rail showed grey actives that summed to a different number — so nothing
 * on screen added up. These tests hold the pair to one counting path.
 */
describe("rebuild demo — attention counts cannot disagree", () => {
  for (const day of DEMO_DAYS) {
    it(`the rail's active badges sum to the day's queued + running (${day})`, () => {
      const rows = topLevelRows(day);
      const perWorkflow = countRowsByWorkflow(rows);
      const summed = [...perWorkflow.values()].reduce((n, c) => n + railEntryCounts(c).active, 0);
      const dayCounts = countRows(rows);
      expect(summed).toBe(dayCounts.queued + dayCounts.running);
    });

    it(`the rail's all badges sum to the day's total (${day})`, () => {
      const rows = topLevelRows(day);
      const perWorkflow = countRowsByWorkflow(rows);
      const summed = [...perWorkflow.values()].reduce((n, c) => n + railEntryCounts(c).total, 0);
      expect(summed).toBe(countRows(rows).all);
    });

    it(`a rail badge equals the queue's own scoped count (${day})`, () => {
      const rows = topLevelRows(day);
      const perWorkflow = countRowsByWorkflow(rows);
      for (const w of DEMO_WORKFLOW_LIST) {
        const scoped = countRows(rowsForWorkflow(rows, w.label));
        const rail = railEntryCounts(perWorkflow.get(w.label));
        expect(rail.total).toBe(scoped.all);
        expect(rail.active).toBe(scoped.queued + scoped.running);
      }
    });

    it(`the launcher's pair is the rail's own badges, summed (${day})`, () => {
      const rows = topLevelRows(day);
      const launcher = attentionAcrossWorkflows(rows);
      let active = 0;
      let all = 0;
      for (const w of DEMO_WORKFLOW_LIST) {
        const scoped = countRows(rowsForWorkflow(rows, w.label));
        active += scoped.queued + scoped.running;
        all += scoped.all;
      }
      expect(launcher.active).toBe(active);
      expect(launcher.all).toBe(all);
    });

    it(`the launcher's active never exceeds its own total (${day})`, () => {
      const { active, all } = attentionAcrossWorkflows(topLevelRows(day));
      expect(active).toBeLessThanOrEqual(all);
      expect(active).toBeGreaterThanOrEqual(0);
    });
  }

  it("the launcher's active is a different quantity from Needs you", () => {
    const rows = topLevelRows();
    const launcher = attentionAcrossWorkflows(rows);
    const needsYou = countRows(rows).needsYou;
    // Both are positive on the demo day, and they are not the same number —
    // that is the point of keeping attention on the Status Bar pill.
    expect(launcher.active).toBeGreaterThan(0);
    expect(needsYou).toBeGreaterThan(0);
    expect(launcher.active).not.toBe(needsYou);
  });
});
