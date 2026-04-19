import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { withLogContext, setLogRunId, getLogRunId } from "../../../src/utils/log.js";

describe("getLogRunId", () => {
  it("returns undefined outside a log context", () => {
    assert.equal(getLogRunId(), undefined);
  });

  it("returns undefined inside a context with no runId set", async () => {
    await withLogContext("wf", "item-1", async () => {
      assert.equal(getLogRunId(), undefined);
    });
  });

  it("returns the runId after setLogRunId is called", async () => {
    await withLogContext("wf", "item-1", async () => {
      setLogRunId("item-1#3");
      assert.equal(getLogRunId(), "item-1#3");
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
    assert.ok(results.includes("item-A#1"));
    assert.ok(results.includes("item-B#1"));
    assert.ok(!results.includes("missing"));
  });
});
