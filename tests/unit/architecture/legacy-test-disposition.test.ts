import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { describe, it } from "vitest";
import inventory from "../../../config/rebuild/legacy-test-disposition.json" with { type: "json" };
import { REPO_ROOT } from "./helpers/guard-files.js";

function baselineDirectories(): string[] {
  const files = execFileSync(
    "git",
    ["ls-tree", "-r", "--name-only", inventory.baselineCommit, "--", "tests"],
    { cwd: REPO_ROOT, encoding: "utf8" },
  ).trim().split("\n").filter(Boolean);
  const directories = new Set(["tests"]);
  for (const file of files) {
    const parts = file.split("/");
    parts.pop();
    while (parts.length > 1) {
      directories.add(parts.join("/"));
      parts.pop();
    }
  }
  return [...directories].sort();
}

describe("legacy test disposition inventory", () => {
  it("classifies every baseline test directory exactly once", () => {
    const paths = inventory.entries.map(({ path }) => path);
    assert.equal(new Set(paths).size, paths.length);
    assert.deepEqual(paths, baselineDirectories());
  });

  it("requires port evidence before any later-retirement candidacy", () => {
    for (const entry of inventory.entries) {
      assert.ok(["preserved", "ported-and-preserved", "candidate-for-later-retirement"].includes(entry.disposition));
      if (entry.disposition !== "preserved") {
        assert.ok(entry.rebuildEvidenceIds.length > 0, `${entry.path} needs rebuild evidence`);
      }
    }
  });
});
