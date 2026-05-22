import { describe, it } from "node:test";
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

function rel(path: string): string {
  return normalize(relative(ROOT, path));
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

function importSpecs(source: string): string[] {
  const specs: string[] = [];
  const importRegex = /from\s+["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g;
  for (const match of source.matchAll(importRegex)) {
    specs.push(match[1] ?? match[2]);
  }
  return specs;
}

function isTrackerHttpAdapter(path: string): boolean {
  return /^src\/tracker\/dashboard\/hono\/routes\/(ocr|ops|daemon-stop)\.ts$/.test(path);
}

describe("control module layering", () => {
  it("does not leave workflow action or ops handlers under tracker/dashboard", () => {
    const legacyDirs = [
      "src/tracker/dashboard/actions",
      "src/tracker/dashboard/ops",
    ].filter((path) => existsSync(join(ROOT, path)));
    assert.deepEqual(legacyDirs, []);
  });

  it("keeps src/control above core/tracker with tracker HTTP adapters as the only inward callers", () => {
    const violations: string[] = [];
    for (const file of walk(SRC)) {
      const source = readFileSync(file, "utf8");
      const importer = rel(file);
      for (const spec of importSpecs(source)) {
        const target = resolveRelativeImport(file, spec);
        if (!target) continue;
        const imported = rel(target);

        if (
          imported.startsWith("src/control/") &&
          !importer.startsWith("src/control/") &&
          !isTrackerHttpAdapter(importer)
        ) {
          violations.push(`${importer} imports ${imported}`);
        }

        if (
          importer.startsWith("src/control/") &&
          (imported.startsWith("src/dashboard/") || imported.startsWith("src/tracker/dashboard/hono/"))
        ) {
          violations.push(`${importer} imports UI/HTTP adapter ${imported}`);
        }

        if (importer.startsWith("src/core/") && imported.startsWith("src/control/")) {
          violations.push(`${importer} imports ${imported}`);
        }
      }
    }
    assert.deepEqual(violations.sort(), []);
  });
});
