import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import os from "node:os";
import {
  checkEnvFile,
  checkNodeVersion,
  checkTsx,
  checkPlaywrightBrowsers,
  checkDirWritable,
  renderResults,
} from "../../../../src/scripts/ops/setup.js";

// Use a dedicated tmp dir per test group so tests don't stomp on the real
// repo root. Each test gets a fresh empty dir to build up a minimal fake
// project layout (.env, node_modules/.bin/tsx, etc.) for isolated checks.
const TEST_DIR = ".setup-cli-test";

function mkTmp(): string {
  const dir = join(os.tmpdir(), `${TEST_DIR}-${Date.now()}-${Math.random()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function rmTmp(dir: string): void {
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
}

describe("checkEnvFile", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkTmp();
  });

  afterEach(() => {
    rmTmp(tmp);
  });

  it("fails when .env is missing", () => {
    const r = checkEnvFile(tmp);
    assert.equal(r.status, "fail");
    assert.match(r.message, /missing/i);
    assert.ok(r.fix);
  });

  it("fails when .env exists but UCPATH_USER_ID key is absent", () => {
    writeFileSync(join(tmp, ".env"), "UCPATH_PASSWORD=x\n");
    const r = checkEnvFile(tmp);
    assert.equal(r.status, "fail");
    assert.match(r.message, /UCPATH_USER_ID/);
  });

  it("fails when .env exists but UCPATH_PASSWORD key is absent", () => {
    writeFileSync(join(tmp, ".env"), "UCPATH_USER_ID=alice\n");
    const r = checkEnvFile(tmp);
    assert.equal(r.status, "fail");
    assert.match(r.message, /UCPATH_PASSWORD/);
  });

  it("passes when both required keys exist (values ignored)", () => {
    writeFileSync(
      join(tmp, ".env"),
      "UCPATH_USER_ID=alice\nUCPATH_PASSWORD=secret-not-logged\n",
    );
    const r = checkEnvFile(tmp);
    assert.equal(r.status, "ok");
    // Never leak values into the message — check that "secret-not-logged"
    // doesn't appear anywhere in the output.
    assert.ok(!r.message.includes("secret-not-logged"));
  });

  it("tolerates leading whitespace + key=value with empty value", () => {
    writeFileSync(
      join(tmp, ".env"),
      "  UCPATH_USER_ID=\n  UCPATH_PASSWORD=\n",
    );
    const r = checkEnvFile(tmp);
    // Empty values are still "key exists" — we don't validate content,
    // only presence.
    assert.equal(r.status, "ok");
  });
});

describe("checkNodeVersion", () => {
  it("passes for Node 20+", () => {
    assert.equal(checkNodeVersion("20.0.0").status, "ok");
    assert.equal(checkNodeVersion("22.11.0").status, "ok");
    assert.equal(checkNodeVersion("24.9.0").status, "ok");
  });

  it("fails for Node 18 or older", () => {
    assert.equal(checkNodeVersion("18.20.0").status, "fail");
    assert.equal(checkNodeVersion("16.0.0").status, "fail");
  });

  it("fails on garbled version strings", () => {
    const r = checkNodeVersion("not-a-version");
    assert.equal(r.status, "fail");
    assert.match(r.message, /unrecognized/);
  });
});

describe("checkTsx", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkTmp();
  });

  afterEach(() => {
    rmTmp(tmp);
  });

  it("passes when tsx is in node_modules/.bin", () => {
    const binDir = join(tmp, "node_modules", ".bin");
    mkdirSync(binDir, { recursive: true });
    const binName = process.platform === "win32" ? "tsx.cmd" : "tsx";
    writeFileSync(join(binDir, binName), "#!/bin/sh\n");
    const r = checkTsx(tmp);
    assert.equal(r.status, "ok");
    assert.match(r.message, /node_modules/);
  });

  // We don't test the PATH-fallback branch in isolation — would require
  // mocking execSync. The node_modules/.bin branch is the primary path
  // (all npm scripts invoke tsx via that bin dir).
});

describe("checkPlaywrightBrowsers", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkTmp();
  });

  afterEach(() => {
    rmTmp(tmp);
  });

  it("fails when no cache dir exists", () => {
    // Point at a fake homedir with NO Playwright cache layout.
    const r = checkPlaywrightBrowsers(tmp, undefined);
    assert.equal(r.status, "fail");
    assert.match(r.message, /no chromium/i);
  });

  it("passes when PLAYWRIGHT_BROWSERS_PATH override has chromium-* dir", () => {
    const cache = join(tmp, "pw-cache");
    mkdirSync(join(cache, "chromium-1234"), { recursive: true });
    const r = checkPlaywrightBrowsers(tmp, cache);
    assert.equal(r.status, "ok");
    assert.match(r.message, /chromium installed/);
  });

  it("fails when cache dir exists but has no chromium-* subdir", () => {
    const cache = join(tmp, "pw-cache");
    mkdirSync(join(cache, "firefox-100"), { recursive: true });
    mkdirSync(join(cache, "webkit-200"), { recursive: true });
    const r = checkPlaywrightBrowsers(tmp, cache);
    assert.equal(r.status, "fail");
  });
});

describe("checkDirWritable", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkTmp();
  });

  afterEach(() => {
    rmTmp(tmp);
  });

  it("creates the directory if missing + returns ok", () => {
    const target = join(tmp, "new-dir");
    const r = checkDirWritable("target", target, "fix me");
    assert.equal(r.status, "ok");
    assert.ok(existsSync(target), "directory created");
  });

  it("passes on an already-existing directory", () => {
    const target = join(tmp, "existing");
    mkdirSync(target, { recursive: true });
    const r = checkDirWritable("target", target, "fix me");
    assert.equal(r.status, "ok");
  });
});

describe("renderResults", () => {
  it("exits 0 when all pass", () => {
    const { exitCode, output } = renderResults([
      { name: "a", status: "ok", message: "good" },
      { name: "b", status: "ok", message: "good" },
    ]);
    assert.equal(exitCode, 0);
    assert.match(output, /All 2 checks passed/);
  });

  it("exits 0 when warnings but no failures", () => {
    const { exitCode, output } = renderResults([
      { name: "a", status: "ok", message: "good" },
      { name: "b", status: "warn", message: "meh", fix: "maybe fix" },
    ]);
    assert.equal(exitCode, 0);
    assert.match(output, /1 warning/);
  });

  it("exits 1 when any check fails", () => {
    const { exitCode, output } = renderResults([
      { name: "a", status: "fail", message: "broken", fix: "do X" },
      { name: "b", status: "ok", message: "good" },
    ]);
    assert.equal(exitCode, 1);
    assert.match(output, /1 check failed/);
    // Fix suggestion must be surfaced on failures.
    assert.match(output, /do X/);
  });

  it("includes fix suggestions only for non-ok results", () => {
    const { output } = renderResults([
      { name: "ok-check", status: "ok", message: "clean", fix: "shouldnt render" },
      { name: "warn-check", status: "warn", message: "soft", fix: "soft-fix-text" },
    ]);
    assert.ok(!output.includes("shouldnt render"));
    assert.match(output, /soft-fix-text/);
  });
});
