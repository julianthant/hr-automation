import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { relative, resolve } from "node:path";
import { isDirectExecution, resolveScopeFiles } from "./scope-files.js";

const ROOT = process.cwd();
const SOURCE_ROOT = resolve(ROOT, "temp_src");
const TEST_ROOT = resolve(ROOT, "tests/rebuild");

export type RebuildTestScope =
  | { readonly state: "planned-absent"; readonly root: string; readonly files: readonly [] }
  | { readonly state: "active"; readonly root: string; readonly files: readonly string[] };

/**
 * `tests/rebuild` itself is the activation boundary. Once that directory
 * exists it must contain at least one runnable test under the unit/scenario
 * projects; an empty tree, helper-only tree, or misplaced test is never green.
 */
export function resolveRebuildTestFiles(testRoot: string): RebuildTestScope {
  if (!existsSync(testRoot)) return { state: "planned-absent", root: testRoot, files: [] };

  const scope = resolveScopeFiles(testRoot, [".ts", ".tsx"]);
  assertActiveScope(scope);
  const testFiles = scope.files.filter((file) => file.endsWith(".test.ts") || file.endsWith(".test.tsx"));
  const misplaced = testFiles.filter((file) => {
    const path = relative(testRoot, file).replaceAll("\\", "/");
    return !path.startsWith("unit/") && !path.startsWith("scenario/");
  });
  if (misplaced.length > 0) {
    throw new Error(
      `tests/rebuild contains test file(s) outside unit/ or scenario/: ${misplaced.map((file) => relative(testRoot, file)).join(", ")}`,
    );
  }
  if (testFiles.length === 0) {
    throw new Error("Active tests/rebuild resolved zero runnable *.test.ts(x) files.");
  }
  return { state: "active", root: testRoot, files: testFiles };
}

function assertActiveScope(
  scope: ReturnType<typeof resolveScopeFiles>,
): asserts scope is Extract<ReturnType<typeof resolveScopeFiles>, { state: "active" }> {
  if (scope.state !== "active") throw new Error("tests/rebuild activation state was lost.");
}

export function resolveRebuildGateActivation(
  sourceRoot: string,
  testRoot: string,
): {
  readonly source: ReturnType<typeof resolveScopeFiles>;
  readonly tests: RebuildTestScope;
} {
  const source = resolveScopeFiles(sourceRoot, [".ts", ".tsx"]);
  const tests = resolveRebuildTestFiles(testRoot);

  if (source.state === "planned-absent" && tests.state === "active") {
    throw new Error("tests/rebuild is active while temp_src is absent; activate source and tests atomically.");
  }
  if (source.state === "active" && tests.state === "planned-absent") {
    throw new Error("temp_src is active while tests/rebuild is absent; activate source and tests atomically.");
  }
  return { source, tests };
}

export function runRebuildTests(withCoverage: boolean): void {
  const activation = resolveRebuildGateActivation(SOURCE_ROOT, TEST_ROOT);

  if (activation.source.state === "planned-absent") {
    console.log(
      `[planned-absent] ${relative(ROOT, SOURCE_ROOT)} is not activated; rebuild tests${withCoverage ? " and coverage" : ""} are inert.`,
    );
    return;
  }

  const vitest = resolve(ROOT, "node_modules/.bin/vitest");
  const args = [
    "run",
    "--project",
    "rebuild-unit",
    "--project",
    "rebuild-scenario",
    "--reporter=dot",
  ];
  if (withCoverage) args.push("--coverage");
  const result = spawnSync(vitest, args, { cwd: ROOT, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Rebuild Vitest lane exited with status ${String(result.status)}.`);
  }
}

if (isDirectExecution(import.meta.url)) {
  runRebuildTests(process.argv.includes("--coverage"));
}
