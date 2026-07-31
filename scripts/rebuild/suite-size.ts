import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { isDirectExecution, resolveScopeFiles } from "./scope-files.js";

const ROOT = process.cwd();
const FAMILIES = [
  ["rebuild-unit", "tests/rebuild/unit"],
  ["rebuild-scenario", "tests/rebuild/scenario"],
  ["architecture", "tests/unit/architecture"],
] as const;

export interface SuiteSize {
  readonly family: string;
  readonly files: number;
  readonly lines: number;
  readonly state: "active" | "planned-absent";
}

export function measureSuiteSize(): SuiteSize[] {
  return FAMILIES.map(([family, path]) => {
    const root = resolve(ROOT, path);
    if (!existsSync(root)) {
      return { family, files: 0, lines: 0, state: "planned-absent" };
    }
    const scope = resolveScopeFiles(root, [".ts", ".tsx"]);
    const files = scope.files.filter((file) => file.endsWith(".test.ts") || file.endsWith(".test.tsx"));
    return {
      family,
      files: files.length,
      lines: files.reduce((sum, file) => sum + readFileSync(file, "utf8").split("\n").length, 0),
      state: "active",
    };
  });
}

if (isDirectExecution(import.meta.url)) {
  console.log("Rebuild suite size (reviewed at phase exits; not a hard gate):");
  for (const row of measureSuiteSize()) {
    console.log(
      `  ${row.family}: ${row.files} file(s), ${row.lines} line(s) [${row.state}]`,
    );
  }
}
