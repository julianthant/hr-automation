import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

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
  return relative(ROOT, path);
}

/** Kebab-case file stem + .ts / .tsx (no uppercase). */
const KEBAB_TS = /^[a-z0-9][a-z0-9.-]*\.(ts|tsx)$/;

/** Dashboard: PascalCase component modules. */
const DASHBOARD_PASCAL_TSX = /^[A-Z][a-zA-Z0-9]*\.tsx$/;

/** Dashboard: useThing hook modules. */
const DASHBOARD_HOOK = /^use[A-Z][a-zA-Z0-9]*\.(ts|tsx)$/;

function isAllowedDashboardBasename(basename: string): boolean {
  return (
    KEBAB_TS.test(basename) ||
    DASHBOARD_PASCAL_TSX.test(basename) ||
    DASHBOARD_HOOK.test(basename)
  );
}

describe("codebase conventions", () => {
  it("does not add default exports in src", () => {
    const violations = walk(SRC)
      .filter((file) => !rel(file).startsWith("src/dashboard/"))
      .filter((file) => /\bexport\s+default\b/.test(readFileSync(file, "utf8")))
      .map(rel)
      .sort();
    assert.deepEqual(violations, []);
  });

  it("does not call process.removeAllListeners for SIGINT or SIGTERM", () => {
    const violations = walk(SRC)
      .filter((file) => /removeAllListeners\(["']SIG(INT|TERM)["']\)/.test(readFileSync(file, "utf8")))
      .map(rel)
      .sort();
    assert.deepEqual(violations, []);
  });

  it("keeps production console logging behind the shared logger or explicit CLI/scripts", () => {
    const allowed = [
      "src/utils/log.ts",
      "src/cli.ts",
      "src/cli-daemon.ts",
      "src/scripts/",
      "/scripts/",
      // Browser-side React SPA — log.* uses Node AsyncLocalStorage and is unavailable
      // in the browser. console.warn/error are the correct idiom for client-side diagnostics.
      "src/dashboard/",
    ];
    const violations = walk(SRC)
      .filter((file) => {
        const path = rel(file);
        return !allowed.some((prefix) => path.startsWith(prefix) || path.includes(prefix) || path === prefix);
      })
      .filter((file) => /\bconsole\.(log|warn|error|info|debug)\s*\(/.test(readFileSync(file, "utf8")))
      .map(rel)
      .sort();
    assert.deepEqual(violations, []);
  });

  it("keeps src filenames aligned with naming rules (kebab-case outside dashboard; React patterns inside dashboard)", () => {
    const violations: string[] = [];
    for (const file of walk(SRC)) {
      const path = rel(file);
      const basename = path.split("/").pop() ?? "";
      const inDashboard = path.startsWith("src/dashboard/");
      if (inDashboard) {
        if (!isAllowedDashboardBasename(basename)) {
          violations.push(`${path} — use PascalCase.tsx, useHook.ts, or kebab-case`);
        }
      } else if (!KEBAB_TS.test(basename)) {
        violations.push(`${path} — use kebab-case only under src/ (not inside src/dashboard/)`);
      }
    }
    assert.deepEqual(violations.sort(), []);
  });
});
