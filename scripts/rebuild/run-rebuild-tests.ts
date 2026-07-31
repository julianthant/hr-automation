import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { relative, resolve } from "node:path";
import { isDirectExecution, resolveScopeFiles } from "./scope-files.js";

const ROOT = process.cwd();
const SOURCE_ROOT = resolve(ROOT, "temp_src");
const TEST_ROOTS = [
  resolve(ROOT, "tests/rebuild/unit"),
  resolve(ROOT, "tests/rebuild/scenario"),
] as const;

function resolveTestFiles(): string[] {
  const existingRoots = TEST_ROOTS.filter(existsSync);
  if (existingRoots.length === 0) return [];
  return existingRoots.flatMap((root) => {
    const scope = resolveScopeFiles(root, [".ts", ".tsx"]);
    return [...scope.files].filter((file) => file.endsWith(".test.ts") || file.endsWith(".test.tsx"));
  });
}

export function runRebuildTests(withCoverage: boolean): void {
  const source = resolveScopeFiles(SOURCE_ROOT, [".ts", ".tsx"]);
  const testFiles = resolveTestFiles();

  if (source.state === "planned-absent") {
    if (testFiles.length > 0) {
      throw new Error("tests/rebuild is active while temp_src is absent; activate source and tests atomically.");
    }
    console.log(
      `[planned-absent] ${relative(ROOT, SOURCE_ROOT)} is not activated; rebuild tests${withCoverage ? " and coverage" : ""} are inert.`,
    );
    return;
  }
  if (testFiles.length === 0) {
    throw new Error("temp_src is active but tests/rebuild resolved zero test files.");
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
