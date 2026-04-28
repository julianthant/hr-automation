import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { log, withLogContext } from "../../../src/utils/log.js";
import { dateLocal } from "../../../src/tracker/jsonl.js";

describe("log.debug", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "log-debug-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("writes to JSONL with level='debug' when inside a log context", async () => {
    await withLogContext("test-wf", "item-1", async () => {
      log.debug("hello debug");
    }, dir);

    const file = join(dir, "test-wf-" + dateLocal() + "-logs.jsonl");
    assert.ok(existsSync(file), `expected JSONL file at ${file}`);
    const lines = readFileSync(file, "utf8").trim().split("\n").filter(Boolean);
    const parsed = lines.map((l) => JSON.parse(l));
    const debugLines = parsed.filter((p) => p.level === "debug");
    assert.strictEqual(debugLines.length, 1);
    assert.strictEqual(debugLines[0].message, "hello debug");
  });

  it("does not throw when called outside a log context", () => {
    assert.doesNotThrow(() => log.debug("no context"));
  });
});
