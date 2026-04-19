import { describe, it, expect } from "vitest";
import { withLogContext, setLogRunId, getLogRunId } from "../../src/utils/log.js";

describe("getLogRunId", () => {
  it("returns undefined outside a log context", () => {
    expect(getLogRunId()).toBeUndefined();
  });

  it("returns undefined inside a context with no runId set", async () => {
    await withLogContext("wf", "item-1", async () => {
      expect(getLogRunId()).toBeUndefined();
    });
  });

  it("returns the runId after setLogRunId is called", async () => {
    await withLogContext("wf", "item-1", async () => {
      setLogRunId("item-1#3");
      expect(getLogRunId()).toBe("item-1#3");
    });
  });

  it("isolates runId between concurrent contexts", async () => {
    const results: string[] = [];
    await Promise.all([
      withLogContext("wf", "item-A", async () => {
        setLogRunId("item-A#1");
        await new Promise((r) => setTimeout(r, 10));
        results.push(getLogRunId() ?? "missing");
      }),
      withLogContext("wf", "item-B", async () => {
        setLogRunId("item-B#1");
        await new Promise((r) => setTimeout(r, 10));
        results.push(getLogRunId() ?? "missing");
      }),
    ]);
    expect(results).toContain("item-A#1");
    expect(results).toContain("item-B#1");
    expect(results).not.toContain("missing");
  });
});
