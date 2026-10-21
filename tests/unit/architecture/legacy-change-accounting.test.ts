import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { describe, it } from "vitest";
import accounting from "../../../config/rebuild/legacy-change-accounting.json" with { type: "json" };
import capabilities from "../../../config/rebuild/legacy-capabilities.json" with { type: "json" };
import preservation from "../../../config/rebuild/legacy-preservation.json" with { type: "json" };

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

function currentFiles(repoRoot: string, root: string): string[] {
  return execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "--", root], {
    cwd: repoRoot, encoding: "utf8",
  }).trim().split("\n").filter(Boolean);
}

function baselineBytes(repoRoot: string, baselineCommit: string, path: string): Buffer {
  return execFileSync("git", ["show", `${baselineCommit}:${path}`], { cwd: repoRoot });
}

function changedPaths(repoRoot: string, baselineCommit: string, roots: readonly { root: string; files: readonly string[] }[]): Map<string, { before: string | null; after: string }> {
  const baseline = new Set(roots.flatMap(({ files }) => files));
  const current = roots.flatMap(({ root }) => currentFiles(repoRoot, root)).sort();
  const modified = new Set(
    execFileSync(
      "git",
      ["diff", "--name-only", baselineCommit, "--", "src", "tests"],
      { cwd: repoRoot, encoding: "utf8" },
    ).trim().split("\n").filter((path) => path.length > 0 && baseline.has(path)),
  );
  const changes = new Map<string, { before: string | null; after: string }>();
  for (const path of current) {
    const added = !baseline.has(path);
    if (!added && !modified.has(path)) continue;
    const after = hash(readFileSync(join(repoRoot, path)));
    const before = added ? null : hash(baselineBytes(repoRoot, baselineCommit, path));
    changes.set(path, { before, after });
  }
  return changes;
}

describe("D90 legacy change accounting", () => {
  it("accounts committed and uncommitted changes against an explicit recoverable baseline", () => {
    const root = mkdtempSync(join(tmpdir(), "legacy-accounting-"));
    const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
    try {
      git("init", "--quiet");
      mkdirSync(join(root, "src"));
      mkdirSync(join(root, "tests"));
      writeFileSync(join(root, "src/example.ts"), "export const value = 1;\n");
      git("add", "src/example.ts");
      git("-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "baseline");
      const baseline = git("rev-parse", "HEAD");
      const roots = [{ root: "src", files: ["src/example.ts"] }, { root: "tests", files: [] }];
      assert.equal(changedPaths(root, baseline, roots).size, 0);
      writeFileSync(join(root, "src/example.ts"), "export const value = 2;\n");
      git("add", "src/example.ts");
      git("-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "change");
      writeFileSync(join(root, "tests/example.ts"), "export const test = true;\n");
      assert.deepEqual([...changedPaths(root, baseline, roots)], [
        ["src/example.ts", { before: hash(Buffer.from("export const value = 1;\n")), after: hash(Buffer.from("export const value = 2;\n")) }],
        ["tests/example.ts", { before: null, after: hash(Buffer.from("export const test = true;\n")) }],
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("validates the frozen pre-split accounting inventory", () => {
    assert.equal(accounting.baselineCommit, preservation.baselineCommit);
    assert.match(accounting.baselineCommit, /^[a-f0-9]{40}$/);

    const records: readonly ChangeRecord[] = accounting.records;
    const recordedPaths = records.map(({ path }) => path);
    assert.equal(new Set(recordedPaths).size, recordedPaths.length, "change paths must be unique");
    assert.ok(records.length > 0);
    const baseline = new Set(preservation.roots.flatMap(({ files }) => files));

    const capabilityIds = new Set(capabilities.entries.map(({ id }) => id));
    for (const record of records) {
      assert.match(record.afterSha256, /^[a-f0-9]{64}$/, `${record.path}: after hash`);
      if (baseline.has(record.path)) assert.match(record.beforeSha256 ?? "", /^[a-f0-9]{64}$/, `${record.path}: before hash`);
      else assert.equal(record.beforeSha256, null, `${record.path}: added path`);
      assert.ok(record.capabilityIds.length > 0, `${record.path}: affected capability`);
      assert.ok(record.rebuildRecheckIds.length > 0, `${record.path}: rebuild recheck`);
      assert.equal(record.preservation, "preserved");
      for (const id of record.capabilityIds) assert.ok(capabilityIds.has(id), `${record.path}: ${id}`);
    }
  });
});
