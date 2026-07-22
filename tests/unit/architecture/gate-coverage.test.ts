import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Gate-coverage guard (2026-07-17). The dashboard spent months excluded from
 * every type gate: root tsconfig excludes `src/dashboard`, and `typecheck:all`
 * was byte-identical to `typecheck`, so the "full" gate never checked the
 * frontend (100 errors accumulated invisibly while Vite's type-blind build
 * stayed green). Same story for lint: warnings were reported but never failed
 * the gate, so 375 piled up.
 *
 * This pins the shape of the gates themselves:
 *   1. `typecheck:all` runs BOTH tsc programs (backend root + the dashboard
 *      project) — anyone simplifying the script back to one `tsc --noEmit`
 *      silently un-gates the frontend again.
 *   2. `lint` fails on warnings (`--max-warnings 0`) — the burn-down stays
 *      burned down.
 *   3. The dashboard tsconfig the composite gate points at actually exists.
 *
 * Extended 2026-07-20 (rebuild slice 1a-1) with the `temp_src` umbrella facts.
 * The charter's non-negotiable is "Same quality umbrella from day one … No
 * ungated parallel tree" (docs/rebuild/00-charter.md:118-119): the rebuild tree
 * must sit inside the SAME tsconfig program, the SAME lint root, and the SAME
 * architecture suite as `src`. Each of those wirings is one line that a future
 * edit could quietly drop, so each is pinned here.
 */

const root = join(import.meta.dirname, "..", "..", "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
  scripts: Record<string, string>;
};
const tsconfigText = readFileSync(join(root, "tsconfig.json"), "utf8");
const eslintConfigText = readFileSync(join(root, "eslint.config.js"), "utf8");
const gitignoreText = readFileSync(join(root, ".gitignore"), "utf8");

describe("gate coverage", () => {
  it("typecheck:all composes the backend AND dashboard tsc programs", () => {
    const script = pkg.scripts["typecheck:all"];
    assert.ok(script, "package.json must keep a typecheck:all script");
    assert.match(script, /tsc --noEmit/, "typecheck:all must run the backend program");
    assert.match(
      script,
      /-p src\/dashboard\/tsconfig\.json/,
      "typecheck:all must also run the dashboard project — the root tsconfig excludes src/dashboard, so dropping this silently un-gates the frontend",
    );
  });

  it("typecheck:dashboard targets the dashboard project", () => {
    assert.match(
      pkg.scripts["typecheck:dashboard"] ?? "",
      /-p src\/dashboard\/tsconfig\.json/,
      "typecheck:dashboard must run tsc against src/dashboard/tsconfig.json",
    );
  });

  it("the dashboard tsconfig the gates point at exists", () => {
    assert.ok(existsSync(join(root, "src", "dashboard", "tsconfig.json")));
  });

  it("lint fails on warnings — the zero-warning ratchet stays ratcheted", () => {
    assert.match(
      pkg.scripts.lint ?? "",
      /--max-warnings 0/,
      "npm run lint must carry --max-warnings 0; without it new warnings accumulate invisibly",
    );
  });

  it("the root tsconfig type-gates temp_src", () => {
    const include = /"include"\s*:\s*\[([^\]]*)\]/.exec(tsconfigText)?.[1];
    assert.ok(include, "tsconfig.json must keep an include array");
    assert.match(
      include,
      /temp_src/,
      'tsconfig.json "include" must list temp_src — the rebuild tree lives in the SAME tsc program as src (charter: no ungated parallel tree)',
    );
  });

  it("lint covers temp_src, and cannot silently cover nothing", () => {
    const lint = pkg.scripts.lint ?? "";
    assert.match(
      lint,
      /\btemp_src\b/,
      "npm run lint must pass temp_src as a lint root; otherwise the rebuild tree is unlinted",
    );
    assert.doesNotMatch(
      lint,
      /--no-error-on-unmatched-pattern/,
      "lint must NOT carry --no-error-on-unmatched-pattern: eslint exits 2 on an empty/missing pattern, and that non-zero exit is exactly what proves the temp_src root still matches files. Suppressing it would make 'lint covered nothing' green forever",
    );
    assert.match(
      pkg.scripts["lint:fix"] ?? "",
      /\btemp_src\b/,
      "lint:fix must use the same roots as lint, or --fix silently skips the rebuild tree",
    );
  });

  it("test:architecture stays a DIRECTORY glob — new guards are picked up automatically", () => {
    const script = pkg.scripts["test:architecture"] ?? "";
    assert.match(
      script,
      /tests\/unit\/architecture(?![\w/.-])/,
      "test:architecture must point at the tests/unit/architecture DIRECTORY",
    );
    assert.doesNotMatch(
      script,
      /tests\/unit\/architecture\/[\w-]+\.test\.ts/,
      "test:architecture must not degrade into a hand-listed set of guard files — a directory glob is what stops the suite silently shrinking when a guard is added or renamed",
    );
  });

  it("temp_src is tracked, not gitignored", () => {
    assert.doesNotMatch(
      gitignoreText,
      /^\s*!?\/?temp_src\b/m,
      ".gitignore must not mention temp_src — an ignored rebuild tree would be invisible to review and to every gate that walks tracked files",
    );
  });

  it("the eslint back-end block covers temp_src", () => {
    const backEndBlock = /files:\s*\[[^\]]*"src\/\*\*\/\*\.ts"[^\]]*\]/.exec(eslintConfigText)?.[0];
    assert.ok(
      backEndBlock,
      'eslint.config.js must keep a back-end block scoped with files: ["src/**/*.ts", ...]',
    );
    assert.match(
      backEndBlock,
      /temp_src/,
      "the eslint back-end block must also match temp_src/**/*.ts — without it temp_src files fall back to the base presets only (no unused-imports rule, no Node globals, no type-aware tuning): a tree that looks linted but isn't",
    );
  });
});
