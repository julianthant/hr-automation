import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { withTrackedWorkflow } from "../../../src/tracker/jsonl.js";

describe("withTrackedWorkflow stamps data.archetype on tracker rows", () => {
  it("stamps single archetype by default", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "archetype-"));
    try {
      await withTrackedWorkflow(
        "test-single",
        "id-1",
        async () => {},
        { dir, archetype: "single" },
      );
      const jsonlFile = readdirSync(dir).find((f) => f.startsWith("test-single-") && f.endsWith(".jsonl"));
      assert.ok(jsonlFile, "should have written a JSONL file");
      const lines = readFileSync(path.join(dir, jsonlFile), "utf-8")
        .trim().split("\n").map((l) => JSON.parse(l));
      assert.ok(lines.length >= 2, "should emit at least pending + done");
      for (const line of lines) {
        assert.equal(line.data?.archetype, "single", `every row should carry archetype=single (got ${JSON.stringify(line.data)})`);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
