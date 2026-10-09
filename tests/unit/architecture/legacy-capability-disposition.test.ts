import { existsSync } from "node:fs";
import { join } from "node:path";
import assert from "node:assert/strict";
import { describe, it } from "vitest";
import inventory from "../../../config/rebuild/legacy-capabilities.json" with { type: "json" };
import { gitVisibleFiles, REPO_ROOT } from "./helpers/guard-files.js";

function childDirectories(path: string): string[] {
  const prefix = `${path}/`;
  return [...new Set(gitVisibleFiles([path]).flatMap((file) => {
    const relativePath = file.slice(prefix.length);
    return relativePath.includes("/") ? [`${path}/${relativePath.split("/")[0]}`] : [];
  }))].sort();
}

function directTsFiles(path: string): string[] {
  const prefix = `${path}/`;
  return gitVisibleFiles([path]).filter((file) => {
    const name = file.slice(prefix.length);
    return !name.includes("/") && name.endsWith(".ts") && name !== "index.ts";
  });
}

function discoveredCapabilityPaths(): string[] {
  return [
    ...childDirectories("src/workflows"),
    ...childDirectories("src/services"),
    ...directTsFiles("src/tracker/dashboard/hono/routes"),
    ...childDirectories("src/dashboard/components"),
    "src/cli.ts",
    "src/cli-daemon.ts",
    ...gitVisibleFiles(["src/scripts"]).filter((file) => file.endsWith(".ts")),
    ...directTsFiles("src/tracker/exports"),
    "tests/unit/architecture",
  ].sort();
}

describe("D58 legacy capability disposition", () => {
  it("covers every reviewed capability surface exactly once", () => {
    const owned = inventory.entries.flatMap(({ sourcePaths }) => sourcePaths).sort();
    assert.equal(new Set(owned).size, owned.length, "a legacy capability path is owned more than once");
    assert.deepEqual(owned, discoveredCapabilityPaths());
  });

  it("keeps entries strict, evidenced, and proxy-free", () => {
    const ids = inventory.entries.map(({ id }) => id);
    assert.equal(new Set(ids).size, ids.length, "capability ids must be unique");
    assert.equal(inventory.proxyDispositionAllowed, false);
    for (const entry of inventory.entries) {
      assert.ok(entry.knownConsumers.length > 0, `${entry.id}: knownConsumers`);
      assert.ok(entry.ownerMilestone.trim(), `${entry.id}: ownerMilestone`);
      assert.ok(entry.verificationEvidence.length > 0, `${entry.id}: verificationEvidence`);
      assert.notEqual(entry.disposition.kind, "proxy", `${entry.id}: proxy is forbidden`);
      for (const path of entry.sourcePaths) assert.ok(existsSync(join(REPO_ROOT, path)), path);
    }
  });
});
