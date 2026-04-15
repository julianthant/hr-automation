import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, rmSync, readFileSync, readdirSync } from "fs";
import { withLogContext, log } from "../../../src/utils/log.js";

const TEST_DIR = ".tracker-log-test";

describe("withLogContext", () => {
  beforeEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  it("captures log calls inside context to JSONL", async () => {
    await withLogContext("test-wf", "item-001", async () => {
      log.step("doing something");
      log.success("it worked");
    }, TEST_DIR);

    const files = readdirSync(TEST_DIR);
    assert.equal(files.length, 1);
    assert.ok(files[0].endsWith("-logs.jsonl"));

    const lines = readFileSync(`${TEST_DIR}/${files[0]}`, "utf-8").split("\n").filter(Boolean);
    assert.equal(lines.length, 2);

    const entry1 = JSON.parse(lines[0]);
    assert.equal(entry1.workflow, "test-wf");
    assert.equal(entry1.itemId, "item-001");
    assert.equal(entry1.level, "step");
    assert.equal(entry1.message, "doing something");

    const entry2 = JSON.parse(lines[1]);
    assert.equal(entry2.level, "success");
  });

  it("does not capture logs outside context", async () => {
    log.step("outside context");
    assert.equal(existsSync(TEST_DIR), false);
  });

  it("handles separate contexts independently", async () => {
    await withLogContext("wf-a", "id-a", async () => {
      log.step("from A");
    }, TEST_DIR);

    await withLogContext("wf-b", "id-b", async () => {
      log.step("from B");
    }, TEST_DIR);

    const files = readdirSync(TEST_DIR).sort();
    assert.equal(files.length, 2);
  });
});
