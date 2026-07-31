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
 */

const root = join(import.meta.dirname, "..", "..", "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
  scripts: Record<string, string>;
};
const eslintConfig = readFileSync(join(root, "eslint.config.js"), "utf8");

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

  it("keeps the four coexistence lint gates wired to their exact debt policies", () => {
    assert.match(pkg.scripts.lint ?? "", /eslint src scripts\/rebuild --max-warnings 0/);
    assert.match(pkg.scripts["lint:rebuild"] ?? "", /lint-scope\.ts source --max-warnings 0/);
    assert.match(pkg.scripts["lint:rebuild-tests"] ?? "", /lint-scope\.ts tests --max-warnings 0/);
    assert.match(pkg.scripts["lint:legacy-tests-ratchet"] ?? "", /legacy-test-lint-ratchet\.ts/);
    assert.doesNotMatch(Object.values(pkg.scripts).join("\n"), /--no-error-on-unmatched-pattern/);
  });

  it("keeps ESLint config coverage ready for both rebuild runtime environments", () => {
    assert.match(eslintConfig, /files:\s*\["temp_src\/\*\*\/\*\.ts"\]/);
    assert.match(eslintConfig, /temp_src\/dashboard\/\*\*\/\*\.tsx/);
    assert.match(eslintConfig, /files:\s*\["scripts\/rebuild\/\*\*\/\*\.ts"\]/);
  });

  it("keeps rebuild test and coverage gates registered", () => {
    assert.match(pkg.scripts["test:rebuild"] ?? "", /run-rebuild-tests\.ts/);
    assert.match(pkg.scripts["test:coverage"] ?? "", /run-rebuild-tests\.ts --coverage/);
    assert.match(pkg.scripts["test:coverage"] ?? "", /suite-size\.ts/);
  });
});
