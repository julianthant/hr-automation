import { createHash } from "node:crypto";
import { existsSync, globSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import assert from "node:assert/strict";
import { describe, it } from "vitest";
import inventory from "../../../docs/rebuild/guard-inventory.json" with { type: "json" };
import {
  REBUILD_COVERAGE_EXCLUSIONS,
  REBUILD_COVERAGE_FLOORS,
} from "../../../vitest.config.js";
import { REPO_ROOT, walkFiles } from "./helpers/guard-files.js";

const ARCHITECTURE_ROOT = join(REPO_ROOT, inventory.architectureRoot);
const packageJson = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as {
  scripts: Record<string, string>;
};

describe("reviewed architecture guard manifest", () => {
  it("registers every guard file exactly once and every active entry exists", () => {
    const active = inventory.guards.filter(({ status }) => status === "active");
    const names = active.map(({ name }) => name);
    assert.equal(new Set(names).size, names.length, "active guard names must be unique");

    const present = readdirSync(ARCHITECTURE_ROOT)
      .filter((name) => name.endsWith(".test.ts"))
      .map((name) => name.slice(0, -8))
      .sort();
    assert.deepEqual(names.sort(), present, "guard file exists without registration or active inventory entry has no file");
    for (const entry of active) {
      assert.ok(entry.invariant.trim(), `${entry.name} must state its invariant`);
      assert.ok(entry.owner.trim(), `${entry.name} must name its owner`);
      assert.equal(entry.replacementRequired, true, `${entry.name} must require a replacement decision on removal`);
      assert.ok(existsSync(join(REPO_ROOT, entry.file)), entry.file);
    }
  });

  it("keeps test:architecture pointed at the complete architecture directory", () => {
    const script = packageJson.scripts[inventory.testScript] ?? "";
    assert.match(script, /vitest run tests\/unit\/architecture/);
  });

  it("pins the reviewed coverage exclusions and floors", () => {
    const digest = createHash("sha256")
      .update(JSON.stringify(REBUILD_COVERAGE_EXCLUSIONS.map(({ pattern }) => pattern)))
      .digest("hex");
    assert.equal(digest, inventory.coveragePolicy.exclusionListSha256);
    const patterns = REBUILD_COVERAGE_EXCLUSIONS.map(({ pattern }) => pattern);
    assert.equal(new Set(patterns).size, patterns.length, "coverage exclusions must be unique");
    for (const exclusion of REBUILD_COVERAGE_EXCLUSIONS) {
      assert.ok(exclusion.reason.trim(), `${exclusion.pattern}: exclusion needs a reason`);
      const activated = globSync(exclusion.activationRoot, { cwd: REPO_ROOT }).length > 0;
      if (activated) {
        assert.ok(
          globSync(exclusion.pattern, { cwd: REPO_ROOT }).length > 0,
          `${exclusion.pattern}: active coverage exclusion matches nothing`,
        );
      }
    }
    assert.ok(REBUILD_COVERAGE_FLOORS.global.lines >= inventory.coveragePolicy.minimumFloors.global);
    assert.ok(REBUILD_COVERAGE_FLOORS.global.statements >= inventory.coveragePolicy.minimumFloors.global);
    assert.ok(REBUILD_COVERAGE_FLOORS.global.functions >= inventory.coveragePolicy.minimumFloors.global);
    assert.ok(REBUILD_COVERAGE_FLOORS.safetyCritical.lines >= inventory.coveragePolicy.minimumFloors.safetyCritical);
    assert.equal(REBUILD_COVERAGE_FLOORS.branches.phase1ReportOnly, true);
    assert.ok(REBUILD_COVERAGE_FLOORS.branches.phase2Global >= 50);
    assert.ok(REBUILD_COVERAGE_FLOORS.branches.phase2SafetyCritical >= 70);
  });

  it("activates every planned temp_src ratchet non-vacuously with the first source file", () => {
    const tempRoot = join(REPO_ROOT, inventory.tempSrcRatchetActivation.sourceRoot);
    if (!existsSync(tempRoot)) {
      assert.equal(inventory.tempSrcRatchetActivation.state, "planned-until-first-file");
      return;
    }
    assert.ok(walkFiles(tempRoot).length > 0, "active temp_src must contain a scannable source file");
    for (const name of inventory.tempSrcRatchetActivation.requiredGuardNames) {
      const source = readFileSync(join(ARCHITECTURE_ROOT, `${name}.test.ts`), "utf8");
      assert.match(source, /temp_src/, `${name} must include a temp_src scan arm when active`);
    }
  });
});
