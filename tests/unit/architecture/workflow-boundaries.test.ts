import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, normalize, relative, resolve } from "node:path";

const ROOT = process.cwd();
const SRC = join(ROOT, "src");

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) out.push(...walk(full));
    else if (entry.endsWith(".ts") || entry.endsWith(".tsx")) out.push(full);
  }
  return out;
}

function workflowName(absPath: string): string | null {
  const rel = normalize(relative(ROOT, absPath));
  const match = rel.match(/^src\/workflows\/([^/]+)\//);
  return match?.[1] ?? null;
}

function resolveRelativeImport(fromFile: string, spec: string): string | null {
  if (!spec.startsWith(".")) return null;
  const base = resolve(dirname(fromFile), spec);
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    join(base, "index.ts"),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

function isAllowedWorkflowEntrypoint(target: string): boolean {
  const rel = normalize(relative(ROOT, target));
  return /^src\/workflows\/[^/]+\/(index|workflow)\.ts$/.test(rel);
}

describe("workflow boundary ownership", () => {
  it("does not import workflow-owned internal helpers across workflow boundaries", () => {
    const violations: string[] = [];
    for (const file of walk(SRC)) {
      const source = readFileSync(file, "utf8");
      const importerWorkflow = workflowName(file);
      const importRegex = /from\s+["']([^"']+)["']/g;
      for (const match of source.matchAll(importRegex)) {
        const target = resolveRelativeImport(file, match[1]);
        if (!target) continue;
        const targetWorkflow = workflowName(target);
        if (!targetWorkflow) continue;
        if (isAllowedWorkflowEntrypoint(target)) continue;
        if (importerWorkflow === targetWorkflow) continue;
        violations.push(`${relative(ROOT, file)} imports ${relative(ROOT, target)}`);
      }
    }
    assert.deepEqual(violations.sort(), []);
  });
});
