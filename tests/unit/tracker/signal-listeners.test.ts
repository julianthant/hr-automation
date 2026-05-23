import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { withTrackedWorkflow } from "../../../src/tracker/jsonl.js";

describe("withTrackedWorkflow signal cleanup", () => {
  it("does not remove signal listeners it did not install", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hr-signal-listeners-"));
    const externalSigint = (): void => {};
    const externalSigterm = (): void => {};
    process.on("SIGINT", externalSigint);
    process.on("SIGTERM", externalSigterm);
    try {
      await withTrackedWorkflow(
        "signal-test",
        "item-1",
        async () => undefined,
        { dir },
      );
      assert.equal(process.listeners("SIGINT").includes(externalSigint), true);
      assert.equal(process.listeners("SIGTERM").includes(externalSigterm), true);
    } finally {
      process.off("SIGINT", externalSigint);
      process.off("SIGTERM", externalSigterm);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
