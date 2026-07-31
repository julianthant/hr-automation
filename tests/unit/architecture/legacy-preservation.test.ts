import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import assert from "node:assert/strict";
import { describe, it } from "vitest";
import manifest from "../../../config/rebuild/legacy-preservation.json" with { type: "json" };
import { REPO_ROOT } from "./helpers/guard-files.js";

function baselineFiles(root: string): string[] {
  return execFileSync(
    "git",
    ["ls-tree", "-r", "--name-only", manifest.baselineCommit, "--", root],
    { cwd: REPO_ROOT, encoding: "utf8" },
  ).trim().split("\n").filter(Boolean);
}

describe("legacy source and test preservation", () => {
  it("pins an explicit recoverable baseline and every baseline path", () => {
    assert.match(manifest.baselineCommit, /^[a-f0-9]{40}$/);
    execFileSync("git", ["cat-file", "-e", `${manifest.baselineCommit}^{commit}`], { cwd: REPO_ROOT });
    for (const root of manifest.roots) {
      assert.deepEqual(root.files, baselineFiles(root.root), `${root.root} baseline inventory drifted`);
      for (const path of root.files) {
        assert.ok(existsSync(join(REPO_ROOT, path)), `legacy path deleted before authorized retirement: ${path}`);
      }
    }
  });

  it("keeps legacy Vitest projects runnable through initial cutover", () => {
    const config = readFileSync(join(REPO_ROOT, "vitest.config.ts"), "utf8");
    for (const project of manifest.legacyVitestProjects) {
      assert.match(config, new RegExp(`name:\\s*["']${project}["']`));
    }
    assert.equal(manifest.retirementRequiresOperatorAuthorization, true);
    assert.equal(manifest.preservationMode, "through-initial-cutover");
  });

  it("hash-binds every current TypeScript legacy source file for D88 preservation mode", () => {
    assert.equal(manifest.runtimeIsolation.sourceRoot, "src");
    const sourceRoot = manifest.roots.find(({ root }) => root === manifest.runtimeIsolation.sourceRoot);
    assert.ok(sourceRoot, "src preservation root must exist");
    const expected = sourceRoot.files.filter((path) => path.endsWith(".ts") || path.endsWith(".tsx")).sort();
    assert.deepEqual(Object.keys(manifest.runtimeIsolation.files).sort(), expected);
    for (const [path, expectedHash] of Object.entries(manifest.runtimeIsolation.files)) {
      const actualHash = createHash("sha256").update(readFileSync(join(REPO_ROOT, path))).digest("hex");
      assert.equal(actualHash, expectedHash, `${path}: runtime-isolation preservation hash`);
    }
  });
});
