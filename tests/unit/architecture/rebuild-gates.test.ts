import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { REBUILD_COVERAGE_FLOORS } from "../../../vitest.config.js";
import {
  resolveRebuildGateActivation,
  resolveRebuildTestFiles,
} from "../../../scripts/rebuild/run-rebuild-tests.js";
import { resolveScopeFiles } from "../../../scripts/rebuild/scope-files.js";
import packageJson from "../../../package.json" with { type: "json" };

describe("non-vacuous rebuild gates", () => {
  it("distinguishes a planned absent root from an active empty root", () => {
    const root = join(tmpdir(), `hrauto-rebuild-gate-${process.pid}-${Date.now()}`);
    try {
      assert.equal(resolveScopeFiles(root, [".ts"]).state, "planned-absent");
      mkdirSync(root, { recursive: true });
      assert.throws(() => resolveScopeFiles(root, [".ts"]), /resolved zero/);
      writeFileSync(join(root, "leaf.ts"), "export const leaf = true;\n");
      const active = resolveScopeFiles(root, [".ts"]);
      assert.equal(active.state, "active");
      assert.equal(active.files.length, 1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps all four lint commands explicit and warnings-fatal for new code", () => {
    assert.match(packageJson.scripts.lint, /--max-warnings 0/);
    assert.match(packageJson.scripts["lint:rebuild"] ?? "", /source --max-warnings 0/);
    assert.match(packageJson.scripts["lint:rebuild-tests"] ?? "", /tests --max-warnings 0/);
    assert.match(packageJson.scripts["lint:legacy-tests-ratchet"] ?? "", /legacy-test-lint-ratchet/);
    assert.doesNotMatch(packageJson.scripts["lint:rebuild"] ?? "", /no-error-on-unmatched-pattern/);
  });

  it("keeps rebuild test and coverage launchers inert only before activation", () => {
    assert.match(packageJson.scripts["test:rebuild"] ?? "", /run-rebuild-tests\.ts/);
    assert.match(packageJson.scripts["test:coverage"] ?? "", /run-rebuild-tests\.ts --coverage/);
    assert.match(packageJson.scripts["test:coverage"] ?? "", /suite-size\.ts/);
    assert.deepEqual(REBUILD_COVERAGE_FLOORS.global, { lines: 60, statements: 60, functions: 60 });
    assert.deepEqual(REBUILD_COVERAGE_FLOORS.safetyCritical, { lines: 80, statements: 80, functions: 80 });
  });

  it("treats tests/rebuild itself as activation and rejects every vacuous or misplaced bypass", () => {
    const fixture = join(tmpdir(), `hrauto-rebuild-tests-${process.pid}-${Date.now()}`);
    const source = join(fixture, "temp_src");
    const tests = join(fixture, "tests/rebuild");
    try {
      assert.deepEqual(resolveRebuildTestFiles(tests), {
        state: "planned-absent",
        root: tests,
        files: [],
      });
      assert.equal(resolveRebuildGateActivation(source, tests).source.state, "planned-absent");

      mkdirSync(tests, { recursive: true });
      assert.throws(() => resolveRebuildGateActivation(source, tests), /resolved zero/);

      writeFileSync(join(tests, "README.txt"), "not a test\n");
      assert.throws(() => resolveRebuildGateActivation(source, tests), /resolved zero/);

      writeFileSync(join(tests, "helper.ts"), "export const helper = true;\n");
      assert.throws(() => resolveRebuildGateActivation(source, tests), /zero runnable/);

      writeFileSync(join(tests, "misplaced.test.ts"), "export {};\n");
      assert.throws(() => resolveRebuildGateActivation(source, tests), /outside unit\/ or scenario/);

      rmSync(tests, { recursive: true, force: true });
      mkdirSync(join(tests, "unit"), { recursive: true });
      writeFileSync(join(tests, "unit/leaf.test.ts"), "export {};\n");
      assert.throws(() => resolveRebuildGateActivation(source, tests), /tests\/rebuild is active while temp_src is absent/);

      rmSync(tests, { recursive: true, force: true });
      mkdirSync(source, { recursive: true });
      writeFileSync(join(source, "leaf.ts"), "export const leaf = true;\n");
      assert.throws(() => resolveRebuildGateActivation(source, tests), /tests\/rebuild is absent/);

      mkdirSync(join(tests, "unit"), { recursive: true });
      writeFileSync(join(tests, "unit/leaf.test.ts"), "export {};\n");
      const active = resolveRebuildGateActivation(source, tests);
      assert.equal(active.source.state, "active");
      assert.equal(active.tests.state, "active");
      assert.equal(active.tests.files.length, 1);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });
});
