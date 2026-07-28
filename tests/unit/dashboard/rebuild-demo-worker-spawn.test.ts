import { describe, expect, it } from "vitest";
import {
  DEMO_EXECUTOR_CAP,
  DEMO_LANE_BUDGET,
  DEMO_SESSIONS,
  laneBudgetOf,
  planWorkerSpawn,
  workerSpawnCapacity,
  type DemoLaneBudget,
} from "@/components/dev/rebuild-demo/demo-workers-wire";

/**
 * DEV-ONLY (`?view=rebuild-demo`) — the Session Panel's `+`, which was a NOOP.
 *
 * The contract worth pinning is not "it starts workers", it is **what it says
 * when it cannot**. Capacity here is nearly always short — the operator session
 * gets one shared UCPath window, so a second Separations worker is refused by
 * the SYSTEM, not by a workflow-local policy — which makes partial success the
 * ORDINARY outcome. These tests hold three things:
 *
 *  1. the answer is a per-worker VECTOR, never an aggregate;
 *  2. nothing is ever rounded up to success;
 *  3. the refusal names the real constraint, and the budget it names is the
 *     same one the Session Cards render.
 */

/** a machine with room, so a refusal in a test is the system's and not the pool's */
const ROOMY: DemoLaneBudget = {
  executorCap: 6,
  executorInUse: 0,
  systems: [
    { system: "ucpath", inUse: 1, cap: 1, scope: "session", heldBy: ["Separations"] },
    { system: "kuali", inUse: 0, cap: 2, scope: "workflow", heldBy: [] },
    { system: "i9", inUse: 0, cap: 1, scope: "workflow", heldBy: [] },
  ],
};

describe("rebuild demo — the lane budget is derived from the cards", () => {
  it("folds the SAME session array the Session Panel renders", () => {
    expect(DEMO_LANE_BUDGET).toEqual(laneBudgetOf(DEMO_SESSIONS));
  });

  it("does not count a crashed executor as holding a lane", () => {
    const live = DEMO_SESSIONS.filter((s) => !s.crashed).length;
    expect(DEMO_LANE_BUDGET.executorInUse).toBe(live);
    expect(DEMO_LANE_BUDGET.executorCap).toBe(DEMO_EXECUTOR_CAP);
  });

  it("names who holds each in-use lease, so a refusal can name them too", () => {
    const ucpath = DEMO_LANE_BUDGET.systems.find((s) => s.system === "ucpath");
    expect(ucpath?.cap).toBe(1);
    expect(ucpath?.inUse).toBe(1);
    expect(ucpath?.heldBy).toEqual(["Separations"]);
  });
});

describe("rebuild demo — spawning N workers answers for each of them", () => {
  it("returns one outcome per requested worker, in order", () => {
    const result = planWorkerSpawn("ocr", 4, ROOMY);
    expect(result.requested).toBe(4);
    expect(result.outcomes).toHaveLength(4);
    expect(result.outcomes.map((o) => o.index)).toEqual([1, 2, 3, 4]);
  });

  it("refuses at a SYSTEM cap and names the holder", () => {
    // separations drives ucpath, whose one lease Separations already holds
    const result = planWorkerSpawn("separations", 3, ROOMY);
    expect(result.started).toBe(0);
    expect(result.refused).toBe(3);
    for (const o of result.outcomes) {
      expect(o.state).toBe("refused");
      expect(o.code).toBe("system-at-cap");
      expect(o.reason).toContain("This session gets 1 ucpath window");
      expect(o.reason).toContain("shared by every workflow");
      expect(o.reason).toContain("Separations");
    }
  });

  it("is a WALK, not a summary: worker 1 takes the last lease and worker 2 is refused for it", () => {
    // person-lookup drives ucpath only; give it a free one
    const budget: DemoLaneBudget = {
      ...ROOMY,
      systems: [{ system: "ucpath", inUse: 0, cap: 1, scope: "session", heldBy: [] }],
    };
    const result = planWorkerSpawn("separations", 3, budget);
    expect(result.outcomes[0].state).toBe("started");
    expect(result.outcomes[1].state).toBe("refused");
    expect(result.outcomes[2].state).toBe("refused");
    expect(result.outcomes[1].reason).toContain("Separations");
  });

  it("refuses on the EXECUTOR pool when the machine is full, before any system is consulted", () => {
    const full: DemoLaneBudget = { ...ROOMY, executorInUse: ROOMY.executorCap };
    const result = planWorkerSpawn("ocr", 2, full);
    expect(result.started).toBe(0);
    expect(result.outcomes.every((o) => o.code === "executor-pool-full")).toBe(true);
    expect(result.outcomes[0].reason).toContain("at most 6 workers");
  });

  it("never rounds a partial up to success", () => {
    const budget: DemoLaneBudget = {
      ...ROOMY,
      systems: [{ system: "ucpath", inUse: 0, cap: 1, scope: "session", heldBy: [] }],
    };
    const result = planWorkerSpawn("separations", 5, budget);
    expect(result.headline).toContain("1 of 5 started");
    expect(result.headline).toContain("4 refused");
    // and a clean run says so without the refusal clause
    expect(planWorkerSpawn("ocr", 1, ROOMY).headline).toBe("1 of 1 started");
  });

  it("never mutates the budget it was handed", () => {
    const before = JSON.stringify(ROOMY);
    planWorkerSpawn("separations", 4, ROOMY);
    planWorkerSpawn("ocr", 4, ROOMY);
    expect(JSON.stringify(ROOMY)).toBe(before);
  });

  it("gives every started worker its own instance id", () => {
    const result = planWorkerSpawn("ocr", 3, ROOMY);
    const ids = result.outcomes.filter((o) => o.state === "started").map((o) => o.instance);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every((id) => id?.startsWith("oc-w"))).toBe(true);
  });

  it("previews exactly what the command will do — the two cannot disagree", () => {
    for (const workflow of ["separations", "ocr", "person-lookup"] as const) {
      const preview = workerSpawnCapacity(workflow, ROOMY);
      const actual = planWorkerSpawn(workflow, 6, ROOMY);
      expect(preview.canStart).toBe(actual.started);
      if (preview.canStart < 6) expect(preview.blocker).toBeDefined();
    }
  });
});
