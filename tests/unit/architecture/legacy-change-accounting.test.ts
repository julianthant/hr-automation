import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import assert from "node:assert/strict";
import { describe, it } from "vitest";
import accounting from "../../../config/rebuild/legacy-change-accounting.json" with { type: "json" };
import capabilities from "../../../config/rebuild/legacy-capabilities.json" with { type: "json" };
import preservation from "../../../config/rebuild/legacy-preservation.json" with { type: "json" };
import { REPO_ROOT } from "./helpers/guard-files.js";

interface ChangeRecord {
  readonly path: string;
  readonly beforeSha256: string | null;
  readonly afterSha256: string;
  readonly capabilityIds: readonly string[];
  readonly rebuildRecheckIds: readonly string[];
  readonly preservation: string;
}

function hash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function currentFiles(root: string): string[] {
  const files: string[] = [];
  function walk(directory: string): void {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) files.push(relative(REPO_ROOT, path).replaceAll("\\", "/"));
    }
  }
  walk(join(REPO_ROOT, root));
  return files;
}

function baselineBytes(path: string): Buffer {
  return execFileSync("git", ["show", `${accounting.baselineCommit}:${path}`], { cwd: REPO_ROOT });
}

function changedPaths(): Map<string, { before: string | null; after: string }> {
  const baseline = new Set(preservation.roots.flatMap(({ files }) => files));
  const current = [...preservation.roots.flatMap(({ root }) => currentFiles(root))].sort();
  const modified = new Set(
    execFileSync(
      "git",
      ["diff", "--name-only", accounting.baselineCommit, "--", "src", "tests"],
      { cwd: REPO_ROOT, encoding: "utf8" },
    ).trim().split("\n").filter((path) => path.length > 0 && baseline.has(path)),
  );
  const changes = new Map<string, { before: string | null; after: string }>();
  for (const path of current) {
    const added = !baseline.has(path);
    if (!added && !modified.has(path)) continue;
    const after = hash(readFileSync(join(REPO_ROOT, path)));
    const before = added ? null : hash(baselineBytes(path));
    changes.set(path, { before, after });
  }
  return changes;
}

describe("D90 legacy change accounting", () => {
  it("accounts from the explicit Phase-0 base rather than git diff HEAD", () => {
    assert.equal(accounting.baselineCommit, preservation.baselineCommit);
    assert.match(accounting.baselineCommit, /^[a-f0-9]{40}$/);

    const changes = changedPaths();
    const records: readonly ChangeRecord[] = accounting.records;
    const recordedPaths = records.map(({ path }) => path);
    assert.equal(new Set(recordedPaths).size, recordedPaths.length, "change paths must be unique");
    assert.deepEqual(recordedPaths.sort(), [...changes.keys()].sort());

    const capabilityIds = new Set(capabilities.entries.map(({ id }) => id));
    for (const record of records) {
      const actual = changes.get(record.path);
      assert.ok(actual, `stale change record: ${record.path}`);
      assert.equal(record.beforeSha256, actual.before, `${record.path}: before hash`);
      assert.equal(record.afterSha256, actual.after, `${record.path}: after hash`);
      assert.ok(record.capabilityIds.length > 0, `${record.path}: affected capability`);
      assert.ok(record.rebuildRecheckIds.length > 0, `${record.path}: rebuild recheck`);
      assert.equal(record.preservation, "preserved");
      for (const id of record.capabilityIds) assert.ok(capabilityIds.has(id), `${record.path}: ${id}`);
    }
  });
});
