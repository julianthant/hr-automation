import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";

/**
 * Guard: no inline Playwright selectors outside per-system `selectors.ts`.
 *
 * This test walks every `.ts` file under `src/systems/<name>/` (with some
 * explicit allowlist exceptions) and rejects the common Playwright locator-
 * constructor patterns. New selectors must be added to `selectors.ts` and
 * invoked from callers as `<system>Selectors.group.name(root)`.
 *
 * Patterns checked (on a single line):
 *   - `.locator(` immediately followed by a string literal
 *   - `.getByRole(`
 *   - `.getByLabel(`
 *   - `.getByText(`
 *   - `.getByPlaceholder(`
 *   - `.getByTestId(`
 *   - `.frameLocator(`
 *
 * Allowlist:
 *   - `selectors.ts` in every system (this is where selectors belong)
 *   - `types.ts` and `index.ts` — no selectors expected there
 *   - `common/` directory — shared helpers may wrap locator invocations
 *   - Per-file opt-out: `// allow-inline-selectors` anywhere in the file
 *   - Per-line opt-out: `// allow-inline-selector` at the end of the
 *     offending line
 */

const SYSTEMS_DIR = path.resolve(
  new URL("../../../src/systems", import.meta.url).pathname,
);

const ALLOWED_FILENAMES = new Set(["selectors.ts", "types.ts", "index.ts"]);
const ALLOWED_DIRS = new Set(["common"]);

// Conservative patterns. Aim: catch common Playwright locator constructors
// without false-positiving on DOM queries inside page.evaluate() bodies.
const INLINE_PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: ".locator('...')", re: /\.locator\(\s*["'`]/ },
  { name: ".getByRole(", re: /\.getByRole\(/ },
  { name: ".getByLabel(", re: /\.getByLabel\(/ },
  { name: ".getByText(", re: /\.getByText\(/ },
  { name: ".getByPlaceholder(", re: /\.getByPlaceholder\(/ },
  { name: ".getByTestId(", re: /\.getByTestId\(/ },
  { name: ".frameLocator(", re: /\.frameLocator\(/ },
];

/**
 * Walk a dir recursively, returning all `.ts` files not in ignored locations.
 */
async function findTsFiles(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const out: string[] = [];
  for (const entry of entries) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (ALLOWED_DIRS.has(entry.name)) continue;
      out.push(...(await findTsFiles(p)));
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      if (ALLOWED_FILENAMES.has(entry.name)) continue;
      out.push(p);
    }
  }
  return out;
}

describe("inline-selectors guard", () => {
  it("src/systems/<system>/ files (other than selectors.ts / types.ts / index.ts) contain no inline Playwright selector constructors", async () => {
    const files = await findTsFiles(SYSTEMS_DIR);
    const offenders: Array<{
      file: string;
      line: number;
      match: string;
      pattern: string;
    }> = [];

    for (const file of files) {
      const content = await fs.readFile(file, "utf-8");
      // Per-file opt-out
      if (content.includes("// allow-inline-selectors")) continue;

      const lines = content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        // Per-line opt-out (rare cases like dynamic regex matchers or JS-eval
        // paths that can't reasonably factor to the registry)
        if (line.includes("// allow-inline-selector")) continue;
        // Skip comment-only lines (JSDoc often mentions locator APIs)
        const trimmed = line.trim();
        if (trimmed.startsWith("//")) continue;
        if (trimmed.startsWith("*")) continue;
        if (trimmed.startsWith("/*")) continue;

        for (const pat of INLINE_PATTERNS) {
          if (pat.re.test(line)) {
            offenders.push({
              file: path.relative(process.cwd(), file),
              line: i + 1,
              match: line.trim().slice(0, 140),
              pattern: pat.name,
            });
            break;
          }
        }
      }
    }

    if (offenders.length > 0) {
      const msg = offenders
        .map(
          (o) =>
            `  ${o.file}:${o.line}\n    [${o.pattern}] ${o.match}`,
        )
        .join("\n");
      assert.fail(
        `Found ${offenders.length} inline Playwright selector(s) outside selectors.ts:\n${msg}\n\n` +
          `Fix: move the selector to the per-system selectors.ts registry, or add\n` +
          `  // allow-inline-selector\n` +
          `at the end of the offending line (for rare cases like dynamic regex\n` +
          `matchers or JS-eval paths that can't reasonably factor).`,
      );
    }
  });
});
