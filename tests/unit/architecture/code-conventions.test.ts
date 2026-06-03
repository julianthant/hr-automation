import { describe, it } from "vitest";
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
      // render-pages.ts monkey-patches console.warn to suppress noisy pdfjs "Indexing all
      // PDF objects" warnings — this is intentional and tested in ocr/orchestrator.test.ts.
      "src/services/ocr/render-pages.ts",
    ];
    // Broadened from (log|warn|error|info|debug) to \w+ to catch all console methods:
    // table/dir/trace/group/time/count/assert/clear/groupCollapsed/groupEnd, etc.
    const violations = walk(SRC)
      .filter((file) => {
        const path = rel(file);
        return !allowed.some((prefix) => path.startsWith(prefix) || path.includes(prefix) || path === prefix);
      })
      .filter((file) => /\bconsole\.\w+/.test(readFileSync(file, "utf8")))
      // Exclude comment-only mentions (JSDoc / inline comments describing the allowed paths).
      // The regex above is intentionally broad — filter out comment-only occurrences to avoid
      // false positives from doc comments that reference console methods by name.
      .filter((file) => {
        const content = readFileSync(file, "utf8");
        // Strip both block comments (/** */ / /* */) and single-line (//) comments,
        // then check for live console usage in the remaining code.
        const withoutComments = content
          .replace(/\/\*[\s\S]*?\*\//g, "")
          .replace(/\/\/[^\n]*/g, "");
        return /\bconsole\.\w+/.test(withoutComments);
      })
      .map(rel)
      .sort();
    assert.deepEqual(violations, []);
  });

  it("does not place .tsx files outside src/dashboard/", () => {
    // .tsx is React/JSX syntax — it must only appear under src/dashboard/.
    // Anything outside the dashboard that uses JSX should be refactored to .ts.
    const violations = walk(SRC)
      .filter((file) => !rel(file).startsWith("src/dashboard/"))
      .filter((file) => file.endsWith(".tsx"))
      .map(rel)
      .sort();
    assert.deepEqual(violations, [], "found .tsx files outside src/dashboard/");
  });

  it("does not place AGENTS.md files under src/", () => {
    // Global convention: AGENTS.md files are generated session artifacts for Codex and
    // must never appear under src/. Documentation belongs in the corresponding CLAUDE.md.
    // (The root AGENTS.md is an allowed session artifact — this check is scoped to src/ only.)
    // Re-use the walk() helper but also check directory entries for markdown files:
    function findAgentsMd(dir: string): string[] {
      const results: string[] = [];
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        const stat = statSync(full);
        if (stat.isDirectory()) {
          results.push(...findAgentsMd(full));
        } else if (entry.toLowerCase() === "agents.md") {
          results.push(full);
        }
      }
      return results;
    }
    const violations = findAgentsMd(SRC).map(rel).sort();
    assert.deepEqual(violations, [], "found AGENTS.md files under src/");
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
