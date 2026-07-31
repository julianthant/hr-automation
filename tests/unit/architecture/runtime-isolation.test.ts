import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import assert from "node:assert/strict";
import { describe, it } from "vitest";
import isolation from "../../../config/rebuild/runtime-isolation.json" with { type: "json" };
import { REPO_ROOT, repoRelative, walkFiles } from "./helpers/guard-files.js";

const packageJson = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as {
  scripts: Record<string, string>;
};

function importSpecs(source: string): string[] {
  return [...source.matchAll(/(?:import|export)\s+(?:type\s+)?[^"']*?from\s*["']([^"']+)["']|import\s*["']([^"']+)["']/g)]
    .map((match) => match[1] ?? match[2])
    .filter((specifier): specifier is string => specifier !== undefined);
}

describe("D88 runtime isolation", () => {
  it("pins distinct exact runtime resources", () => {
    assert.deepEqual(isolation.legacy, {
      sourceRoot: "src",
      entrypoint: "src/cli.ts",
      commands: ["dashboard", "dashboard:prod", "dashboard:watch"],
      stateRoot: ".tracker",
      artifactRoot: ".tracker",
      backendPort: 3838,
      frontendPort: 5173,
      processLockRoot: ".tracker/daemons",
      browserProfileRoot: ".auth",
      browserSessionNamespace: "hrauto-legacy",
    });
    assert.deepEqual(isolation.rebuild, {
      sourceRoot: "temp_src",
      entrypoint: "temp_src/cli.ts",
      commands: ["rebuild:dashboard", "rebuild:dashboard:prod", "rebuild:cli"],
      stateRoot: ".tracker-rebuild",
      artifactRoot: ".tracker-rebuild/artifacts",
      backendPort: 3938,
      frontendPort: 5174,
      processLockRoot: ".tracker-rebuild/locks",
      browserProfileRoot: ".auth-rebuild",
      browserSessionNamespace: "hrauto-rebuild",
    });

    for (const key of ["stateRoot", "artifactRoot", "processLockRoot", "browserProfileRoot", "browserSessionNamespace"] as const) {
      assert.notEqual(isolation.legacy[key], isolation.rebuild[key], `${key} must differ`);
    }
    assert.notEqual(isolation.legacy.backendPort, isolation.rebuild.backendPort);
    assert.notEqual(isolation.legacy.frontendPort, isolation.rebuild.frontendPort);
    assert.deepEqual(
      isolation.legacy.commands.filter((command) => isolation.rebuild.commands.includes(command)),
      [],
    );
  });

  it("keeps cross-tree runtime imports absent in both directions", () => {
    for (const file of walkFiles(join(REPO_ROOT, isolation.legacy.sourceRoot))) {
      const specs = importSpecs(readFileSync(file, "utf8"));
      assert.deepEqual(
        specs.filter((specifier) => specifier.includes("temp_src")),
        [],
        `${repoRelative(file)} imports the rebuild tree`,
      );
    }

    const rebuildRoot = join(REPO_ROOT, isolation.rebuild.sourceRoot);
    if (!existsSync(rebuildRoot)) return;
    for (const file of walkFiles(rebuildRoot)) {
      const crossings = importSpecs(readFileSync(file, "utf8")).filter((specifier) => {
        if (!specifier.startsWith(".")) return specifier === "src" || specifier.startsWith("src/");
        const target = resolve(dirname(file), specifier.replace(/\.js$/, ""));
        return target === join(REPO_ROOT, "src") || target.startsWith(`${join(REPO_ROOT, "src")}/`);
      });
      assert.deepEqual(crossings, [], `${repoRelative(file)} imports the legacy tree`);
    }
  });

  it("treats the missing rebuild entrypoint as planned, then requires exact commands on activation", () => {
    const rebuildRoot = join(REPO_ROOT, isolation.rebuild.sourceRoot);
    if (!existsSync(rebuildRoot)) {
      assert.equal(isolation.phase, "pre-tree");
      assert.equal(existsSync(join(REPO_ROOT, isolation.rebuild.entrypoint)), false);
      for (const command of isolation.rebuild.commands) assert.equal(packageJson.scripts[command], undefined);
      return;
    }
    assert.ok(existsSync(join(REPO_ROOT, isolation.rebuild.entrypoint)));
    for (const command of isolation.rebuild.commands) {
      assert.match(packageJson.scripts[command] ?? "", /temp_src/);
    }
  });
});
