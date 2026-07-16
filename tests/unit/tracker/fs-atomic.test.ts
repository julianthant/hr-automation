import { describe, it, beforeEach, afterEach } from "vitest";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { appendFileDurable, writeFileAtomic } from "../../../src/tracker/fs-atomic.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "fs-atomic-"));
});

describe("appendFileDurable", () => {
  it("creates and appends complete records without replacing prior bytes", () => {
    const file = join(dir, "events.jsonl");
    appendFileDurable(file, '{"n":1}\n');
    appendFileDurable(file, Buffer.from('{"n":2}\n'));
    assert.equal(readFileSync(file, "utf8"), '{"n":1}\n{"n":2}\n');
  });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("writeFileAtomic", () => {
  it("writes a new file with the exact content", () => {
    const file = join(dir, "state.json");
    writeFileAtomic(file, '{"a":1}\n');
    assert.equal(readFileSync(file, "utf8"), '{"a":1}\n');
  });

  it("replaces an existing file completely (no partial merge)", () => {
    const file = join(dir, "state.json");
    writeFileSync(file, "OLD CONTENT MUCH LONGER THAN THE REPLACEMENT");
    writeFileAtomic(file, "new");
    assert.equal(readFileSync(file, "utf8"), "new");
  });

  it("leaves no temp-file litter behind after a successful write", () => {
    const file = join(dir, "state.json");
    writeFileAtomic(file, "x");
    writeFileAtomic(file, "y");
    assert.deepEqual(readdirSync(dir), ["state.json"]);
  });

  it("accepts Buffer content", () => {
    const file = join(dir, "blob.bin");
    writeFileAtomic(file, Buffer.from([0x00, 0x0a, 0xff]));
    assert.deepEqual([...readFileSync(file)], [0x00, 0x0a, 0xff]);
  });

  it("fails loud when the parent directory does not exist (no silent mkdir fallback)", () => {
    assert.throws(() => writeFileAtomic(join(dir, "missing", "state.json"), "x"));
  });
});
