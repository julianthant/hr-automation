import { readFileSync } from "node:fs";
import { join } from "node:path";
import assert from "node:assert/strict";
import { describe, it } from "vitest";
import manifest from "../../../config/rebuild/legacy-test-lint.json" with { type: "json" };
import preservation from "../../../config/rebuild/legacy-preservation.json" with { type: "json" };
import { REPO_ROOT } from "./helpers/guard-files.js";

describe("diagnostic-fingerprinted legacy test lint debt", () => {
  it("reproduces the reviewed 514-file, 1,344-error, 2-warning baseline", () => {
    assert.equal(manifest.baselineCommit, preservation.baselineCommit);
    assert.equal(manifest.baselineLintedFileCount, 514);
    assert.equal(manifest.baselineDiagnosticFileCount, 154);
    assert.equal(manifest.baselineErrorCount, 1344);
    assert.equal(manifest.baselineWarningCount, 2);
    assert.equal(manifest.diagnostics.length, 1346);
  });

  it("stores semantic, location-stable fingerprints without absolute paths or line numbers", () => {
    const keys = manifest.diagnostics.map((diagnostic) => JSON.stringify(diagnostic));
    assert.deepEqual(keys, [...keys].sort());
    for (const diagnostic of manifest.diagnostics) {
      assert.match(diagnostic.file, /^tests\//);
      assert.equal(diagnostic.file.startsWith(REPO_ROOT), false);
      assert.ok(diagnostic.message.length > 0);
      assert.ok(diagnostic.startColumn > 0);
      assert.match(diagnostic.sourceLineSha256, /^[a-f0-9]{64}$/);
      assert.equal("line" in diagnostic, false);
      assert.equal("endLine" in diagnostic, false);
    }
  });

  it("keeps the executable ratchet wired as the truthful coexistence gate", () => {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    assert.match(pkg.scripts["lint:legacy-tests-ratchet"] ?? "", /legacy-test-lint-ratchet\.ts/);
  });
});
