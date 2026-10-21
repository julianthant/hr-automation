import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import assert from "node:assert/strict";
import { describe, it } from "vitest";
import manifest from "../../../config/rebuild/legacy-preservation.json" with { type: "json" };
import { REPO_ROOT } from "./helpers/guard-files.js";

describe("legacy source and test preservation", () => {
  it("preserves every path in the frozen pre-split baseline inventory", () => {
    assert.match(manifest.baselineCommit, /^[a-f0-9]{40}$/);
    for (const root of manifest.roots) {
      assert.ok(root.files.length > 0, `${root.root}: non-empty frozen inventory`);
      assert.equal(new Set(root.files).size, root.files.length, `${root.root}: duplicate path`);
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

  it("retains valid hashes for every TypeScript path in the frozen preservation snapshot", () => {
    assert.equal(manifest.runtimeIsolation.sourceRoot, "src");
    const sourceRoot = manifest.roots.find(({ root }) => root === manifest.runtimeIsolation.sourceRoot);
    assert.ok(sourceRoot, "src preservation root must exist");
    const expected = sourceRoot.files.filter((path) => path.endsWith(".ts") || path.endsWith(".tsx")).sort();
    const hashed = Object.keys(manifest.runtimeIsolation.files);
    assert.ok(hashed.length >= expected.length);
    for (const path of expected) assert.ok(hashed.includes(path), `${path}: baseline hash missing`);
    for (const [path, expectedHash] of Object.entries(manifest.runtimeIsolation.files)) {
      assert.ok(path.startsWith("src/"));
      assert.match(expectedHash, /^[a-f0-9]{64}$/, `${path}: preservation hash`);
    }
  });
});
