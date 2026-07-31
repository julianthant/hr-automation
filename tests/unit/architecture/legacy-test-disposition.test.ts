import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { describe, it } from "vitest";
import inventory from "../../../config/rebuild/legacy-test-disposition.json" with { type: "json" };
import { REPO_ROOT } from "./helpers/guard-files.js";

function baselineDirectories(): string[] {
  return requiredLegacyDirectories(execFileSync(
    "git",
    ["ls-tree", "-r", "--name-only", inventory.baselineCommit, "--", "tests"],
    { cwd: REPO_ROOT, encoding: "utf8" },
  ).trim().split("\n").filter(Boolean), currentTestFiles());
}

function currentTestFiles(): string[] {
  return execFileSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "--", "tests"],
    { cwd: REPO_ROOT, encoding: "utf8" },
  ).trim().split("\n").filter(Boolean);
}

export function requiredLegacyDirectories(
  baselineFiles: readonly string[],
  currentFiles: readonly string[],
): string[] {
  const directories = new Set(["tests"]);
  for (const file of [...baselineFiles, ...currentFiles]) {
    if (file === "tests/rebuild" || file.startsWith("tests/rebuild/")) continue;
    const parts = file.split("/");
    parts.pop();
    while (parts.length > 1) {
      const directory = parts.join("/");
      if (directory !== "tests/rebuild" && !directory.startsWith("tests/rebuild/")) {
        directories.add(directory);
      }
      parts.pop();
    }
  }
  return [...directories].sort();
}

describe("legacy test disposition inventory", () => {
  it("classifies the union of baseline and current legacy test directories exactly once", () => {
    const paths = inventory.entries.map(({ path }) => path);
    assert.equal(new Set(paths).size, paths.length);
    assert.deepEqual(paths, baselineDirectories());
  });

  it("excludes only tests/rebuild while retaining newly added legacy helper directories", () => {
    assert.deepEqual(
      requiredLegacyDirectories(
        ["tests/unit/original.test.ts"],
        [
          "tests/unit/architecture/helpers/guard-files.ts",
          "tests/rebuild/unit/new.test.ts",
          "tests/rebuild/scenario/helper.ts",
        ],
      ),
      ["tests", "tests/unit", "tests/unit/architecture", "tests/unit/architecture/helpers"],
    );
    assert.ok(inventory.entries.some(({ path }) => path === "tests/unit/architecture/helpers"));
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
