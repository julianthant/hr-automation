import { createHash } from "node:crypto";
import { existsSync, globSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import assert from "node:assert/strict";
import { describe, it } from "vitest";
import inventory from "../../../docs/rebuild/guard-inventory.json" with { type: "json" };
import {
  REBUILD_COVERAGE_EXCLUSIONS,
  REBUILD_COVERAGE_FLOORS,
} from "../../../vitest.config.js";
import { REPO_ROOT, walkFiles } from "./helpers/guard-files.js";
import {
  auditRebuildRatchetArm,
  rebuildRatchetFixture,
  REQUIRED_REBUILD_RATCHET_NAMES,
} from "./helpers/rebuild-ratchet-arms.js";

const ARCHITECTURE_ROOT = join(REPO_ROOT, inventory.architectureRoot);
const packageJson = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as {
  scripts: Record<string, string>;
};

interface CoverageExclusion {
  readonly pattern: string;
  readonly activation: {
    readonly ownerRoot: string;
    readonly status: "planned" | "active";
  };
  readonly reason: string;
}

export function discoverArchitectureTests(root: string): string[] {
  return walkFiles(root, { extensions: [".ts"] })
    .filter((file) => file.endsWith(".test.ts"))
    .map((file) => relative(REPO_ROOT, file).replaceAll("\\", "/"))
    .sort();
}

export function architectureCommandViolations(command: string): string[] {
  const normalized = command.trim().replace(/\s+/g, " ");
  const exact = "vitest run tests/unit/architecture --reporter=dot";
  return normalized === exact
    ? []
    : [`test:architecture must select the complete directory with no file/glob/project/config/exclude narrowing; expected '${exact}'`];
}

export function coverageExclusionActivationViolations(
  exclusions: readonly CoverageExclusion[],
  root: string,
): string[] {
  const violations: string[] = [];
  const owners = exclusions.map(({ activation }) => activation.ownerRoot);
  if (new Set(owners).size !== owners.length) violations.push("coverage exclusions must have independent owner roots");
  for (const [index, owner] of owners.entries()) {
    for (const other of owners.slice(index + 1)) {
      if (owner.startsWith(`${other}/`) || other.startsWith(`${owner}/`)) {
        violations.push(`${owner} and ${other}: coverage owner roots overlap`);
      }
    }
  }

  for (const exclusion of exclusions) {
    const { ownerRoot, status } = exclusion.activation;
    if (!exclusion.reason.trim()) violations.push(`${exclusion.pattern}: exclusion needs a reason`);
    if (/[*?{}[\]]/.test(ownerRoot)) violations.push(`${exclusion.pattern}: ownerRoot must be an exact path, not a glob`);
    if (ownerRoot === exclusion.pattern) violations.push(`${exclusion.pattern}: ownerRoot cannot equal its exclusion pattern`);
    if (!exclusion.pattern.startsWith(`${ownerRoot}/`)) {
      violations.push(`${exclusion.pattern}: exclusion must be owned beneath ownerRoot ${ownerRoot}`);
    }
    const ownerExists = existsSync(join(root, ownerRoot));
    const matches = globSync(exclusion.pattern, { cwd: root });
    if (status === "planned") {
      if (ownerExists) violations.push(`${exclusion.pattern}: planned exclusion owner is already active`);
      if (matches.length > 0) violations.push(`${exclusion.pattern}: planned exclusion already matches files`);
    } else {
      if (!ownerExists) violations.push(`${exclusion.pattern}: active exclusion owner is missing`);
      if (matches.length === 0) violations.push(`${exclusion.pattern}: active coverage exclusion is stale`);
    }
  }
  return violations;
}

function writeFixture(root: string, path: string, content: string): void {
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
}

describe("reviewed architecture guard manifest", () => {
  it("recursively registers every guard file exactly once and every active entry exists", () => {
    const active = inventory.guards.filter(({ status }) => status === "active");
    const names = active.map(({ name }) => name);
    assert.equal(new Set(names).size, names.length, "active guard names must be unique");

    const registered = active.map(({ file }) => file).sort();
    assert.deepEqual(
      registered,
      discoverArchitectureTests(ARCHITECTURE_ROOT),
      "recursive guard file discovery and inventory must match exactly",
    );
    for (const entry of active) {
      assert.ok(entry.invariant.trim(), `${entry.name} must state its invariant`);
      assert.ok(entry.owner.trim(), `${entry.name} must name its owner`);
      assert.equal(entry.replacementRequired, true, `${entry.name} must require a replacement decision on removal`);
      assert.ok(existsSync(join(REPO_ROOT, entry.file)), entry.file);
    }
  });

  it("keeps test:architecture on the complete directory without any narrowing escape hatch", () => {
    assert.deepEqual(architectureCommandViolations(packageJson.scripts[inventory.testScript] ?? ""), []);
    for (const bypass of [
      "vitest run tests/unit/architecture/guard-manifest.test.ts --reporter=dot",
      "vitest run tests/unit/architecture/*.test.ts --reporter=dot",
      "vitest run tests/unit/architecture --exclude runtime-isolation.test.ts --reporter=dot",
      "vitest run tests/unit/architecture --project unit --reporter=dot",
      "vitest run tests/unit/architecture --config narrow.config.ts --reporter=dot",
    ]) {
      assert.ok(architectureCommandViolations(bypass).length > 0, bypass);
    }
  });

  it("pins independently activated coverage exclusions and ratified floors", () => {
    const digest = createHash("sha256")
      .update(JSON.stringify(REBUILD_COVERAGE_EXCLUSIONS))
      .digest("hex");
    assert.equal(digest, inventory.coveragePolicy.exclusionListSha256);
    const patterns = REBUILD_COVERAGE_EXCLUSIONS.map(({ pattern }) => pattern);
    assert.equal(new Set(patterns).size, patterns.length, "coverage exclusions must be unique");
    assert.deepEqual(coverageExclusionActivationViolations(REBUILD_COVERAGE_EXCLUSIONS, REPO_ROOT), []);

    const root = join(tmpdir(), `hrauto-coverage-policy-${process.pid}-${Date.now()}`);
    const planned: CoverageExclusion = {
      pattern: "owned/**/*.ts",
      activation: { ownerRoot: "owned", status: "planned" },
      reason: "fixture",
    };
    try {
      assert.deepEqual(coverageExclusionActivationViolations([planned], root), []);
      mkdirSync(join(root, "owned"), { recursive: true });
      assert.match(coverageExclusionActivationViolations([planned], root).join("\n"), /planned exclusion owner/);
      const active = { ...planned, activation: { ...planned.activation, status: "active" as const } };
      assert.match(coverageExclusionActivationViolations([active], root).join("\n"), /stale/);
      writeFixture(root, "owned/generated.ts", "export {};\n");
      assert.deepEqual(coverageExclusionActivationViolations([active], root), []);
      rmSync(join(root, "owned"), { recursive: true, force: true });
      assert.match(coverageExclusionActivationViolations([active], root).join("\n"), /owner is missing/);
      assert.match(
        coverageExclusionActivationViolations([{ ...planned, activation: { ownerRoot: planned.pattern, status: "planned" } }], root).join("\n"),
        /ownerRoot cannot equal/,
      );
      assert.match(
        coverageExclusionActivationViolations([
          planned,
          { ...planned, pattern: "owned/nested/**/*.ts", activation: { ownerRoot: "owned/nested", status: "planned" } },
        ], root).join("\n"),
        /owner roots overlap/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }

    assert.ok(REBUILD_COVERAGE_FLOORS.global.lines >= inventory.coveragePolicy.minimumFloors.global);
    assert.ok(REBUILD_COVERAGE_FLOORS.global.statements >= inventory.coveragePolicy.minimumFloors.global);
    assert.ok(REBUILD_COVERAGE_FLOORS.global.functions >= inventory.coveragePolicy.minimumFloors.global);
    assert.ok(REBUILD_COVERAGE_FLOORS.safetyCritical.lines >= inventory.coveragePolicy.minimumFloors.safetyCritical);
    assert.equal(REBUILD_COVERAGE_FLOORS.branches.phase1ReportOnly, true);
    assert.ok(REBUILD_COVERAGE_FLOORS.branches.phase2Global >= 50);
    assert.ok(REBUILD_COVERAGE_FLOORS.branches.phase2SafetyCritical >= 70);
  });

  it("executes every required temp_src ratchet arm and proves its violating fixture is caught", () => {
    assert.deepEqual(
      [...inventory.tempSrcRatchetActivation.requiredGuardNames].sort(),
      [...REQUIRED_REBUILD_RATCHET_NAMES].sort(),
    );
    for (const name of REQUIRED_REBUILD_RATCHET_NAMES) {
      const actual = auditRebuildRatchetArm(name, REPO_ROOT);
      assert.deepEqual(actual.violations, [], `${name} found rebuild violations`);
      if (actual.state === "active") assert.ok(actual.files.length > 0, `${name} active scan is empty`);

      const root = join(tmpdir(), `hrauto-ratchet-${name}-${process.pid}-${Date.now()}`);
      try {
        const fixture = rebuildRatchetFixture(name);
        for (const [path, content] of Object.entries(fixture.files)) writeFixture(root, path, content);
        const result = auditRebuildRatchetArm(name, root);
        assert.equal(result.state, "active", `${name} fixture did not activate its scanner`);
        assert.ok(result.files.length > 0, `${name} fixture resolved no files`);
        assert.match(result.violations.join("\n"), fixture.expected, `${name} fixture bypassed its executable arm`);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });
});
