import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  utimesSync,
  readdirSync,
} from "fs";
import { join } from "path";
import { cleanOldTrackerFiles } from "../../../src/tracker/jsonl.js";

// Dedicated tmp dir to keep the real .tracker/ untouched.
const TEST_DIR = ".tracker-clean-test";

function writeFixture(filename: string, ageDays: number): string {
  const fullPath = join(TEST_DIR, filename);
  writeFileSync(fullPath, '{"test":true}\n');
  // Set mtime + atime to ageDays in the past. `cleanOldTrackerFiles` uses the
  // date embedded in the filename (YYYY-MM-DD), not mtime — but we still set
  // both to keep the fixture honest if the implementation ever changes.
  const t = new Date();
  t.setDate(t.getDate() - ageDays);
  utimesSync(fullPath, t, t);
  return fullPath;
}

function isoDate(daysAgo: number): string {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  return d.toISOString().slice(0, 10);
}

describe("cleanOldTrackerFiles (clean-tracker script)", () => {
  beforeEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  it("deletes only files whose filename-date is older than maxAgeDays", () => {
    writeFixture(`test-${isoDate(1)}.jsonl`, 1);
    writeFixture(`test-${isoDate(5)}.jsonl`, 5);
    writeFixture(`test-${isoDate(30)}.jsonl`, 30);

    const deleted = cleanOldTrackerFiles(7, TEST_DIR);

    assert.equal(deleted, 1, "should delete 1 file (the 30-day-old one)");
    const remaining = readdirSync(TEST_DIR).sort();
    assert.equal(remaining.length, 2);
    assert.ok(
      remaining.some((f) => f.includes(isoDate(1))),
      "1-day-old file kept"
    );
    assert.ok(
      remaining.some((f) => f.includes(isoDate(5))),
      "5-day-old file kept"
    );
    assert.ok(
      !remaining.some((f) => f.includes(isoDate(30))),
      "30-day-old file deleted"
    );
  });

  it("returns 0 when directory does not exist", () => {
    const missing = ".tracker-missing-" + Date.now();
    assert.equal(cleanOldTrackerFiles(7, missing), 0);
  });

  it("ignores non-jsonl files", () => {
    writeFixture(`test-${isoDate(30)}.txt`, 30);
    writeFixture(`test-${isoDate(30)}.jsonl`, 30);
    const deleted = cleanOldTrackerFiles(7, TEST_DIR);
    assert.equal(deleted, 1);
    const remaining = readdirSync(TEST_DIR);
    assert.ok(remaining.some((f) => f.endsWith(".txt")));
  });

  it("respects custom maxAgeDays", () => {
    writeFixture(`test-${isoDate(3)}.jsonl`, 3);
    writeFixture(`test-${isoDate(10)}.jsonl`, 10);

    // With --days 1, both files should be deleted.
    const deleted = cleanOldTrackerFiles(1, TEST_DIR);
    assert.equal(deleted, 2);
    assert.equal(readdirSync(TEST_DIR).length, 0);
  });
});
