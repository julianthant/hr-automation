import { describe, expect, it } from "vitest";
import {
  DEMO_LIVE_WORKERS,
  DEMO_SESSIONS,
  liveWorkerCount,
  planWorkerSpawn,
} from "@/components/dev/rebuild-demo/demo-workers-wire";

/**
 * DEV-ONLY (`?view=rebuild-demo`) — the Session Panel's `+`.
 *
 * UCPath's per-worker cap of 1 means each worker opens one UCPath window.
 * Distinct browser sessions may each hold their own — so spawn never refuses
 * on a folded `ucpath 1/1`. The dialog is workflow + count; every ask starts.
 */

describe("rebuild demo — worker count is derived from the cards", () => {
  it("folds the SAME session array the Session Panel renders", () => {
    expect(DEMO_LIVE_WORKERS).toBe(liveWorkerCount(DEMO_SESSIONS));
  });

  it("does not count a crashed executor as a live worker", () => {
    const live = DEMO_SESSIONS.filter((s) => !s.crashed).length;
    expect(DEMO_LIVE_WORKERS).toBe(live);
  });

  it("does not model lane or per-system capacity fields", () => {
    expect(DEMO_SESSIONS.every((session) => !("lanes" in session) && !("budgets" in session))).toBe(true);
  });
});

describe("rebuild demo — spawning N workers starts all of them", () => {
  it("returns one started outcome per requested worker, in order", () => {
    const result = planWorkerSpawn("separations", 5);
    expect(result.requested).toBe(5);
    expect(result.started).toBe(5);
    expect(result.outcomes).toHaveLength(5);
    expect(result.outcomes.map((o) => o.index)).toEqual([1, 2, 3, 4, 5]);
    expect(result.outcomes.every((o) => o.state === "started")).toBe(true);
    expect(result.headline).toBe("5 of 5 started");
  });

  it("does not refuse on UCPath — each worker gets its own browser session", () => {
    const result = planWorkerSpawn("separations", 3);
    expect(result.started).toBe(3);
    for (const o of result.outcomes) {
      expect(o.claimed).toContain("ucpath");
      expect(o.instance).toMatch(/^se-w\d+$/);
    }
  });

  it("gives every started worker its own instance id", () => {
    const result = planWorkerSpawn("ocr", 3);
    const ids = result.outcomes.map((o) => o.instance);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every((id) => id.startsWith("oc-w"))).toBe(true);
  });

  it("numbers instances from the live executor count", () => {
    const result = planWorkerSpawn("ocr", 2, 4);
    expect(result.outcomes.map((o) => o.instance)).toEqual(["oc-w5", "oc-w6"]);
  });
});
