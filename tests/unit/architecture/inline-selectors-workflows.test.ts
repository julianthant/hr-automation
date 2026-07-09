import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * Guard: extends `tests/unit/systems/inline-selectors.test.ts`'s rule (no
 * inline Playwright locator constructors — selectors belong in a per-system
 * `selectors.ts` registry, per root CLAUDE.md's "No page.locator(...) inline
 * in system files") to `src/workflows/**`.
 *
 * A workflow file that reaches for `page.getByRole(...)` / `frame.locator(
 * "...")` etc. directly, instead of calling a registry helper from the
 * relevant system's `selectors.ts`, loses the registry's benefits: no JSDoc
 * + `// verified <date>` provenance, invisible to `npm run selector:search`,
 * and no single place to fix when the UI changes. It is a maintainability
 * gap, not a data-correctness one (a bad selector throws — it does not
 * silently substitute wrong data) — see this file's allowlist for the
 * pre-existing cases and why they aren't treated as fail-loud bugs.
 *
 * This is a RATCHET over the current tree (per-file count), seeded after
 * `src/workflows/person-lookup/**` was migrated to call system registries
 * directly (no violations remain there). New inline selectors in
 * src/workflows/** fail the guard immediately.
 */

const ROOT = process.cwd();
const WORKFLOWS_DIR = join(ROOT, "src", "workflows");

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) out.push(...walk(full));
    else if (full.endsWith(".ts")) out.push(full);
  }
  return out;
}

function rel(path: string): string {
  return relative(ROOT, path);
}

// Same conservative pattern set as tests/unit/systems/inline-selectors.test.ts.
const INLINE_PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: ".locator('...')", re: /\.locator\(\s*["'`]/ },
  { name: ".getByRole(", re: /\.getByRole\(/ },
  { name: ".getByLabel(", re: /\.getByLabel\(/ },
  { name: ".getByText(", re: /\.getByText\(/ },
  { name: ".getByPlaceholder(", re: /\.getByPlaceholder\(/ },
  { name: ".getByTestId(", re: /\.getByTestId\(/ },
  { name: ".frameLocator(", re: /\.frameLocator\(/ },
];

/** file (relative to repo root) -> { count, reason } */
const ALLOWLIST: Record<string, { count: number; reason: string }> = {
  },
};

function countInlineSelectors(content: string): number {
  if (content.includes("// allow-inline-selectors")) return 0;
  let n = 0;
  for (const line of content.split("\n")) {
    if (line.includes("// allow-inline-selector")) continue;
    const t = line.trim();
    if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) continue;
    if (INLINE_PATTERNS.some((p) => p.re.test(line))) n++;
  }
  return n;
}

const FIX_GUIDANCE =
  "Root CLAUDE.md codebase conventions: 'No page.locator(...) inline in " +
  "system files' — the same rule now applies to src/workflows/**. Fix: move " +
  "the selector into the owning system's src/<system>/selectors.ts (JSDoc + " +
  "`// verified <date>`, per src/systems/CLAUDE.md), run `npm run " +
  "selectors:catalog`, and call it as `<system>Selectors.group.name(root)` " +
  "from the workflow. If it's a genuinely one-off, non-promotable locator " +
  "(e.g. matching a value the run itself generated), add/adjust its " +
  "{ count, reason } entry in the ALLOWLIST here, or mark the specific line " +
  "`// allow-inline-selector`.";

describe("inline-selectors guard: src/workflows/**", () => {
  it("src/workflows/** files contain no new unallowlisted inline Playwright selector constructors", () => {
    const found = new Map<string, number>();
    for (const file of walk(WORKFLOWS_DIR)) {
      const content = readFileSync(file, "utf8");
      const n = countInlineSelectors(content);
      if (n > 0) found.set(rel(file), n);
    }

    const violations: string[] = [];
    for (const [file, n] of found) {
      const entry = ALLOWLIST[file];
      if (!entry) {
        violations.push(`${file}: ${n} unallowlisted inline selector(s) — new inline Playwright selector introduced outside the allowlist.`);
        continue;
      }
      if (entry.count !== n) {
        violations.push(
          `${file}: allowlisted for ${entry.count} inline selector(s) but found ${n} — update the ALLOWLIST count (and reason, if the shape changed).`,
        );
      }
    }
    for (const file of Object.keys(ALLOWLIST)) {
      if (!found.has(file)) {
        violations.push(`${file}: allowlisted for ${ALLOWLIST[file].count} inline selector(s) but none found anymore — remove the stale entry.`);
      }
    }

    assert.deepEqual(violations, [], `\n${FIX_GUIDANCE}\n\n${violations.join("\n")}`);
  });
});
