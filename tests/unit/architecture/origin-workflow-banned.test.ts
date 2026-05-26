import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { it } from "vitest";

const BANNED_TERM = "origin" + "Workflow";

it("does not reintroduce origin workflow lineage fields", () => {
  const result = spawnSync(
    "rg",
    ["-n", String.raw`\b${BANNED_TERM}\b`, "src", "tests/unit"],
    { cwd: process.cwd(), encoding: "utf8" },
  );

  assert.notEqual(result.status, null, "ripgrep was terminated before completing");
  assert.ok(
    result.status === 1,
    result.stdout || result.stderr || `${BANNED_TERM} is still present`,
  );
});
