import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { withLogContext, getLogWorkflow } from "../../../src/utils/log.js";

describe("getLogWorkflow", () => {
  it("returns undefined outside a log context", () => {
    assert.equal(getLogWorkflow(), undefined);
  });

  it("returns the workflow name set by withLogContext", async () => {
    await withLogContext("oath-signature", "10859569", async () => {
      assert.equal(getLogWorkflow(), "oath-signature");
    });
  });

  it("nested context restores the outer workflow on return", async () => {
    await withLogContext("emergency-contact", "p01-12345", async () => {
      assert.equal(getLogWorkflow(), "emergency-contact");
      await withLogContext("oath-signature", "10859569", async () => {
        assert.equal(getLogWorkflow(), "oath-signature");
      });
      assert.equal(getLogWorkflow(), "emergency-contact");
    });
  });

  it("isolates workflow between concurrent contexts", async () => {
    const results: string[] = [];
    await Promise.all([
      withLogContext("oath-signature", "item-A", async () => {
        await new Promise((r) => setTimeout(r, 10));
        results.push(getLogWorkflow() ?? "missing");
      }),
      withLogContext("emergency-contact", "item-B", async () => {
        await new Promise((r) => setTimeout(r, 10));
        results.push(getLogWorkflow() ?? "missing");
      }),
    ]);
    assert.ok(results.includes("oath-signature"));
    assert.ok(results.includes("emergency-contact"));
    assert.ok(!results.includes("missing"));
  });
});
