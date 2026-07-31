import { relative, resolve } from "node:path";
import { ESLint } from "eslint";
import { isDirectExecution, resolveScopeFiles } from "./scope-files.js";

const ROOT = process.cwd();

export type RebuildLintScope = "source" | "tests";

export async function lintRebuildScope(scope: RebuildLintScope): Promise<void> {
  const root = resolve(ROOT, scope === "source" ? "temp_src" : "tests/rebuild");
  const resolved = resolveScopeFiles(root, [".ts", ".tsx"]);
  if (resolved.state === "planned-absent") {
    console.log(
      `[planned-absent] ${relative(ROOT, root)} is not activated; no rebuild lint target exists yet.`,
    );
    return;
  }

  if (!process.argv.includes("--max-warnings") || !process.argv.includes("0")) {
    throw new Error("Rebuild lint must be invoked with --max-warnings 0.");
  }

  const eslint = new ESLint();
  const results = await eslint.lintFiles([...resolved.files]);
  const formatter = await eslint.loadFormatter("stylish");
  const output = await formatter.format(results);
  if (output) process.stdout.write(output);

  const errors = results.reduce((sum, result) => sum + result.errorCount, 0);
  const warnings = results.reduce((sum, result) => sum + result.warningCount, 0);
  if (errors > 0 || warnings > 0) {
    throw new Error(
      `${scope} rebuild lint failed: ${errors} error(s), ${warnings} warning(s).`,
    );
  }
  console.log(
    `[active] linted ${resolved.files.length} ${scope} rebuild file(s) with zero diagnostics.`,
  );
}

if (isDirectExecution(import.meta.url)) {
  const scope = process.argv[2];
  if (scope !== "source" && scope !== "tests") {
    throw new Error("Usage: tsx scripts/rebuild/lint-scope.ts <source|tests> --max-warnings 0");
  }
  await lintRebuildScope(scope);
}
